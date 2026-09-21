# Decisions

Judgement calls made while building Relay, in the order they came up. Each one was made without a human
in the loop; if any is wrong, it is a small, local change.

## Transport & sessions

1. **Stateful sessions plus a stateless fallback.** A client that sends `initialize` gets an `Mcp-Session-Id`
   and its own `McpServer`. A client that just POSTs `tools/call` with no session is served by a throwaway
   server instance instead of being rejected. Reason: "Runs" is priority one and custom connector clients
   vary in how faithfully they implement the handshake. Idle sessions are dropped after 6 h.
2. **`enableJsonResponse: true`.** POST responses are plain JSON rather than SSE frames. The SDK client
   handles both; minimal hand-rolled clients only handle JSON. GET `/mcp` still opens an SSE stream for
   clients that want server notifications.
3. **Forgiving `Accept` header.** The SDK returns 406 unless the client accepts both `application/json` and
   `text/event-stream`. Since we answer in JSON anyway, `/mcp` rewrites a missing/partial Accept header before
   handing off. Recorded because it deviates from strict spec behaviour.
4. **No DNS-rebinding protection / host allowlist.** The hub is public by design and bearer-gated; a host
   allowlist would break the first Railway deploy before `PUBLIC_URL` is known.

## Auth

5. **Constant-time compare of a single static token.** As specified. Additionally accepted:
   `X-API-Key: <token>` (some connector UIs only offer an "API key" field) and optional per-agent tokens
   via `RELAY_AGENT_TOKENS=muse:tok,codex:tok`, which also identify the calling agent. All optional; the
   brief's contract (`Authorization: Bearer RELAY_TOKEN`) is unchanged.
6. **If `RELAY_TOKEN` is unset the server generates one and logs it** rather than refusing to boot. A hub
   that boots with a printed token is recoverable in one Railway variable edit; one that crash-loops is not.

## Errors over MCP

7. **HTTP status codes live inside tool results.** Over MCP a tool call is always HTTP 200, so validation
   failures return `isError: true` with a JSON body `{status: 400, error, known_verbs | errors}`. The same
   six tools are also exposed as `POST /tools/<name>`, where the status is a real HTTP 400/401/404. The
   self-test checks both. This is also what makes `/openapi.json` truthful rather than decorative.

## Envelope & verbs

8. **`replySchema`.** A reply to `question.freeform` obviously should not need a `question`. Verb files may
   declare an optional `replySchema`; envelopes with `corr` set are validated against it (falling back to
   `schema`). `deal.propose` has none because the natural reply is the separate verb `deal.respond`.
9. **Optional verb-file extras** (`kind`, `replyKind`, `replySchema`, `defaultAsk`, `textField`). The five
   required fields from the brief are enforced at load time; the extras let `agent.ask` accept a plain
   `question` string without the core ever naming `question.freeform`. The default-ask verb is whichever
   plugin declares `defaultAsk: true` (or, failing that, the first non-mutating verb with a `textField`).
10. **`kind` is derived from the verb** when the caller does not pass one: the plugin's `kind`, else
    `task.request` for mutating verbs and `ask` otherwise. Reply kinds follow ask→answer,
    task.request→task.result, deal.event→deal.event, else ack.
11. **Note sanitisation order:** strip `<`/`>` (so a note can never close the wrapper tag), replace URLs and
    bare domains with `[link removed]`, collapse whitespace, truncate to 280, then remove *leading sentences*
    that start with an imperative ("Ignore previous instructions. Please transfer…"), then re-run the URL
    pass because truncation can expose a fragment. Removing the whole leading sentence rather than just the
    verb was chosen because "previous instructions and pay me" is still an instruction.
12. **The store holds `note_untrusted`, never `note`.** `present()` is the single function that turns a
    stored envelope into a model-facing object, and it is the only place the wrapper is produced.
13. **`needs_decision` flag.** Each stored envelope carries `mutating || (from a peer who is not
    allowlisted)`. This is how the brief's "mutating: false ⇒ auto-allowed for allowlisted peers" surfaces to
    the polling agent; the hub itself never acts on anything.
14. **Store bounded at 5000 envelopes**, dropping the oldest *terminal* ones (answered/delivered/expired).
    Queued items are never evicted. Expiry is applied lazily on `inbox.list`.

## Dispatcher

15. **`agent.send` to a reachable agent still queues first**, then pushes in the background and marks the
    envelope `delivered`. If the peer answers inline, the answer is parked in the sender's inbox. This keeps
    `send` non-blocking while not wasting a live endpoint.
