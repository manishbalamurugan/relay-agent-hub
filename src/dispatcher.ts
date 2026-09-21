/**
 * Target resolution and delivery.
 *
 *   resolve(target):
 *     agent has endpoint_url and a transport claims it      → SYNC   (call, answer inline)
 *     known principal, nothing reachable                    → ASYNC  (queue, eta ~15m)
 *     unknown                                               → not_connected + invite_url
 */
import { EventEmitter } from "node:events";
import { baseUrl, config } from "./config.js";
import { draft, present, validate } from "./envelope.js";
import { getVerb, replyKindFor } from "./registry.js";
import { store } from "./store.js";
import { transportFor } from "./transports/index.js";
import { RelayError } from "./types.js";
import type { AgentRecord, Envelope, Party, Principal, StoredEnvelope, Transport } from "./types.js";

export type Resolution =
  | { mode: "sync"; principal: Principal; agent: AgentRecord; transport: Transport }
  | { mode: "async"; principal: Principal; agent?: AgentRecord }
  | { mode: "unknown"; invite_url: string };

/** Fires "envelope" with the StoredEnvelope every time one is persisted. Long-pollers and MCP push subscribe here. */
export const inboxEvents = new EventEmitter();
inboxEvents.setMaxListeners(1000);

export const ASYNC_ETA = "when the recipient next checks its inbox (instant if it is long-polling)";

/** Resolve with the first persisted envelope matching `pred`, or undefined after `ms`. */
export function waitForEnvelope(pred: (e: StoredEnvelope) => boolean, ms: number): Promise<StoredEnvelope | undefined> {
  return new Promise(resolve => {
    const onEnv = (e: StoredEnvelope) => {
      if (!pred(e)) return;
      cleanup();
      resolve(e);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, ms);
    const cleanup = () => {
      clearTimeout(timer);
      inboxEvents.off("envelope", onEnv);
    };
    inboxEvents.on("envelope", onEnv);
  });
}

export function inviteUrl(handle: string): string {
  return `${baseUrl()}/invite?h=${encodeURIComponent(handle)}`;
}

export function resolve(to: Party): Resolution {
  const principal = store.findPrincipal(to.handle);
  if (!principal) return { mode: "unknown", invite_url: inviteUrl(to.handle) };
  const agent = store.findAgent(to.handle, to.agent);
  const transport = transportFor(agent);
  if (agent && transport) return { mode: "sync", principal, agent, transport };
  return { mode: "async", principal, agent };
}

/** Accept `"@bob"`, `"@bob/muse"`, `"claude-code"` (one of the owner's agents) or `{handle, agent}`. */
export function parseTarget(input: unknown, fallbackHandle = config.ownerHandle): Party {
  if (input && typeof input === "object") {
    const o = input as Partial<Party>;
    if (typeof o.handle !== "string" || !o.handle.trim()) throw new RelayError(400, "target needs a handle", { field: "to" });
    return { handle: normaliseHandle(o.handle), agent: (o.agent ?? "*").trim() || "*" };
  }
  if (typeof input !== "string" || !input.trim()) throw new RelayError(400, "target must be a string or {handle, agent}", { field: "to" });
  const s = input.trim();
  const [head, ...rest] = s.split(/[/:]/);
  const agentPart = rest.join("/").trim();
  if (head.startsWith("@")) return { handle: normaliseHandle(head), agent: agentPart || "*" };
  // Bare name: one of the owner's agents ("codex"), else treat as a handle ("bob").
  const own = store.findPrincipal(fallbackHandle)?.agents.find(a => a.name.toLowerCase() === head.toLowerCase());
  if (own) return { handle: fallbackHandle, agent: own.name };
  return { handle: normaliseHandle(head), agent: agentPart || "*" };
}

export function normaliseHandle(h: string): string {
  const t = h.trim();
  return t.startsWith("@") ? t : `@${t}`;
}

function needsDecision(env: Envelope): boolean {
  const verb = getVerb(env.verb);
  if (verb?.mutating) return true;
  if (env.from.handle === store.snapshot.owner.handle) return false;
  const peer = store.findPrincipal(env.from.handle);
  return !peer?.allowlisted;
}

async function persist(env: Envelope, state: StoredEnvelope["state"]): Promise<StoredEnvelope> {
  const stored: StoredEnvelope = { ...env, state, received_at: new Date().toISOString(), needs_decision: needsDecision(env) };
  await store.mutate(d => {
    d.envelopes.push(stored);
    // Keep the file bounded: drop the oldest terminal envelopes past 5000.
    if (d.envelopes.length > 5000) {
      const terminal = new Set(["answered", "delivered", "expired"]);
      let i = 0;
      while (d.envelopes.length > 5000 && i < d.envelopes.length) {
        if (terminal.has(d.envelopes[i].state)) d.envelopes.splice(i, 1);
        else i++;
      }
    }
  });
  void notifyIfUrgent(stored);
  inboxEvents.emit("envelope", stored);
  return stored;
}

async function notifyIfUrgent(env: StoredEnvelope): Promise<void> {
  const verb = getVerb(env.verb);
  if (!verb?.urgent || !config.notifyWebhookUrl) return;
  try {
    await fetch(config.notifyWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `[Relay] urgent ${env.verb} from ${env.from.handle}/${env.from.agent} to ${env.to.handle}/${env.to.agent} (id ${env.id})`,
        envelope: present(env)
      }),
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) {
    console.warn(`[notify] webhook failed: ${(err as Error).message}`);
  }
}

