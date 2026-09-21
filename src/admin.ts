/**
 * Owner-key routes: minting keys for the owner's own agents, inviting people, rotating/revoking keys,
 * and registering live endpoints. Everything here mutates the store; the six tools never do any of this.
 */
import { randomBytes } from "node:crypto";
import { Router } from "express";
import type { Request } from "express";
import { extractToken, getCaller, hashToken, requireAdmin, requireBearer } from "./auth.js";
import { baseUrl } from "./config.js";
import { normaliseHandle } from "./dispatcher.js";
import { store } from "./store.js";
import { RelayError } from "./types.js";
import type { AgentRecord, Principal, StoreData } from "./types.js";
import { connectBlock, wrap } from "./http.js";

export const newToken = (): string => `rly_${randomBytes(24).toString("base64url")}`;
export const inviteLink = (handle: string, token: string): string => `${baseUrl()}/invite?h=${encodeURIComponent(handle)}&t=${encodeURIComponent(token)}`;
const now = () => new Date().toISOString();
const body = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;
const slug = (raw: unknown, fallback = ""): string => String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 40) || fallback;

export function claimHandle(raw: string): string {
  const cleaned = slug(raw.replace(/^@+/, "")).replace(/^-+|-+$/g, "");
  if (cleaned.length < 2) throw new RelayError(400, "handle must be at least 2 characters (letters, digits, . _ -)");
  const handle = `@${cleaned}`;
  if (handle === store.snapshot.owner.handle) throw new RelayError(400, "that is the hub owner's handle");
  return handle;
}

function principalIn(d: StoreData, handle: string, create = false): Principal | undefined {
  if (handle === d.owner.handle) return d.owner;
  let p = d.peers.find(x => x.handle === handle);
  if (!p && create) d.peers.push((p = { handle, agents: [], invited_at: now() }));
  return p;
}

function revokeWhere(d: StoreData, pred: (t: StoreData["tokens"][string]) => boolean): number {
  let n = 0;
  for (const t of Object.values(d.tokens)) if (!t.revoked_at && pred(t)) (t.revoked_at = now()), n++;
  return n;
}

function releaseParked(d: StoreData, handle: string): void {
  for (const e of d.envelopes) if (e.state === "pending_invite" && e.to.handle === handle) e.state = "queued";
}

/** Create/extend a peer principal and bind a token to it. Runs inside store.mutate. */
export function bindToken(d: StoreData, token: string, handle: string, agents: string[], displayName?: string, label?: string, allowlisted = false): void {
  const p = principalIn(d, handle, true)!;
  p.allowlisted ??= allowlisted;
  if (displayName) p.display_name = displayName;
  p.connected_at ??= now();
  for (const name of agents) if (!p.agents.some(a => a.name === name)) p.agents.push({ name });
  p.default_agent ||= agents[0] ?? p.agents[0]?.name; // so their messages never go out as "unknown"
  d.tokens[hashToken(token)] = { ...(d.tokens[hashToken(token)] ?? { created_at: now() }), handle, label };
  releaseParked(d, handle);
}

