/**
 * Transport registry. Every sibling file in this directory (except this one) is a transport
 * plugin exporting `{ name, canHandle(agent), send(agent, envelope, timeoutMs) }`.
 * Drop `a2a.ts` next to `mcp-client.ts` and it is live on the next boot.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentRecord, Transport } from "../types.js";

const transports: Transport[] = [];

function isPluginFile(name: string): boolean {
  if (/^index\.(ts|js)$/.test(name)) return false;
  if (name.endsWith(".d.ts") || name.endsWith(".map")) return false;
  if (name.startsWith("_") || name.startsWith(".")) return false;
  return /\.(ts|js|mjs|cjs)$/.test(name);
}

export async function loadTransports(): Promise<Transport[]> {
  transports.length = 0;
  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (const file of (await fs.readdir(dir)).filter(isPluginFile).sort()) {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    const t = (mod.default ?? mod) as Partial<Transport>;
    if (typeof t.name !== "string" || typeof t.canHandle !== "function" || typeof t.send !== "function") {
      throw new Error(`[transports] ${file} does not export { name, canHandle, send }`);
    }
    transports.push(t as Transport);
  }
  console.log(`[transports] loaded ${transports.length}: ${transports.map(t => t.name).join(", ") || "(none)"}`);
  return transports;
}

export function listTransports(): Transport[] {
  return [...transports];
}

/** First transport that claims the agent, or undefined when the agent is not reachable. */
export function transportFor(agent: AgentRecord | undefined): Transport | undefined {
  if (!agent?.endpoint_url) return undefined;
  return transports.find(t => {
    try {
      return t.canHandle(agent);
    } catch {
      return false;
    }
  });
}
