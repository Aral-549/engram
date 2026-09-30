// Golden tests for contracts/sdk.md. One test per behavior case (#n). Written from the spec before the SDK existed.
// Runs against a local anvil chain with the real compiled MemoryRegistry. FROZEN: add cases, never edit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import { encodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAccount, deriveNamespaceId, deriveNamespaceKey, encryptEntry } from "../../../packages/crypto/src/index.js";
import {
  EngramAgent,
  EngramError,
  EngramOwner,
  connectEngram,
  createRelayHandler,
  firstAvailable,
  graphqlSource,
  httpRelayer,
  inProcessRelayer,
  logsSource,
  memoryRegistryAbi,
  parseConnectRequest,
  type EngramConfig,
  type MemorySource,
  type Relayer,
} from "../../../packages/sdk/src/index.js";
import { startLocalChain, type LocalChain } from "../../support/anvil.js";
import { FakeAuthenticator } from "../../support/fake-authenticator.js";

let chain: LocalChain;
let base: EngramConfig;
let lines: Array<Record<string, unknown>>;
const RP = "vault.test";

const agentKeys = () => {
  const priv = x25519.utils.randomSecretKey();
  return { priv, pub: x25519.getPublicKey(priv) };
};
const A = { id: 7n, ...agentKeys() };
const B = { id: 9n, ...agentKeys() };

async function code(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === "function" ? p() : p);
    return "OK";
  } catch (e) {
    if (e instanceof EngramError) return e.code;
    throw e;
  }
}

function config(overrides: Partial<EngramConfig> = {}): EngramConfig {
  return { ...base, ...overrides };
}

function agent(which: typeof A, operatorIndex: number, cfg = base) {
  return new EngramAgent({ config: cfg, agentId: which.id, x25519PrivateKey: which.priv, operator: chain.wallet(operatorIndex) });
}

let userSeq = 0;
async function newOwner(cfg = base) {
  const auth = new FakeAuthenticator(`user-${userSeq++}`);
  const session = await EngramOwner.signUp({ config: cfg, rpId: RP, rpName: "Engram", userName: `user${userSeq}`, webAuthnClient: auth.client });
  return { auth, session };
}

const relayerNonce = () => chain.publicClient.getTransactionCount({ address: chain.wallet(1).account.address });

beforeAll(async () => {
  chain = await startLocalChain();
  lines = [];
  const handler = createRelayHandler({
    config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl } as never,
    wallet: chain.wallet(1),
  });
  base = {
    chainId: 31337,
    registry: chain.registry,
    identityRegistry: chain.identityRegistry,
    rpcUrl: chain.rpcUrl,
    source: logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n }),
    relayer: inProcessRelayer(handler),
    logger: (line) => lines.push(line),
  };
  await chain.mintAgent(A.id, chain.wallet(2).account.address);
  await chain.mintAgent(B.id, chain.wallet(4).account.address);
  await EngramAgent.publishKeys({ config: base, agentId: A.id, x25519PublicKey: A.pub, operator: chain.wallet(3).account.address, holder: chain.wallet(2) });
  await EngramAgent.publishKeys({ config: base, agentId: B.id, x25519PublicKey: B.pub, operator: chain.wallet(4).account.address, holder: chain.wallet(4) });
});

afterAll(() => chain?.stop());

