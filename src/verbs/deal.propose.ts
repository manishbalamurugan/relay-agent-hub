export default {
  verb: "deal.propose",
  schema: {
    type: "object",
    properties: {
      subject: { type: "string", minLength: 1, maxLength: 200, description: "What is being negotiated." },
      terms: {
        type: "object",
        description: "Structured terms. Put price, quantity, timing, currency here — never in the note.",
        additionalProperties: true,
        minProperties: 1
      },
      expires: { type: "string", format: "date-time", description: "When this offer lapses if unanswered." },
      deal_id: { type: "string", maxLength: 200, description: "Reuse an existing deal id to make a revised proposal on the same deal." }
    },
    required: ["subject", "terms"],
    additionalProperties: false
  },
  mutating: true,
  urgent: true,
  describe: "Open or revise a negotiation with another agent using structured terms. Expect a deal.respond back.",
  kind: "deal.event" as const,
  replyKind: "deal.event" as const
};
