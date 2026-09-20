export default {
  verb: "question.freeform",
  schema: {
    type: "object",
    properties: {
      question: { type: "string", minLength: 1, maxLength: 4000, description: "The question to put to the other agent." },
      context: { type: "string", maxLength: 8000, description: "Optional background the other agent needs to answer well." }
    },
    required: ["question"],
    additionalProperties: false
  },
  replySchema: {
    type: "object",
    properties: {
      answer: { type: "string", minLength: 1, maxLength: 8000, description: "The answer text." },
      confidence: { type: "number", minimum: 0, maximum: 1, description: "Optional self-assessed confidence 0..1." }
    },
    required: ["answer"],
    additionalProperties: false
  },
  mutating: false,
  urgent: false,
  describe: "Ask another agent a free-form question and get a text answer.",
  kind: "ask" as const,
  defaultAsk: true,
  textField: "question"
};
