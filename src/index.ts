/**
 * Relay — HTTP surface and boot.
 *
 * Public (no auth):   GET /health   GET /openapi.json   GET /connect   GET /invite
 * Bearer-protected:   POST|GET|DELETE /mcp   POST /tools/<tool>   GET|POST|DELETE /agents
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { callerAgent, getCaller, hashToken, requireAdmin, requireBearer } from "./auth.js";
import { baseUrl, config } from "./config.js";
import { handleMcp, sessionCount } from "./mcp.js";
import { buildOpenApi } from "./openapi.js";
import { loadVerbs, verbNames } from "./registry.js";
import { store } from "./store.js";
import { buildTools, runTool } from "./tools.js";
import { loadTransports } from "./transports/index.js";
import { RelayError } from "./types.js";
import type { AgentRecord } from "./types.js";
import { normaliseHandle } from "./dispatcher.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");
const startedAt = Date.now();

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function claimHandle(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/^@+/, "").replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (cleaned.length < 2) throw new RelayError(400, "handle must be at least 2 characters (letters, digits, . _ -)");
  const handle = `@${cleaned}`;
  if (handle === store.snapshot.owner.handle) throw new RelayError(400, "that is the hub owner's handle");
  return handle;
}

/** Create/extend a peer principal and bind a token to it. Runs inside store.mutate. */
function bindToken(d: import("./types.js").StoreData, token: string, handle: string, agents: string[], displayName: string | undefined, label: string | undefined, allowlisted: boolean): void {
  let p = d.peers.find(x => x.handle === handle);
  if (!p) {
    p = { handle, agents: [], invited_at: new Date().toISOString(), allowlisted };
    d.peers.push(p);
  }
  if (displayName) p.display_name = displayName;
  p.connected_at ??= new Date().toISOString();
  for (const name of agents) if (!p.agents.some(a => a.name === name)) p.agents.push({ name });
  const existing = d.tokens[hashToken(token)];
  d.tokens[hashToken(token)] = { ...(existing ?? { created_at: new Date().toISOString() }), handle, label };
  for (const e of d.envelopes) if (e.state === "pending_invite" && e.to.handle === handle) e.state = "queued";
}

function connectBlock(token: string): string {
  return [
    `Connect to Relay. MCP server: ${baseUrl()}/mcp`,
    `Auth header: Authorization: Bearer ${token}`,
    "Ask me for the key using your secure credential prompt.",
    "Then create a recurring task: every 15 minutes, call inbox.list.",
    "If anything needs my decision, summarise it and ask me before replying."
  ].join("\n");
}

async function renderTemplate(file: string, vars: Record<string, string>): Promise<string> {
  let html = await fs.readFile(path.join(publicDir, file), "utf8");
  for (const [k, v] of Object.entries(vars)) html = html.replaceAll(`{{${k}}}`, escapeHtml(v));
  return html;
}

