/**
 * Outbound transport: call a peer agent that exposes an MCP server over streamable HTTP.
 *
 * Claims any agent whose endpoint_url is http(s) and whose `transport` is unset or "mcp".
 * Protocol (documented in README "Receiving envelopes"):
 *   - opens a short-lived MCP session with `Authorization: Bearer <agent.token>` when a token is set
 *   - calls the tool named by agent.config.tool (default "relay.receive") with `{ envelope }`
 *     — or, when agent.config.mode === "flat", with the envelope's fields spread as top-level
 *     arguments (this is what another Relay hub's `agent.send` expects)
 *   - parses the first JSON text block of the result as the reply
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentRecord, Envelope, Transport, TransportReply } from "../types.js";

const DEFAULT_TOOL = "relay.receive";

function parseResult(result: unknown): TransportReply {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
  const structured = (result as { structuredContent?: unknown })?.structuredContent;
  const text = content.find(c => c.type === "text")?.text;
  let parsed: unknown = structured;
  if (parsed === undefined && text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { answer: text };
    }
  }
  if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    // A peer may return a full envelope, `{ envelope: {...} }`, `{ verb?, args, note? }`, or bare args.
    const looksLikeEnvelope = typeof p.verb === "string" || (p.args !== undefined && typeof p.args === "object");
    const env = (p.envelope as Record<string, unknown> | undefined) ?? (looksLikeEnvelope ? p : undefined);
    if (env) {
      const e = env as Record<string, unknown>;
      return { envelope: { ...e, note: (e.note ?? e.note_untrusted ?? null) as string | null } as TransportReply["envelope"], raw: parsed };
    }
    return { envelope: { args: p }, raw: parsed };
  }
  return { raw: parsed ?? text };
}

const mcpClientTransport: Transport = {
  name: "mcp",

  canHandle(agent: AgentRecord): boolean {
    if (!agent.endpoint_url || !/^https?:\/\//i.test(agent.endpoint_url)) return false;
    return !agent.transport || agent.transport === "mcp";
  },

  async send(agent: AgentRecord, envelope: Envelope, timeoutMs: number): Promise<TransportReply> {
    const headers: Record<string, string> = {};
    if (agent.token) headers.Authorization = `Bearer ${agent.token}`;
    const transport = new StreamableHTTPClientTransport(new URL(agent.endpoint_url!), { requestInit: { headers } });
    const client = new Client({ name: "relay-agent-hub", version: "0.1.0" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await client.connect(transport, { signal: controller.signal, timeout: timeoutMs });
      const tool = (agent.config?.tool as string | undefined) ?? DEFAULT_TOOL;
      const mode = (agent.config?.mode as string | undefined) ?? "envelope";
      const args =
        mode === "flat"
          ? { from: envelope.from, to: envelope.to, verb: envelope.verb, args: envelope.args, note: envelope.note_untrusted, corr: envelope.corr, kind: envelope.kind, expires: envelope.expires }
          : { envelope: { ...envelope, note: envelope.note_untrusted } };
      const result = await client.callTool({ name: tool, arguments: args }, undefined, { signal: controller.signal, timeout: timeoutMs });
      if ((result as { isError?: boolean }).isError) {
        const text = ((result as { content?: Array<{ text?: string }> }).content ?? []).map(c => c.text).join("\n");
        throw new Error(`peer tool '${tool}' returned an error: ${text.slice(0, 500)}`);
      }
      return parseResult(result);
    } finally {
      clearTimeout(timer);
      await client.close().catch(() => undefined);
    }
  }
};

export default mcpClientTransport;
