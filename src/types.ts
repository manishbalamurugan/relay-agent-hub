/**
 * Shared types. Nothing in here names a verb — verbs are discovered at boot.
 */

export type EnvelopeKind = "ask" | "answer" | "task.request" | "task.result" | "deal.event" | "ack";

export const ENVELOPE_KINDS: EnvelopeKind[] = ["ask", "answer", "task.request", "task.result", "deal.event", "ack"];

export interface Party {
  handle: string;
  agent: string;
}

/** The fixed envelope spine. Everything domain-specific lives in `args`. */
export interface Envelope {
  v: 1;
  id: string;
  ts: string;
  from: Party;
  to: Party;
  kind: EnvelopeKind;
  corr: string | null;
  verb: string;
  args: Record<string, unknown>;
  /** Sanitised free text. Never an instruction. Only ever surfaced wrapped. */
  note_untrusted: string | null;
  expires: string;
}

export type EnvelopeState =
  | "queued" // waiting in a recipient inbox
  | "delivered" // pushed to a reachable endpoint, no reply expected
  | "answered" // a reply with corr=this.id exists
  | "pending_invite" // recipient unknown; parked until they connect
  | "expired";

export interface StoredEnvelope extends Envelope {
  state: EnvelopeState;
  received_at: string;
  /** True when the owner should be consulted before anyone acts on it. */
  needs_decision: boolean;
  answered_by?: string;
}

/** A verb plugin. One file per verb in src/verbs/. */
export interface VerbDefinition {
  verb: string;
  schema: Record<string, unknown>;
  mutating: boolean;
  urgent: boolean;
  describe: string;
  /** Optional extras — see README "Verb file shape". */
  kind?: EnvelopeKind;
  replyKind?: EnvelopeKind;
  /** Schema for args on reply envelopes (corr set). Defaults to `schema`. */
  replySchema?: Record<string, unknown>;
  /** When true, `agent.ask` uses this verb if the caller gives only free text. */
  defaultAsk?: boolean;
  /** Name of the string arg free text maps to (used with defaultAsk). */
  textField?: string;
}

export interface AgentRecord {
  /** Short name, e.g. "muse", "claude-code". Unique per handle. */
  name: string;
  /** Streamable-HTTP MCP endpoint (or other transport URL) if reachable. */
  endpoint_url?: string;
  /** Transport name hint; transports decide via canHandle(). */
  transport?: string;
  /** Bearer token to present to the endpoint, if any. */
  token?: string;
  /** Transport-specific knobs (e.g. remote tool name). */
  config?: Record<string, unknown>;
  last_seen?: string;
}

export interface Principal {
  handle: string;
  /** Agent name assumed when a key for this principal is not bound to one (e.g. the owner's RELAY_TOKEN). */
  default_agent?: string;
  /** Human name shown next to the handle. */
  display_name?: string;
  agents: AgentRecord[];
  /** Peers only: non-mutating verbs from allowlisted peers need no owner decision. */
  allowlisted?: boolean;
  invited_at?: string;
  connected_at?: string;
}

export interface StoreData {
  owner: Principal;
  peers: Principal[];
  envelopes: StoredEnvelope[];
  /** sha256(token) -> who it acts for. Minted via POST /invites. */
  tokens: Record<string, TokenRecord>;
}

export interface TokenRecord {
  /** Empty string while an open invite is unclaimed. */
  handle: string;
  agent?: string;
  label?: string;
  created_at: string;
  last_used_at?: string;
  revoked_at?: string;
}

export interface Transport {
  name: string;
  canHandle(agent: AgentRecord): boolean;
  /** Deliver and return the peer's reply envelope (or a partial answer). */
  send(agent: AgentRecord, envelope: Envelope, timeoutMs: number): Promise<TransportReply>;
}

export interface TransportReply {
  /** A full reply envelope if the peer produced one. */
  envelope?: Partial<Envelope> & { verb?: string; args?: Record<string, unknown>; note?: string | null };
  /** Raw result when the peer replied with something that is not an envelope. */
  raw?: unknown;
}

export class RelayError extends Error {
  constructor(
    public status: number,
    message: string,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
  }
  toJSON() {
    return { status: this.status, error: this.message, ...this.details };
  }
}
