/**
 * Relay — HTTP surface and boot.
 *
 * Public:     GET /health  /openapi.json  /start.md  /connect  /invite  /admin  /relay.css   POST /pair   + OAuth shim (src/oauth.ts)
 * Bearer:     POST|GET|DELETE /mcp   POST /tools/<tool>
 * Owner key:  invites, agent keys, endpoint registry (src/admin.ts)
 */
import path from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { adminRouter, newToken } from "./admin.js";
import { bridgeOptionsFromEnv, startBridge } from "./imessage/index.js";
import { callerAgent, getCaller, hashToken, requireBearer } from "./auth.js";
import { baseUrl, config } from "./config.js";
import { normaliseHandle } from "./dispatcher.js";
import { connectBlock, page, publicDir, wrap } from "./http.js";
import { handleMcp, sessionCount } from "./mcp.js";
import { buildOpenApi } from "./openapi.js";
import { oauthRouter } from "./oauth.js";
import { listVerbs, loadVerbs, verbNames } from "./registry.js";
import { store } from "./store.js";
import { buildTools, runTool } from "./tools.js";
import { loadTransports } from "./transports/index.js";
import { RelayError } from "./types.js";

const startedAt = Date.now();
const toolContext = (req: Request) => ({ handle: getCaller(req).handle, agent: callerAgent(req), admin: getCaller(req).admin });
const html = (res: Response, body: string) => void res.type("html").send(body);

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));
  app.use((_req, res, next) => (res.setHeader("Cache-Control", "no-store"), next()));

  // ---- public ----------------------------------------------------------------------------------
  app.get("/", (_req, res) => res.redirect("/connect"));
  app.get("/relay.css", (_req, res) => res.sendFile(path.join(publicDir, "relay.css")));

  // Agent-facing onboarding. A human forwards one sentence pointing here; the assistant does the rest.
  app.get(
    "/start.md",
    wrap(async (_req, res) => {
      const owner = store.snapshot.owner.handle;
      const verbs = listVerbs()
        .map(v => `- \`${v.verb}\` — ${v.describe}${v.mutating ? " *(needs the user's decision)*" : ""}`)
        .join("\n");
      res.type("text/markdown; charset=utf-8").send(await page("start.md", { BASE_URL: baseUrl(), MCP_URL: `${baseUrl()}/mcp`, OWNER: owner, OWNER_BARE: owner.replace(/^@/, ""), VERBS: verbs }));
    })
  );
  app.use(oauthRouter());

  app.get("/health", (_req, res) => {
    const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? null;
    res.json({
      ok: true,
      verbs: verbNames(),
      version: "0.1.0",
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      sessions: sessionCount(),
      public_url: baseUrl(),
      store: { file: config.dataFile, volume, persistent: Boolean(volume && path.resolve(config.dataFile).startsWith(path.resolve(volume))) }
    });
  });

  app.get("/openapi.json", (_req, res) => res.json(buildOpenApi()));

  app.get(
    "/connect",
    wrap(async (_req, res) =>
      html(
        res,
        await page("connect.html", {
          BASE_URL: baseUrl(),
          MCP_URL: `${baseUrl()}/mcp`,
          OWNER: store.snapshot.owner.handle,
          VERBS: verbNames().join(", "),
          TOKEN_NOTE: config.tokenWasGenerated ? "(the server generated a temporary token at boot — set RELAY_TOKEN to pin one)" : ""
        })
      )
    )
  );

  // Owner console: the page is static; every action it takes calls the admin API with the owner key.
  app.get("/admin", wrap(async (_req, res) => html(res, await page("admin.html"))));

  // Invite page: unclaimed open invite → claim form; claimed/bound key → welcome + connect block; no key → explainer.
  app.get(
    "/invite",
    wrap(async (req, res) => {
      const handle = normaliseHandle(String(req.query.h ?? "").slice(0, 120) || "@friend");
      const t = typeof req.query.t === "string" ? req.query.t : "";
      const rec = t ? store.snapshot.tokens[hashToken(t)] : undefined;
      const common = { BASE_URL: baseUrl(), MCP_URL: `${baseUrl()}/mcp`, OWNER: store.snapshot.owner.handle, HANDLE: handle };
      if (rec && !rec.revoked_at && rec.handle === "") return html(res, (await page("claim.html", common)).replace("{{TOKEN_JSON}}", JSON.stringify(t)));
      if (rec && !rec.revoked_at && rec.handle === handle) return html(res, await page("joined.html", { ...common, CONNECT_BLOCK: connectBlock(t) }));
      return html(res, await page("invite.html", { ...common, REPO_URL: config.repoUrl }));
    })
  );

  // ---- bearer ----------------------------------------------------------------------------------
  app.all("/mcp", requireBearer, async (req, res, next) => {
    try {
      // The SDK insists on both media types in Accept; be forgiving to minimal clients.
      const accept = req.headers.accept ?? "";
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) req.headers.accept = "application/json, text/event-stream";
      await handleMcp(req, res, toolContext(req));
    } catch (err) {
      next(err);
    }
  });

  app.post("/tools/:name", requireBearer, wrap(req => runTool(String(req.params.name), req.body ?? {}, toolContext(req))));

  app.use(adminRouter());

  // ---- errors ----------------------------------------------------------------------------------
  app.use((_req, res) => res.status(404).json({ status: 404, error: "not found", see: `${baseUrl()}/openapi.json` }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if ((err as { type?: string })?.type === "entity.parse.failed") return void res.status(400).json({ status: 400, error: "malformed JSON body" });
    if (err instanceof RelayError) return void res.status(err.status).json(err.toJSON());
    console.error("[http] unhandled error:", err);
    res.status(500).json({ status: 500, error: (err as Error).message ?? "internal error" });
  });
  return app;
}