describe("owner: stateless passkey sessions", () => {
  it("#1 #26 sign up, remember, then sign in on a synced device and recall", async () => {
    const { auth, session } = await newOwner();
    const w = await session.remember("preferences", { kind: "preference", text: "vegetarian" });
    expect(w.seq).toBe(0n);
    session.end();
    const device2 = auth.syncedDevice();
    const s2 = await EngramOwner.signIn({ config: base, rpId: RP, webAuthnClient: device2.client });
    expect(s2.owner).toBe(session.owner);
    const r = await s2.recall("preferences");
    expect(r.entries.map((e) => e.text)).toEqual(["vegetarian"]);
    expect(r.complete).toBe(true);
  });

  it("#2 nothing is read from or written to browser storage", async () => {
    const trap = new Proxy({}, { get: () => { throw new Error("storage touched"); } });
    const g = globalThis as Record<string, unknown>;
    g.localStorage = trap;
    g.sessionStorage = trap;
    g.indexedDB = trap;
    try {
      const { auth, session } = await newOwner();
      await session.remember("preferences", { kind: "note", text: "no storage" });
      const s2 = await EngramOwner.signIn({ config: base, rpId: RP, webAuthnClient: auth.syncedDevice().client });
      expect((await s2.recall("preferences")).entries.length).toBe(1);
    } finally {
      delete g.localStorage;
      delete g.sessionStorage;
      delete g.indexedDB;
    }
  });

  it("#15 authenticator without PRF", async () => {
    const auth = new FakeAuthenticator("no-prf");
    auth.prfSupported = false;
    let err: unknown;
    try {
      await EngramOwner.signUp({ config: base, rpId: RP, rpName: "Engram", userName: "x", webAuthnClient: auth.client });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EngramError);
    expect((err as EngramError).code).toBe("PRF_UNAVAILABLE");
    expect((err as EngramError).message).toMatch(/1Password|iCloud/);
  });

  it("#23 ended and idle-expired sessions refuse to act", async () => {
    let now = 1_000_000;
    const prf = new Uint8Array(32).fill(0x23);
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf, clock: () => now });
    now += 15 * 60 * 1000 + 1;
    expect(await code(s.recall("preferences"))).toBe("SESSION_EXPIRED");
    const s2 = await EngramOwner.fromPrf({ config: base, prfOutput: prf, clock: () => now });
    s2.end();
    expect(await code(s2.recall("preferences"))).toBe("SESSION_ENDED");
  });
});

describe("owner: reads", () => {
  it("#3 missing seq from the source is detected", async () => {
    const real = base.source;
    const dropping: MemorySource = { ...real, entries: async (q) => (await real.entries(q)).filter((e) => e.seq !== 2n) };
    const { session: s3 } = await newOwner(config({ source: dropping }));
    for (const t of ["a", "b", "c", "d"]) await s3.remember("preferences", { kind: "note", text: t });
    lines.length = 0;
    const r = await s3.recall("preferences");
    expect(r.complete).toBe(false);
    expect(r.missingSeqs).toEqual([2n]);
    expect(r.entries.map((e) => e.seq)).toEqual([0n, 1n, 3n]);
    expect(lines.some((l) => l.op === "recall" && JSON.stringify(l.missingSeqs) === JSON.stringify(["2"]))).toBe(true);
  });

  it("#4 owner recall spans epochs", async () => {
    const { session } = await newOwner();
    await session.remember("work", { kind: "fact", text: "epoch zero" });
    await session.rotate("work");
    await session.remember("work", { kind: "fact", text: "epoch one" });
    const r = await session.recall("work");
    expect(r.entries.map((e) => [e.text, e.epoch])).toEqual([["epoch zero", 0n], ["epoch one", 1n]]);
  });

  it("#17 authentic but invalid entry is skipped without logging content", async () => {
    const prf = new Uint8Array(32).fill(0x17);
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    await s.remember("preferences", { kind: "note", text: "valid" });
    const acc = deriveAccount(prf);
    await chain.test.setBalance({ address: s.owner, value: 10n ** 18n });
    const nsId = toHex(deriveNamespaceId(prf, "preferences"));
    const junk = await encryptEntry({
      key: deriveNamespaceKey(prf, "preferences", 0), ctx: { chainId: 31337n, registry: chain.registry, owner: s.owner },
      nsId: deriveNamespaceId(prf, "preferences"), epoch: 0, plaintext: new TextEncoder().encode("SECRET-JUNK not json"),
    });
    const { createWalletClient, http } = await import("viem");
    const w = createWalletClient({ chain: chain.chain, transport: http(chain.rpcUrl), account: privateKeyToAccount(toHex(acc.accountKey)) });
    const h = await w.writeContract({ address: chain.registry, abi: memoryRegistryAbi, functionName: "appendAsOwner", args: [nsId, 0n, toHex(junk)] });
    await chain.publicClient.waitForTransactionReceipt({ hash: h });
    lines.length = 0;
    const r = await s.recall("preferences");
    expect(r.entries.map((e) => e.text)).toEqual(["valid"]);
    expect(r.skipped).toBe(1);
    expect(JSON.stringify(lines)).not.toContain("SECRET-JUNK");
  });

  it("#27 read path falls back when the indexer is down", async () => {
    const cfg = config({ source: firstAvailable([graphqlSource("http://127.0.0.1:9/v1/graphql"), base.source]) });
    const { session } = await newOwner(cfg);
    await session.remember("preferences", { kind: "note", text: "fallback" });
    expect((await session.recall("preferences")).entries.map((e) => e.text)).toEqual(["fallback"]);
  });
});

