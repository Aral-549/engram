// Golden tests for Disclosure mode in the SDK: contracts/disclosure.md D1-D20, D26 and contracts/sdk.md 48-52.
// Local anvil with the real MemoryRegistry bytecode. Written from the spec before the implementation.
// FROZEN: add cases, never edit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import {
  EngramAgent,
  EngramOwner,
  createRelayHandler,
  inProcessRelayer,
  logsSource,
  openVaultBridge,
  startBridge,
  verifyAppSession,
  type EngramConfig,
  type OwnerSession,
} from "../../../packages/sdk/src/index.js";
import { startLocalChain, type LocalChain } from "../../support/anvil.js";

let chain: LocalChain;
let config: EngramConfig;
const APP = "https://app.x";
const VAULT = "https://vault.x";
const DAY = 86400;

const prfOf = () => globalThis.crypto.getRandomValues(new Uint8Array(32));
async function code(p: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "NO_THROW";
}
const texts = (r: { entries: { text: string }[] }) => r.entries.map((e) => e.text);

async function vaultWith(memories: string[], opts: { prf?: Uint8Array; clock?: () => number } = {}) {
  const s = await EngramOwner.fromPrf({ config, prfOutput: opts.prf ?? prfOf(), clock: opts.clock });
  for (const m of memories) await s.remember("preferences", { kind: "preference", text: m });
  return s;
}

/** In-memory postMessage bus between an app page (APP) and the vault bridge iframe (VAULT). */
function bus() {
  const appL = new Set<(e: MessageEvent) => void>();
  const vaultL = new Set<(e: MessageEvent) => void>();
  const sent: { msg: unknown; target: string }[] = [];
  const deliver = (set: Set<(e: MessageEvent) => void>, e: { origin: string; data: unknown; source: unknown }) =>
    queueMicrotask(() => set.forEach((f) => f(e as MessageEvent)));
  // frameWin is what the app holds (iframe.contentWindow); parentRef is what the vault holds (window.parent).
  const parentRef = {
    postMessage(msg: unknown, target: string) {
      sent.push({ msg, target });
      if (target === APP) deliver(appL, { origin: VAULT, data: structuredClone(msg), source: frameWin });
    },
  };
  const frameWin = {
    postMessage(msg: unknown, target: string) {
      if (target === VAULT) deliver(vaultL, { origin: APP, data: structuredClone(msg), source: parentRef });
    },
  };
  return {
    sent,
    frame: { contentWindow: frameWin },
    appWin: { addEventListener: (_t: string, f: (e: MessageEvent) => void) => appL.add(f), removeEventListener: (_t: string, f: (e: MessageEvent) => void) => appL.delete(f) },
    vaultWin: { parent: parentRef, addEventListener: (_t: string, f: (e: MessageEvent) => void) => vaultL.add(f), removeEventListener: (_t: string, f: (e: MessageEvent) => void) => vaultL.delete(f) },
    /** Inject a raw message into the vault, as if from `origin` and `source`. */
    toVault(origin: string, data: unknown, source: unknown = parentRef) {
      deliver(vaultL, { origin, data, source });
    },
  };
}
const req = (op: string, args: unknown, id = "r1") => ({ type: "engram:bridge:req", v: 1, id, op, args });
const tick = () => new Promise((r) => setTimeout(r, 50));

beforeAll(async () => {
  chain = await startLocalChain();
  const handler = createRelayHandler({ config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl }, wallet: chain.wallet(1) });
  config = {
    chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl,
    source: logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n }), relayer: inProcessRelayer(handler),
  };
});
afterAll(() => chain?.stop());