export async function boot() {
  await store.load();
  await loadVerbs();
  await loadTransports();
  buildTools();
  const server = createApp().listen(config.port, config.host, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : config.port;
    console.log(`[relay] listening on ${config.host}:${port}  public=${baseUrl()}  owner=${config.ownerHandle}  data=${config.dataFile}`);
    if (config.tokenWasGenerated) console.warn(`[relay] RELAY_TOKEN not set — generated a temporary token for this process: ${config.token}`);
    if (!config.publicUrl) console.warn("[relay] PUBLIC_URL not set — /connect will advertise localhost");
    console.log(`RELAY_READY port=${port}`);
    void startImessageBridge(port);
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

/**
 * If SENDBLUE_* env is set, run the iMessage bridge inside the hub against localhost: one Railway service,
 * four env vars, no key handling. The bridge's key is minted per boot (label "imessage-bridge"), never stored in clear.
 */
async function startImessageBridge(port: number): Promise<void> {
  let opts;
  try {
    opts = bridgeOptionsFromEnv(`http://127.0.0.1:${port}`, "");
  } catch (err) {
    return console.error(`[imessage] not started: ${(err as Error).message}`);
  }
  if (!opts) return;
  const label = "imessage-bridge";
  const key = newToken(); // lives only in this process; the previous boot's key is revoked so nothing accumulates
  await store.mutate(d => {
    const now = new Date().toISOString();
    for (const t of Object.values(d.tokens)) if (t.label === label && !t.revoked_at) t.revoked_at = now;
    d.tokens[hashToken(key)] = { handle: d.owner.handle, agent: "imessage", label, created_at: now };
    if (!d.owner.agents.some(a => a.name === "imessage")) d.owner.agents.push({ name: "imessage" });
  });
  startBridge({ ...opts, key }).catch(err => console.error(`[imessage] ${(err as Error).message}`));
}

boot().catch(err => {
  console.error("[relay] failed to start:", err);
  process.exit(1);
});