export function adminRouter(): Router {
  const r = Router();
  const admin = [requireBearer, requireAdmin];

  // Invite a person. With a handle: bound immediately. Without: an open invite they claim on the invite page.
  r.post(
    "/invites",
    ...admin,
    wrap(async req => {
      const b = body(req);
      const token = newToken();
      const label = typeof b.label === "string" ? b.label : undefined;
      if (typeof b.handle !== "string" || !b.handle.trim()) {
        await store.mutate(d => void (d.tokens[hashToken(token)] = { handle: "", label, created_at: now() }));
        return { ok: true, handle: null, token, invite_url: `${baseUrl()}/invite?t=${encodeURIComponent(token)}`, note: "Open invite: the person chooses their handle when they open it." };
      }
      const handle = claimHandle(b.handle);
      const agents = Array.isArray(b.agents) ? b.agents.map(String).filter(Boolean) : ["muse"];
      await store.mutate(d => bindToken(d, token, handle, agents, typeof b.display_name === "string" ? b.display_name : undefined, label, Boolean(b.allowlisted)));
      return { ok: true, handle, token, invite_url: inviteLink(handle, token), connect_block: connectBlock(token), note: "Send invite_url privately; it contains their key." };
    })
  );

  // Public: claim an open invite. Possession of the token is the proof.
  r.post(
    "/invite/claim",
    wrap(async req => {
      const b = body(req);
      const t = String(b.t ?? "");
      const rec = store.snapshot.tokens[hashToken(t)];
      if (!rec || rec.revoked_at) throw new RelayError(404, "invite not found or revoked");
      if (rec.handle) throw new RelayError(409, "invite already claimed", { handle: rec.handle });
      const handle = claimHandle(String(b.handle ?? ""));
      const displayName = typeof b.display_name === "string" ? b.display_name.trim().slice(0, 80) : undefined;
      await store.mutate(d => bindToken(d, t, handle, [slug(b.agent, "muse")], displayName, rec.label));
      return { ok: true, handle, next: inviteLink(handle, t) };
    })
  );

  r.get("/invites", ...admin, wrap(async () => ({ tokens: Object.values(store.snapshot.tokens) })));

  r.delete(
    "/invites/:handle",
    ...admin,
    wrap(async req => {
      const handle = normaliseHandle(String(req.params.handle));
      return { ok: true, revoked: await store.mutate(d => revokeWhere(d, t => t.handle === handle)) };
    })
  );

  // Owner rotates a guest's key (they lost it): old keys die, new invite link returned.
  r.post(
    "/invites/:handle/rotate",
    ...admin,
    wrap(async req => {
      const handle = normaliseHandle(String(req.params.handle));
      if (!store.findPrincipal(handle) || handle === store.snapshot.owner.handle) throw new RelayError(404, `no guest ${handle}`);
      const token = newToken();
      await store.mutate(d => {
        revokeWhere(d, t => t.handle === handle);
        d.tokens[hashToken(token)] = { handle, created_at: now(), label: "rotated by owner" };
      });
      return { ok: true, handle, token, invite_url: inviteLink(handle, token), connect_block: connectBlock(token) };
    })
  );

  // Any key holder rotates their own key.
  r.post(
    "/me/rotate",
    requireBearer,
    wrap(async req => {
      const caller = getCaller(req);
      if (caller.admin) throw new RelayError(400, "the owner key is RELAY_TOKEN; rotate it in Railway variables");
      const presented = hashToken(extractToken(req)!);
      const token = newToken();
      await store.mutate(d => {
        const old = d.tokens[presented];
        if (old) old.revoked_at = now();
        d.tokens[hashToken(token)] = { handle: caller.handle, agent: caller.agent, label: old?.label, created_at: now() };
      });
      return { ok: true, handle: caller.handle, token, connect_block: connectBlock(token), invite_url: inviteLink(caller.handle, token) };
    })
  );

  // Any key holder updates their own profile.
  r.post(
    "/me",
    requireBearer,
    wrap(async req => {
      const b = body(req);
      const caller = getCaller(req);
      const out = await store.mutate(d => {
        const p = principalIn(d, caller.handle);
        if (!p) throw new RelayError(404, "principal not found");
        if (typeof b.display_name === "string") p.display_name = b.display_name.trim().slice(0, 80) || undefined;
        if (typeof b.default_agent === "string") {
          p.default_agent = slug(b.default_agent) || undefined;
          if (p.default_agent && !p.agents.some(a => a.name === p.default_agent)) p.agents.push({ name: p.default_agent });
        }
        if (Array.isArray(b.agents)) for (const name of b.agents.map(String).filter(Boolean)) if (!p.agents.some(a => a.name === name)) p.agents.push({ name });
        return { handle: p.handle, display_name: p.display_name ?? null, default_agent: p.default_agent ?? null, agents: p.agents.map(a => a.name) };
      });
      return { ok: true, ...out };
    })
  );

  // Owner mints a key for one of their own agents: acts as @owner/<agent>, sees only that agent's inbox, not admin.
  r.post(
    "/agents/tokens",
    ...admin,
    wrap(async req => {
      const b = body(req);
      const agent = slug(b.agent);
      if (agent.length < 2) throw new RelayError(400, "agent name is required, e.g. claude-code");
      const token = newToken();
      await store.mutate(d => {
        if (!d.owner.agents.some(a => a.name === agent)) d.owner.agents.push({ name: agent });
        if (b.rotate === true) revokeWhere(d, t => t.handle === d.owner.handle && t.agent === agent);
        d.tokens[hashToken(token)] = { handle: d.owner.handle, agent, label: typeof b.label === "string" ? b.label : `owner agent ${agent}`, created_at: now() };
      });
      return { ok: true, handle: store.snapshot.owner.handle, agent, token, connect_block: connectBlock(token) };
    })
  );

  // Revoke every key minted for one of the owner's agents (the agent record stays).
  r.delete(
    "/agents/tokens/:agent",
    ...admin,
    wrap(async req => {
      const agent = slug(req.params.agent);
      return { ok: true, agent, revoked: await store.mutate(d => revokeWhere(d, t => t.handle === d.owner.handle && t.agent === agent)) };
    })
  );

  // Start over on the owner's side: revoke all owner-agent keys and drop agent records except `keep`. Peers untouched.
  r.post(
    "/agents/reset",
    ...admin,
    wrap(async req => {
      const b = body(req);
      const keep = new Set((Array.isArray(b.keep) ? b.keep.map(String) : [store.snapshot.owner.default_agent ?? "muse"]).filter(Boolean));
      return await store.mutate(d => {
        const revoked = revokeWhere(d, t => t.handle === d.owner.handle && !!t.agent);
        const before = d.owner.agents.map(a => a.name);
        d.owner.agents = d.owner.agents.filter(a => keep.has(a.name));
        return { ok: true, revoked, removed: before.filter(n => !keep.has(n)), kept: d.owner.agents.map(a => a.name) };
      });
    })
  );

  // Owner edits a peer: allowlist toggle, display name.
  r.post(
    "/invites/:handle",
    ...admin,
    wrap(async req => {
      const b = body(req);
      const handle = normaliseHandle(String(req.params.handle));
      return await store.mutate(d => {
        const p = principalIn(d, handle);
        if (!p || p === d.owner) throw new RelayError(404, `no guest ${handle}`);
        if (typeof b.allowlisted === "boolean") p.allowlisted = b.allowlisted;
        if (typeof b.display_name === "string") p.display_name = b.display_name.trim().slice(0, 80) || undefined;
        return { ok: true, handle, allowlisted: Boolean(p.allowlisted), display_name: p.display_name ?? null };
      });
    })
  );

  const redact = (a: AgentRecord) => ({ ...a, token: a.token ? "***" : undefined });

  r.get(
    "/agents",
    ...admin,
    wrap(async () => {
      const d = store.snapshot;
      return { owner: { ...d.owner, agents: d.owner.agents.map(redact) }, peers: d.peers.map(p => ({ ...p, agents: p.agents.map(redact) })) };
    })
  );

  // Register/update how an agent can be reached live (endpoint_url + transport). Owner agents: handle = OWNER_HANDLE.
  r.post(
    "/agents",
    ...admin,
    wrap(async req => {
      const b = body(req);
      const handle = normaliseHandle(String(b.handle ?? store.snapshot.owner.handle));
      const name = String(b.agent ?? "").trim();
      if (!name) throw new RelayError(400, "agent (name) is required");
      if (b.endpoint_url != null && !/^https?:\/\//i.test(String(b.endpoint_url))) throw new RelayError(400, "endpoint_url must be http(s)");
      const record = await store.mutate(d => {
        const p = principalIn(d, handle, true)!;
        if (typeof b.allowlisted === "boolean" && p !== d.owner) p.allowlisted = b.allowlisted;
        let agent = p.agents.find(a => a.name === name);
        if (!agent) p.agents.push((agent = { name }));
        for (const key of ["endpoint_url", "transport", "token", "config"] as const) {
          if (!(key in b)) continue;
          if (b[key] === null) delete agent[key];
          else (agent as unknown as Record<string, unknown>)[key] = b[key];
        }
        p.connected_at ??= now();
        releaseParked(d, handle);
        return agent;
      });
      return { ok: true, handle, agent: redact(record) };
    })
  );

  r.delete(
    "/agents/:handle/:agent",
    ...admin,
    wrap(async req => {
      const handle = normaliseHandle(String(req.params.handle));
      const name = String(req.params.agent);
      const removed = await store.mutate(d => {
        const p = principalIn(d, handle);
        if (!p) return false;
        const before = p.agents.length;
        p.agents = p.agents.filter(a => a.name !== name);
        if (p !== d.owner && p.agents.length === 0) d.peers = d.peers.filter(x => x !== p);
        return p.agents.length !== before;
      });
      return { ok: removed };
    })
  );

  return r;
}