describe("approval and pseudonyms", () => {
  it("D1/48 approve writes a policy entry, no onchain grant; reply carries the pairwise owner", async () => {
    const s = await vaultWith(["vegetarian"]);
    const r = await s.approve(7n, { origin: APP, labels: ["preferences"], scope: "read", expiresInSec: DAY });
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.pairwiseOwner).toBe(s.pairwise(7n));
    expect(r.pairwiseOwner.toLowerCase()).not.toBe(s.owner.toLowerCase());
    const ps = await s.policies();
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ agentId: 7n, origin: APP, labels: ["preferences"], scope: "read", active: true });
    expect(await s.grants()).toEqual([]);
  });

  it("49 the latest approval for an agent wins", async () => {
    const s = await vaultWith([]);
    await s.approve(7n, { origin: APP, labels: ["preferences"], scope: "read", expiresInSec: DAY });
    await s.approve(7n, { origin: APP, labels: ["preferences", "travel"], scope: "readwrite", expiresInSec: DAY });
    const ps = await s.policies();
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ labels: ["preferences", "travel"], scope: "readwrite" });
  });

  it("D2 a pairwise session proof verifies and recovers the pairwise address", async () => {
    const s = await vaultWith([]);
    const proof = await s.signAppSession({ agentId: 7n, origin: APP, ttlSec: 600, pairwise: true });
    expect(proof.owner).toBe(s.pairwise(7n));
    expect(await verifyAppSession(proof, { config, agentId: 7n, origin: APP })).toBe(s.pairwise(7n));
  });

  it("D3/D4 pairwise ids are stable across devices, distinct per agent, and never appear onchain", async () => {
    const prf = prfOf();
    const a = await vaultWith(["x"], { prf });
    const b = await EngramOwner.fromPrf({ config, prfOutput: new Uint8Array(prf) });
    expect(b.pairwise(7n)).toBe(a.pairwise(7n));
    expect(new Set([a.owner, a.pairwise(7n), a.pairwise(8n)].map((x) => x.toLowerCase())).size).toBe(3);
    await a.approve(7n, { origin: APP, labels: ["preferences"], scope: "readwrite", expiresInSec: DAY });
    await a.approve(8n, { origin: APP, labels: ["preferences"], scope: "read", expiresInSec: DAY });
    const logs = await chain.publicClient.getLogs({ address: chain.registry, fromBlock: 0n });
    const needles = [a.pairwise(7n), a.pairwise(8n)].map((x) => x.slice(2).toLowerCase());
    for (const l of logs) {
      const tx = await chain.publicClient.getTransaction({ hash: l.transactionHash! });
      const hay = (l.data + l.topics.join("") + tx.input + tx.from).toLowerCase();
      for (const n of needles) expect(hay.includes(n)).toBe(false);
    }
  });

  it("D15 approvals for reserved folders are rejected", async () => {
    const s = await vaultWith([]);
    expect(await code(s.approve(7n, { origin: APP, labels: ["engram-log"], scope: "read", expiresInSec: DAY }))).toBe("INPUT_INVALID");
    expect(await code(s.approve(7n, { origin: "https://app.x/", labels: ["preferences"], scope: "read", expiresInSec: DAY }))).toBe("INPUT_INVALID");
  });
});

