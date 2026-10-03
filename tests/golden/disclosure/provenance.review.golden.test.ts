// Regression cases for the provenance review (BUGLOG PR-1..PR-4, PR-6; contracts/provenance.md P17-P23).
// Local anvil with the real MemoryRegistry. FROZEN: add cases, never edit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import { toHex } from "viem";
import {
  EngramAgent,
  EngramOwner,
  createRelayHandler,
  inProcessRelayer,
  logsSource,
  memoryRegistryAbi,
  type EngramConfig,
  type OwnerSession,
  type Relayer,
} from "../../../packages/sdk/src/index.js";
import { deriveNamespaceId, deriveNamespaceKey, encodeEntry, encryptEntry } from "../../../packages/crypto/src/index.js";
import { startLocalChain, type LocalChain } from "../../support/anvil.js";

let chain: LocalChain;
let config: EngramConfig;
let base: Relayer;
const APP = "https://app.x";
const DAY = 86400;
const SAGE = 7n;
const WAYFARER = 8n;
const OFFLINE = { id: 61n, priv: x25519.utils.randomSecretKey() };
const prfOf = () => globalThis.crypto.getRandomValues(new Uint8Array(32));
const count = (r: { entries: { text: string }[] }, text: string) => r.entries.filter((e) => e.text === text).length;
const full = (s: OwnerSession, agentId: bigint) => s.disclose({ agentId, origin: APP, query: "", mode: "full", round: 0 });

async function vault(cfg: EngramConfig = config, prf = prfOf()) {
  const s = await EngramOwner.fromPrf({ config: cfg, prfOutput: prf });
  await s.remember("preferences", { kind: "preference", text: "likes jazz" });
  await s.approve(SAGE, { origin: APP, labels: ["preferences"], scope: "readwrite", expiresInSec: DAY });
  await s.approve(WAYFARER, { origin: APP, labels: ["preferences"], scope: "read", expiresInSec: DAY });
  return { s, prf };
}
async function offlineWrites(s: OwnerSession, prf: Uint8Array, texts: string[]) {
  const nsId = deriveNamespaceId(prf, "preferences");
  const key = deriveNamespaceKey(prf, "preferences", 0n);
  for (const t of texts) {
    const envelope = await encryptEntry({ key, ctx: { chainId: 31337n, registry: chain.registry, owner: s.owner }, nsId, epoch: 0n, plaintext: encodeEntry({ v: 1, t: Date.now(), kind: "note", text: t }) });
    const hash = await chain.wallet(3).writeContract({ address: chain.registry, abi: memoryRegistryAbi, functionName: "appendAsAgent", args: [s.owner, toHex(nsId), OFFLINE.id, 0n, toHex(envelope)], chain: chain.wallet(3).chain });
    await chain.publicClient.waitForTransactionReceipt({ hash, pollingInterval: 50 }); // viem's default 4 s poll would dominate
  }
}

beforeAll(async () => {
  chain = await startLocalChain();
  const handler = createRelayHandler({ config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl }, wallet: chain.wallet(1) });
  base = inProcessRelayer(handler);
  config = {
    chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl,
    source: logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n }), relayer: base,
  };
  await chain.mintAgent(OFFLINE.id, chain.wallet(2).account.address);
  await EngramAgent.publishKeys({ config, agentId: OFFLINE.id, x25519PublicKey: x25519.getPublicKey(OFFLINE.priv), operator: chain.wallet(3).account.address, holder: chain.wallet(2) });
});
afterAll(() => chain?.stop());

