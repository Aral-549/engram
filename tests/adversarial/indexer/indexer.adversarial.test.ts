// Adversarial probes for the indexer (contracts/indexer.md), mirrored against chain/src/MemoryRegistry.sol and the
// live ERC-8004 IdentityRegistry log order (register tx 0x988261ef...5d1d: Transfer(mint) at logIndex 43, then
// MetadataUpdate 44, Registered 45, MetadataSet 46 -- Registered is emitted AFTER _safeMint's onERC721Received callback).
// A probe PASSES when entities equal what the contract state would be; it FAILS on a bug.
import { describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";

const CHAIN = 10143;
const ZERO = "0x0000000000000000000000000000000000000000";
const O = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const o = O.toLowerCase();
const O2 = "0x3333333333333333333333333333333333333333";
const W = "0x4444444444444444444444444444444444444444"; // contract wallet that registers (onERC721Received runs)
const X = "0x2222222222222222222222222222222222222222";
const Y = "0x5555555555555555555555555555555555555555";
const H = "0x1111111111111111111111111111111111111111";
const N = "0x" + "ab".repeat(32);
const N2 = "0x" + "cd".repeat(32);
const NS = `${o}-${N}`;
const T1 = 1_790_000_000;
const CT = "0x01" + "cd".repeat(40);
const WRAP = "0x01" + "ef".repeat(93);
const WRAP2 = "0x01" + "aa".repeat(93);
const K1 = "0x" + "11".repeat(32);
const K2 = "0x" + "22".repeat(32);
const EXP = 2_000_000_000n;

type Sim = { contract: string; event: string; params: Record<string, unknown>; block: Record<string, unknown>; transaction: Record<string, unknown>; logIndex: number };

/** Builds events in strictly non-decreasing block order; `tx()` starts a new block, events inside share it. */
function chain(startBlock = 100) {
  let bn = startBlock;
  let li = 0;
  let ts = T1;
  let cur = { number: bn, timestamp: ts };
  const items: Sim[] = [];
  const api = {
    items,
    tx(t = ts) {
      bn += 1;
      ts = t;
      li = 0;
      cur = { number: bn, timestamp: ts };
      return api;
    },
    push(contract: string, event: string, params: Record<string, unknown>) {
      items.push({ contract, event, params, block: cur, transaction: { hash: "0x" + bn.toString(16).padStart(64, "0") }, logIndex: li++ });
      return api;
    },
    reg(event: string, params: Record<string, unknown>) {
      return api.push("MemoryRegistry", event, params);
    },
    idr(event: string, params: Record<string, unknown>) {
      return api.push("IdentityRegistry", event, params);
    },
    // MemoryRegistry shorthands
    created(owner = O, nsId = N) {
      return api.reg("NamespaceCreated", { owner, nsId });
    },
    grantSet(agentId: bigint, owner = O, nsId = N, scope = 1n, expiry = EXP) {
      return api.reg("GrantSet", { owner, nsId, agentId, scope, expiry });
    },
    wrapped(agentId: bigint, epoch: bigint, owner = O, nsId = N, wrap = WRAP) {
      return api.reg("KeyWrapped", { owner, nsId, agentId, epoch, wrap });
    },
    revoked(agentId: bigint, owner = O, nsId = N) {
      return api.reg("GrantRevoked", { owner, nsId, agentId });
    },
    rotated(newEpoch: bigint, owner = O, nsId = N) {
      return api.reg("EpochRotated", { owner, nsId, newEpoch });
    },
    appended(seq: bigint, owner = O, nsId = N, byOwner = true, agentId = 0n, epoch = 0n) {
      return api.reg("EntryAppended", { owner, nsId, seq, epoch, byOwner, agentId, ciphertext: CT });
    },
    keysSet(agentId: bigint, pub = K1, operator = H) {
      return api.reg("AgentKeysSet", { agentId, x25519Pub: pub, operator });
    },
    // IdentityRegistry shorthands
    transfer(from: string, to: string, tokenId: bigint) {
      return api.idr("Transfer", { from, to, tokenId });
    },
    registered(agentId: bigint, owner: string, agentURI = "https://a.example/card.json") {
      return api.idr("Registered", { agentId, agentURI, owner });
    },
    /** Normal EOA register(): mint, then Registered in the same tx. */
    mint(agentId: bigint, holder: string) {
      return api.tx().transfer(ZERO, holder, agentId).registered(agentId, holder);
    },
  };
  return api;
}

async function run(items: Sim[]) {
  const indexer = createTestIndexer();
  await indexer.process({ chains: { [CHAIN]: { simulate: items } } } as never);
  return indexer as any;
}

const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

// ------------------------------------------------------------------------------------------------ bugs hunted

describe("identity ordering: Registered is emitted after the mint callback", () => {
  it("mint-callback transfer: Registered(owner=W) must not resurrect W as tokenOwner after W->X in onERC721Received", async () => {
    // W.register(): _safeMint(W) -> W.onERC721Received transfers the token to X -> Registered(7, uri, W).
    // Onchain ownerOf(7) == X.
    const c = chain().tx().transfer(ZERO, W, 7n).transfer(W, X, 7n).registered(7n, W);
    const ix = await run(c.items);
    expect((await ix.Agent.getOrThrow("7")).tokenOwner).toBe(X);
  });

  it("mint-callback setAgentKeys then transfer: keysCurrent must be false (contract hasCurrentKeys false)", async () => {
    // Inside onERC721Received W (holder) calls setAgentKeys, then transfers to X. Contract: setBy W, ownerOf X.
    const c = chain().tx().transfer(ZERO, W, 7n).keysSet(7n, K1, W).transfer(W, X, 7n).registered(7n, W);
    const ix = await run(c.items);
    const a = await ix.Agent.getOrThrow("7");
    expect({ tokenOwner: a.tokenOwner, keysSetBy: a.keysSetBy, keysCurrent: a.keysCurrent }).toEqual({ tokenOwner: X, keysSetBy: W, keysCurrent: false });
  });

  it("mint-callback stale owner poisons keysSetBy: X sets keys, X->Y->W must leave keysCurrent false", async () => {
    // After the callback transfer X holds the token and X calls setAgentKeys (contract setBy = X).
    // Then X->Y and Y->W. Contract: setBy X != ownerOf W -> not current.
    const c = chain().tx().transfer(ZERO, W, 7n).transfer(W, X, 7n).registered(7n, W);
    c.tx().keysSet(7n, K1, X);
    c.tx().transfer(X, Y, 7n);
    c.tx().transfer(Y, W, 7n);
    const ix = await run(c.items);
    const a = await ix.Agent.getOrThrow("7");
    expect({ keysSetBy: a.keysSetBy, keysCurrent: a.keysCurrent }).toEqual({ keysSetBy: X, keysCurrent: false });
  });
});

describe("defensive invariants (not contract-reachable; spec case 13 says violations are recorded)", () => {
  it("duplicate EntryAppended seq: must not inflate entryCount/entriesWritten/DailyStat and must record IndexerError", async () => {
    const c = chain().tx().created();
    c.tx().appended(0n);
    c.tx().appended(0n); // seq 0 again: violates seq == nextSeq
    const ix = await run(c.items);
    const errors = await ix.IndexerError.getAll();
    expect({ entryCount: (await ix.Owner.getOrThrow(o)).entryCount, dayEntries: (await ix.DailyStat.getOrThrow(day(T1))).entries, errors: errors.length }).toEqual({
      entryCount: 1,
      dayEntries: 1,
      errors: 1,
    });
  });

  it("seq gap: EntryAppended seq 5 on a namespace with nextSeq 0 must record IndexerError", async () => {
    const c = chain().tx().created();
    c.tx().appended(5n);
    const ix = await run(c.items);
    expect((await ix.IndexerError.getAll()).length).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ expected to hold

describe("rotation and prune sequences the contract can emit", () => {
  it("rotate pruning several grantees (GrantRevoked x2, EpochRotated, KeyWrapped for survivor)", async () => {
    const c = chain().tx().created();
    for (const a of [7n, 9n, 11n]) c.tx().grantSet(a).wrapped(a, 0n);
    c.tx().revoked(9n).revoked(11n).rotated(1n).wrapped(7n, 1n, O, N, WRAP2);
    const ix = await run(c.items);
    const ns = await ix.Namespace.getOrThrow(NS);
    expect({ epoch: ns.epoch, granteeCount: ns.granteeCount }).toEqual({ epoch: 1n, granteeCount: 1 });
    expect((await ix.Agent.getOrThrow("9")).activeGrantCount).toBe(0);
    expect((await ix.Agent.getOrThrow("11")).activeGrantCount).toBe(0);
    expect((await ix.Agent.getOrThrow("7")).activeGrantCount).toBe(1);
    expect((await ix.WrappedKey.getOrThrow(`${NS}-7-1`)).wrap).toBe(WRAP2);
    expect((await ix.DailyStat.getOrThrow(day(T1))).revokes).toBe(2);
    expect((await ix.IndexerError.getAll()).length).toBe(0);
  });

  it("revoke(7) plus prune of expired 9 in one tx, no survivors", async () => {
    const c = chain().tx().created();
    c.tx().grantSet(7n).wrapped(7n, 0n);
    c.tx().grantSet(9n, O, N, 1n, BigInt(T1 + 10)).wrapped(9n, 0n);
    c.tx(T1 + 20).revoked(7n).revoked(9n).rotated(1n);
    const ix = await run(c.items);
    const grants = await ix.Grant.getAll();
    expect(grants.every((g: any) => g.active === false && g.revokedAt === BigInt(T1 + 20))).toBe(true);
    expect((await ix.Namespace.getOrThrow(NS)).granteeCount).toBe(0);
    expect((await ix.IndexerError.getAll()).length).toBe(0);
  });

  it("grant, prune by expiry, re-grant with history epochs [0,1] overwrites WrappedKey rows", async () => {
    const c = chain().tx().created();
    c.tx().grantSet(7n, O, N, 1n, BigInt(T1 + 10)).wrapped(7n, 0n);
    c.tx(T1 + 20).revoked(7n).rotated(1n);
    c.tx(T1 + 30).grantSet(7n, O, N, 3n, EXP).wrapped(7n, 0n, O, N, WRAP2).wrapped(7n, 1n, O, N, WRAP2);
    const ix = await run(c.items);
    const g = await ix.Grant.getOrThrow(`${NS}-7`);
    expect({ active: g.active, scope: g.scope, revokedAt: g.revokedAt ?? undefined }).toEqual({ active: true, scope: 3, revokedAt: undefined });
    expect((await ix.WrappedKey.getOrThrow(`${NS}-7-0`)).wrap).toBe(WRAP2);
    expect((await ix.WrappedKey.getOrThrow(`${NS}-7-1`)).wrap).toBe(WRAP2);
    expect((await ix.Agent.getOrThrow("7")).activeGrantCount).toBe(1);
    expect((await ix.Namespace.getOrThrow(NS)).granteeCount).toBe(1);
  });

  it("re-grant of an expired-but-unpruned grant does not double count (contract keeps it in grantees)", async () => {
    const c = chain().tx().created();
    c.tx().grantSet(7n, O, N, 1n, BigInt(T1 + 10)).wrapped(7n, 0n);
    c.tx(T1 + 100).grantSet(7n, O, N, 1n, EXP).wrapped(7n, 0n);
    const ix = await run(c.items);
    expect((await ix.Agent.getOrThrow("7")).activeGrantCount).toBe(1);
    expect((await ix.Namespace.getOrThrow(NS)).granteeCount).toBe(1);
  });

  it("same agent on two namespaces of one owner and on a second owner: activeGrantCount 3 then 2", async () => {
    const c = chain().tx().created(O, N).created(O, N2).created(O2, N);
    c.tx().grantSet(7n, O, N).grantSet(7n, O, N2).grantSet(7n, O2, N);
    c.tx().grantSet(7n, O, N2, 3n); // re-grant, no change in counts
    const ix1 = await run(c.items);
    expect((await ix1.Agent.getOrThrow("7")).activeGrantCount).toBe(3);
    c.tx().revoked(7n, O, N2).rotated(1n, O, N2);
    const ix2 = await run(c.items);
    expect((await ix2.Agent.getOrThrow("7")).activeGrantCount).toBe(2);
    expect((await ix2.Namespace.getOrThrow(`${o}-${N}`)).granteeCount).toBe(1);
    expect((await ix2.Namespace.getOrThrow(`${o}-${N2}`)).granteeCount).toBe(0);
    expect((await ix2.Namespace.getOrThrow(`${O2}-${N}`)).granteeCount).toBe(1);
    expect((await ix2.Owner.getOrThrow(o)).namespaceCount).toBe(2);
    expect((await ix2.Grant.getAll()).filter((g: any) => g.agent_id === "7").length).toBe(3);
  });

  it("token transfer then rotate prunes the stale-key grantee on every namespace it rotates", async () => {
    const c = chain().mint(7n, H);
    c.tx().keysSet(7n, K1, H);
    c.tx().created();
    c.tx().grantSet(7n).wrapped(7n, 0n);
    c.tx().transfer(H, X, 7n);
    c.tx().revoked(7n).rotated(1n); // pruned: keys not current
    const ix = await run(c.items);
    const a = await ix.Agent.getOrThrow("7");
    expect({ tokenOwner: a.tokenOwner, keysCurrent: a.keysCurrent, activeGrantCount: a.activeGrantCount }).toEqual({ tokenOwner: X, keysCurrent: false, activeGrantCount: 0 });
  });
});

describe("key currency mirrors _keysCurrent", () => {
  it("transfer away and back (H->X->H): keys current again", async () => {
    const c = chain().mint(7n, H);
    c.tx().keysSet(7n, K1, H);
    c.tx().transfer(H, X, 7n);
    c.tx().transfer(X, H, 7n);
    const ix = await run(c.items);
    expect((await ix.Agent.getOrThrow("7")).keysCurrent).toBe(true);
  });

  it("burn then re-mint to the original setter: current; re-mint to someone else: not current", async () => {
    const base = () => {
      const c = chain().mint(7n, H);
      c.tx().keysSet(7n, K1, H);
      c.tx().transfer(H, ZERO, 7n);
      return c;
    };
    const c1 = base();
    c1.tx().transfer(ZERO, H, 7n);
    expect((await (await run(c1.items)).Agent.getOrThrow("7")).keysCurrent).toBe(true);
    const c2 = base();
    c2.tx().transfer(ZERO, X, 7n);
    expect((await (await run(c2.items)).Agent.getOrThrow("7")).keysCurrent).toBe(false);
  });

  it("EOA register in one tx (Transfer then Registered) then keys: current, keysSetBy is holder", async () => {
    const c = chain().mint(7n, H);
    c.tx().keysSet(7n, K1, H);
    const a = await (await run(c.items)).Agent.getOrThrow("7");
    expect({ tokenOwner: a.tokenOwner, keysSetBy: a.keysSetBy, keysCurrent: a.keysCurrent }).toEqual({ tokenOwner: H, keysSetBy: H, keysCurrent: true });
  });

  it("URIUpdated, GrantSet, EntryAppended and GrantRevoked on the agent never flip keysCurrent", async () => {
    const c = chain().mint(7n, H);
    c.tx().keysSet(7n, K1, H);
    c.tx().transfer(H, X, 7n);
    c.tx().idr("URIUpdated", { agentId: 7n, newURI: "u2", updatedBy: X });
    const a = await (await run(c.items)).Agent.getOrThrow("7");
    expect(a.keysCurrent).toBe(false);
    const c2 = chain().mint(7n, H);
    c2.tx().keysSet(7n, K1, H);
    c2.tx().created();
    c2.tx().grantSet(7n, O, N, 3n).wrapped(7n, 0n);
    c2.tx().appended(0n, O, N, false, 7n);
    c2.tx().idr("URIUpdated", { agentId: 7n, newURI: "u2", updatedBy: H });
    const b = await (await run(c2.items)).Agent.getOrThrow("7");
    expect({ keysCurrent: b.keysCurrent, entriesWritten: b.entriesWritten, agentURI: b.agentURI }).toEqual({ keysCurrent: true, entriesWritten: 1, agentURI: "u2" });
  });

  it("AgentKeysSet key rotation by the same holder replaces pub and stays current", async () => {
    const c = chain().mint(7n, H);
    c.tx().keysSet(7n, K1, H);
    c.tx().keysSet(7n, K2.toUpperCase().replace("0X", "0x"), X.toUpperCase().replace("0X", "0x"));
    const a = await (await run(c.items)).Agent.getOrThrow("7");
    expect({ x25519Pub: a.x25519Pub, operator: a.operator, keysCurrent: a.keysCurrent }).toEqual({ x25519Pub: K2, operator: X, keysCurrent: true });
  });
});

describe("ids, casing, and extreme values", () => {
  it("uint256 max agentId, uint64 max epoch/expiry, large seq round-trip through ids", async () => {
    const MAXA = 2n ** 256n - 1n;
    const MAX64 = 2n ** 64n - 1n;
    const c = chain().tx().created();
    c.tx().grantSet(MAXA, O, N, 3n, MAX64).wrapped(MAXA, MAX64 - 1n);
    c.tx().appended(0n, O, N, false, MAXA);
    const ix = await run(c.items);
    const g = await ix.Grant.getOrThrow(`${NS}-${MAXA}`);
    expect({ agent_id: g.agent_id, expiry: g.expiry, scope: g.scope }).toEqual({ agent_id: MAXA.toString(), expiry: MAX64, scope: 3 });
    expect((await ix.WrappedKey.getOrThrow(`${NS}-${MAXA}-${MAX64 - 1n}`)).epoch).toBe(MAX64 - 1n);
    expect((await ix.Entry.getOrThrow(`${NS}-0`)).agentId).toBe(MAXA);
    expect((await ix.Agent.getOrThrow(MAXA.toString())).entriesWritten).toBe(1);
  });

  it("mixed-case owner and nsId across events land on the same rows", async () => {
    const NU = "0x" + "AB".repeat(32);
    const c = chain().tx().created(O.toUpperCase().replace("0X", "0x"), NU);
    c.tx().grantSet(7n, o, NU).wrapped(7n, 0n, O, N);
    c.tx().appended(0n, O, NU);
    c.tx().revoked(7n, o, N).rotated(1n, O.toUpperCase().replace("0X", "0x"), NU);
    const ix = await run(c.items);
    expect((await ix.Namespace.getAll()).length).toBe(1);
    const ns = await ix.Namespace.getOrThrow(NS);
    expect({ epoch: ns.epoch, nextSeq: ns.nextSeq, granteeCount: ns.granteeCount, nsId: ns.nsId }).toEqual({ epoch: 1n, nextSeq: 1n, granteeCount: 0, nsId: N });
    expect((await ix.WrappedKey.getOrThrow(`${NS}-7-0`)).grant_id).toBe(`${NS}-7`);
    expect((await ix.IndexerError.getAll()).length).toBe(0);
    expect((await ix.OwnerDay.getAll()).length).toBe(1);
    expect((await ix.DailyStat.getOrThrow(day(T1))).activeOwners).toBe(1);
  });

  it("same nsId under two owners: entries and counters do not collide", async () => {
    const c = chain().tx().created(O, N).created(O2, N);
    c.tx().appended(0n, O, N).appended(0n, O2, N).appended(1n, O2, N);
    const ix = await run(c.items);
    expect((await ix.Entry.getAll()).length).toBe(3);
    expect((await ix.Owner.getOrThrow(o)).entryCount).toBe(1);
    expect((await ix.Owner.getOrThrow(O2)).entryCount).toBe(2);
    expect((await ix.Namespace.getOrThrow(`${O2}-${N}`)).nextSeq).toBe(2n);
  });

  it("two invariant violations in one block at different logIndex produce two IndexerError rows", async () => {
    const c = chain().tx().revoked(7n).revoked(9n).rotated(1n);
    const ix = await run(c.items);
    expect((await ix.IndexerError.getAll()).length).toBe(3);
  });
});

describe("DailyStat and OwnerDay", () => {
  it("UTC midnight boundary: last second of day and exact midnight are different days", async () => {
    const MID = Math.ceil(T1 / 86_400) * 86_400;
    const c = chain().tx(MID - 1).created();
    c.tx(MID).appended(0n);
    const ix = await run(c.items);
    expect(day(MID - 1)).not.toBe(day(MID));
    expect((await ix.DailyStat.getOrThrow(day(MID - 1))).activeOwners).toBe(1);
    expect(await ix.DailyStat.getOrThrow(day(MID))).toMatchObject({ entries: 1, activeOwners: 1 });
  });

  it("two owners same day count 2; same owner on two days counts 1 per day", async () => {
    const c = chain().tx().created(O, N).created(O2, N);
    c.tx(T1 + 86_400).appended(0n, O, N);
    const ix = await run(c.items);
    expect((await ix.DailyStat.getOrThrow(day(T1))).activeOwners).toBe(2);
    expect((await ix.DailyStat.getOrThrow(day(T1 + 86_400))).activeOwners).toBe(1);
  });
});
