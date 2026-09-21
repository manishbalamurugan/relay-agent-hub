/**
 * Bearer auth. Three kinds of token, all presented as `Authorization: Bearer <token>`:
 *   - RELAY_TOKEN                      → the hub owner, admin (can mint invites, register endpoints)
 *   - RELAY_AGENT_TOKENS=muse:tok,...  → the owner, bound to one named agent
 *   - invite tokens (minted at runtime, stored hashed) → a peer principal (@friend), scoped to their own inbox
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { store } from "./store.js";

const agentTokens = new Map<string, string>(); // token -> agent name
for (const pair of (process.env.RELAY_AGENT_TOKENS || "").split(",")) {
  const [name, tok] = pair.split(":").map(s => s?.trim());
  if (name && tok) agentTokens.set(tok, name);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface Caller {
  /** Principal this token acts for. */
  handle: string;
  /** Agent name this token is bound to, if any. */
  agent?: string;
  /** True for RELAY_TOKEN / RELAY_AGENT_TOKENS holders. */
  admin: boolean;
}

export function extractToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (header) {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) return m[1].trim();
  }
  // Courtesy for connector UIs that only offer an API-key header field.
  const apiKey = req.header("x-api-key");
  if (apiKey) return apiKey.trim();
  return undefined;
}

export function checkToken(token: string | undefined): Caller | null {
  if (!token) return null;
  const owner = store.snapshot.owner.handle;
  if (safeEqual(token, config.token)) return { handle: owner, admin: true };
  for (const [tok, name] of agentTokens) if (safeEqual(token, tok)) return { handle: owner, agent: name, admin: true };
  const rec = store.snapshot.tokens[hashToken(token)];
  if (rec && !rec.revoked_at && rec.handle) return { handle: rec.handle, agent: rec.agent, admin: false };
  return null;
}

export function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const caller = checkToken(extractToken(req));
  if (!caller) {
    res
      .status(401)
      .set("WWW-Authenticate", 'Bearer realm="relay"')
      .json({ status: 401, error: "missing or invalid bearer token", hint: "Send: Authorization: Bearer <token>" });
    return;
  }
  (req as Request & { caller: Caller }).caller = caller;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const caller = (req as Request & { caller?: Caller }).caller;
  if (!caller?.admin) {
    res.status(403).json({ status: 403, error: "admin token required (RELAY_TOKEN)" });
    return;
  }
  next();
}

export function getCaller(req: Request): Caller {
  return (req as Request & { caller: Caller }).caller;
}

/** The agent a request is acting for: explicit header beats token binding. */
export function callerAgent(req: Request): string | undefined {
  const explicit = req.header("x-relay-agent")?.trim();
  if (explicit) return explicit;
  return getCaller(req).agent;
}