describe("idempotent, consistent confirm", () => {
  it("P17 a confirm retried after its review write failed leaves one copy", async () => {
    let allow = Infinity;
    const relayer: Relayer = { submit: (r) => (allow-- > 0 ? base.submit(r) : Promise.reject(Object.assign(new Error("down"), { code: "RELAYER_UNAVAILABLE" }))) };
    const { s } = await vault({ ...config, relayer });
    await s.propose(SAGE, APP, { kind: "preference", text: "vegetarian" });
    const [p] = await s.proposals(["preferences"]);
    allow = 1; // the copy lands, the review record does not
    await expect(s.review({ label: "preferences", seq: p!.seq, action: "confirm" })).rejects.toBeDefined();
    allow = Infinity;
    await s.review({ label: "preferences", seq: p!.seq, action: "confirm" });
    const mine = (await s.recallAll("preferences")).entries.filter((e) => e.text === "vegetarian" && !e.src);
    expect(mine).toHaveLength(1);
    expect(count(await full(s, WAYFARER), "vegetarian")).toBe(1);
    await s.flushLogs();
  }, 60_000);

  it("P18 two sessions confirming at once: agents see one copy", async () => {
    const { s, prf } = await vault();
    await s.propose(SAGE, APP, { kind: "preference", text: "vegan on weekdays" });
    const [p] = await s.proposals(["preferences"]);
    const t = await EngramOwner.fromPrf({ config, prfOutput: new Uint8Array(prf) });
    await Promise.all([
      s.review({ label: "preferences", seq: p!.seq, action: "confirm" }),
      t.review({ label: "preferences", seq: p!.seq, action: "confirm" }),
    ]);
    const fresh = await EngramOwner.fromPrf({ config, prfOutput: new Uint8Array(prf) });
    expect(count(await full(fresh, WAYFARER), "vegan on weekdays")).toBe(1);
    await Promise.all([s.flushLogs(), t.flushLogs(), fresh.flushLogs()]);
  }, 60_000);

  it("P19 confirm then reject: the copy keeps confirmedFrom", async () => {
    const { s } = await vault();
    await s.propose(SAGE, APP, { kind: "fact", text: "plays chess" });
    const [p] = await s.proposals(["preferences"]);
    const r = await s.review({ label: "preferences", seq: p!.seq, action: "confirm" });
    await s.review({ label: "preferences", seq: p!.seq, action: "reject" });
    expect((await s.recallAll("preferences")).entries.find((e) => e.seq === r.copySeq)).toMatchObject({ confirmedFrom: "7" });
    await s.flushLogs();
  });

  it("P22 a re-proposal identical to an owner memory is not listed or disclosed", async () => {
    const { s } = await vault();
    await s.propose(SAGE, APP, { kind: "preference", text: "vegetarian" });
    const [p] = await s.proposals(["preferences"]);
    await s.review({ label: "preferences", seq: p!.seq, action: "confirm" });
    await s.propose(SAGE, APP, { kind: "preference", text: " Vegetarian " });
    expect(await s.proposals(["preferences"])).toEqual([]);
    const r = await full(s, SAGE);
    expect(r.entries.filter((e) => e.text.trim().toLowerCase() === "vegetarian")).toHaveLength(1);
    await s.flushLogs();
  });
});

describe("reject all", () => {
  it("P20/P21/P23 a flood of 55 offline proposals: inbox shows 50, counts 55, reject-all clears all and revokes the key", async () => {
    const { s, prf } = await vault();
    await s.grant("preferences", OFFLINE.id, { scope: "readwrite", expiresInSec: DAY, includeHistory: true });
    await offlineWrites(s, prf, Array.from({ length: 55 }, (_, i) => `flood ${i}`));
    const listed = await s.proposals(["preferences"]);
    expect(listed.filter((p) => p.agentId === OFFLINE.id)).toHaveLength(50);
    expect((await s.proposalCounts(["preferences"]))[OFFLINE.id.toString()]).toBe(55);
    const r = await s.rejectAllFrom(OFFLINE.id, ["preferences"]);
    expect(r.rejected).toBe(55);
    expect(await s.proposals(["preferences"])).toEqual([]);
    const g = (await s.grants()).filter((x) => x.agentId === OFFLINE.id);
    expect(g.every((x) => !x.active)).toBe(true);
    await s.flushLogs();
  }, 180_000);
});

describe("no duplicates (P26)", () => {
  it("P26 a confirming session itself sees one copy right after a concurrent confirm", async () => {
    const { s, prf } = await vault();
    await s.propose(SAGE, APP, { kind: "preference", text: "aisle seats" });
    const [p] = await s.proposals(["preferences"]);
    const t = await EngramOwner.fromPrf({ config, prfOutput: new Uint8Array(prf) });
    await Promise.all([s.review({ label: "preferences", seq: p!.seq, action: "confirm" }), t.review({ label: "preferences", seq: p!.seq, action: "confirm" })]);
    expect(count(await full(s, WAYFARER), "aisle seats")).toBe(1);
    expect(count(await full(t, WAYFARER), "aisle seats")).toBe(1);
    await Promise.all([s.flushLogs(), t.flushLogs()]);
  }, 60_000);
});