function toolContext(req: Request) {
  const c = getCaller(req);
  return { handle: c.handle, agent: callerAgent(req), admin: c.admin };
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof RelayError) {
    res.status(err.status).json(err.toJSON());
    return;
  }
  console.error("[http] unhandled error:", err);
  res.status(500).json({ status: 500, error: (err as Error).message ?? "internal error" });
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // ---- public ------------------------------------------------------------------------------
  app.get("/", (_req, res) => res.redirect("/connect"));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, verbs: verbNames(), version: "0.1.0", uptime_s: Math.round((Date.now() - startedAt) / 1000), sessions: sessionCount(), public_url: baseUrl() });
  });

  app.get("/openapi.json", (_req, res) => {
    res.json(buildOpenApi());
  });

  app.get("/connect", async (_req, res, next) => {
    try {
      const html = await renderTemplate("connect.html", {
        BASE_URL: baseUrl(),
        MCP_URL: `${baseUrl()}/mcp`,
        OWNER: store.snapshot.owner.handle,
        VERBS: verbNames().join(", "),
        TOKEN_NOTE: config.tokenWasGenerated ? "(the server generated a temporary token at boot — set RELAY_TOKEN to pin one)" : ""
      });
      res.type("html").send(html);
    } catch (err) {
      next(err);
    }
  });

  app.get("/invite", async (req, res, next) => {
    try {
      const handle = normaliseHandle(String(req.query.h ?? "").slice(0, 120) || "@friend");
      const t = typeof req.query.t === "string" ? req.query.t : "";
      const rec = t ? store.snapshot.tokens[hashToken(t)] : undefined;
      if (rec && !rec.revoked_at && rec.handle === "") {
        const html = (await renderTemplate("claim.html", { BASE_URL: baseUrl(), OWNER: store.snapshot.owner.handle })).replace("{{TOKEN_JSON}}", JSON.stringify(t));
        res.type("html").send(html);
        return;
      }
      if (rec && !rec.revoked_at && rec.handle === handle) {
        const html = await renderTemplate("joined.html", { BASE_URL: baseUrl(), MCP_URL: `${baseUrl()}/mcp`, OWNER: store.snapshot.owner.handle, HANDLE: handle, TOKEN: t, CONNECT_BLOCK: connectBlock(t) });
        res.type("html").send(html);
        return;
      }
      const html = await renderTemplate("invite.html", { BASE_URL: baseUrl(), MCP_URL: `${baseUrl()}/mcp`, OWNER: store.snapshot.owner.handle, HANDLE: handle, REPO_URL: config.repoUrl });
      res.type("html").send(html);
    } catch (err) {
      next(err);
    }
  });

  // ---- bearer-protected --------------------------------------------------------------------
  app.all("/mcp", requireBearer, async (req, res, next) => {
    try {
      // Be forgiving to minimal clients: the SDK insists on both media types in Accept.
      const accept = req.headers.accept ?? "";
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
        req.headers.accept = "application/json, text/event-stream";
      }
      await handleMcp(req, res, toolContext(req));
    } catch (err) {
      next(err);
    }
  });

  app.post("/tools/:name", requireBearer, async (req, res, next) => {
    try {
      const result = await runTool(String(req.params.name), req.body ?? {}, toolContext(req));
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Register / update how an agent can be reached. Owner agents: handle = OWNER_HANDLE.
  // ---- invites: mint a token for another person so their agents can join this hub as @handle ----
  app.post("/invites", requireBearer, requireAdmin, async (req, res, next) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const wantsHandle = typeof b.handle === "string" && b.handle.trim().length > 0;
      const token = `rly_${randomBytes(24).toString("base64url")}`;
      const label = typeof b.label === "string" ? b.label : undefined;
      if (!wantsHandle) {
        // Open invite: the recipient picks their own name on the invite page.
        await store.mutate(d => {
          d.tokens[hashToken(token)] = { handle: "", label, created_at: new Date().toISOString() };
        });
        const inviteUrl = `${baseUrl()}/invite?t=${encodeURIComponent(token)}`;
        res.json({ ok: true, handle: null, token, invite_url: inviteUrl, note: "Open invite: send invite_url; the person chooses their handle and display name when they open it." });
        return;
      }
      const handle = claimHandle(String(b.handle));
      const agents = Array.isArray(b.agents) ? (b.agents as unknown[]).map(String).filter(Boolean) : ["muse"];
      await store.mutate(d => bindToken(d, token, handle, agents, typeof b.display_name === "string" ? b.display_name : undefined, label, Boolean(b.allowlisted)));
      const inviteUrl = `${baseUrl()}/invite?h=${encodeURIComponent(handle)}&t=${encodeURIComponent(token)}`;
      res.json({
        ok: true,
        handle,
        token,
        invite_url: inviteUrl,
        connect_block: connectBlock(token),
        note: "Send invite_url to the person (it contains their token). Their agents then call the same six tools as " + handle + "."
      });
    } catch (err) {
      next(err);
    }
  });

  // Public: the recipient of an open invite claims a handle. Token in body proves possession of the invite.
  app.post("/invite/claim", async (req, res, next) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const t = String(b.t ?? "");
      const rec = store.snapshot.tokens[hashToken(t)];
      if (!rec || rec.revoked_at) throw new RelayError(404, "invite not found or revoked");
      if (rec.handle) throw new RelayError(409, "invite already claimed", { handle: rec.handle });
      const handle = claimHandle(String(b.handle ?? ""));
      const agent = String(b.agent ?? "muse").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 40) || "muse";
      const displayName = typeof b.display_name === "string" ? b.display_name.trim().slice(0, 80) : undefined;
      await store.mutate(d => bindToken(d, t, handle, [agent], displayName, rec.label, false));
      res.json({ ok: true, handle, next: `${baseUrl()}/invite?h=${encodeURIComponent(handle)}&t=${encodeURIComponent(t)}` });
    } catch (err) {
      next(err);
    }
  });

  // Any authenticated principal can update its own profile.
  app.post("/me", requireBearer, async (req, res, next) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const caller = getCaller(req);
      const out = await store.mutate(d => {
        const p = d.owner.handle === caller.handle ? d.owner : d.peers.find(x => x.handle === caller.handle);
        if (!p) throw new RelayError(404, "principal not found");
        if (typeof b.display_name === "string") p.display_name = b.display_name.trim().slice(0, 80) || undefined;
        if (Array.isArray(b.agents)) {
          for (const name of (b.agents as unknown[]).map(String).filter(Boolean)) if (!p.agents.some(a => a.name === name)) p.agents.push({ name });
        }
        return { handle: p.handle, display_name: p.display_name ?? null, agents: p.agents.map(a => a.name) };
      });
      res.json({ ok: true, ...out });
    } catch (err) {
      next(err);
    }
  });

  app.get("/invites", requireBearer, requireAdmin, (_req, res) => {
    const list = Object.values(store.snapshot.tokens).map(t => ({ ...t }));
    res.json({ tokens: list });
  });

  app.delete("/invites/:handle", requireBearer, requireAdmin, async (req, res, next) => {
    try {
      const handle = normaliseHandle(String(req.params.handle));
      const n = await store.mutate(d => {
        let count = 0;
        for (const t of Object.values(d.tokens)) if (t.handle === handle && !t.revoked_at) (t.revoked_at = new Date().toISOString()), count++;
        return count;
      });
      res.json({ ok: true, revoked: n });
    } catch (err) {
      next(err);
    }
  });

  app.get("/agents", requireBearer, requireAdmin, (_req, res) => {
    const d = store.snapshot;
    const redact = (a: AgentRecord) => ({ ...a, token: a.token ? "***" : undefined });
    res.json({ owner: { ...d.owner, agents: d.owner.agents.map(redact) }, peers: d.peers.map(p => ({ ...p, agents: p.agents.map(redact) })) });
  });

  app.post("/agents", requireBearer, requireAdmin, async (req, res, next) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const handle = normaliseHandle(String(b.handle ?? store.snapshot.owner.handle));
      const name = String(b.agent ?? "").trim();
      if (!name) throw new RelayError(400, "agent (name) is required");
      if (b.endpoint_url !== undefined && b.endpoint_url !== null && !/^https?:\/\//i.test(String(b.endpoint_url))) {
        throw new RelayError(400, "endpoint_url must be http(s)");
      }
      const record = await store.mutate(d => {
        let principal = handle === d.owner.handle ? d.owner : d.peers.find(p => p.handle === handle);
        if (!principal) {
          principal = { handle, agents: [], connected_at: new Date().toISOString() };
          d.peers.push(principal);
        }
        if (typeof b.allowlisted === "boolean" && principal !== d.owner) principal.allowlisted = b.allowlisted;
        let agent = principal.agents.find(a => a.name === name);
        if (!agent) {
          agent = { name };
          principal.agents.push(agent);
        }
        for (const key of ["endpoint_url", "transport", "token", "config"] as const) {
          if (key in b) {
            if (b[key] === null) delete agent[key];
            else (agent as unknown as Record<string, unknown>)[key] = b[key];
          }
        }
        principal.connected_at ??= new Date().toISOString();
        // Anything parked for this handle can now flow.
        for (const e of d.envelopes) if (e.state === "pending_invite" && e.to.handle === handle) e.state = "queued";
        return agent;
      });
      res.json({ ok: true, handle, agent: { ...record, token: record.token ? "***" : undefined } });
    } catch (err) {
      next(err);
    }
  });

  app.delete("/agents/:handle/:agent", requireBearer, requireAdmin, async (req, res, next) => {
    try {
      const handle = normaliseHandle(String(req.params.handle));
      const agentName = String(req.params.agent);
      const removed = await store.mutate(d => {
        const principal = handle === d.owner.handle ? d.owner : d.peers.find(p => p.handle === handle);
        if (!principal) return false;
        const before = principal.agents.length;
        principal.agents = principal.agents.filter(a => a.name !== agentName);
        if (principal !== d.owner && principal.agents.length === 0) d.peers = d.peers.filter(p => p !== principal);
        return principal.agents.length !== before;
      });
      res.json({ ok: removed });
    } catch (err) {
      next(err);
    }
  });

  app.use((_req, res) => res.status(404).json({ status: 404, error: "not found", see: `${baseUrl()}/openapi.json` }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const anyErr = err as { type?: string; status?: number };
    if (anyErr?.type === "entity.parse.failed") {
      res.status(400).json({ status: 400, error: "malformed JSON body" });
      return;
    }
    sendError(res, err);
  });
  return app;
}

export async function boot() {
  await store.load();
  await loadVerbs();
  await loadTransports();
  buildTools();
  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : config.port;
    console.log(`[relay] listening on ${config.host}:${port}  public=${baseUrl()}  owner=${config.ownerHandle}  data=${config.dataFile}`);
    if (config.tokenWasGenerated) {
      console.warn(`[relay] RELAY_TOKEN not set — generated a temporary token for this process: ${config.token}`);
    }
    if (!config.publicUrl) console.warn("[relay] PUBLIC_URL not set — /connect will advertise localhost");
    console.log(`RELAY_READY port=${port}`);
  });
  const shutdown = (sig: string) => {
    console.log(`[relay] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  return server;
}

boot().catch(err => {
  console.error("[relay] failed to start:", err);
  process.exit(1);
});