describe("grants and agents", () => {
  it("#5 grant with history wraps every epoch; agent reads all", async () => {
    const { session } = await newOwner();
    await session.remember("preferences", { kind: "note", text: "e0" });
    await session.rotate("preferences");
    await session.remember("preferences", { kind: "note", text: "e1" });
    await session.rotate("preferences");
    await session.remember("preferences", { kind: "note", text: "e2" });
    const g = await session.grant("preferences", A.id, { scope: "read", expiresInSec: 7 * 86400, includeHistory: true });
    expect(g.epochs).toEqual([0n, 1n, 2n]);
    const inbox = await agent(A, 3).inbox();
    const item = inbox.find((i) => i.owner.toLowerCase() === session.owner.toLowerCase())!;
    const r = await agent(A, 3).recall(session.owner, item.nsId);
    expect(r.label).toBe("preferences");
    expect(r.entries.map((e) => e.text)).toEqual(["e0", "e1", "e2"]);
  });

  it("#6 grant without history only opens the current epoch", async () => {
    const { session } = await newOwner();
    await session.remember("preferences", { kind: "note", text: "old" });
    await session.rotate("preferences");
    await session.remember("preferences", { kind: "note", text: "new" });
    const g = await session.grant("preferences", A.id, { scope: "read", expiresInSec: 86400, includeHistory: false });
    expect(g.epochs).toEqual([1n]);
    const item = (await agent(A, 3).inbox()).find((i) => i.owner.toLowerCase() === session.owner.toLowerCase())!;
    const r = await agent(A, 3).recall(session.owner, item.nsId);
    expect(r.entries.map((e) => e.text)).toEqual(["new"]);
    expect(r.skipped).toBe(1);
  });

  it("#7 agent keys come from chain, not the source", async () => {
    const lying: MemorySource = { ...base.source, agentKeys: async () => ({ x25519Pub: toHex(new Uint8Array(32).fill(9)), operator: "0x0000000000000000000000000000000000000001" }) };
    const { session } = await newOwner(config({ source: lying }));
    await session.remember("preferences", { kind: "note", text: "k" });
    lines.length = 0;
    await session.grant("preferences", A.id, { scope: "read", expiresInSec: 86400, includeHistory: true });
    expect(lines.some((l) => l.code === "SOURCE_KEYS_MISMATCH")).toBe(true);
    const item = (await agent(A, 3).inbox()).find((i) => i.owner.toLowerCase() === session.owner.toLowerCase())!;
    expect((await agent(A, 3).recall(session.owner, item.nsId)).entries.map((e) => e.text)).toEqual(["k"]);
  });

  it("#8 #9 #10 revoke rotates, revoked agent is refused, remaining agent sees new entries", async () => {
    const { session } = await newOwner();
    await session.remember("preferences", { kind: "note", text: "before" });
    await session.grant("preferences", A.id, { scope: "read", expiresInSec: 86400, includeHistory: true });
    await session.grant("preferences", B.id, { scope: "read", expiresInSec: 86400, includeHistory: true });
    const nsId = (await agent(B, 4).inbox()).find((i) => i.owner.toLowerCase() === session.owner.toLowerCase())!.nsId;
    const rv = await session.revoke("preferences", [A.id]);
    expect(rv.newEpoch).toBe(1n);
    const grantees = await chain.publicClient.readContract({ address: chain.registry, abi: memoryRegistryAbi, functionName: "granteesOf", args: [session.owner, nsId] });
    expect(grantees).toEqual([B.id]);
    expect(await code(agent(A, 3).recall(session.owner, nsId))).toBe("ACCESS_REVOKED");
    await session.remember("preferences", { kind: "note", text: "after" });
    expect((await agent(B, 4).recall(session.owner, nsId)).entries.map((e) => e.text)).toEqual(["before", "after"]);
  });

  it("#11 read-only agent cannot write, and no tx is sent", async () => {
    const { session } = await newOwner();
    await session.remember("preferences", { kind: "note", text: "x" });
    await session.grant("preferences", A.id, { scope: "read", expiresInSec: 86400, includeHistory: true });
    const nsId = (await agent(A, 3).inbox()).find((i) => i.owner.toLowerCase() === session.owner.toLowerCase())!.nsId;
    const before = await chain.publicClient.getTransactionCount({ address: chain.wallet(3).account.address });
    expect(await code(agent(A, 3).remember(session.owner, nsId, { kind: "note", text: "nope" }))).toBe("NOT_AUTHORIZED");
    expect(await chain.publicClient.getTransactionCount({ address: chain.wallet(3).account.address })).toBe(before);
  });

  it("agent with read_write can write, owner sees it attributed to the agent", async () => {
    const { session } = await newOwner();
    await session.remember("preferences", { kind: "note", text: "owner" });
    await session.grant("preferences", A.id, { scope: "readwrite", expiresInSec: 86400, includeHistory: true });
    const nsId = (await agent(A, 3).inbox()).find((i) => i.owner.toLowerCase() === session.owner.toLowerCase())!.nsId;
    await agent(A, 3).remember(session.owner, nsId, { kind: "fact", text: "from agent" });
    const r = await session.recall("preferences");
    expect(r.entries.map((e) => [e.text, e.byOwner, e.agentId])).toEqual([["owner", true, 0n], ["from agent", false, A.id]]);
  });

  it("#18 grant to an agent whose token moved is refused before any prompt or tx", async () => {
    const C = { id: 11n, ...agentKeys() };
    await chain.mintAgent(C.id, chain.wallet(5).account.address);
    await EngramAgent.publishKeys({ config: base, agentId: C.id, x25519PublicKey: C.pub, operator: chain.wallet(5).account.address, holder: chain.wallet(5) });
    const h = await chain.wallet(5).writeContract({ address: chain.identityRegistry, abi: chain.identityAbi, functionName: "transferFrom", args: [chain.wallet(5).account.address, chain.wallet(2).account.address, C.id] });
    await chain.publicClient.waitForTransactionReceipt({ hash: h });
    const { auth, session } = await newOwner();
    await session.remember("preferences", { kind: "note", text: "x" });
    const gets = auth.calls.get;
    const n = await relayerNonce();
    expect(await code(session.grant("preferences", C.id, { scope: "read", expiresInSec: 86400, includeHistory: true }))).toBe("AGENT_KEYS_NOT_CURRENT");
    expect(auth.calls.get).toBe(gets);
    expect(await relayerNonce()).toBe(n);
  });

  it("#19 grant to an agent with a non-canonical X25519 key is refused before any tx", async () => {
    const D = 13n;
    await chain.mintAgent(D, chain.wallet(5).account.address);
    const nonCanonical = new Uint8Array(32).fill(0x05);
    nonCanonical[31] = 0x85; // top bit set
    const h = await chain.wallet(5).writeContract({ address: chain.registry, abi: memoryRegistryAbi, functionName: "setAgentKeys", args: [D, toHex(nonCanonical), chain.wallet(5).account.address] });
    await chain.publicClient.waitForTransactionReceipt({ hash: h });
    const { session } = await newOwner();
    await session.remember("preferences", { kind: "note", text: "x" });
    const n = await relayerNonce();
    expect(await code(session.grant("preferences", D, { scope: "read", expiresInSec: 86400, includeHistory: true }))).toBe("INPUT_INVALID");
    expect(await relayerNonce()).toBe(n);
  });

  it("#20 re-grant after revoke uses only the current generation", async () => {
    const { session } = await newOwner();
    await session.remember("preferences", { kind: "note", text: "one" });
    await session.grant("preferences", A.id, { scope: "read", expiresInSec: 86400, includeHistory: true });
    await session.revoke("preferences", [A.id]);
    await session.remember("preferences", { kind: "note", text: "two" });
    await session.grant("preferences", A.id, { scope: "read", expiresInSec: 86400, includeHistory: false });
    const item = (await agent(A, 3).inbox()).find((i) => i.owner.toLowerCase() === session.owner.toLowerCase())!;
    expect(item.generation).toBe(2);
    expect(item.epochs).toEqual([1n]);
    const r = await agent(A, 3).recall(session.owner, item.nsId);
    expect(r.entries.map((e) => e.text)).toEqual(["two"]);
  });

  it("#21 revoke and rotate prune expired and stale-key grantees", async () => {
    const { session } = await newOwner();
    await session.remember("preferences", { kind: "note", text: "x" });
    await session.grant("preferences", A.id, { scope: "read", expiresInSec: 86400, includeHistory: true });
    await session.grant("preferences", B.id, { scope: "read", expiresInSec: 60, includeHistory: true });
    await chain.increaseTime(120);
    await session.revoke("preferences", [A.id]);
    const grants = await session.grants();
    expect(grants.filter((g) => g.active).length).toBe(0);
  });

  it("#12 connect request origin verification against the agent card", () => {
    const url = "https://vault.test/connect?v=1&agentId=7&labels=preferences&scope=read&expiresInSec=604800&origin=https%3A%2F%2Fplanner.test";
    const card = (endpoint: string) => ({ name: "Planner", endpoints: [{ name: "web", endpoint }] });
    const bad = parseConnectRequest(url, { agentCard: card("https://other.test/app") });
    expect(bad).toMatchObject({ agentId: 7n, labels: ["preferences"], scope: "read", expiresInSec: 604800, origin: "https://planner.test", originVerified: false });
    expect(parseConnectRequest(url, { agentCard: card("https://planner.test/") }).originVerified).toBe(true);
    expect(() => parseConnectRequest(url.replace("labels=preferences", "labels=Preferences"))).toThrow(EngramError);
  });
});

