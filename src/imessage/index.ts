/**
 * Relay iMessage bridge — text your assistant from any phone.
 *
 *   you (iMessage) ──▶ Sendblue number ──▶ this bridge ──agent.send──▶ Relay ──▶ your Muse
 *   you (iMessage) ◀── Sendblue API    ◀── this bridge ◀──inbox.list── Relay ◀── inbox.reply
 *
 * The bridge is one of your agents (mint a key for "imessage" in /admin). It forwards texts from allow-listed
 * numbers to your front door as question.freeform, long-polls its own inbox, and texts every reply back.
 * Anything your assistant sends to @you/imessage unprompted is texted to you too, so it can reach you first.
 *
 * Works on Sendblue's free shared line: no webhooks needed (inbound is polled from GET /api/v2/messages) and
 * replies to a verified contact are allowed. Set SENDBLUE_WEBHOOK=true on a paid line to receive pushes instead.
 *
 * Env: RELAY_URL, RELAY_KEY, SENDBLUE_API_KEY, SENDBLUE_API_SECRET, SENDBLUE_NUMBER (the line you text),
 *      ALLOW_NUMBERS (comma-separated E.164; only these can talk to your assistant),
 *      SENDBLUE_POLL_S (default 2), SENDBLUE_WEBHOOK (default false), PORT (webhook mode), SENDBLUE_URL (tests).
 */
import { createServer } from "node:http";

type Json = Record<string, any>;
const env = (k: string, d = ""): string => (process.env[k] ?? d).trim();
const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[imessage]", ...a);
const fail = (m: string): never => (console.error(`[imessage] ${m}`), process.exit(1));

const HUB = env("RELAY_URL", "http://127.0.0.1:3000").replace(/\/+$/, "");
const KEY = env("RELAY_KEY") || fail("RELAY_KEY is required (mint a key for agent 'imessage' in /admin)");
const SB = env("SENDBLUE_URL", "https://api.sendblue.co").replace(/\/+$/, "");
const SB_KEY = env("SENDBLUE_API_KEY") || fail("SENDBLUE_API_KEY is required");
const SB_SECRET = env("SENDBLUE_API_SECRET") || fail("SENDBLUE_API_SECRET is required");
const LINE = env("SENDBLUE_NUMBER") || fail("SENDBLUE_NUMBER is required (the Sendblue number you text)");
const ALLOW = new Set(env("ALLOW_NUMBERS").split(",").map(s => s.replace(/[^+\d]/g, "")).filter(Boolean));
if (ALLOW.size === 0) fail("ALLOW_NUMBERS is required: only these numbers may talk to your assistant");
const POLL_S = Number(env("SENDBLUE_POLL_S", "2")) || 2;
const WEBHOOK = env("SENDBLUE_WEBHOOK") === "true";
const WAIT_S = 30;
const MAX_TEXT = 1500;

// ---- Relay ----------------------------------------------------------------------------------------

