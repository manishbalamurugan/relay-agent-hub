export default {
  verb: "deal.respond",
  schema: {
    type: "object",
    properties: {
      deal_id: { type: "string", minLength: 1, maxLength: 200, description: "The deal being answered (the proposal envelope id unless the proposer set deal_id)." },
      decision: { type: "string", enum: ["accept", "counter", "reject"] },
      terms: {
        type: "object",
        description: "Required when decision is counter: the full revised terms.",
        additionalProperties: true
      }
    },
    required: ["deal_id", "decision"],
    additionalProperties: false,
    if: { properties: { decision: { const: "counter" } } },
    then: { required: ["terms"] }
  },
  mutating: true,
  urgent: true,
  describe: "Accept, counter or reject a deal another agent proposed.",
  kind: "deal.event" as const,
  replyKind: "ack" as const
};
