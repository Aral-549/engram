// Golden tests for contracts/indexer.md, one test per behavior case. Written from the spec before the
// handlers existed. Run from indexer/ (createTestIndexer loads indexer/config.yaml). FROZEN: add, never edit.
import { describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";

const CHAIN = 10143;
const O = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01"; // mixed case on purpose: ids must be lowercase
const o = O.toLowerCase();
const H = "0x1111111111111111111111111111111111111111";
const X = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";
const N = "0x" + "ab".repeat(32);
const NS = `${o}-${N}`;
const T1 = 1_790_000_000; // 2026-09-21 UTC
const DAY1 = new Date(T1 * 1000).toISOString().slice(0, 10);
const T2 = T1 + 86_400;
const DAY2 = new Date(T2 * 1000).toISOString().slice(0, 10);
const CT = "0x01" + "cd".repeat(40);
const WRAP = "0x01" + "ef".repeat(93);
const TX = "0x" + "9a".repeat(32);

type Sim = { contract: string; event: string; params: Record<string, unknown>; block?: Record<string, unknown>; transaction?: Record<string, unknown>; logIndex?: number };
let block = 100;
const at = (s: Omit<Sim, "block" | "transaction">, t = T1, logIndex = 0): Sim => ({
  ...s,
  block: { number: block++, timestamp: t },
  transaction: { hash: TX },
  logIndex,
});
const reg = (event: string, params: Record<string, unknown>, t = T1, logIndex = 0) => at({ contract: "MemoryRegistry", event, params }, t, logIndex);
const idr = (event: string, params: Record<string, unknown>, t = T1) => at({ contract: "IdentityRegistry", event, params }, t);

const created = () => reg("NamespaceCreated", { owner: O, nsId: N });
const appended = (seq: bigint, byOwner = true, agentId = 0n, t = T1, logIndex = 0) =>
  reg("EntryAppended", { owner: O, nsId: N, seq, epoch: 0n, byOwner, agentId, ciphertext: CT }, t, logIndex);
const grantSet = (agentId: bigint, scope: bigint, expiry: bigint) => reg("GrantSet", { owner: O, nsId: N, agentId, scope, expiry });
const wrapped = (agentId: bigint, epoch: bigint) => reg("KeyWrapped", { owner: O, nsId: N, agentId, epoch, wrap: WRAP });
const revoked = (agentId: bigint) => reg("GrantRevoked", { owner: O, nsId: N, agentId });
const rotated = (newEpoch: bigint) => reg("EpochRotated", { owner: O, nsId: N, newEpoch });
const keysSet = (agentId: bigint, x25519Pub: string, operator: string) => reg("AgentKeysSet", { agentId, x25519Pub, operator });
const registered = (agentId: bigint, owner: string, agentURI = "https://a.example/7.json") => idr("Registered", { agentId, agentURI, owner });
const transfer = (from: string, to: string, tokenId: bigint) => idr("Transfer", { from, to, tokenId });

async function run(events: Sim[]) {
  const indexer = createTestIndexer();
  await indexer.process({ chains: { [CHAIN]: { simulate: events } } } as never);
  return indexer as any;
}

describe("indexer golden cases (contracts/indexer.md)", () => {
  it("#1 NamespaceCreated creates Namespace and Owner", async () => {
    const ix = await run([created()]);
    const ns = await ix.Namespace.getOrThrow(NS);
    expect(ns).toMatchObject({ owner_id: o, nsId: N, epoch: 0n, nextSeq: 0n, granteeCount: 0, createdAt: BigInt(T1) });
    expect(await ix.Owner.getOrThrow(o)).toMatchObject({ namespaceCount: 1, entryCount: 0, firstSeenAt: BigInt(T1) });
  });

  it("#2 three entries", async () => {
    const ix = await run([created(), appended(0n), appended(1n), appended(2n)]);
    for (const s of [0n, 1n, 2n]) {
      expect(await ix.Entry.getOrThrow(`${NS}-${s}`)).toMatchObject({
        namespace_id: NS, seq: s, epoch: 0n, byOwner: true, agentId: 0n, ciphertext: CT, txHash: TX, blockTime: BigInt(T1),
      });
    }
    expect((await ix.Namespace.getOrThrow(NS)).nextSeq).toBe(3n);
    expect((await ix.Owner.getOrThrow(o)).entryCount).toBe(3);
  });

  it("#3 grant with wrapped key", async () => {
    const ix = await run([created(), grantSet(7n, 1n, 2_000_000_000n), wrapped(7n, 0n)]);
    expect(await ix.Grant.getOrThrow(`${NS}-7`)).toMatchObject({ namespace_id: NS, agent_id: "7", scope: 1, expiry: 2_000_000_000n, active: true });
    expect(await ix.WrappedKey.getOrThrow(`${NS}-7-0`)).toMatchObject({ grant_id: `${NS}-7`, epoch: 0n, wrap: WRAP });
    expect((await ix.Agent.getOrThrow("7")).activeGrantCount).toBe(1);
    expect((await ix.Namespace.getOrThrow(NS)).granteeCount).toBe(1);
  });

  it("#4 re-grant updates the same row without double counting", async () => {
    const ix = await run([created(), grantSet(7n, 1n, 2_000_000_000n), wrapped(7n, 0n), grantSet(7n, 3n, 2_100_000_000n)]);
    expect(await ix.Grant.getOrThrow(`${NS}-7`)).toMatchObject({ scope: 3, expiry: 2_100_000_000n, active: true });
    expect((await ix.Agent.getOrThrow("7")).activeGrantCount).toBe(1);
    expect((await ix.Namespace.getOrThrow(NS)).granteeCount).toBe(1);
    expect((await ix.Grant.getAll()).length).toBe(1);
  });

  it("#5 revoke + rotate", async () => {
    const ix = await run([created(), grantSet(7n, 1n, 2_000_000_000n), wrapped(7n, 0n), revoked(7n), rotated(1n)]);
    const g = await ix.Grant.getOrThrow(`${NS}-7`);
    expect(g.active).toBe(false);
    expect(g.revokedAt).toBe(BigInt(T1));
    expect((await ix.Namespace.getOrThrow(NS)).epoch).toBe(1n);
    expect((await ix.Namespace.getOrThrow(NS)).granteeCount).toBe(0);
    expect((await ix.Agent.getOrThrow("7")).activeGrantCount).toBe(0);
  });

  it("#6 latest AgentKeysSet wins", async () => {
    const k1 = "0x" + "11".repeat(32);
    const k2 = "0x" + "22".repeat(32);
    const ix = await run([registered(7n, H), transfer(ZERO, H, 7n), keysSet(7n, k1, H), keysSet(7n, k2, X)]);
    expect(await ix.Agent.getOrThrow("7")).toMatchObject({ x25519Pub: k2, operator: X.toLowerCase() });
  });

  it("#7 keysCurrent mirrors the contract across a transfer", async () => {
    const k = "0x" + "11".repeat(32);
    const ix1 = await run([registered(7n, H), transfer(ZERO, H, 7n), keysSet(7n, k, H)]);
    expect(await ix1.Agent.getOrThrow("7")).toMatchObject({ tokenOwner: H, keysSetBy: H, keysCurrent: true });
    const ix2 = await run([registered(7n, H), transfer(ZERO, H, 7n), keysSet(7n, k, H), transfer(H, X, 7n)]);
    expect(await ix2.Agent.getOrThrow("7")).toMatchObject({ tokenOwner: X, keysCurrent: false });
    const ix3 = await run([registered(7n, H), transfer(ZERO, H, 7n), keysSet(7n, k, H), transfer(H, X, 7n), keysSet(7n, k, X)]);
    expect(await ix3.Agent.getOrThrow("7")).toMatchObject({ tokenOwner: X, keysSetBy: X, keysCurrent: true });
  });

  it("#8 agent-written entry", async () => {
    const ix = await run([created(), grantSet(7n, 3n, 2_000_000_000n), appended(0n, false, 7n)]);
    expect(await ix.Entry.getOrThrow(`${NS}-0`)).toMatchObject({ byOwner: false, agentId: 7n });
    expect((await ix.Agent.getOrThrow("7")).entriesWritten).toBe(1);
  });

  it("#9 two entries in the same block keep seq order", async () => {
    const c = created(); // build in block order: namespace block < entries block
    const e0 = appended(0n, true, 0n, T1, 0);
    const e1 = { ...appended(1n, true, 0n, T1, 1), block: e0.block };
    const ix = await run([c, e0, e1]);
    expect((await ix.Entry.getOrThrow(`${NS}-0`)).seq).toBe(0n);
    expect((await ix.Entry.getOrThrow(`${NS}-1`)).seq).toBe(1n);
    expect((await ix.Namespace.getOrThrow(NS)).nextSeq).toBe(2n);
  });

  it("#10 Registered sets agentURI and registeredAt", async () => {
    const ix = await run([registered(7n, H, "https://agent.example/card.json")]);
    expect(await ix.Agent.getOrThrow("7")).toMatchObject({ agentURI: "https://agent.example/card.json", registeredAt: BigInt(T1) });
  });

  it("#11 URIUpdated replaces agentURI", async () => {
    const ix = await run([registered(7n, H), idr("URIUpdated", { agentId: 7n, newURI: "https://new.example/7.json", updatedBy: H })]);
    expect((await ix.Agent.getOrThrow("7")).agentURI).toBe("https://new.example/7.json");
  });

  it("#12 burn clears ownership and currency", async () => {
    const k = "0x" + "11".repeat(32);
    const ix = await run([registered(7n, H), transfer(ZERO, H, 7n), keysSet(7n, k, H), transfer(H, ZERO, 7n)]);
    expect(await ix.Agent.getOrThrow("7")).toMatchObject({ tokenOwner: ZERO, keysCurrent: false });
  });

  it("#13 invariant violations are recorded, never negative, never thrown", async () => {
    const ix = await run([created(), revoked(7n), reg("EntryAppended", { owner: O, nsId: "0x" + "00".repeat(32), seq: 0n, epoch: 0n, byOwner: true, agentId: 0n, ciphertext: CT })]);
    const errors = await ix.IndexerError.getAll();
    expect(errors.length).toBe(2);
    expect((await ix.Namespace.getOrThrow(NS)).granteeCount).toBe(0);
    const agent = await ix.Agent.get("7");
    expect(agent === undefined || agent.activeGrantCount === 0).toBe(true);
  });

  it("#14 daily stats count owners once per day", async () => {
    const ix = await run([created(), appended(0n, true, 0n, T1), appended(1n, true, 0n, T1), appended(2n, true, 0n, T2), grantSet(7n, 1n, 2_000_000_000n)]);
    const d1 = await ix.DailyStat.getOrThrow(DAY1);
    const d2 = await ix.DailyStat.getOrThrow(DAY2);
    expect(d1).toMatchObject({ entries: 2, activeOwners: 1, grantsSet: 1 });
    expect(d2).toMatchObject({ entries: 1, activeOwners: 1 });
  });

  it("#15 revoke then re-grant reactivates", async () => {
    const ix = await run([created(), grantSet(7n, 1n, 2_000_000_000n), revoked(7n), grantSet(7n, 1n, 2_000_000_000n)]);
    const g = await ix.Grant.getOrThrow(`${NS}-7`);
    expect(g.active).toBe(true);
    expect(g.revokedAt ?? undefined).toBeUndefined();
    expect((await ix.Agent.getOrThrow("7")).activeGrantCount).toBe(1);
    expect((await ix.Namespace.getOrThrow(NS)).granteeCount).toBe(1);
  });
});
