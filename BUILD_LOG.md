# Relay — build log and full context

Written by Cursor (the agent that built Relay) on 21 Sep 2026 as a complete handoff for Manish and his Muse.
Companion to `README.md` (how to use it) and `DECISIONS.md` (why it is shaped this way). This file is the
"what happened, in order, and what was learned".

## 0. Brief and ground rules

Manish's brief, given from his phone while driving San Diego → Los Angeles: build and deploy "Relay", a
pluggable agent-interop MCP hub, end to end, without asking questions except at marked checkpoints; the
deliverable is a live public URL. Design priorities: pluggability (verbs and transports as drop-in files) and
safe handling of messages between agents (typed envelopes, untrusted free text). Later directives that shaped
everything after: Muse is the single point of contact (SPOC) and should fan work out to his other vendor tools
(Claude Code, Codex, Cursor) and get results back; no interest in raw API-key models; peer-to-peer must be
Muse-to-Muse only; the admin console must not carry placeholder names; keep the codebase minimal.

Repo: https://github.com/manishbalamurugan/relay-agent-hub. Live: https://relay-agent-hub-production.up.railway.app.
Stack: Node 22 + TypeScript, Express, `@modelcontextprotocol/sdk` (Streamable HTTP), `ajv`, `zod`. Single JSON
file store. ~4,000 lines including the e2e suite. 27 commits.

## 1. Phase one — the hub (20 Sep 23:24 → 21 Sep 00:50)

Built in one pass: `src/store.ts` (atomic JSON persistence, load at boot, flush on every mutation),
`src/envelope.ts` (envelope draft/validate/present, note sanitiser), `src/registry.ts` (loads `src/verbs/*.ts`
at boot, compiles JSON schemas with ajv), `src/transports/` (loads `src/transports/*.ts`; shipped `mcp-client`
which calls a peer's own MCP endpoint), `src/dispatcher.ts` (resolve target → sync/async/unknown; deliver or
queue), `src/auth.ts` (bearer), `src/mcp.ts` (McpServer, sessions, six tools), `src/index.ts` (Express: /health,
/openapi.json, /connect, /mcp, POST /tools/<tool> REST mirror).

The envelope: fixed spine `{id, from:{handle,agent}, to:{handle,agent}, verb, kind, args, note_untrusted,
corr, expires}` with domain-specific `args` validated against the verb's schema. Free text only lives in
`note_untrusted`: ≤280 chars, URLs stripped, imperative verbs neutralised, and it is presented to models
wrapped in `<untrusted_peer_note>` so instructions inside it are data, not commands.

The six tools, chosen so a model's tool routing stays accurate: `identity.whoami`, `agent.list`, `agent.ask`,
`agent.send`, `inbox.list`, `inbox.reply`. Eight verbs: `presence.ping`, `question.freeform`, `task.delegate`,
`task.status`, `calendar.availability`, `calendar.hold`, `deal.propose`, `deal.respond`. Mutating verbs
(hold, deal, delegate) arrive from other people with `needs_decision: true`.

Self-test `test/e2e.ts` boots a real server on a free port and drives it over real MCP and REST. 16 steps at
first, including "drop a new verb file, restart, it is live" as the pluggability proof and a mock peer for the
sync transport.

Deploy: Dockerfile, `railway.json`, `.env.example`. GitHub push needed credentials; Manish authenticated via
`gh auth login --web` device flow. First live issues: `PUBLIC_URL` showed localhost (fixed by deriving it from
`RAILWAY_PUBLIC_DOMAIN`); store was ephemeral (Manish attached a Railway volume at `/data`; `/health` now
reports whether the store is on a mounted volume).

Bugs fixed in this phase: sanitiser deleted a whole sentence when a URL had trailing punctuation (now keeps the
punctuation after `[link removed]`); mock peer had to create a fresh McpServer+transport per request; the
mcp-client transport misread `{args, note}` replies without a `verb` as bare args.

## 2. Phase two — people (01:17 → 02:05)

Manish asked whether he could hand the URL to a friend and have their agents talk to his. Answer was "not yet";
he said "build it as fast as possible, I need to show my friend in five minutes".

Multi-tenant identity: principals (owner + peers), each with handles and agents. `POST /invites` mints a token
bound to a handle (hashed SHA-256 at rest); the invite page shows the friend a connect block; guests see only
envelopes to/from their handle; admin routes require the owner key. Open invites (no handle) let the person pick
their handle and display name on a claim page. `POST /me` for profile updates. Lenient bearer parsing
(`Bearer Bearer x`, bare key, quotes, `Token x`) with diagnostic 401s, because consumer apps mangle headers.
Key rotation for owner and guests.