async function tool(name: string, body: Json): Promise<{ status: number; json: any }> {
  const r = await fetch(`${HUB}/tools/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((WAIT_S + 15) * 1000)
  });
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text) };
  } catch {
    return { status: r.status, json: { error: text.slice(0, 300) } };
  }
}

// ---- Sendblue ---------------------------------------------------------------------------------------

const sbHeaders = { "sb-api-key-id": SB_KEY, "sb-api-secret-key": SB_SECRET, "content-type": "application/json" };

async function sendText(number: string, content: string, replyTo?: string): Promise<void> {
  for (const chunk of chunks(content)) {
    const body: Json = { number, from_number: LINE, content: chunk };
    if (replyTo) body.reply_to = { message_handle: replyTo };
    const r = await fetch(`${SB}/api/send-message`, { method: "POST", headers: sbHeaders, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`sendblue send ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
}

function chunks(s: string): string[] {
  const out: string[] = [];
  let rest = s.trim();
  while (rest.length > MAX_TEXT) {
    const cut = Math.max(rest.lastIndexOf("\n", MAX_TEXT), rest.lastIndexOf(". ", MAX_TEXT), MAX_TEXT - 200);
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest) out.push(rest);
  return out;
}

/** Inbound message from Sendblue (webhook payload and /api/v2/messages rows share these fields). */
interface Inbound {
  message_handle: string;
  content: string;
  from_number: string;
  is_outbound?: boolean;
  date_sent?: string;
  created_at?: string;
}

async function pollSendblue(since: string): Promise<Inbound[]> {
  const q = new URLSearchParams({ is_outbound: "false", sendblue_number: LINE, created_at_gte: since, order_by: "createdAt", order_direction: "asc", limit: "50" });
  const r = await fetch(`${SB}/api/v2/messages?${q}`, { headers: sbHeaders, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`sendblue list ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j: any = await r.json();
  const rows: any[] = Array.isArray(j) ? j : j.messages ?? j.data ?? [];
  return rows.filter(m => m && m.is_outbound !== true && m.content);
}

// ---- bridge -----------------------------------------------------------------------------------------

let owner = "";
let me = "imessage";
const seen = new Set<string>(); // Sendblue message handles already forwarded
const threads = new Map<string, { number: string; handle: string }>(); // Relay envelope id → who asked

async function onInbound(m: Inbound): Promise<void> {
  if (!m.message_handle || seen.has(m.message_handle)) return;
  seen.add(m.message_handle);
  if (seen.size > 5000) seen.delete(seen.values().next().value!);
  const from = (m.from_number ?? "").replace(/[^+\d]/g, "");
  if (!ALLOW.has(from)) return log(`ignored text from ${from || "?"} (not in ALLOW_NUMBERS)`);
  const text = m.content.trim();
  if (!text) return;
  const { status, json } = await tool("agent.send", { to: owner, verb: "question.freeform", args: { question: text.slice(0, 4000) }, from_agent: me });
  if (status !== 200) return log(`agent.send → ${status} ${JSON.stringify(json).slice(0, 200)}`);
  threads.set(json.id, { number: from, handle: m.message_handle });
  log(`→ ${owner}: "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}" as ${json.id}`);
}

function textOf(m: any): string {
  const a = m.args ?? {};
  const body = a.answer ?? a.summary ?? a.detail ?? a.question ?? a.reason ?? (Object.keys(a).length ? JSON.stringify(a) : "");
  const links = Array.isArray(a.links) && a.links.length ? "\n" + a.links.join("\n") : "";
  return `${String(body)}${links}`.trim() || `(${m.verb} from ${m.from?.handle}/${m.from?.agent})`;
}

async function inboxLoop(): Promise<void> {
  let since = new Date().toISOString();
  const handled = new Set<string>();
  for (;;) {
    try {
      const { status, json } = await tool("inbox.list", { since, wait_s: WAIT_S, filter: { direction: "inbound", state: "all" } });
      if (status !== 200) throw new Error(`inbox.list → ${status} ${JSON.stringify(json).slice(0, 200)}`);
      for (const m of json.messages ?? []) {
        if (handled.has(m.id)) continue;
        handled.add(m.id);
        if (m.received_at > since) since = m.received_at;
        if (m.from?.handle !== owner) continue; // front-door policy already prevents this; belt and braces
        const thread = m.corr ? threads.get(m.corr) : undefined;
        const targets = thread ? [thread] : [...ALLOW].map(number => ({ number, handle: undefined }));
        for (const t of targets) await sendText(t.number, textOf(m), t.handle);
        if (m.corr) threads.delete(m.corr);
        log(`← ${m.from.handle}/${m.from.agent} ${m.verb}${m.corr ? " (reply)" : ""} → texted ${targets.map(t => t.number).join(",")}`);
      }
    } catch (err) {
      log(`inbox loop: ${(err as Error).message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

async function sendbluePollLoop(): Promise<void> {
  let since = new Date(Date.now() - 60_000).toISOString();
  for (;;) {
    try {
      const rows = await pollSendblue(since);
      for (const m of rows) {
        await onInbound(m);
        const ts = m.created_at ?? m.date_sent;
        if (ts && ts > since) since = ts;
      }
    } catch (err) {
      log(`sendblue poll: ${(err as Error).message}`);
    }
    await new Promise(r => setTimeout(r, POLL_S * 1000));
  }
}

function webhookServer(): void {
  const port = Number(env("PORT", "8787"));
  createServer((req, res) => {
    if (req.method === "GET") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, agent: `${owner}/${me}`, threads: threads.size }));
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      res.writeHead(200).end("ok"); // Sendblue retries until it gets a response; answer first, work after
      try {
        const m = JSON.parse(body);
        if (m && m.is_outbound === false && m.content) void onInbound(m).catch(err => log(`webhook: ${(err as Error).message}`));
      } catch {
        log("webhook: bad JSON");
      }
    });
  }).listen(port, () => log(`webhook listening on :${port} (set this URL as Sendblue's 'receive' webhook)`));
}

async function main(): Promise<void> {
  const { status, json } = await tool("identity.whoami", {}).catch(err => fail(`cannot reach hub ${HUB}: ${(err as Error).message}`));
  if (status !== 200) fail(`identity.whoami → ${status} ${JSON.stringify(json).slice(0, 200)}`);
  owner = json.owner;
  me = json.acting_as && json.acting_as !== "unknown" ? json.acting_as : "imessage";
  log(`online as ${owner}/${me}; texts from ${[...ALLOW].join(", ")} on ${LINE} go to ${owner}'s front door; mode=${WEBHOOK ? "webhook" : `poll every ${POLL_S}s`}`);
  void inboxLoop();
  if (WEBHOOK) webhookServer();
  else void sendbluePollLoop();
}

void main();
