export default {
  verb: "calendar.hold",
  schema: {
    type: "object",
    properties: {
      start: { type: "string", format: "date-time", description: "Hold start, RFC 3339." },
      end: { type: "string", format: "date-time", description: "Hold end, RFC 3339." },
      subject: { type: "string", minLength: 1, maxLength: 200, description: "What the meeting is about." },
      location: { type: "string", maxLength: 300, description: "Place or call link label (no URLs in notes)." },
      attendees: { type: "array", items: { type: "string", maxLength: 120 }, maxItems: 50 },
      tentative: { type: "boolean", default: true, description: "True asks for a soft hold; false asks for a confirmed booking." }
    },
    required: ["start", "end", "subject"],
    additionalProperties: false
  },
  replySchema: {
    type: "object",
    properties: {
      held: { type: "boolean" },
      hold_id: { type: "string", maxLength: 200 },
      conflict: { type: "boolean", description: "True if the slot clashed with something." },
      reason: { type: "string", maxLength: 2000 }
    },
    required: ["held"],
    additionalProperties: false
  },
  mutating: true,
  urgent: true,
  describe: "Ask another agent to put a hold on its person's calendar.",
  kind: "task.request" as const
};
