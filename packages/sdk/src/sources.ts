// Read paths for entries, wraps, and grants (contracts/sdk.md "Inputs"). Sources are a convenience, not a trust
// anchor: ciphertext is authenticated by AAD, completeness is checked against chain `nextSeq`, and access/key
// decisions use chain reads.
import { getAbiItem, type Hex } from "viem";
import { memoryRegistryAbi } from "./abi.js";
import { clientsFor } from "./config.js";
import { EngramError } from "./errors.js";

export type SourceEntry = { seq: bigint; epoch: bigint; byOwner: boolean; agentId: bigint; ciphertext: Hex; txHash: Hex };
/** `generation` increments each time an inactive grant becomes active again; only current-generation wraps are valid. */
export type SourceWrap = { epoch: bigint; wrap: Hex; generation: number };
export type SourceGrant = { owner: Hex; nsId: Hex; agentId: bigint; scope: number; expiry: bigint; active: boolean; generation: number };

export interface MemorySource {
  entries(q: { owner: Hex; nsId: Hex }): Promise<SourceEntry[]>;
  wraps(q: { owner: Hex; nsId: Hex; agentId: bigint }): Promise<SourceWrap[]>;
  grantsForAgent(agentId: bigint): Promise<SourceGrant[]>;
  grantsForOwner(owner: Hex): Promise<SourceGrant[]>;
  /** Optional: the source's copy of agent keys. Only used to warn when it disagrees with chain. */
  agentKeys?(agentId: bigint): Promise<{ x25519Pub: Hex; operator: Hex } | undefined>;
}

const unavailable = (what: string, cause: unknown) => new EngramError("SOURCE_UNAVAILABLE", `${what} is unavailable`, { cause });
const lc = (h: string) => h.toLowerCase() as Hex;

// ------------------------------------------------------------------------------------------ logs source

/**
 * Reads events straight from chain with `eth_getLogs`. Needs no indexer; slower for long histories.
 * `blockRange` bounds each getLogs call (public RPCs cap ranges).
 */
export function logsSource(opts: { rpcUrl: string; registry: Hex; fromBlock: bigint; chainId?: number; blockRange?: bigint }): MemorySource {
  const { publicClient } = clientsFor({ chainId: opts.chainId ?? 0, rpcUrl: opts.rpcUrl });
  const range = opts.blockRange ?? 10_000n;
  const event = (name: string) => getAbiItem({ abi: memoryRegistryAbi, name: name as never }) as never;

  async function logs(name: string, args: Record<string, unknown>) {
    try {
      const head = await publicClient.getBlockNumber();
      const out: Array<{ args: any; blockNumber: bigint; logIndex: number; transactionHash: Hex }> = [];
      for (let from = opts.fromBlock; from <= head; from += range) {
        const to = from + range - 1n > head ? head : from + range - 1n;
        const got = await publicClient.getLogs({ address: opts.registry, event: event(name), args: args as never, fromBlock: from, toBlock: to });
        out.push(...(got as never[]));
      }
      return out;
    } catch (e) {
      throw unavailable("chain logs source", e);
    }
  }

  type Ev = { kind: "set" | "revoked" | "wrapped"; args: any; blockNumber: bigint; logIndex: number };
  /** Replays grant events in chain order to compute active/generation exactly like the indexer. */
  function replay(events: Ev[]) {
    events.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    const grants = new Map<string, SourceGrant & { wraps: Map<bigint, SourceWrap> }>();
    for (const e of events) {
      const key = `${lc(e.args.owner)}-${lc(e.args.nsId)}-${e.args.agentId}`;
      let g = grants.get(key);
      if (e.kind === "set") {
        if (!g) {
          g = { owner: lc(e.args.owner), nsId: lc(e.args.nsId), agentId: e.args.agentId, scope: 0, expiry: 0n, active: false, generation: 0, wraps: new Map() };
          grants.set(key, g);
        }
        if (!g.active) g.generation += 1;
        g.active = true;
        g.scope = Number(e.args.scope);
        g.expiry = e.args.expiry;
      } else if (e.kind === "revoked" && g) {
        g.active = false;
      } else if (e.kind === "wrapped" && g) {
        g.wraps.set(e.args.epoch, { epoch: e.args.epoch, wrap: lc(e.args.wrap), generation: g.generation });
      }
    }
    return grants;
  }

  async function grantState(filter: Record<string, unknown>) {
    const [sets, revokes, wraps] = await Promise.all([logs("GrantSet", filter), logs("GrantRevoked", filter), logs("KeyWrapped", filter)]);
    return replay([
      ...sets.map((l) => ({ kind: "set" as const, ...l })),
      ...revokes.map((l) => ({ kind: "revoked" as const, ...l })),
      ...wraps.map((l) => ({ kind: "wrapped" as const, ...l })),
    ]);
  }

  const strip = ({ wraps: _w, ...g }: SourceGrant & { wraps: unknown }) => g;

  return {
    async entries({ owner, nsId }) {
      const got = await logs("EntryAppended", { owner, nsId });
      return got.map((l) => ({
        seq: l.args.seq, epoch: l.args.epoch, byOwner: l.args.byOwner, agentId: l.args.agentId, ciphertext: lc(l.args.ciphertext), txHash: lc(l.transactionHash),
      }));
    },
    async wraps({ owner, nsId, agentId }) {
      const g = (await grantState({ owner, nsId, agentId })).values().next().value;
      return g ? [...g.wraps.values()] : [];
    },
    async grantsForAgent(agentId) {
      return [...(await grantState({ agentId })).values()].map(strip);
    },
    async grantsForOwner(owner) {
      return [...(await grantState({ owner })).values()].map(strip);
    },
    async agentKeys(agentId) {
      const got = await logs("AgentKeysSet", { agentId });
      const last = got.at(-1);
      return last ? { x25519Pub: lc(last.args.x25519Pub), operator: lc(last.args.operator) } : undefined;
    },
  };
}

