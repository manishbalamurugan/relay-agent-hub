/**
 * Single-JSON-file persistence.
 * Loaded into memory at boot; every mutation is flushed atomically
 * (write to a temp file in the same directory, then rename over the target).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { StoreData, StoredEnvelope, Principal, AgentRecord } from "./types.js";

function emptyData(): StoreData {
  return {
    owner: { handle: config.ownerHandle, agents: [] },
    peers: [],
    envelopes: [],
    tokens: {}
  };
}

export class Store {
  private data: StoreData = emptyData();
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly file: string = config.dataFile) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      this.data = { ...emptyData(), ...parsed };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // A corrupt store must not take the hub down. Keep it aside and start clean.
        const backup = `${this.file}.corrupt.${Date.now()}`;
        console.error(`[store] could not parse ${this.file}: ${(err as Error).message}. Moving to ${backup}`);
        await fs.rename(this.file, backup).catch(() => undefined);
      }
      this.data = emptyData();
    }
    this.seedOwner();
    this.loaded = true;
    await this.flush();
  }

  /** Owner handle comes from env; make sure configured agents exist as records. */
  private seedOwner(): void {
    this.data.owner.handle = config.ownerHandle;
    for (const name of config.ownerAgents) {
      if (!this.data.owner.agents.some(a => a.name === name)) {
        this.data.owner.agents.push({ name });
      }
    }
  }

  get snapshot(): Readonly<StoreData> {
    return this.data;
  }

  /** Apply a mutation and persist. Mutations are applied synchronously; flushes are serialised. */
  async mutate<T>(fn: (data: StoreData) => T): Promise<T> {
    if (!this.loaded) throw new Error("store used before load()");
    const result = fn(this.data);
    await this.flush();
    return result;
  }

  private flush(): Promise<void> {
    const json = JSON.stringify(this.data, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      const dir = path.dirname(this.file);
      await fs.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.${path.basename(this.file)}.${process.pid}.${Date.now()}.tmp`);
      await fs.writeFile(tmp, json, "utf8");
      await fs.rename(tmp, this.file);
    });
    return this.writeChain;
  }

  // ---- convenience lookups (read-only) -------------------------------------------------

  findPrincipal(handle: string): Principal | undefined {
    if (handle === this.data.owner.handle) return this.data.owner;
    return this.data.peers.find(p => p.handle === handle);
  }

  findAgent(handle: string, agent: string): AgentRecord | undefined {
    const p = this.findPrincipal(handle);
    if (!p) return undefined;
    if (agent === "*" || !agent) {
      // Prefer a reachable agent when the sender does not care which one answers.
      return p.agents.find(a => a.endpoint_url) ?? p.agents[0];
    }
    return p.agents.find(a => a.name === agent);
  }

  getEnvelope(id: string): StoredEnvelope | undefined {
    return this.data.envelopes.find(e => e.id === id);
  }

  /** Mark expired envelopes lazily; returns true if anything changed. */
  sweepExpired(now = Date.now()): boolean {
    let changed = false;
    for (const e of this.data.envelopes) {
      if (e.state === "queued" && Date.parse(e.expires) < now) {
        e.state = "expired";
        changed = true;
      }
    }
    return changed;
  }
}

export const store = new Store();
