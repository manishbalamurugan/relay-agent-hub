/** Standalone entry: `npm run imessage`. Needs RELAY_URL, RELAY_KEY (agent "imessage" key) and SENDBLUE_* env. */
import { bridgeOptionsFromEnv, startBridge } from "./index.js";

const env = (k: string, d = ""): string => (process.env[k] ?? d).trim();
const hub = env("RELAY_URL", "http://127.0.0.1:3000").replace(/\/+$/, "");
const key = env("RELAY_KEY");
if (!key) {
  console.error("[imessage] RELAY_KEY is required (mint a key for agent 'imessage' in /admin)");
  process.exit(1);
}
const opts = bridgeOptionsFromEnv(hub, key);
if (!opts) {
  console.error("[imessage] SENDBLUE_API_KEY, SENDBLUE_API_SECRET, SENDBLUE_NUMBER and ALLOW_NUMBERS are required");
  process.exit(1);
}
startBridge(opts).catch(err => {
  console.error(`[imessage] ${(err as Error).message}`);
  process.exit(1);
});
