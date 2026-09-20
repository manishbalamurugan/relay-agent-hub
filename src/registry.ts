/**
 * Runtime verb registry.
 * Globs ./verbs/* next to this module at boot (src/verbs in dev, dist/verbs in prod),
 * validates each plugin's shape, compiles its args schema, and exposes lookups.
 * No verb name is known to the core — everything comes from the files found here.
 */
import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { VerbDefinition, EnvelopeKind } from "./types.js";
import { ENVELOPE_KINDS } from "./types.js";

export interface RegisteredVerb extends VerbDefinition {
  validate: ValidateFunction;
  /** Validator for reply args; same as `validate` when the plugin has no replySchema. */
  validateReply: ValidateFunction;
  /** Basename of the plugin file, for diagnostics. */
  source: string;
}

export const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: true, coerceTypes: false });
addFormats.default ? addFormats.default(ajv) : (addFormats as unknown as (a: Ajv2020) => void)(ajv);

const verbs = new Map<string, RegisteredVerb>();

function isPluginFile(name: string): boolean {
  if (name.endsWith(".d.ts") || name.endsWith(".map")) return false;
  if (name.startsWith("_") || name.startsWith(".")) return false;
  return /\.(ts|js|mjs|cjs)$/.test(name);
}

function assertShape(def: unknown, source: string): VerbDefinition {
  const d = def as Partial<VerbDefinition>;
  const problems: string[] = [];
  if (typeof d?.verb !== "string" || !/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(d.verb)) {
    problems.push("verb must be a dotted lowercase string like 'task.delegate'");
  }
  if (!d?.schema || typeof d.schema !== "object") problems.push("schema must be a JSON Schema object");
  if (typeof d?.mutating !== "boolean") problems.push("mutating must be boolean");
  if (typeof d?.urgent !== "boolean") problems.push("urgent must be boolean");
  if (typeof d?.describe !== "string" || !d.describe.trim()) problems.push("describe must be a non-empty string");
  if (d?.kind !== undefined && !ENVELOPE_KINDS.includes(d.kind as EnvelopeKind)) problems.push(`kind must be one of ${ENVELOPE_KINDS.join("|")}`);
  if (problems.length) throw new Error(`[registry] invalid verb plugin ${source}: ${problems.join("; ")}`);
  return d as VerbDefinition;
}

function prepareSchema(s: Record<string, unknown>): Record<string, unknown> {
  const schema: Record<string, unknown> = { $schema: "https://json-schema.org/draft/2020-12/schema", ...s };
  delete schema.$id; // avoid ajv id collisions across plugins
  return schema;
}

export async function loadVerbs(dirs: string[] = defaultVerbDirs()): Promise<RegisteredVerb[]> {
  verbs.clear();
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const file of entries.filter(isPluginFile).sort()) {
      const full = path.join(dir, file);
      const mod = await import(pathToFileURL(full).href);
      const def = assertShape(mod.default ?? mod, file);
      if (verbs.has(def.verb)) {
        throw new Error(`[registry] duplicate verb '${def.verb}' from ${file} and ${verbs.get(def.verb)!.source}`);
      }
      const schema = prepareSchema(def.schema);
      const validate = ajv.compile(schema);
      const replySchema = def.replySchema ? prepareSchema(def.replySchema) : undefined;
      const validateReply = replySchema ? ajv.compile(replySchema) : validate;
      verbs.set(def.verb, { ...def, schema, replySchema, validate, validateReply, source: file });
    }
  }
  const list = [...verbs.values()];
  console.log(`[registry] loaded ${list.length} verbs: ${list.map(v => v.verb).join(", ")}`);
  return list;
}

/** src/verbs (dev, via tsx) or dist/verbs (prod). Extra dirs via RELAY_VERB_DIRS (colon-separated). */
export function defaultVerbDirs(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dirs = [path.join(here, "verbs")];
  for (const extra of (process.env.RELAY_VERB_DIRS || "").split(":").filter(Boolean)) {
    dirs.push(path.resolve(extra));
  }
  return dirs;
}

export function getVerb(name: string): RegisteredVerb | undefined {
  return verbs.get(name);
}

export function listVerbs(): RegisteredVerb[] {
  return [...verbs.values()];
}

export function verbNames(): string[] {
  return [...verbs.keys()];
}

/** The verb `agent.ask` falls back to when the caller only supplies free text. */
export function defaultAskVerb(): RegisteredVerb | undefined {
  return listVerbs().find(v => v.defaultAsk) ?? listVerbs().find(v => !v.mutating && v.textField);
}

/** Envelope kind implied by a verb (plugins may override; otherwise derived from mutating). */
export function kindFor(v: VerbDefinition): EnvelopeKind {
  return v.kind ?? (v.mutating ? "task.request" : "ask");
}

export function replyKindFor(v: VerbDefinition, originalKind: EnvelopeKind): EnvelopeKind {
  if (v.replyKind) return v.replyKind;
  switch (originalKind) {
    case "ask":
      return "answer";
    case "task.request":
      return "task.result";
    case "deal.event":
      return "deal.event";
    default:
      return "ack";
  }
}