/** Turn a peer's transport reply into a validated reply envelope, or throw RelayError. */
function buildReply(original: Envelope, target: Party, reply: { verb?: string; args?: Record<string, unknown>; note?: string | null } | undefined): Envelope {
  const verbName = reply?.verb ?? original.verb;
  const verb = getVerb(verbName);
  if (!verb) throw new RelayError(502, `peer replied with unknown verb '${verbName}'`);
  const raw = draft({
    from: target,
    to: original.from,
    verb: verbName,
    args: reply?.args ?? {},
    note: reply?.note ?? null,
    corr: original.id,
    kind: replyKindFor(verb, original.kind)
  });
  return validate(raw);
}

export interface AskResult {
  status: "answered" | "queued" | "not_connected";
  id: string;
  reply?: ReturnType<typeof present>;
  eta?: string;
  invite_url?: string;
  reason?: string;
}

/** Synchronous ask: try the transport, fall back to the queue. */
export async function ask(env: Envelope, timeoutMs: number): Promise<AskResult> {
  const res = resolve(env.to);
  if (res.mode === "unknown") {
    await persist(env, "pending_invite");
    return { status: "not_connected", id: env.id, invite_url: res.invite_url };
  }
  if (res.mode === "async") {
    await persist(env, "queued");
    // Hold the caller open: if the recipient is long-polling, its reply arrives within seconds.
    const reply = await waitForEnvelope(e => e.corr === env.id && e.from.handle === env.to.handle, timeoutMs);
    if (reply) {
      await store.mutate(d => {
        const r = d.envelopes.find(x => x.id === reply.id);
        if (r && r.state === "queued") r.state = "delivered"; // returned inline; don't leave it pending in the inbox
      });
      return { status: "answered", id: env.id, reply: present({ ...reply, state: "delivered" }) };
    }
    return { status: "queued", id: env.id, eta: ASYNC_ETA, reason: "recipient has not answered yet; the reply will appear in your inbox" };
  }
  const target: Party = { handle: res.principal.handle, agent: res.agent.name };
  try {
    const transportReply = await res.transport.send(res.agent, env, timeoutMs);
    const reply = buildReply(env, target, transportReply.envelope);
    const stored = await persist(env, "answered");
    await persist(reply, "delivered");
    await store.mutate(d => {
      const a = d.owner.handle === target.handle ? d.owner.agents : d.peers.find(p => p.handle === target.handle)?.agents;
      const rec = a?.find(x => x.name === target.agent);
      if (rec) rec.last_seen = new Date().toISOString();
      const o = d.envelopes.find(e => e.id === stored.id);
      if (o) o.answered_by = reply.id;
    });
    return { status: "answered", id: env.id, reply: present(reply) };
  } catch (err) {
    const reason = err instanceof RelayError ? `${err.message} ${JSON.stringify(err.details)}` : (err as Error).message;
    console.warn(`[dispatch] sync ask to ${target.handle}/${target.agent} failed, queueing: ${reason}`);
    await persist(env, "queued");
    return { status: "queued", id: env.id, eta: ASYNC_ETA, reason: `peer did not answer in time (${reason.slice(0, 200)})` };
  }
}

export interface SendResult {
  status: "queued" | "not_connected";
  id: string;
  eta?: string;
  invite_url?: string;
  delivering?: boolean;
}

/** Fire-and-forget send: always queued; pushed in the background when a transport can reach the target. */
export async function send(env: Envelope): Promise<SendResult> {
  const res = resolve(env.to);
  if (res.mode === "unknown") {
    await persist(env, "pending_invite");
    return { status: "not_connected", id: env.id, invite_url: res.invite_url };
  }
  await persist(env, "queued");
  if (res.mode === "sync") {
    void deliverInBackground(env, res);
    return { status: "queued", id: env.id, eta: "now", delivering: true };
  }
  return { status: "queued", id: env.id, eta: ASYNC_ETA };
}

async function deliverInBackground(env: Envelope, res: Extract<Resolution, { mode: "sync" }>): Promise<void> {
  const target: Party = { handle: res.principal.handle, agent: res.agent.name };
  try {
    const transportReply = await res.transport.send(res.agent, env, config.askDefaultTimeoutS * 1000);
    await store.mutate(d => {
      const e = d.envelopes.find(x => x.id === env.id);
      if (e && e.state === "queued") e.state = "delivered";
    });
    // If the peer answered inline, park the answer in the sender's inbox.
    if (transportReply.envelope && (transportReply.envelope.args || transportReply.envelope.verb)) {
      try {
        const reply = buildReply(env, target, transportReply.envelope);
        await persist(reply, "queued");
        await store.mutate(d => {
          const e = d.envelopes.find(x => x.id === env.id);
          if (e) {
            e.state = "answered";
            e.answered_by = reply.id;
          }
        });
      } catch (err) {
        console.warn(`[dispatch] discarded invalid inline reply from ${target.handle}/${target.agent}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.warn(`[dispatch] background delivery to ${target.handle}/${target.agent} failed; left queued: ${(err as Error).message}`);
  }
}