## 3. Phase three — identities for the owner's own agents, and OAuth (03:04 → 03:37)

Owner-agent keys: `POST /agents/tokens {agent}` mints a non-admin key that acts as `@manish/<agent>` and sees
only messages addressed to that agent (or `*`). This is what lets Claude Code, Codex and Cursor each have their
own inbox under Manish.

OAuth 2.1 shim for clients that only offer "Sign in" (Claude mobile): discovery documents, dynamic client
registration, an authorize page that asks for the Relay key, PKCE token exchange, RFC 9728 challenge on 401.
The access token issued is the Relay key itself, so revocation keeps working.

MCP session context was captured at `initialize` and went stale when settings changed; fixed by refreshing the
caller context per request.

## 4. Phase four — real time (03:52 → 04:54)

Manish: "I don't like this 15-minute bottleneck. I'm imagining something more real time, web-socket-like."

Three mechanisms, all over plain Streamable HTTP so proxies are fine: `inbox.list {wait_s}` long-poll (returns
within ~1 s of arrival); `agent.ask` holds the caller open until a correlated reply lands and returns it inline;
MCP push notifications (`relay/inbox`) on open SSE sessions. Delivery labels stopped saying "15 minutes".

The honest finding that followed: consumer chat apps (Claude, ChatGPT, Muse) only act when the user types.
For an agent to answer unattended something must be running. First attempt: a "worker" that answered via
Anthropic/OpenAI/xAI APIs. Manish rejected this direction: "I don't care if Muse can hit vendor models with API
keys, I want it to access my vendor tools like Claude, Claude Code." Also added `scripts/relay.sh` and a Claude
Code `/relay-listen` slash command for interactive sessions.

Owner console `/admin`: browser page that takes the owner key once and does invites, agent keys, revocation.

## 5. Phase five — the agent runner (15:27 → 16:06)

"Bridge": run Claude Code (`claude -p --output-format json --json-schema`), Codex (`codex exec
--output-schema`) or any custom CLI headless as always-on Relay agents. Then the audit Manish asked for
("streamline, de-bloat, minimal and agile"): worker + bridge collapsed into one `npm run agent` runner
(`src/agent/index.ts`) with presets `claude-code | codex | custom | api | cursor`, configured by `agents.json`
or `AGENT_*` env; `Dockerfile.agent` for Railway; admin routes moved to `src/admin.ts`; HTML helpers to
`src/http.ts`; shared `public/relay.css`; dead `RELAY_AGENT_TOKENS`, unused store field and exports removed.

Cursor preset: registers Cursor (this agent) as `@manish/cursor`. On `task.delegate` it launches a Cursor
Cloud Agent via the API (`POST /v1/agents` with repo + prompt), polls the run, and replies with `accepted`,
`summary` and typed `links` (agent run URL, branch). Reply schemas for `task.delegate`/`task.status` grew
`summary` and `links` so links survive the note sanitiser. Needs `CURSOR_API_KEY` in a running runner to be live.

Own-order policy: a mutating verb from the owner's own Muse to the owner's own agent is executed by the runner
without a human step, because the owner already decided by telling Muse. Mutating verbs from other people are
left for the human.

