import { randomBytes } from "node:crypto";


const generatedToken = process.env.RELAY_TOKEN ? null : randomBytes(24).toString("base64url").slice(0, 32);

export const config = {
  port: Number(process.env.PORT) || 3000,
  host: "0.0.0.0",
  token: process.env.RELAY_TOKEN || (generatedToken as string),
  tokenWasGenerated: generatedToken !== null,
  /**
   * Public base URL, e.g. https://relay.up.railway.app — no trailing slash.
   * Falls back to Railway's injected RAILWAY_PUBLIC_DOMAIN so /connect is right on the first deploy.
   */
  publicUrl: (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "")).replace(/\/+$/, ""),
  ownerHandle: ((h: string) => (h.startsWith("@") ? h : `@${h}`))((process.env.OWNER_HANDLE || "@owner").trim() || "@owner"),
  /** Agent the bare RELAY_TOKEN acts as when the caller does not say (store setting overrides). */
  ownerTokenAgent: process.env.RELAY_TOKEN_AGENT || "",
  ownerAgents: (process.env.OWNER_AGENTS || "muse")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean),
  dataFile: process.env.DATA_FILE || "./data/store.json",
  /** Optional webhook that receives a JSON summary whenever an urgent envelope is queued. */
  notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL || "",
  /** Shown on /invite so a peer can self-host their own hub. */
  repoUrl: process.env.REPO_URL || "https://github.com/manishbalamurugan/relay-agent-hub",
  askDefaultTimeoutS: 30,
  longPollMaxS: 55,
  askMaxTimeoutS: 60,
  noteMaxChars: 280,
  defaultTtlMs: 24 * 60 * 60 * 1000,
  /** Idle MCP sessions are dropped after this long without traffic. */
  sessionIdleMs: 6 * 60 * 60 * 1000
};

export function baseUrl(): string {
  return config.publicUrl || `http://localhost:${config.port}`;
}