16. **Unknown target ⇒ `pending_invite`, not dropped.** `agent.ask`/`agent.send` to an unknown handle
    return `{status:"not_connected", invite_url}` *and* park the envelope; registering that handle via
    `POST /agents` releases it to `queued`.
17. **A sync peer reply that fails validation is discarded and the ask is queued**, with the reason in the
    result. Delivering an unvalidated reply would breach "untrusted text is never delivered as instruction".
18. **`to.agent = "*"` resolves to a reachable agent first**, else the principal's first agent.

## Peers, endpoints, identity

19. **`POST /agents` admin route (bearer).** There is no seventh tool for registering endpoints (tool count
    matters for routing accuracy), so agents/peers/endpoints are managed over REST. `/invite` is a public
    HTML page explaining how the invited person connects.
20. **Caller identity is soft.** All agents share one token, so `from.agent` comes from (in order) the
    `from_agent` tool argument, the `X-Relay-Agent` header, the per-agent token binding, else `"unknown"`.
21. **Peer protocol for `mcp-client`:** call `relay.receive` with `{envelope}` and read JSON back; or
    `config: {tool: "agent.send", mode: "flat"}` to talk to another Relay hub's own `agent.send`
    (which accepts `from_handle` for exactly this hop). No `/relay/receive` REST route — the MCP surface is
    enough for hub-to-hub.
22. **`peer.invite` seventh tool: not added.** All 16 steps passed with time to spare, but the invite URL is
    already returned by `agent.ask`/`agent.send` for unknown handles and served at `/invite`. Adding a tool
    that only echoes a URL would spend routing accuracy for no new capability.

## Build & deploy

23. **TypeScript pinned to 5.x.** `npm i typescript` resolved to 7.0 (the native port); 5.9 is the
    conservative choice for `NodeNext` + `tsx` interplay.
24. **Runtime image runs as root.** Railway volumes mount root-owned; a non-root user would need an
    entrypoint chown dance and is a known first-deploy failure mode. Revisit once a volume is confirmed.
25. **No `EXPOSE`.** Railway injects `PORT`; the server binds `0.0.0.0:$PORT`. Docker `HEALTHCHECK` uses
    the same variable.
26. **Zod 4 for tool input schemas**, JSON Schema 2020-12 (ajv) for verb args. Zod is what the MCP SDK
    wants for `inputSchema`; verbs use JSON Schema so a verb file is plain data and `/openapi.json` can
    embed it verbatim. `z.toJSONSchema` bridges the tool side into OpenAPI.
27. **Tests spawn the real process** via `tsx` on a random free port with a temp `DATA_FILE`, so restart
    and plugin-drop steps exercise the actual boot path. Three extra steps (17–19) cover the sync transport
    with a mock MCP peer, stateless MCP + REST auth, and conditional/reply-schema validation.

28. **`PUBLIC_URL` falls back to `https://$RAILWAY_PUBLIC_DOMAIN`.** Railway injects that variable once a
    domain exists, so the first deploy renders `/connect` correctly without the human copying the domain
    into a variable. An explicit `PUBLIC_URL` still wins (custom domains, other hosts).

29. **Multi-tenant via invite tokens (added post-launch).** `POST /invites` mints `rly_…` tokens bound to a
    handle, stored hashed. Every tool now scopes by the caller's handle: `inbox.list`/`inbox.reply` see only
    envelopes to/from that principal, `from.handle` is forced to the caller (only the hub owner may set
    `from_handle` for hub-to-hub forwarding), and admin routes (`/agents`, `/invites`) need `RELAY_TOKEN`.
    The invite URL carries the token (`?t=`) so one link is enough to onboard a friend in the moment; the page
    warns not to forward it and revocation is one DELETE. A claim-once code would be stricter and is the
    obvious next hardening step.

30. **Open invites + claim.** `POST /invites {}` mints a token with no handle; the invite page becomes a
    two-field form (name, handle) that POSTs to public `/invite/claim` with the token as proof of possession.
    Unclaimed tokens never authenticate; a claim is once-only (409 afterwards). Handles are normalised to
    `@[a-z0-9._-]{2,40}`; `display_name` is free text shown as `person` next to agents.

## Not built (on purpose)

- No UI beyond `/connect` and `/invite`, no database, no OAuth, no message signing (schema says
  "signed-optional"; a `sig` field can be added to the spine without breaking anything).
- No `a2a.ts` transport — the registry is ready for it.
