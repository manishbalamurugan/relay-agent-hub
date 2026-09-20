/**
 * OpenAPI 3.1 document generated from the tool definitions and the live verb registry.
 * Each tool is a POST /tools/<name> operation; each verb's args schema is a component.
 */
import { z } from "zod";
import { baseUrl } from "./config.js";
import { envelopeSchema } from "./envelope.js";
import { listVerbs } from "./registry.js";
import { listTools } from "./tools.js";

function toJsonSchema(shape: z.ZodRawShape): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(shape), { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

function componentName(verb: string): string {
  return "Verb_" + verb.replace(/[^A-Za-z0-9]+/g, "_");
}

export function buildOpenApi(): Record<string, unknown> {
  const verbs = listVerbs();
  const paths: Record<string, unknown> = {
    "/health": {
      get: {
        operationId: "health",
        summary: "Liveness check; lists registered verbs.",
        security: [],
        responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { ok: { const: true }, verbs: { type: "array", items: { type: "string" } } } } } } } }
      }
    },
    "/connect": {
      get: { operationId: "connect", summary: "Human-readable connection instructions (HTML).", security: [], responses: { "200": { description: "HTML page" } } }
    },
    "/openapi.json": {
      get: { operationId: "openapi", summary: "This document.", security: [], responses: { "200": { description: "OpenAPI 3.1 JSON" } } }
    },
    "/mcp": {
      post: {
        operationId: "mcp",
        summary: "MCP streamable HTTP endpoint (JSON-RPC 2.0). Same six tools as below.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", description: "JSON-RPC 2.0 request" } } } },
        responses: { "200": { description: "JSON-RPC response" }, "401": { $ref: "#/components/responses/Unauthorized" } }
      }
    }
  };

  for (const tool of listTools()) {
    paths[`/tools/${tool.name}`] = {
      post: {
        operationId: tool.name.replace(/\./g, "_"),
        summary: tool.description,
        description: tool.description,
        tags: [tool.name.split(".")[0]],
        requestBody: { required: true, content: { "application/json": { schema: toJsonSchema(tool.input) } } },
        responses: {
          "200": { description: "Result", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
          "400": { $ref: "#/components/responses/ValidationError" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { description: "Unknown id", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
        }
      }
    };
  }

  const verbComponents: Record<string, unknown> = {};
  for (const v of verbs) {
    const { $schema: _s, ...schema } = v.schema as Record<string, unknown>;
    verbComponents[componentName(v.verb)] = { ...schema, title: v.verb, description: `${v.describe} (mutating: ${v.mutating}, urgent: ${v.urgent})` };
    if (v.replySchema) {
      const { $schema: _r, ...reply } = v.replySchema as Record<string, unknown>;
      verbComponents[componentName(v.verb) + "_Reply"] = { ...reply, title: `${v.verb} reply`, description: `Args expected on a reply to ${v.verb}.` };
    }
  }

  const { $schema: _e, ...envelope } = envelopeSchema as unknown as Record<string, unknown>;

  return {
    openapi: "3.1.0",
    info: {
      title: "Relay — agent interop hub",
      version: "0.1.0",
      description:
        "Lets one person's AI agents talk to each other with typed, schema-validated envelopes. " +
        "Prefer the MCP endpoint at /mcp; the REST operations below are the same six tools for clients without MCP support. " +
        `Registered verbs: ${verbs.map(v => v.verb).join(", ")}.`
    },
    servers: [{ url: baseUrl() }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "Static token: Authorization: Bearer <RELAY_TOKEN>" } },
      responses: {
        Unauthorized: { description: "Missing or invalid bearer token", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        ValidationError: {
          description: "Envelope, verb or args failed validation. Body lists known verbs or ajv error paths.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
        }
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            status: { type: "integer" },
            error: { type: "string" },
            known_verbs: { type: "array", items: { type: "string" } },
            errors: { type: "array", items: { type: "object", properties: { path: { type: "string" }, message: { type: "string" } } } }
          },
          required: ["status", "error"]
        },
        Envelope: { ...envelope, title: "Envelope", description: "Fixed message spine. `args` is validated against the verb's component schema." },
        Verb: { type: "string", enum: verbs.map(v => v.verb), description: "A registered verb." },
        ...verbComponents
      }
    }
  };
}