Admin console cleanup per Manish: placeholder names removed, per-agent key revoke, peer allowlist toggle
("allowlisted" peers' non-mutating asks can be answered without consulting the owner), "Reset my agents"
(revokes and removes the owner's agents except the ones kept; peers untouched; seeding no longer resurrects
them on restart). Manish reset to muse + Saurav's invite and re-minted what he needed.

Errors along the way: `worker` mis-parsed `acting_as`; mutating-verb check had to run before the reply-schema
check; `OWNER_AGENTS` missing from the test env; the runner's `repo` field didn't resolve `$ENV` refs; Docker
in the sandbox needed sudo; hub-unreachable at boot printed a stack trace (now a clean message).

## 6. Phase six — the "unknown agent" incident (17:07 → 17:15)

Manish's screenshot: his Muse reported that a friend's messages "arrive without an agent name", that its
replies went to agent "unknown", and that the friend's poll never picked them up. Diagnosis from the live
store: the friend (@vaishu) had a key bound to her handle but to no agent, and no `default_agent`, so the hub
stamped her as `@vaishu/unknown`; Muse's `inbox.reply` addressed the answer to `@vaishu/unknown`; her Muse
polled with `for_agent: "muse"`, which excluded it.

Fixes: an unbound key acts as the principal's `default_agent`, else its only agent (`store.impliedAgent`);
`bindToken` sets `default_agent` at invite/claim; boot migration gives existing peers a default and
re-addresses parked `@x/unknown` envelopes to `@x/*`; replies to a sender without an agent go to `@x/*`;
inbound matching treats legacy `unknown` as wildcard; `inbox.list` stamps `last_seen` on the polling agent
(visible in `identity.whoami`, so you can tell whether someone's Muse is actually checking).

Read receipts: Muse had concluded "still queued, so she hasn't seen it", but `queued` only meant "not replied".
`inbox.list` now sets `seen_at` on messages the recipient lists; `agent.send`/`agent.ask` results carry a
`track` hint. Verified live: Vaishu's Muse polls every 30 s and had read the reply within a minute.

Not a hub bug: Muse's scheduled check and Manish's manual prompt ran concurrently and produced two replies.
Muse should check outbound with `corr` before answering.

## 7. Phase seven — packaging (21:40 → 21:42)

An outside critique Manish forwarded: the paste block (URL + bearer + `timeout_s`) is hostile to normal
people; tokens in chat get screenshotted; the Railway hostname looks like a weekend deploy; the demo that
matters is two people, two vendors, one outcome.

Shipped: `GET /start.md`, an agent-facing onboarding page (how to pair, connect, ask, reply, when to consult
the human, which text is untrusted, live verb list). Pairing codes `RELAY-XXXXXX`: single-use, 48 h, hashed at
rest; `POST /pair {code}` mints a key and returns it to the assistant, which stores it in its own config. The
human forwards one sentence: "Connect me to Relay: fetch <hub>/start.md and follow it. My pairing code is
RELAY-XXXXXX. Then tell me who I can reach." Open invites make the assistant ask the person for a name. The
OAuth sign-in page accepts a code too. `/admin` leads with the share text and a "Text it" button.
`DELETE /invites/:handle?purge=true` forgets a person entirely (record, pairings, messages). Custom domain is
the one item left to Manish (Railway → Networking → Custom Domain; `PUBLIC_URL` follows automatically).

Demo script and post were drafted: 40-second phone recording, "ask vaishu's muse if friday 7pm works for
dinner; hold both calendars if yes" → answer → one "yes" → "have claude code add a 'who's free tonight' verb
and open a PR" → PR link back in the same chat. Result-first post, how/proof/paste in replies.

## 8. Phase eight — front-door policy (21:59)

Manish: "Peer-to-peer should only be Muse to Muse. Someone else's Muse shouldn't be able to talk to my Claude
Code and vice versa."

`tools.gate()` on `agent.ask`, `agent.send`, `inbox.reply`: for cross-principal traffic the sender's agent
must be its principal's front door (else 403 "answer your own Muse and let it relay"), the recipient's agent
must be `*` or their front door (else 403 "address @handle instead"), and `*` is rewritten to the front door so
it lands in exactly one inbox. Peers only see each other's front door in `identity.whoami`/`agent.list`.
Same-principal traffic is unrestricted. Front door = `default_agent`, else only agent, else the one named
`muse`. Verified on production with a throwaway guest: it saw only `muse` for @manish; sends to
`@manish/claude-code` and `@manish/cursor` were refused; guest purged.

## 9. State at handoff

- 25/25 e2e steps passing; every change deployed to Railway and verified against production.
- People: @manish (owner; agents muse, claude-code, codex, cursor, chatgpt, claude, grok), @vaishu (Muse polling
  every 30 s, allowlisted), @saurav (key issued, Muse has never polled).
- Claude Code answered Muse's `presence.ping`s inline this afternoon while `/relay-listen` was running.
- Open: custom domain; Cursor runner deployment with `CURSOR_API_KEY`; Saurav's recurring check; film the demo.

## 10. Lessons worth keeping

1. Typed envelopes plus a quarantined note field made cross-agent prompt injection a non-issue by construction.
2. Six tools was the right count; every tempting seventh tool was an existing REST route or a returned URL.
3. "Real time" for consumer assistants means long-poll on the hub plus something that is actually running on
   the user's side; the hub can only be as live as the least-attended participant.
4. Identity defaults matter more than features: one missing `default_agent` produced a full day of "it's
   broken" that was really "it's addressed to nobody".
5. Status words must mean one thing. `queued` meant two things until `seen_at` existed.
6. Packaging is the product for anyone outside the builder's chat: one sentence, a code, no tokens.
7. The privacy boundary is the person's front door. Fan-out is inside it; negotiation crosses it.
