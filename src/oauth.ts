/**
 * Minimal OAuth 2.1 authorization server so OAuth-only MCP clients (Claude mobile, some connector UIs)
 * can "sign in". There are no user accounts: the consent page asks for an existing Relay key, and the
 * access token issued is that same key. PKCE (S256) is required; clients are public (no secret).
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
 *   GET  /.well-known/oauth-authorization-server        RFC 8414
 *   POST /register                                       RFC 7591 (dynamic client registration)
 *   GET  /authorize      → paste-your-key page
 *   POST /authorize      → validates key, redirects with code
 *   POST /token          → authorization_code (PKCE) | refresh_token
 */
import { createHash, randomBytes } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { checkToken } from "./auth.js";
import { baseUrl } from "./config.js";
import { escapeHtml as esc, page } from "./http.js";

const FIELDS = ["client_id", "redirect_uri", "code_challenge", "state", "scope"] as const;

/** The paste-your-key consent page, carrying the authorization request through as hidden fields. */
async function authorizePage(fields: Record<string, string | undefined>, client: string, error: string): Promise<string> {
  const hidden = FIELDS.map(k => `<input type="hidden" name="${k}" value="${esc(fields[k] ?? "")}">`).join("\n");
  return (await page("authorize.html", { CLIENT: client, BASE_URL: baseUrl(), ERROR: error })).replaceAll("{{HIDDEN}}", hidden);
}

interface PendingCode {
  token: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  expires: number;
}
const codes = new Map<string, PendingCode>();
const clients = new Map<string, { redirect_uris: string[]; name?: string }>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of codes) if (v.expires < now) codes.delete(k);
}, 60_000).unref();

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function safeRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

export function oauthRouter(): Router {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));

  const resourceMeta = (_req: Request, res: Response) =>
    res.json({
      resource: `${baseUrl()}/mcp`,
      authorization_servers: [baseUrl()],
      bearer_methods_supported: ["header"],
      scopes_supported: ["relay"],
      resource_name: "Relay agent hub"
    });
  r.get("/.well-known/oauth-protected-resource", resourceMeta);
  r.get("/.well-known/oauth-protected-resource/mcp", resourceMeta);

  const serverMeta = (_req: Request, res: Response) =>
    res.json({
      issuer: baseUrl(),
      authorization_endpoint: `${baseUrl()}/authorize`,
      token_endpoint: `${baseUrl()}/token`,
      registration_endpoint: `${baseUrl()}/register`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["relay"]
    });
  r.get("/.well-known/oauth-authorization-server", serverMeta);
  r.get("/.well-known/oauth-authorization-server/mcp", serverMeta);
  r.get("/.well-known/openid-configuration", serverMeta);

  r.post("/register", (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const uris = Array.isArray(b.redirect_uris) ? (b.redirect_uris as unknown[]).map(String).filter(safeRedirect) : [];
    if (!uris.length) {
      res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris must contain https (or localhost) URLs" });
      return;
    }
    const client_id = `rc_${b64url(randomBytes(12))}`;
    clients.set(client_id, { redirect_uris: uris, name: typeof b.client_name === "string" ? b.client_name : undefined });
    res.status(201).json({
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: b.client_name ?? "MCP client"
    });
  });

  r.get("/authorize", async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const redirect_uri = q.redirect_uri ?? "";
    const problems: string[] = [];
    if (q.response_type !== "code") problems.push("response_type must be code");
    if (!q.client_id) problems.push("client_id missing");
    if (!safeRedirect(redirect_uri)) problems.push("redirect_uri must be https or localhost");
    if (!q.code_challenge || (q.code_challenge_method ?? "S256") !== "S256") problems.push("PKCE S256 code_challenge required");
    const known = q.client_id ? clients.get(q.client_id) : undefined;
    if (known && !known.redirect_uris.includes(redirect_uri)) problems.push("redirect_uri not registered for this client");
    if (problems.length) {
      res.status(400).type("html").send(`<h1>Relay sign-in</h1><p>Bad authorization request:</p><ul>${problems.map(p => `<li>${esc(p)}</li>`).join("")}</ul>`);
      return;
    }
    const client = known?.name ?? new URL(redirect_uri).hostname;
    res.type("html").send(await authorizePage({ ...q, redirect_uri, scope: q.scope ?? "relay" }, client, ""));
  });

  r.post("/authorize", async (req, res) => {
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    const redirect_uri = b.redirect_uri ?? "";
    if (!safeRedirect(redirect_uri) || !b.client_id || !b.code_challenge) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const key = (b.relay_key ?? "").trim().replace(/^bearer\s+/i, "");
    const caller = checkToken(key);
    if (!caller) {
      res.status(401).type("html").send(await authorizePage(b, clients.get(b.client_id)?.name ?? "the client", "That key was not recognised. Check for typos or ask the hub owner for a new one."));
      return;
    }
    const code = `ac_${b64url(randomBytes(24))}`;
    codes.set(code, { token: key, client_id: b.client_id, redirect_uri, code_challenge: b.code_challenge, expires: Date.now() + 10 * 60_000 });
    const u = new URL(redirect_uri);
    u.searchParams.set("code", code);
    if (b.state) u.searchParams.set("state", b.state);
    res.redirect(302, u.toString());
  });

  r.post("/token", (req, res) => {
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    res.setHeader("Cache-Control", "no-store");
    if (b.grant_type === "refresh_token") {
      const caller = checkToken(b.refresh_token);
      if (!caller) {
        res.status(400).json({ error: "invalid_grant", error_description: "refresh token revoked or unknown" });
        return;
      }
      res.json({ access_token: b.refresh_token, token_type: "bearer", refresh_token: b.refresh_token, scope: "relay" });
      return;
    }
    if (b.grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }
    const pending = b.code ? codes.get(b.code) : undefined;
    if (!pending || pending.expires < Date.now()) {
      res.status(400).json({ error: "invalid_grant", error_description: "code unknown or expired" });
      return;
    }
    codes.delete(b.code!);
    if (b.client_id && b.client_id !== pending.client_id) {
      res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });
      return;
    }
    if (b.redirect_uri && b.redirect_uri !== pending.redirect_uri) {
      res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
      return;
    }
    const verifier = b.code_verifier ?? "";
    if (!verifier || b64url(createHash("sha256").update(verifier).digest()) !== pending.code_challenge) {
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }
    if (!checkToken(pending.token)) {
      res.status(400).json({ error: "invalid_grant", error_description: "key revoked" });
      return;
    }
    res.json({ access_token: pending.token, token_type: "bearer", refresh_token: pending.token, scope: "relay" });
  });

  return r;
}
