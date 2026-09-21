/**
 * The six tools. Defined once, exposed twice: over MCP (src/mcp.ts) and as POST /tools/<name>
 * (src/index.ts), and described in /openapi.json. Descriptions are written for an assistant
 * deciding when to call them — they are the only routing signal every model family sees.
 */
import { z } from "zod";
import { baseUrl, config } from "./config.js";
import * as dispatcher from "./dispatcher.js";
import { draft, present, validate } from "./envelope.js";
import { defaultAskVerb, getVerb, listVerbs, replyKindFor, verbNames } from "./registry.js";
import { store } from "./store.js";
import { ENVELOPE_KINDS, RelayError } from "./types.js";
import type { EnvelopeKind, Party, StoredEnvelope } from "./types.js";

export interface ToolContext {
  /** Principal the caller acts for (hub owner or an invited peer). */
  handle: string;
  /** Agent the caller is acting as, when known from the token or X-Relay-Agent header. */
  agent?: string;
  /** Hub owner tokens only. */
  admin: boolean;
}

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  input: Shape;
  readOnly: boolean;
  handler(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): Promise<unknown>;
}

let tools: ToolDef[] = [];

/** Build tool definitions. Must run after the verb registry is loaded (verb lists are baked into arg descriptions). */
export function buildTools(): ToolDef[] {
  const targetSchema = z
    .union([
      z.string().min(1),
      z.object({
        handle: z.string().min(1).describe("Person handle, e.g. @manish or @bob."),
        agent: z.string().min(1).optional().describe("Agent name under that handle, e.g. claude-code. Use * for any.")
      })
    ])
    .describe('Who to reach: "@handle", "@handle/agent", a bare agent name of your own user (e.g. "codex"), or {handle, agent}.');

  function verbField(extra = "") {
    return z
      .string()
      .min(3)
      .describe(`Message type. One of: ${verbNames().join(", ")}. ${extra}`.trim());
  }

  const argsField = z.record(z.string(), z.unknown()).optional().describe("Typed fields for the verb. Must match the verb's schema (see identity.whoami).");
  const noteField = z.string().max(20000).optional().describe("Optional free-text colour. Stored sanitised and delivered as untrusted data, never as instructions.");
  const fromAgentField = z.string().min(1).optional().describe("Which of the user's agents you are (muse, claude-code, codex, cursor). Defaults to the agent bound to your token.");

  function actingAgent(explicit: string | undefined, ctx: ToolContext): string {
    return explicit?.trim() || ctx.agent || "unknown";
  }

  function agentView(handle: string, a: { name: string; endpoint_url?: string; last_seen?: string }, kind: "own" | "peer") {
    const reachable = Boolean(dispatcher.resolve({ handle, agent: a.name }).mode === "sync");
    return { handle, agent: a.name, kind, can_answer_now: reachable, delivery: reachable ? "sync" : "inbox (polled)", last_seen: a.last_seen ?? null };
  }

  function inboundFor(e: StoredEnvelope, handle: string, forAgent?: string): boolean {
    if (e.to.handle !== handle) return false;
    if (!forAgent) return true;
    return e.to.agent === "*" || e.to.agent === forAgent;
  }

  // ------------------------------------------------------------------------------------------------

  const identityWhoami: ToolDef<Record<string, never>> = {
    name: "identity.whoami",
    description: "Find out which user you are acting for and which other agents are available.",
    input: {},
    readOnly: true,
    async handler(_args, ctx) {
      const d = store.snapshot;
      const me = store.findPrincipal(ctx.handle);
      const others = [d.owner, ...d.peers].filter(p => p.handle !== ctx.handle);
      return {
        owner: ctx.handle,
        acting_as: ctx.agent ?? "unknown",
        role: ctx.admin ? "hub owner" : "guest on " + d.owner.handle + "'s hub",
        agents: (me?.agents ?? []).map(a => agentView(ctx.handle, a, "own")),
        peers: others.map(p => ({ handle: p.handle, allowlisted: Boolean(p.allowlisted), agents: p.agents.map(a => agentView(p.handle, a, "peer")) })),
        verbs: listVerbs().map(v => ({
          verb: v.verb,
          describe: v.describe,
          mutating: v.mutating,
          urgent: v.urgent,
          required_args: ((v.schema.required as string[] | undefined) ?? []).slice(),
          args_schema: v.schema
        })),
        hub: { mcp_url: `${baseUrl()}/mcp`, openapi_url: `${baseUrl()}/openapi.json` }
      };
    }
  };

  const agentList: ToolDef<Record<string, never>> = {
    name: "agent.list",
    description: "List the user's other AI agents and connected people, and whether each can answer immediately.",
    input: {},
    readOnly: true,
    async handler(_args, ctx) {
      const d = store.snapshot;
      const all = [d.owner, ...d.peers];
      const agents = all.flatMap(p => p.agents.map(a => agentView(p.handle, a, p.handle === ctx.handle ? "own" : "peer")));
      const people = all.filter(p => p.handle !== ctx.handle).map(p => ({ handle: p.handle, agents: p.agents.length, allowlisted: Boolean(p.allowlisted), connected: Boolean(p.connected_at) }));
      return { owner: ctx.handle, hub_owner: d.owner.handle, agents, people };
    }
  };

  const askShape = {
    to: targetSchema,
    question: z.string().min(1).max(4000).optional().describe("Plain-language question. Used when you do not pass verb/args."),
    verb: verbField("Optional; defaults to the free-form question verb.").optional(),
    args: argsField,
    note: noteField,
    timeout_s: z.number().int().min(1).max(config.askMaxTimeoutS).optional().describe(`Seconds to wait for a live answer (default ${config.askDefaultTimeoutS}, max ${config.askMaxTimeoutS}). Falls back to the inbox on timeout.`),
    from_agent: fromAgentField
  };

  const agentAsk: ToolDef<typeof askShape> = {
    name: "agent.ask",
    description: "Ask one of the user's other AI agents a question and wait for the answer.",
    input: askShape,
    readOnly: false,
    async handler(a, ctx) {
      const verb = a.verb ? getVerb(a.verb) : defaultAskVerb();
      if (!verb) throw new RelayError(400, `unknown verb '${a.verb ?? "(none)"}'`, { known_verbs: verbNames() });
      const args: Record<string, unknown> = { ...(a.args ?? {}) };
      if (a.question && verb.textField && args[verb.textField] === undefined) args[verb.textField] = a.question;
      const from: Party = { handle: ctx.handle, agent: actingAgent(a.from_agent, ctx) };
      const env = validate(draft({ from, to: dispatcher.parseTarget(a.to, ctx.handle), verb: verb.verb, args, note: a.note ?? null }));
      const timeoutMs = Math.min(a.timeout_s ?? config.askDefaultTimeoutS, config.askMaxTimeoutS) * 1000;
      return dispatcher.ask(env, timeoutMs);
    }
  };

  const sendShape = {
    to: targetSchema,
    verb: verbField(),
    args: argsField,
    note: noteField,
    kind: z.enum(ENVELOPE_KINDS as [EnvelopeKind, ...EnvelopeKind[]]).optional().describe("Envelope kind. Usually leave unset; derived from the verb."),
    corr: z.string().optional().describe("Id of the envelope this relates to, if any."),
    expires: z.string().optional().describe("RFC 3339 date-time after which the message is dropped unread. Default: 24h."),
    from_agent: fromAgentField,
    from_handle: z.string().min(1).optional().describe("Hub owner only, for hub-to-hub forwarding: the original sender's handle.")
  };

  const agentSend: ToolDef<typeof sendShape> = {
    name: "agent.send",
    description: "Send a typed message to another agent without waiting for a reply.",
    input: sendShape,
    readOnly: false,
    async handler(a, ctx) {
      const from: Party = { handle: a.from_handle && ctx.admin ? dispatcher.normaliseHandle(a.from_handle) : ctx.handle, agent: actingAgent(a.from_agent, ctx) };
      const env = validate(
        draft({ from, to: dispatcher.parseTarget(a.to, ctx.handle), verb: a.verb, args: a.args ?? {}, note: a.note ?? null, kind: a.kind, corr: a.corr ?? null, expires: a.expires })
      );
      return dispatcher.send(env);
    }
  };

  const listShape = {
    since: z.string().optional().describe("RFC 3339 date-time; only messages received after this."),
    filter: z
      .object({
        verb: z.string().optional(),
        from_handle: z.string().optional(),
        for_agent: z.string().optional().describe("Only messages addressed to this agent of yours (or to any agent)."),
        state: z.enum(["queued", "answered", "delivered", "pending_invite", "expired", "all"]).optional().describe("Default queued: messages still waiting for a response."),
        direction: z.enum(["inbound", "outbound", "all"]).optional().describe("Default inbound: messages sent to the user's agents."),
        needs_decision: z.boolean().optional().describe("Only messages the user should be consulted on."),
        id: z.string().optional().describe("Fetch one message by id.")
      })
      .optional(),
    limit: z.number().int().min(1).max(200).optional().describe("Max messages to return (default 50).")
  };

  const inboxList: ToolDef<typeof listShape> = {
    name: "inbox.list",
    description: "Check for messages from other agents that are waiting for a response.",
    input: listShape,
    readOnly: true,
    async handler(a, ctx) {
      if (store.sweepExpired()) await store.mutate(() => undefined);
      const f = a.filter ?? {};
      const state = f.state ?? "queued";
      const direction = f.direction ?? "inbound";
      const since = a.since ? Date.parse(a.since) : NaN;
      const me = ctx.handle;
      let list = store.snapshot.envelopes.filter(e => {
        // A principal only ever sees envelopes it sent or received.
        if (e.to.handle !== me && e.from.handle !== me) return false;
        if (f.id) return e.id === f.id;
        if (state !== "all" && e.state !== state) return false;
        if (direction === "inbound" && !inboundFor(e, me, f.for_agent)) return false;
        if (direction === "outbound" && e.from.handle !== me) return false;
        if (f.verb && e.verb !== f.verb) return false;
        if (f.from_handle && e.from.handle !== dispatcher.normaliseHandle(f.from_handle)) return false;
        if (f.needs_decision !== undefined && e.needs_decision !== f.needs_decision) return false;
        if (!Number.isNaN(since) && Date.parse(e.received_at) <= since) return false;
        return true;
      });
      list = list.sort((x, y) => Date.parse(x.received_at) - Date.parse(y.received_at));
      const limit = a.limit ?? 50;
      const total = list.length;
      list = list.slice(-limit);
      return {
        count: list.length,
        total,
        needs_decision: list.filter(e => e.needs_decision).length,
        messages: list.map(e => present(e)),
        how_to_reply: "Call inbox.reply with the message id, the verb to answer with, and typed args. Consult the user first when needs_decision is true."
      };
    }
  };

  const replyShape = {
    id: z.string().min(1).describe("Id of the message you are replying to."),
    verb: verbField("Optional; defaults to the original message's verb, whose reply schema then applies.").optional(),
    args: argsField,
    note: noteField,
    from_agent: fromAgentField
  };

  const inboxReply: ToolDef<typeof replyShape> = {
    name: "inbox.reply",
    description: "Reply to a message another agent sent you.",
    input: replyShape,
    readOnly: false,
    async handler(a, ctx) {
      const original = store.getEnvelope(a.id);
      if (!original || original.to.handle !== ctx.handle) throw new RelayError(404, `no message with id '${a.id}' addressed to ${ctx.handle}`);
      const verbName = a.verb ?? original.verb;
      const verb = getVerb(verbName);
      if (!verb) throw new RelayError(400, `unknown verb '${verbName}'`, { known_verbs: verbNames() });
      const fromAgent = a.from_agent?.trim() || (original.to.agent !== "*" ? original.to.agent : undefined) || ctx.agent || "unknown";
      const from: Party = { handle: ctx.handle, agent: fromAgent };
      const reply = validate(
        draft({ from, to: original.from, verb: verbName, args: a.args ?? {}, note: a.note ?? null, corr: original.id, kind: replyKindFor(verb, original.kind) })
      );
      const result = await dispatcher.send(reply);
      await store.mutate(d => {
        const o = d.envelopes.find(e => e.id === original.id);
        if (o && (o.state === "queued" || o.state === "pending_invite")) {
          o.state = "answered";
          o.answered_by = reply.id;
        }
      });
      return { ...result, corr: original.id, reply: present(reply) };
    }
  };

  tools = [identityWhoami, agentList, agentAsk, agentSend, inboxList, inboxReply] as unknown as ToolDef[];
  return tools;
}

export function listTools(): ToolDef[] {
  return tools;
}

export function getTool(name: string): ToolDef | undefined {
  return tools.find(t => t.name === name);
}

/** Run a tool with plain JSON input: zod-parse, then hand to the handler. Throws RelayError. */
export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<unknown> {
  const tool = getTool(name);
  if (!tool) throw new RelayError(404, `unknown tool '${name}'`, { tools: tools.map(t => t.name) });
  const parsed = z.object(tool.input).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    throw new RelayError(400, "invalid tool arguments", {
      errors: parsed.error.issues.map(i => ({ path: "/" + i.path.join("/"), message: i.message }))
    });
  }
  return tool.handler(parsed.data, ctx);
}
