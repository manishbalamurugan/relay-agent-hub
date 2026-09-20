/**
 * Static bearer token check. One token (RELAY_TOKEN) guards /mcp and the REST tool surface.
 * Optional per-agent tokens (RELAY_AGENT_TOKENS="muse:abc,codex:def") also pass and tell the hub
 * which of the owner's agents is calling, so `from.agent` can default correctly.
 */
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

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

export interface Caller {
  /** Owner's agent name this token is bound to, if any. */
  agent?: string;
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
  if (safeEqual(token, config.token)) return {};
  for (const [tok, name] of agentTokens) if (safeEqual(token, tok)) return { agent: name };
  return null;
}

export function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const caller = checkToken(extractToken(req));
  if (!caller) {
    res
      .status(401)
      .set("WWW-Authenticate", 'Bearer realm="relay"')
      .json({ status: 401, error: "missing or invalid bearer token", hint: "Send: Authorization: Bearer <RELAY_TOKEN>" });
    return;
  }
  (req as Request & { caller: Caller }).caller = caller;
  next();
}

/** The owner's agent a request is acting for: explicit header beats token binding. */
export function callerAgent(req: Request): string | undefined {
  const explicit = req.header("x-relay-agent")?.trim();
  if (explicit) return explicit;
  return (req as Request & { caller?: Caller }).caller?.agent;
}