describe("disclosure", () => {
  let s: OwnerSession;
  beforeAll(async () => {
    s = await vaultWith(["vegetarian", "allergic to peanuts", "likes jazz"]);
    await s.remember("work", { kind: "fact", text: "salary is confidential" });
    await s.approve(7n, { origin: APP, labels: ["preferences"], scope: "read", expiresInSec: DAY });
  });

  it("D6 returns only relevant entries, by owner, and logs the read", async () => {
    const r = await s.disclose({ agentId: 7n, origin: APP, query: "Plan dinner, any allergy concerns?", mode: "relevant", round: 0 });
    expect(r.entries).toEqual([{ kind: "preference", text: "allergic to peanuts", by: "owner" }]);
    await s.flushLogs();
    const [log] = await s.disclosures({ agentId: 7n });
    expect(log).toMatchObject({ q: "Plan dinner, any allergy concerns?", mode: "relevant", n: 1, round: 0 });
    expect(log!.refs).toHaveLength(1);
  });

  it("D7/D8 stopword-only and unmatched queries return nothing but are logged; full returns all", async () => {
    expect(texts(await s.disclose({ agentId: 7n, origin: APP, query: "What do you know about me?", mode: "relevant", round: 0 }))).toEqual([]);
    expect(texts(await s.disclose({ agentId: 7n, origin: APP, query: "quantum", mode: "relevant", round: 0 }))).toEqual([]);
    const full = await s.disclose({ agentId: 7n, origin: APP, query: "", mode: "full", round: 1 });
    expect(texts(full).sort()).toEqual(["allergic to peanuts", "likes jazz", "vegetarian"]);
    await s.flushLogs();
    const logs = await s.disclosures({ agentId: 7n });
    expect(logs[0]).toMatchObject({ mode: "full", n: 3, round: 1 });
    expect(logs.some((l) => l.q === "quantum" && l.n === 0)).toBe(true);
  });

  it("D14 unapproved folders never leak, even for a matching query", async () => {
    const r = await s.disclose({ agentId: 7n, origin: APP, query: "salary confidential", mode: "relevant", round: 0 });
    expect(r.entries).toEqual([]);
    const full = await s.disclose({ agentId: 7n, origin: APP, query: "", mode: "full", round: 0 });
    expect(JSON.stringify(full)).not.toContain("salary");
  });

  it("50 no approval, wrong origin, or bad arguments are refused", async () => {
    expect(await code(s.disclose({ agentId: 99n, origin: APP, query: "jazz", mode: "relevant", round: 0 }))).toBe("NOT_APPROVED");
    expect(await code(s.disclose({ agentId: 7n, origin: "https://evil.x", query: "jazz", mode: "relevant", round: 0 }))).toBe("NOT_APPROVED");
    expect(await code(s.disclose({ agentId: 7n, origin: APP, query: "x".repeat(501), mode: "relevant", round: 0 }))).toBe("BAD_REQUEST");
    expect(await code(s.disclose({ agentId: 7n, origin: APP, query: "jazz", mode: "peek" as never, round: 0 }))).toBe("BAD_REQUEST");
    expect(await code(s.disclose({ agentId: 7n, origin: APP, query: "jazz", mode: "relevant", round: 4 }))).toBe("BAD_REQUEST");
  });

  it("D11 an expired approval answers EXPIRED", async () => {
    let now = Date.now();
    const t = await vaultWith(["jazz"], { clock: () => now });
    await t.approve(7n, { origin: APP, labels: ["preferences"], scope: "read", expiresInSec: 2 });
    now += 3000;
    expect(await code(t.disclose({ agentId: 7n, origin: APP, query: "jazz", mode: "relevant", round: 0 }))).toBe("EXPIRED");
  });

  it("D12/50 a revoke from another device takes effect once the cached policy is older than 3 s", async () => {
    const prf = prfOf();
    let now = Date.now();
    const a = await vaultWith(["jazz"], { prf, clock: () => now });
    await a.approve(7n, { origin: APP, labels: ["preferences"], scope: "read", expiresInSec: DAY });
    expect(texts(await a.disclose({ agentId: 7n, origin: APP, query: "jazz", mode: "relevant", round: 0 }))).toEqual(["jazz"]);
    const b = await EngramOwner.fromPrf({ config, prfOutput: new Uint8Array(prf) });
    await b.disapprove(7n);
    now += 5000;
    expect(await code(a.disclose({ agentId: 7n, origin: APP, query: "jazz", mode: "relevant", round: 0 }))).toBe("NOT_APPROVED");
  });

  it("D13 a revoke during a read lets that read finish and blocks the next", async () => {
    const t = await vaultWith(["jazz"]);
    await t.approve(7n, { origin: APP, labels: ["preferences"], scope: "read", expiresInSec: DAY });
    const inFlight = t.disclose({ agentId: 7n, origin: APP, query: "jazz", mode: "relevant", round: 0 });
    const revoke = t.disapprove(7n);
    expect(texts(await inFlight)).toEqual(["jazz"]);
    await revoke;
    expect(await code(t.disclose({ agentId: 7n, origin: APP, query: "jazz", mode: "relevant", round: 0 }))).toBe("NOT_APPROVED");
  });
});

