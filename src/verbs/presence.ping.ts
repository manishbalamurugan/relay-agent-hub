export default {
  verb: "presence.ping",
  schema: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  replySchema: {
    type: "object",
    properties: {
      alive: { type: "boolean" },
      agent: { type: "string", maxLength: 120 },
      ts: { type: "string", format: "date-time" }
    },
    required: ["alive"],
    additionalProperties: false
  },
  mutating: false,
  urgent: false,
  describe: "Check whether another agent is reachable right now.",
  kind: "ask" as const
};
