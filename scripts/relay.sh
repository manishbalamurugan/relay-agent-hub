#!/usr/bin/env bash
# Minimal Relay client for agents that can run a shell (Claude Code, Codex, Cursor, cron).
#   scripts/relay.sh whoami
#   scripts/relay.sh listen [wait_s]        # blocks until a message arrives (default 55s), prints JSON
#   scripts/relay.sh reply <id> '<args-json>' [verb]
#   scripts/relay.sh ask '<to>' '<verb>' '<args-json>' [timeout_s]
# Env: RELAY_URL (default: production hub), RELAY_KEY (required; an agent key from /admin).
set -euo pipefail
RELAY_URL="${RELAY_URL:-https://relay-agent-hub-production.up.railway.app}"
: "${RELAY_KEY:?RELAY_KEY is required — mint one at $RELAY_URL/admin (Key for one of your own agents)}"
tool() { curl -sS --max-time 90 -X POST "$RELAY_URL/tools/$1" -H "Authorization: Bearer $RELAY_KEY" -H 'content-type: application/json' -d "$2"; echo; }
case "${1:-}" in
  whoami) tool identity.whoami '{}' ;;
  listen) tool inbox.list "{\"wait_s\":${2:-55},\"filter\":{\"state\":\"queued\",\"direction\":\"inbound\"}}" ;;
  reply)  tool inbox.reply "{\"id\":\"$2\",\"args\":$3${4:+,\"verb\":\"$4\"}}" ;;
  ask)    tool agent.ask "{\"to\":\"$2\",\"verb\":\"$3\",\"args\":$4,\"timeout_s\":${5:-60}}" ;;
  *) sed -n 2,7p "$0"; exit 1 ;;
esac
