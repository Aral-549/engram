// Regression cases for BUGLOG I1, I2 and review gaps (contracts/indexer.md cases 16-23).
// Written from the review report before the fixes. FROZEN: add cases, never edit.
import { describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";

const CHAIN = 10143;
const O = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const o = O.toLowerCase();
const W = "0x3333333333333333333333333333333333333333";
const X = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";
const N = "0x" + "ab".repeat(32);
const NS = `${o}-${N}`;
const T1 = 1_790_000_000;
const CT = "0x01" + "cd".repeat(40);
const TX = "0x" + "9a".repeat(32);
const KEY = "0x" + "11".repeat(32);
const wrapHex = (tag: string) => "0x01" + tag.repeat(93);

let blockNo = 1000;
const ev = (contract: string, event: string, params: Record<string, unknown>, sameBlock = false) => {
  if (!sameBlock) blockNo++;
  return { contract, event, params, block: { number: blockNo, timestamp: T1 }, transaction: { hash: TX }, logIndex: logIdx++ };
};
let logIdx = 0;
const reg = (event: string, params: Record<string, unknown>, sameBlock = false) => ev("MemoryRegistry", event, params, sameBlock);
const idr = (event: string, params: Record<string, unknown>, sameBlock = false) => ev("IdentityRegistry", event, params, sameBlock);

async function run(events: unknown[]) {
  const indexer = createTestIndexer();
  await indexer.process({ chains: { [CHAIN]: { simulate: events } } } as never);
  return indexer as any;
}

const created = () => reg("NamespaceCreated", { owner: O, nsId: N });
const append = (seq: bigint) => reg("EntryAppended", { owner: O, nsId: N, seq, epoch: 0n, byOwner: true, agentId: 0n, ciphertext: CT });

describe("I1: tokenOwner comes only from Transfer", () => {
  it("#16 mint-callback transfer: Registered(owner=W) does not resurrect W", async () => {
    const ix = await run([
      idr("Transfer", { from: ZERO, to: W, tokenId: 7n }),
      idr("Transfer", { from: W, to: X, tokenId: 7n }, true),
      idr("Registered", { agentId: 7n, agentURI: "https://a.example/7.json", owner: W }, true),
    ]);
    expect(await ix.Agent.getOrThrow("7")).toMatchObject({ tokenOwner: X, agentURI: "https://a.example/7.json" });
  });

  it("#17 mint-callback setAgentKeys then transfer: keysCurrent false", async () => {
    const ix = await run([
      idr("Transfer", { from: ZERO, to: W, tokenId: 7n }),
      reg("AgentKeysSet", { agentId: 7n, x25519Pub: KEY, operator: W }, true),
      idr("Transfer", { from: W, to: X, tokenId: 7n }, true),
      idr("Registered", { agentId: 7n, agentURI: "u", owner: W }, true),
    ]);
    expect(await ix.Agent.getOrThrow("7")).toMatchObject({ keysSetBy: W, tokenOwner: X, keysCurrent: false });
  });
});

describe("I2: EntryAppended seq invariant", () => {
  it("#18 duplicate seq: no double counting, one IndexerError", async () => {
    const ix = await run([created(), append(0n), append(0n)]);
    expect((await ix.Owner.getOrThrow(o)).entryCount).toBe(1);
    const days = await ix.DailyStat.getAll();
    expect(days.reduce((n: number, d: any) => n + d.entries, 0)).toBe(1);
    expect((await ix.IndexerError.getAll()).length).toBe(1);
    expect((await ix.Namespace.getOrThrow(NS)).nextSeq).toBe(1n);
  });

  it("#19 seq gap: stored, nextSeq advances, one IndexerError", async () => {
    const ix = await run([created(), append(5n)]);
    expect(await ix.Entry.get(`${NS}-5`)).toBeDefined();
    expect((await ix.Namespace.getOrThrow(NS)).nextSeq).toBe(6n);
    expect((await ix.IndexerError.getAll()).length).toBe(1);
  });
});

describe("review gaps", () => {
  it("#20 re-grant starts a new generation; old wraps keep the old one", async () => {
    const ix = await run([
      created(),
      reg("GrantSet", { owner: O, nsId: N, agentId: 7n, scope: 1n, expiry: 2_000_000_000n }),
      reg("KeyWrapped", { owner: O, nsId: N, agentId: 7n, epoch: 0n, wrap: wrapHex("a0") }, true),
      reg("EpochRotated", { owner: O, nsId: N, newEpoch: 1n }),
      reg("KeyWrapped", { owner: O, nsId: N, agentId: 7n, epoch: 1n, wrap: wrapHex("a1") }, true),
      reg("GrantRevoked", { owner: O, nsId: N, agentId: 7n }),
      reg("EpochRotated", { owner: O, nsId: N, newEpoch: 2n }, true),
      reg("GrantSet", { owner: O, nsId: N, agentId: 7n, scope: 1n, expiry: 2_000_000_000n }),
      reg("KeyWrapped", { owner: O, nsId: N, agentId: 7n, epoch: 2n, wrap: wrapHex("a2") }, true),
    ]);
    const g = await ix.Grant.getOrThrow(`${NS}-7`);
    expect(g.generation).toBe(2);
    expect((await ix.WrappedKey.getOrThrow(`${NS}-7-0`)).generation).toBe(1);
    expect((await ix.WrappedKey.getOrThrow(`${NS}-7-1`)).generation).toBe(1);
    expect((await ix.WrappedKey.getOrThrow(`${NS}-7-2`)).generation).toBe(2);
  });

  it("#21 KeyWrapped without a grant: IndexerError and no dangling row", async () => {
    const ix = await run([created(), reg("KeyWrapped", { owner: O, nsId: N, agentId: 9n, epoch: 0n, wrap: wrapHex("b0") })]);
    expect(await ix.WrappedKey.get(`${NS}-9-0`)).toBeUndefined();
    expect((await ix.IndexerError.getAll()).length).toBe(1);
  });

  it("#22 counter underflow is recorded, not silently clamped", async () => {
    // Preset an active grant but a namespace whose granteeCount already reads 0 (drift).
    const indexer: any = createTestIndexer();
    indexer.Namespace.set({ id: NS, owner_id: o, nsId: N, epoch: 0n, nextSeq: 0n, granteeCount: 0, createdAt: BigInt(T1) });
    indexer.Grant.set({
      id: `${NS}-7`, namespace_id: NS, owner: o, agent_id: "7", scope: 1, expiry: 2_000_000_000n, active: true,
      generation: 1, grantedAt: BigInt(T1), revokedAt: undefined,
    });
    await indexer.process({ chains: { [CHAIN]: { simulate: [reg("GrantRevoked", { owner: O, nsId: N, agentId: 7n })] } } } as never);
    expect((await indexer.Namespace.getOrThrow(NS)).granteeCount).toBe(0);
    expect((await indexer.IndexerError.getAll()).length).toBeGreaterThanOrEqual(1);
  });

  it("#23 Grant rows carry the owner", async () => {
    const ix = await run([created(), reg("GrantSet", { owner: O, nsId: N, agentId: 7n, scope: 1n, expiry: 2_000_000_000n })]);
    expect((await ix.Grant.getOrThrow(`${NS}-7`)).owner).toBe(o);
  });
});