describe("proposals", () => {
  it("D16-D19 read approvals cannot propose; proposals are owner-written v2, visible to the proposer only", async () => {
    const s = await vaultWith(["vegetarian"]);
    await s.approve(7n, { origin: APP, labels: ["preferences"], scope: "readwrite", expiresInSec: DAY });
    await s.approve(8n, { origin: APP, labels: ["preferences"], scope: "read", expiresInSec: DAY });
    expect(await code(s.propose(8n, APP, { kind: "preference", text: "aisle seats" }))).toBe("READ_ONLY");
    const w = await s.propose(7n, APP, { kind: "preference", text: "prefers window seats" });
    expect(w.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const all = await s.recallAll("preferences");
    const p = all.entries.find((e) => e.text === "prefers window seats")!;
    expect(p).toMatchObject({ byOwner: true, src: { agent: "7" } });
    expect(await s.disclose({ agentId: 7n, origin: APP, query: "seats", mode: "relevant", round: 0 })).toMatchObject({
      entries: [{ kind: "preference", text: "prefers window seats", by: "self" }],
    });
    expect((await s.disclose({ agentId: 8n, origin: APP, query: "seats", mode: "relevant", round: 0 })).entries).toEqual([]);
    await s.flushLogs();
    expect((await s.disclosures({ agentId: 7n })).some((l) => l.mode === "write" && l.n === 1)).toBe(true);
    // plain recall (v1) is unchanged: the proposal is skipped, the owner's entry is returned
    const v1 = await s.recall("preferences");
    expect(v1.entries.map((e) => e.text)).toEqual(["vegetarian"]);
    expect(v1.skipped).toBe(1);
  });

  it("D20 an offline key-grant agent skips v2 proposals and reads v1 as before", async () => {
    const priv = x25519.utils.randomSecretKey();
    await chain.mintAgent(9n, chain.wallet(2).account.address);
    await EngramAgent.publishKeys({ config, agentId: 9n, x25519PublicKey: x25519.getPublicKey(priv), operator: chain.wallet(3).account.address, holder: chain.wallet(2) });
    const s = await vaultWith(["vegetarian"]);
    await s.approve(7n, { origin: APP, labels: ["preferences"], scope: "readwrite", expiresInSec: DAY });
    await s.propose(7n, APP, { kind: "fact", text: "proposed by seven" });
    await s.grant("preferences", 9n, { scope: "read", expiresInSec: DAY, includeHistory: true });
    const agent = new EngramAgent({ config, agentId: 9n, x25519PrivateKey: priv, operator: chain.wallet(3) });
    const item = (await agent.inbox()).find((i) => i.owner.toLowerCase() === s.owner.toLowerCase())!;
    const r = await agent.recall(s.owner, item.nsId);
    expect(r.entries.map((e) => e.text)).toEqual(["vegetarian"]);
    expect(r.skipped).toBe(1);
  });
});

describe("bridge protocol", () => {
  async function approved() {
    const s = await vaultWith(["vegetarian", "allergic to peanuts"]);
    await s.approve(7n, { origin: APP, labels: ["preferences"], scope: "readwrite", expiresInSec: DAY });
    return s;
  }

  it("D6 end to end: the app client asks through the bridge and gets the minimal answer", async () => {
    const s = await approved();
    const b = bus();
    const vault = startBridge({ session: () => s, agentId: 7n, window: b.vaultWin as never });
    const client = openVaultBridge({ vaultUrl: VAULT, agentId: 7n, frame: b.frame as never, window: b.appWin as never, timeoutMs: 5000 });
    const r = await client.disclose("any allergy?", { mode: "relevant", round: 0 });
    expect(r.entries.map((e: { text: string }) => e.text)).toEqual(["allergic to peanuts"]);
    const w = await client.propose({ kind: "fact", text: "likes trains" });
    expect(w.seq).toBeDefined();
    expect(b.sent.every((x) => x.target === APP)).toBe(true);
    client.close();
    vault.stop();
  });

  it("D5 a locked bridge answers VAULT_LOCKED", async () => {
    const b = bus();
    const vault = startBridge({ session: () => undefined, agentId: 7n, window: b.vaultWin as never });
    const client = openVaultBridge({ vaultUrl: VAULT, agentId: 7n, frame: b.frame as never, window: b.appWin as never, timeoutMs: 2000 });
    expect(await code(client.disclose("x", { mode: "relevant", round: 0 }))).toBe("VAULT_LOCKED");
    client.close();
    vault.stop();
  });

  it("D9/D10 requests from another origin or another window get no reply and are not logged", async () => {
    const s = await approved();
    await s.flushLogs();
    const before = (await s.disclosures({})).length;
    const b = bus();
    const vault = startBridge({ session: () => s, agentId: 7n, window: b.vaultWin as never });
    b.toVault("https://evil.x", req("disclose", { query: "allergy", mode: "relevant", round: 0 }));
    b.toVault(APP, req("disclose", { query: "allergy", mode: "relevant", round: 0 }), {});
    b.toVault(APP, "not an object");
    b.toVault(APP, { type: "engram:bridge:req", v: 1, op: "disclose" }); // no id
    await tick();
    await tick();
    expect(b.sent.filter((x) => (x.msg as { type?: string }).type === "engram:bridge:res")).toEqual([]);
    await s.flushLogs();
    expect((await s.disclosures({})).length).toBe(before);
    vault.stop();
  });

  it("51 the app client ignores replies with a wrong id, wrong origin or wrong source, then times out", async () => {
    const posted: unknown[] = [];
    const listeners = new Set<(e: MessageEvent) => void>();
    const frameWin = { postMessage: (m: unknown) => posted.push(m) };
    const appWin = { addEventListener: (_t: string, f: (e: MessageEvent) => void) => listeners.add(f), removeEventListener: (_t: string, f: (e: MessageEvent) => void) => listeners.delete(f) };
    const client = openVaultBridge({ vaultUrl: VAULT, agentId: 7n, frame: { contentWindow: frameWin } as never, window: appWin as never, timeoutMs: 200 });
    const p = client.disclose("x", { mode: "relevant", round: 0 });
    await tick();
    const id = (posted[0] as { id: string }).id;
    const ok = { type: "engram:bridge:res", v: 1, ok: true, entries: [{ kind: "fact", text: "forged", by: "owner" }], mode: "relevant" };
    const emit = (origin: string, data: unknown, source: unknown) => listeners.forEach((f) => f({ origin, data, source } as MessageEvent));
    emit(VAULT, { ...ok, id: "other" }, frameWin);
    emit("https://evil.x", { ...ok, id }, frameWin);
    emit(VAULT, { ...ok, id }, {});
    emit(VAULT, "garbage", frameWin);
    expect(await code(p)).toBe("BRIDGE_TIMEOUT");
    client.close();
  });

  it("52 no key material in serialised sessions or clients", async () => {
    const s = await approved();
    s.pairwise(7n);
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/[0-9a-f]{64}/i);
    const b = bus();
    const client = openVaultBridge({ vaultUrl: VAULT, agentId: 7n, frame: b.frame as never, window: b.appWin as never });
    expect(JSON.stringify(client)).not.toMatch(/[0-9a-f]{64}/i);
    client.close();
  });
});

describe("rate limit", () => {
  it("D26 the 61st disclose for one agent within 10 minutes is RATE_LIMITED", async () => {
    const s = await vaultWith(["jazz"]);
    await s.approve(7n, { origin: APP, labels: ["preferences"], scope: "read", expiresInSec: DAY });
    for (let i = 0; i < 60; i++) await s.disclose({ agentId: 7n, origin: APP, query: "jazz", mode: "relevant", round: 0 });
    expect(await code(s.disclose({ agentId: 7n, origin: APP, query: "jazz", mode: "relevant", round: 0 }))).toBe("RATE_LIMITED");
    await s.flushLogs();
  }, 600_000);
});