describe("relay", () => {
  it("#16 relayer unreachable", async () => {
    const prf = new Uint8Array(32).fill(0x16);
    const s = await EngramOwner.fromPrf({ config: config({ relayer: httpRelayer("http://127.0.0.1:9/api/relay") }), prfOutput: prf });
    let err: unknown;
    try {
      await s.remember("preferences", { kind: "note", text: "x" });
    } catch (e) {
      err = e;
    }
    expect((err as EngramError).code).toBe("RELAYER_UNAVAILABLE");
    expect(JSON.stringify(err) + String(err)).not.toContain(toHex(prf).slice(2));
  });

  it("#22 relayed calls use short deadlines; cancelPending invalidates a pending signature", async () => {
    const seen: bigint[] = [];
    const spying: Relayer = { submit: async (req) => { seen.push(BigInt(req.deadline)); return base.relayer.submit(req); } };
    const prf = new Uint8Array(32).fill(0x22);
    const s = await EngramOwner.fromPrf({ config: config({ relayer: spying }), prfOutput: prf });
    await s.remember("preferences", { kind: "note", text: "x" });
    const chainNow = (await chain.publicClient.getBlock()).timestamp;
    for (const d of seen) expect(d - chainNow).toBeLessThanOrEqual(300n);

    const owner = privateKeyToAccount(toHex(deriveAccount(prf).accountKey));
    const nsId = toHex(deriveNamespaceId(prf, "preferences"));
    const data = encodeFunctionData({ abi: memoryRegistryAbi, functionName: "appendAsOwner", args: [nsId, 0n, toHex(new Uint8Array(30).fill(1))] });
    const nonce = await chain.publicClient.readContract({ address: chain.registry, abi: memoryRegistryAbi, functionName: "nonces", args: [owner.address] });
    const deadline = chainNow + 300n;
    const signature = await owner.signTypedData({
      domain: { name: "EngramMemoryRegistry", version: "1", chainId: 31337, verifyingContract: chain.registry },
      types: { OwnerCall: [{ name: "owner", type: "address" }, { name: "dataHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "OwnerCall",
      message: { owner: owner.address, dataHash: keccak256(data), nonce, deadline },
    });
    await s.cancelPending();
    const handler = createRelayHandler({ config: base, wallet: chain.wallet(1) });
    const res = await handler({ owner: owner.address, data, deadline: deadline.toString(), signature });
    expect(res.status).toBe(400);
  });

  it("#25 relay handler rejects bad input without sending a tx", async () => {
    const handler = createRelayHandler({ config: base, wallet: chain.wallet(1), limits: { perOwnerPerMinute: 30, globalPerMinute: 1000 } });
    const owner = privateKeyToAccount("0x" + "42".repeat(32) as Hex);
    const chainNow = (await chain.publicClient.getBlock()).timestamp;
    const sign = async (data: Hex) => owner.signTypedData({
      domain: { name: "EngramMemoryRegistry", version: "1", chainId: 31337, verifyingContract: chain.registry },
      types: { OwnerCall: [{ name: "owner", type: "address" }, { name: "dataHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "OwnerCall",
      message: { owner: owner.address, dataHash: keccak256(data), nonce: 0n, deadline: chainNow + 300n },
    });
    const n = await relayerNonce();
    const append = encodeFunctionData({ abi: memoryRegistryAbi, functionName: "appendAsOwner", args: [keccak256("0x01"), 0n, toHex(new Uint8Array(30))] });
    const bad = await handler({ owner: owner.address, data: append, deadline: String(chainNow + 300n), signature: "0x" + "11".repeat(65) });
    expect([bad.status, bad.body.code]).toEqual([400, "BAD_SIGNATURE"]);
    const keysCall = encodeFunctionData({ abi: memoryRegistryAbi, functionName: "setAgentKeys", args: [1n, toHex(new Uint8Array(32).fill(1)), owner.address] });
    const sel = await handler({ owner: owner.address, data: keysCall, deadline: String(chainNow + 300n), signature: await sign(keysCall) });
    expect([sel.status, sel.body.code]).toEqual([400, "SELECTOR_NOT_ALLOWED"]);
    const rev = await handler({ owner: owner.address, data: append, deadline: String(chainNow + 300n), signature: await sign(append) });
    expect([rev.status, rev.body.code]).toEqual([400, "NoNamespace"]);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await handler({ owner: owner.address, data: append, deadline: String(chainNow + 300n), signature: "0x" })).status;
    expect(last).toBe(429);
    expect(await relayerNonce()).toBe(n);
  });
});

describe("session scoping (Mera UX)", () => {
  it("#24 grant re-prompts only after 60 s, and refuses a different passkey", async () => {
    let now = 5_000_000;
    const auth = new FakeAuthenticator("scoping");
    const s = await EngramOwner.signUp({ config: base, rpId: RP, rpName: "Engram", userName: "s", webAuthnClient: auth.client, clock: () => now });
    await s.remember("preferences", { kind: "note", text: "x" });
    const g0 = auth.calls.get;
    now += 30_000;
    await s.grant("preferences", A.id, { scope: "read", expiresInSec: 86400, includeHistory: true });
    expect(auth.calls.get).toBe(g0);
    now += 60_000;
    await s.grant("preferences", B.id, { scope: "read", expiresInSec: 86400, includeHistory: true });
    expect(auth.calls.get).toBe(g0 + 1);
    // a second passkey on the same authenticator answers the next re-prompt
    await EngramOwner.signUp({ config: base, rpId: RP, rpName: "Engram", userName: "other", webAuthnClient: auth.client });
    auth.answerWith = 1;
    now += 120_000;
    const n = await relayerNonce();
    expect(await code(s.grant("preferences", A.id, { scope: "readwrite", expiresInSec: 86400, includeHistory: true }))).toBe("REAUTH_MISMATCH");
    expect(await relayerNonce()).toBe(n);
  });

  it("edge: invalid label and expiry fail before any prompt", async () => {
    const { auth, session } = await newOwner();
    expect(await code(session.remember("Preferences", { kind: "note", text: "x" }))).toBe("INPUT_INVALID");
    const g = auth.calls.get;
    expect(await code(session.grant("preferences", A.id, { scope: "read", expiresInSec: 0, includeHistory: true }))).toBe("INPUT_INVALID");
    expect(await code(session.grant("preferences", A.id, { scope: "read", expiresInSec: 366 * 86400, includeHistory: true }))).toBe("INPUT_INVALID");
    expect(auth.calls.get).toBe(g);
  });

  it("edge: two sessions of the same owner write concurrently", async () => {
    const { auth, session } = await newOwner();
    await session.remember("preferences", { kind: "note", text: "first" });
    const s2 = await EngramOwner.signIn({ config: base, rpId: RP, webAuthnClient: auth.syncedDevice().client });
    const [a, b] = await Promise.all([
      session.remember("preferences", { kind: "note", text: "tab1" }),
      s2.remember("preferences", { kind: "note", text: "tab2" }),
    ]);
    expect(new Set([a.seq, b.seq]).size).toBe(2);
    expect((await session.recall("preferences")).entries.length).toBe(3);
  });

  it("edge: agent holding the wrong X25519 key skips wraps with KEY_MISMATCH", async () => {
    const { session } = await newOwner();
    await session.remember("preferences", { kind: "note", text: "x" });
    await session.grant("preferences", A.id, { scope: "read", expiresInSec: 86400, includeHistory: true });
    const imposter = new EngramAgent({ config: base, agentId: A.id, x25519PrivateKey: x25519.utils.randomSecretKey(), operator: chain.wallet(3) });
    const item = (await agent(A, 3).inbox()).find((i) => i.owner.toLowerCase() === session.owner.toLowerCase())!;
    lines.length = 0;
    const r = await imposter.recall(session.owner, item.nsId);
    expect(r.entries).toEqual([]);
    expect(r.skipped).toBeGreaterThan(0);
    expect(lines.some((l) => l.code === "KEY_MISMATCH")).toBe(true);
  });
});

describe("app client popup", () => {
  class FakeWindow {
    listeners = new Set<(e: MessageEvent) => void>();
    popup: { closed: boolean } | null = { closed: false };
    openedUrl = "";
    open(url: string) {
      this.openedUrl = url;
      return this.popup;
    }
    addEventListener(_t: string, f: (e: MessageEvent) => void) {
      this.listeners.add(f);
    }
    removeEventListener(_t: string, f: (e: MessageEvent) => void) {
      this.listeners.delete(f);
    }
    emit(origin: string, data: unknown, source: unknown = this.popup) {
      for (const f of this.listeners) f({ origin, data, source } as MessageEvent);
    }
  }
  const req = { vaultUrl: "https://vault.test", agentId: 7n, labels: ["preferences"], scope: "read" as const, expiresInSec: 3600 };

  it("#13 closing the popup rejects USER_CANCELLED", async () => {
    const w = new FakeWindow();
    const p = connectEngram({ ...req, window: w as never, pollMs: 20 });
    setTimeout(() => (w.popup!.closed = true), 50);
    expect(await code(p)).toBe("USER_CANCELLED");
  });

  it("#14 ignores foreign and malformed messages, resolves on the vault's reply", async () => {
    const w = new FakeWindow();
    const p = connectEngram({ ...req, window: w as never, pollMs: 20 });
    expect(w.openedUrl.startsWith("https://vault.test/connect?")).toBe(true);
    const ok = { type: "engram:connect:result", v: 1, ok: true, owner: "0x" + "ab".repeat(20), granted: ["preferences"], txHash: "0x" + "cd".repeat(32) };
    w.emit("https://evil.test", ok);
    w.emit("https://vault.test", { type: "something-else" });
    w.emit("https://vault.test", ok, {});
    let settled = false;
    p.then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    w.emit("https://vault.test", ok);
    await expect(p).resolves.toMatchObject({ owner: ok.owner, granted: ["preferences"], txHash: ok.txHash });
  });

  it("edge: popup blocked", async () => {
    const w = new FakeWindow();
    w.popup = null;
    expect(await code(connectEngram({ ...req, window: w as never }))).toBe("POPUP_BLOCKED");
  });
});
