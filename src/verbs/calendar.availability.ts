export default {
  verb: "calendar.availability",
  schema: {
    type: "object",
    properties: {
      window_start: { type: "string", format: "date-time", description: "Start of the window to search, RFC 3339." },
      window_end: { type: "string", format: "date-time", description: "End of the window to search, RFC 3339." },
      duration_min: { type: "integer", minimum: 5, maximum: 1440, description: "Meeting length in minutes." },
      timezone: { type: "string", maxLength: 64, description: "IANA timezone the reply should be expressed in, e.g. Europe/London." },
      max_slots: { type: "integer", minimum: 1, maximum: 50, default: 5 }
    },
    required: ["window_start", "window_end", "duration_min"],
    additionalProperties: false
  },
  replySchema: {
    type: "object",
    properties: {
      slots: {
        type: "array",
        items: {
          type: "object",
          properties: {
            start: { type: "string", format: "date-time" },
            end: { type: "string", format: "date-time" }
          },
          required: ["start", "end"],
          additionalProperties: false
        }
      },
      timezone: { type: "string", maxLength: 64 }
    },
    required: ["slots"],
    additionalProperties: false
  },
  mutating: false,
  urgent: false,
  describe: "Ask another agent when its person is free within a time window.",
  kind: "ask" as const
};
