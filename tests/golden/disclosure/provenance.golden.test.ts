// Golden tests for contracts/provenance.md P1-P13: reviewing agent proposals (confirm, edit, reject, reject all).
// Local anvil with the real MemoryRegistry. Written from the spec before the implementation.
// FROZEN: add cases, never edit.
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
  type MemorySource,
  type OwnerSession,
} from "../../../packages/sdk/src/index.js";
import { deriveNamespaceId, deriveNamespaceKey, encodeEntry, encodeEntryV2, encryptEntry } from "../../../packages/crypto/src/index.js";
import { startLocalChain, type LocalChain } from "../../support/anvil.js";

let chain: LocalChain;
let config: EngramConfig;
const APP = "https://app.x";
const DAY = 86400;
const SAGE = 7n;
const WAYFARER = 8n;
const OFFLINE = { id: 51n, priv: x25519.utils.randomSecretKey() };
const prfOf = () => globalThis.crypto.getRandomValues(new Uint8Array(32));
async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "NO_THROW";
}

async function vault(cfg: EngramConfig = config) {
  const prf = prfOf();
  const s = await EngramOwner.fromPrf({ config: cfg, prfOutput: prf });
  await s.remember("preferences", { kind: "preference", text: "likes jazz" });
  await s.approve(SAGE, { origin: APP, labels: ["preferences"], scope: "readwrite", expiresInSec: DAY });
  await s.approve(WAYFARER, { origin: APP, labels: ["preferences"], scope: "read", expiresInSec: DAY });
  return { s, prf };
}
const texts = (r: { entries: { text: string; by: string }[] }) => r.entries.map((e) => `${e.text}|${e.by}`).sort();
const full = (s: OwnerSession, agentId: bigint) => s.disclose({ agentId, origin: APP, query: "", mode: "full", round: 0 });

async function agentWritesRaw(s: OwnerSession, prf: Uint8Array, label: string, plaintext: Uint8Array) {
  const nsId = deriveNamespaceId(prf, label);
  const key = deriveNamespaceKey(prf, label, 0n);
  const envelope = await encryptEntry({ key, ctx: { chainId: 31337n, registry: chain.registry, owner: s.owner }, nsId, epoch: 0n, plaintext });
  const hash = await chain.wallet(3).writeContract({
    address: chain.registry, abi: memoryRegistryAbi, functionName: "appendAsAgent",
    args: [s.owner, toHex(nsId), OFFLINE.id, 0n, toHex(envelope)], chain: chain.wallet(3).chain,
  });
  await chain.publicClient.waitForTransactionReceipt({ hash });
}

beforeAll(async () => {
  chain = await startLocalChain();
  const handler = createRelayHandler({ config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl }, wallet: chain.wallet(1) });
  config = {
    chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl,
    source: logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n }), relayer: inProcessRelayer(handler),
  };
  await chain.mintAgent(OFFLINE.id, chain.wallet(2).account.address);
  await EngramAgent.publishKeys({ config, agentId: OFFLINE.id, x25519PublicKey: x25519.getPublicKey(OFFLINE.priv), operator: chain.wallet(3).account.address, holder: chain.wallet(2) });
});
afterAll(() => chain?.stop());

