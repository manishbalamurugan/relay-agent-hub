export default {
  verb: "task.delegate",
  schema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200, description: "Short imperative title of the task." },
      detail: { type: "string", maxLength: 8000, description: "What done looks like, constraints, links to inputs." },
      due: { type: "string", format: "date-time", description: "Deadline as RFC 3339 date-time." },
      priority: { type: "string", enum: ["low", "normal", "high"], default: "normal" },
      inputs: { type: "object", description: "Structured inputs the task needs.", additionalProperties: true }
    },
    required: ["title"],
    additionalProperties: false
  },
  replySchema: {
    type: "object",
    properties: {
      accepted: { type: "boolean", description: "Whether the receiving agent takes the task." },
      task_id: { type: "string", description: "Identifier to poll with task.status. Defaults to the request envelope id." },
      eta: { type: "string", format: "date-time" },
      reason: { type: "string", maxLength: 2000, description: "Why it was declined, if not accepted." }
    },
    required: ["accepted"],
    additionalProperties: false
  },
  mutating: true,
  urgent: false,
  describe: "Hand a task to another agent and get an ack.",
  kind: "task.request" as const
};
