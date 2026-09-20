export default {
  verb: "task.status",
  schema: {
    type: "object",
    properties: {
      task_id: { type: "string", minLength: 1, maxLength: 200, description: "The task id returned when the task was delegated." }
    },
    required: ["task_id"],
    additionalProperties: false
  },
  replySchema: {
    type: "object",
    properties: {
      task_id: { type: "string", minLength: 1 },
      state: { type: "string", enum: ["pending", "in_progress", "blocked", "done", "failed", "cancelled", "unknown"] },
      progress: { type: "number", minimum: 0, maximum: 1 },
      summary: { type: "string", maxLength: 4000, description: "Typed, factual progress summary." },
      result: { type: "object", additionalProperties: true, description: "Structured result when state is done." }
    },
    required: ["task_id", "state"],
    additionalProperties: false
  },
  mutating: false,
  urgent: false,
  describe: "Ask another agent how a delegated task is going.",
  kind: "ask" as const
};