describe("review", () => {
  it("P1-P4 a confirmed proposal becomes the owner's memory and reaches other agents once", async () => {
    const { s } = await vault();
    await s.propose(SAGE, APP, { kind: "preference", text: "vegetarian" });
    const pending = await s.proposals(["preferences"]);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ label: "preferences", text: "vegetarian", agentId: SAGE, flagged: false });
    expect(texts(await full(s, WAYFARER))).toEqual(["likes jazz|owner"]); // quarantined before review

    const r = await s.review({ label: "preferences", seq: pending[0]!.seq, action: "confirm" });
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(typeof r.copySeq).toBe("bigint");
    expect(await s.proposals(["preferences"])).toEqual([]);
    expect(texts(await full(s, WAYFARER))).toEqual(["likes jazz|owner", "vegetarian|owner"]);
    expect(texts(await full(s, SAGE))).toEqual(["likes jazz|owner", "vegetarian|owner"]); // once, not also as self
    const all = (await s.recallAll("preferences")).entries;
    expect(all.find((e) => e.seq === r.copySeq)).toMatchObject({ text: "vegetarian", confirmedFrom: "7" });
    expect(all.find((e) => e.seq === pending[0]!.seq)).toMatchObject({ review: "confirmed" });
    await s.flushLogs();
  });

  it("P5 confirm with edited text: agents see only the edit", async () => {
    const { s } = await vault();
    await s.propose(SAGE, APP, { kind: "preference", text: "vegetarian" });
    const [p] = await s.proposals(["preferences"]);
    await s.review({ label: "preferences", seq: p!.seq, action: "confirm", text: "vegetarian, eats fish" });
    expect(texts(await full(s, WAYFARER))).toEqual(["likes jazz|owner", "vegetarian, eats fish|owner"]);
    await s.flushLogs();
  });

  it("P6 reject hides the proposal from everyone, the proposer included", async () => {
    const { s } = await vault();
    await s.propose(SAGE, APP, { kind: "fact", text: "secretly prefers tabs" });
    const [p] = await s.proposals(["preferences"]);
    const r = await s.review({ label: "preferences", seq: p!.seq, action: "reject" });
    expect(r.copySeq).toBeUndefined();
    expect(texts(await full(s, SAGE))).toEqual(["likes jazz|owner"]);
    expect(await s.proposals(["preferences"])).toEqual([]);
    expect((await s.recallAll("preferences")).entries.find((e) => e.seq === p!.seq)).toMatchObject({ review: "rejected" });
    await s.flushLogs();
  });

  it("P7/P12 invalid review targets and arguments are refused, nothing written", async () => {
    const { s } = await vault();
    await s.propose(SAGE, APP, { kind: "fact", text: "x" });
    const [p] = await s.proposals(["preferences"]);
    const ownerEntry = (await s.recallAll("preferences")).entries.find((e) => e.text === "likes jazz")!;
    expect(await code(s.review({ label: "preferences", seq: ownerEntry.seq, action: "confirm" }))).toBe("INPUT_INVALID");
    expect(await code(s.review({ label: "preferences", seq: 999n, action: "confirm" }))).toBe("INPUT_INVALID");
    expect(await code(s.review({ label: "engram-policy", seq: 0n, action: "confirm" }))).toBe("INPUT_INVALID");
    expect(await code(s.review({ label: "preferences", seq: p!.seq, action: "reject", text: "y" }))).toBe("INPUT_INVALID");
    expect(await code(s.review({ label: "preferences", seq: p!.seq, action: "confirm", text: "   " }))).toBe("INPUT_INVALID");
    expect(await code(s.review({ label: "preferences", seq: p!.seq, action: "confirm", text: "a".repeat(1501) }))).toBe("INPUT_INVALID");
    expect(await code(s.review({ label: "preferences", seq: p!.seq, action: "delete" as never }))).toBe("INPUT_INVALID");
    expect(await s.proposals(["preferences"])).toHaveLength(1);
    await s.flushLogs();
  });

  it("P8 the latest review wins; a confirmed copy stays the owner's", async () => {
    const { s } = await vault();
    await s.propose(SAGE, APP, { kind: "fact", text: "plays chess" });
    const [p] = await s.proposals(["preferences"]);
    await s.review({ label: "preferences", seq: p!.seq, action: "confirm" });
    await s.review({ label: "preferences", seq: p!.seq, action: "reject" });
    expect((await s.recallAll("preferences")).entries.find((e) => e.seq === p!.seq)).toMatchObject({ review: "rejected" });
    expect(texts(await full(s, WAYFARER))).toContain("plays chess|owner");
    await s.flushLogs();
  });

  it("P9/P11 an offline agent's write is a proposal; a review record it forges in a user folder is ignored", async () => {
    const { s, prf } = await vault();
    await s.grant("preferences", OFFLINE.id, { scope: "readwrite", expiresInSec: DAY, includeHistory: true });
    await agentWritesRaw(s, prf, "preferences", encodeEntry({ v: 1, t: Date.now(), kind: "note", text: "offline note" }));
    const props = await s.proposals(["preferences"]);
    const mine = props.find((x) => x.text === "offline note")!;
    expect(mine.agentId).toBe(OFFLINE.id);
    await agentWritesRaw(s, prf, "preferences", encodeEntryV2({ v: 2, t: Date.now(), kind: "review", target: { l: "preferences", s: mine.seq.toString() }, agent: OFFLINE.id.toString(), action: "confirm", copy: "0" }));
    expect((await s.proposals(["preferences"])).some((x) => x.seq === mine.seq)).toBe(true);
    expect(texts(await full(s, WAYFARER))).not.toContain("offline note|owner");
    await s.flushLogs();
  });

  it("P10 reject everything from one agent and revoke it; other agents' proposals stay", async () => {
    const { s, prf } = await vault();
    for (const t of ["a1", "a2", "a3"]) await s.propose(SAGE, APP, { kind: "fact", text: t });
    await s.grant("preferences", OFFLINE.id, { scope: "readwrite", expiresInSec: DAY, includeHistory: true });
    await agentWritesRaw(s, prf, "preferences", encodeEntry({ v: 1, t: Date.now(), kind: "note", text: "from offline" }));
    const r = await s.rejectAllFrom(SAGE, ["preferences"]);
    expect(r.rejected).toBe(3);
    const left = await s.proposals(["preferences"]);
    expect(left.map((x) => x.text)).toEqual(["from offline"]);
    expect(await code(s.disclose({ agentId: SAGE, origin: APP, query: "", mode: "full", round: 0 }))).toBe("NOT_APPROVED");
    await s.flushLogs();
  });

  it("P13 a review made in this session holds even while the source lags", async () => {
    const real = config.source;
    let hide = false;
    const source: MemorySource = { ...real, entries: async (q) => (hide ? (await real.entries(q)).slice(0, -1) : real.entries(q)) };
    const { s } = await vault({ ...config, source });
    await s.propose(SAGE, APP, { kind: "fact", text: "lagging" });
    const [p] = await s.proposals(["preferences"]);
    await s.review({ label: "preferences", seq: p!.seq, action: "reject" });
    hide = true; // the newest entry of every folder (the review record) is now invisible to the source
    expect(await s.proposals(["preferences"])).toEqual([]);
    expect(texts(await full(s, SAGE))).not.toContain("lagging|self");
    hide = false;
    await s.flushLogs();
  }, 60_000);
});