// ------------------------------------------------------------------------------------------ graphql source

/** Reads from the Envio HyperIndex GraphQL API (indexer/). */
export function graphqlSource(url: string, opts: { headers?: Record<string, string> } = {}): MemorySource {
  async function q<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...opts.headers }, body: JSON.stringify({ query, variables }) });
    } catch (e) {
      throw unavailable("indexer", e);
    }
    const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: unknown };
    if (!res.ok || !json.data) throw unavailable("indexer", json.errors ?? res.status);
    return json.data;
  }
  const toGrant = (g: any): SourceGrant => ({
    owner: lc(g.owner), nsId: lc(g.namespace.nsId), agentId: BigInt(g.agent_id), scope: g.scope, expiry: BigInt(g.expiry), active: g.active, generation: g.generation,
  });
  const GRANT = "owner agent_id scope expiry active generation namespace { nsId }";
  return {
    async entries({ owner, nsId }) {
      const ns = `${lc(owner)}-${lc(nsId)}`;
      const out: SourceEntry[] = [];
      for (let after = -1n; ; ) {
        const d = await q<{ Entry: any[] }>(
          `query($ns:String!,$after:numeric!){ Entry(where:{namespace_id:{_eq:$ns}, seq:{_gt:$after}}, order_by:{seq:asc}, limit:500){ seq epoch byOwner agentId ciphertext txHash } }`,
          { ns, after: after.toString() },
        );
        for (const e of d.Entry) out.push({ seq: BigInt(e.seq), epoch: BigInt(e.epoch), byOwner: e.byOwner, agentId: BigInt(e.agentId), ciphertext: e.ciphertext, txHash: e.txHash });
        if (d.Entry.length < 500) return out;
        after = out.at(-1)!.seq;
      }
    },
    async wraps({ owner, nsId, agentId }) {
      const d = await q<{ WrappedKey: any[] }>(`query($g:String!){ WrappedKey(where:{grant_id:{_eq:$g}}){ epoch wrap generation } }`, {
        g: `${lc(owner)}-${lc(nsId)}-${agentId}`,
      });
      return d.WrappedKey.map((w) => ({ epoch: BigInt(w.epoch), wrap: w.wrap, generation: w.generation }));
    },
    async grantsForAgent(agentId) {
      const d = await q<{ Grant: any[] }>(`query($a:String!){ Grant(where:{agent_id:{_eq:$a}}){ ${GRANT} } }`, { a: agentId.toString() });
      return d.Grant.map(toGrant);
    },
    async grantsForOwner(owner) {
      const d = await q<{ Grant: any[] }>(`query($o:String!){ Grant(where:{owner:{_eq:$o}}){ ${GRANT} } }`, { o: lc(owner) });
      return d.Grant.map(toGrant);
    },
    async agentKeys(agentId) {
      const d = await q<{ Agent: any[] }>(`query($a:String!){ Agent(where:{id:{_eq:$a}}){ x25519Pub operator } }`, { a: agentId.toString() });
      const a = d.Agent[0];
      return a?.x25519Pub ? { x25519Pub: a.x25519Pub, operator: a.operator } : undefined;
    },
  };
}

// ------------------------------------------------------------------------------------------ fallback

/** Tries each source in order, moving on only when one is unavailable. */
export function firstAvailable(sources: MemorySource[]): MemorySource {
  async function tryAll<T>(call: (s: MemorySource) => Promise<T> | undefined): Promise<T> {
    let last: unknown;
    for (const s of sources) {
      try {
        const p = call(s);
        if (p === undefined) continue;
        return await p;
      } catch (e) {
        if (!(e instanceof EngramError && e.code === "SOURCE_UNAVAILABLE")) throw e;
        last = e;
      }
    }
    throw last ?? new EngramError("SOURCE_UNAVAILABLE", "no source available");
  }
  return {
    entries: (q) => tryAll((s) => s.entries(q)),
    wraps: (q) => tryAll((s) => s.wraps(q)),
    grantsForAgent: (a) => tryAll((s) => s.grantsForAgent(a)),
    grantsForOwner: (o) => tryAll((s) => s.grantsForOwner(o)),
    agentKeys: (a) => tryAll((s) => s.agentKeys?.(a)),
  };
}
