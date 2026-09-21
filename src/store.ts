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
    tokens: {},
    pairings: {}
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

  /** Owner handle comes from env. OWNER_AGENTS only seeds an empty store; after that the owner manages agents via /admin. */
  private seedOwner(): void {
    this.data.owner.handle = config.ownerHandle;
    if (this.data.owner.agents.length === 0) this.data.owner.agents = config.ownerAgents.map(name => ({ name }));
    // Peers who joined before default_agent existed: give them one so their messages stop going out as "unknown".
    for (const p of this.data.peers) p.default_agent ||= p.agents[0]?.name;
    // Messages already parked for "@x/unknown" become deliverable to any of @x's agents.
    for (const e of this.data.envelopes) {
      if (e.to.agent === "unknown") e.to.agent = "*";
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

  /** Which agent a principal speaks as when its key is not bound to one: the explicit default, else its only agent. */
  impliedAgent(p: Principal | undefined): string | undefined {
    if (!p) return undefined;
    return p.default_agent || (p.agents.length === 1 ? p.agents[0].name : undefined);
  }

  /**
   * The one agent of a principal that other people may talk to (their "Muse"). Everything else they run is
   * private to them. Explicit default_agent wins; else their only agent; else one literally named muse; else the first.
   */
  frontDoor(handle: string): string | undefined {
    const p = this.findPrincipal(handle);
    if (!p) return undefined;
    return this.impliedAgent(p) ?? p.agents.find(a => a.name === "muse")?.name ?? p.agents[0]?.name;
  }

  findAgent(handle: string, agent: string): AgentRecord | undefined {
    const p = this.findPrincipal(handle);
    if (!p) return undefined;
    if (agent === "*" || !agent || agent === "unknown") {
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
