// Regression cases for BUGLOG S1-S7 (contracts/sdk.md cases 28-42, "Trust boundaries").
// Written from the adversarial review before the fixes. FROZEN: add cases, never edit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { createServer } from "node:http";
import { x25519 } from "@noble/curves/ed25519.js";
import { encodeFunctionData, hexToBytes, toHex, type Hex } from "viem";
import { decryptEntry, deriveNamespaceId, encodeEntry, encryptEntry, wrapNamespaceKey } from "../../../packages/crypto/src/index.js";
import {
  EngramAgent,
  EngramError,
  EngramOwner,
  connectEngram,
  firstAvailable,
  graphqlSource,
  createRelayHandler,
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
const LONG = 300_000;
const keys = () => {
  const priv = x25519.utils.randomSecretKey();
  return { priv, pub: x25519.getPublicKey(priv) };
};
const A = { id: 7n, ...keys() };
const B = { id: 9n, ...keys() };
const rand = () => globalThis.crypto.getRandomValues(new Uint8Array(32));
const nsIdOf = (prf: Uint8Array, label: string) => toHex(deriveNamespaceId(prf, label));
const cfg = (o: Partial<EngramConfig> = {}): EngramConfig => ({ ...base, ...o });
const agentA = (c = base) => new EngramAgent({ config: c, agentId: A.id, x25519PrivateKey: A.priv, operator: chain.wallet(3) });
const read = <T>(fn: string, args: unknown[]) =>
  chain.publicClient.readContract({ address: chain.registry, abi: memoryRegistryAbi, functionName: fn as never, args: args as never }) as Promise<T>;
const relayerNonce = () => chain.publicClient.getTransactionCount({ address: chain.wallet(1).account.address });

async function code(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === "function" ? p() : p);
    return "OK";
  } catch (e) {
    return e instanceof EngramError ? e.code : `RAW:${(e as Error)?.constructor?.name}`;
  }
}

async function mintWithKeys(id: bigint, pub: Uint8Array) {
  await chain.mintAgent(id, chain.wallet(5).account.address);
  const h = await chain.wallet(5).writeContract({ address: chain.registry, abi: memoryRegistryAbi, functionName: "setAgentKeys", args: [id, toHex(pub), chain.wallet(5).account.address] });
  await chain.publicClient.waitForTransactionReceipt({ hash: h });
}
async function setKey(id: bigint, pub: Uint8Array) {
  const h = await chain.wallet(5).writeContract({ address: chain.registry, abi: memoryRegistryAbi, functionName: "setAgentKeys", args: [id, toHex(pub), chain.wallet(5).account.address] });
  await chain.publicClient.waitForTransactionReceipt({ hash: h });
}

beforeAll(async () => {
  chain = await startLocalChain();
  const handler = createRelayHandler({
    config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl },
    wallet: chain.wallet(1),
    limits: { perOwnerPerMinute: 1000, globalPerMinute: 100_000 },
  });
  base = {
    chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl,
    source: logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n }),
    relayer: inProcessRelayer(handler), logger: () => {},
  };
  await chain.mintAgent(A.id, chain.wallet(2).account.address);
  await chain.mintAgent(B.id, chain.wallet(4).account.address);
  await EngramAgent.publishKeys({ config: base, agentId: A.id, x25519PublicKey: A.pub, operator: chain.wallet(3).account.address, holder: chain.wallet(2) });
  await EngramAgent.publishKeys({ config: base, agentId: B.id, x25519PublicKey: B.pub, operator: chain.wallet(4).account.address, holder: chain.wallet(4) });
}, LONG);
afterAll(() => chain?.stop());

describe("S1 chain-verified wraps", () => {
  it("#28 a forged wrap (reusing the genuine wrap's txHash/logIndex) is ignored by remember and recall", async () => {
    const prf = rand();
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    await s.remember("forged", { kind: "note", text: "owner entry" });
    await s.grant("forged", A.id, { scope: "readwrite", expiresInSec: 3600, includeHistory: true });
    const nsId = nsIdOf(prf, "forged");
    const ctx = { chainId: 31337n, registry: chain.registry, owner: s.owner };
    const attackerKey = rand();
    const forged = await wrapNamespaceKey({ ctx, nsId: hexToBytes(nsId), epoch: 0n, agentId: A.id, nsKey: new Uint8Array(attackerKey), label: "forged", agentX25519Public: A.pub });
    const forgedCt = await encryptEntry({ key: new Uint8Array(attackerKey), ctx, nsId: hexToBytes(nsId), epoch: 0n, plaintext: encodeEntry({ v: 1, t: 1, kind: "note", text: "INJECTED" }) });
    const real = base.source;
    const lying: MemorySource = {
      ...real,
      wraps: async (q) => {
        const w = await real.wraps(q);
        return [...w, { ...w[0]!, wrap: toHex(forged) }]; // forged last (would win a naive map), pointing at the genuine wrap's tx/log
      },
    };
    const r = await agentA(cfg({ source: lying })).remember(s.owner, nsId, { kind: "fact", text: "secret told to the agent" });
    const onchain = (await real.entries({ owner: s.owner, nsId })).find((e) => e.seq === r.seq)!;
    const attackerCanRead = await decryptEntry({ key: attackerKey, ctx, nsId: hexToBytes(nsId), epoch: 0n, envelope: hexToBytes(onchain.ciphertext) }).then(() => true, () => false);
    expect(attackerCanRead).toBe(false);
    expect((await s.recall("forged")).entries.map((e) => e.text)).toEqual(["owner entry", "secret told to the agent"]);

    const poisoned: MemorySource = { ...lying, entries: async (q) => (await real.entries(q)).map((e) => ({ ...e, ciphertext: toHex(forgedCt) })) };
    const rec = await agentA(cfg({ source: poisoned })).recall(s.owner, nsId);
    expect(rec.entries.some((e) => e.text === "INJECTED")).toBe(false);
  }, LONG);
});

describe("S2 verified relay effects", () => {
  it("#29 a relayer replaying an old or foreign txHash cannot fake revoke or remember", async () => {
    let fake: Hex | undefined;
    const lying: Relayer = { submit: async (req) => (fake ? { txHash: fake } : base.relayer.submit(req)) };
    const prf = rand();
    const s = await EngramOwner.fromPrf({ config: cfg({ relayer: lying }), prfOutput: prf });
    await s.remember("fx", { kind: "note", text: "x" });
    const g = await s.grant("fx", A.id, { scope: "read", expiresInSec: 3600, includeHistory: true });
    fake = g.txHash;
    let err: unknown;
    try { await s.revoke("fx", [A.id]); } catch (e) { err = e; }
    expect((err as EngramError).code).toBe("RELAY_REJECTED");
    expect((err as EngramError).detail).toBe("EFFECT_NOT_FOUND");

    fake = undefined;
    const other = await EngramOwner.fromPrf({ config: base, prfOutput: rand() });
    await other.remember("fx", { kind: "note", text: "a" });
    fake = (await other.remember("fx", { kind: "note", text: "b" })).txHash;
    expect(await code(s.remember("fx", { kind: "note", text: "dropped" }))).toBe("RELAY_REJECTED");
  }, LONG);
});

describe("S3 no revocation DoS", () => {
  it("#30 a grantee with a low-order key cannot block revoking another agent; it is revoked too", async () => {
    const X = { id: 31n, ...keys() };
    await mintWithKeys(X.id, X.pub);
    const prf = rand();
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    await s.remember("dos", { kind: "note", text: "x" });
    await s.grant("dos", X.id, { scope: "read", expiresInSec: 3600, includeHistory: true });
    await s.grant("dos", B.id, { scope: "read", expiresInSec: 3600, includeHistory: true });
    const lowOrder = new Uint8Array(32);
    lowOrder[0] = 1;
    await setKey(X.id, lowOrder);
    expect(await code(s.revoke("dos", [B.id]))).toBe("OK");
    const nsId = nsIdOf(prf, "dos");
    expect(await read<boolean>("isActive", [s.owner, nsId, B.id])).toBe(false);
    expect(await read<readonly bigint[]>("granteesOf", [s.owner, nsId])).toEqual([]);
  }, LONG);
});

describe("S4 rate limit after verification", () => {
  it("#31 forged-signature traffic naming an owner does not lock that owner out", async () => {
    const h = createRelayHandler({ config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl }, wallet: chain.wallet(1), limits: { perOwnerPerMinute: 30, globalPerMinute: 100_000 } });
    const victim = await EngramOwner.fromPrf({ config: cfg({ relayer: inProcessRelayer(h) }), prfOutput: rand() });
    const data = "0x" + "00".repeat(4) as Hex; // any calldata; signature check rejects first
    for (let i = 0; i < 30; i++) await h({ owner: victim.owner, data, deadline: "9999999999", signature: "0x" + "11".repeat(65) });
    expect(await code(victim.cancelPending())).toBe("OK");
  }, LONG);
});

describe("S5 session state", () => {
  it("#32 calls in flight when end() runs reject SESSION_ENDED and write nothing", async () => {
    const prf = rand();
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    await s.remember("inflight", { kind: "note", text: "first" });
    const w = s.remember("inflight", { kind: "note", text: "after end" });
    const r = s.recall("inflight");
    s.end();
    const [cw, cr] = await Promise.all([code(w), code(r)]); // attach both handlers at once
    expect(cw).toBe("SESSION_ENDED");
    expect(cr).toBe("SESSION_ENDED");
    const [, , nextSeq] = await read<[boolean, bigint, bigint]>("namespaceOf", [s.owner, nsIdOf(prf, "inflight")]);
    expect(nextSeq).toBe(1n);
  }, LONG);

  it("#33 a clock that steps backwards never extends the prompt-free grant window", async () => {
    let now = 50_000_000;
    const auth = new FakeAuthenticator("clock-back-golden");
    const s = await EngramOwner.signUp({ config: base, rpId: "vault.test", rpName: "Engram", userName: "cb", webAuthnClient: auth.client, clock: () => now });
    await s.remember("preferences", { kind: "note", text: "x" });
    const g0 = auth.calls.get;
    now -= 10 * 60_000;
    now += 5 * 60_000;
    await s.grant("preferences", A.id, { scope: "read", expiresInSec: 3600, includeHistory: true });
    expect(auth.calls.get - g0).toBe(1);
  }, LONG);

  it("#42 serializing a session or agent exposes no secrets", async () => {
    const prf = rand();
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    const k = keys();
    const a = new EngramAgent({ config: base, agentId: 999n, x25519PrivateKey: k.priv, operator: chain.wallet(5) });
    const dump = [
      JSON.stringify(s), inspect(s, { depth: 10, maxArrayLength: 1000 }),
      JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), inspect(a, { depth: 10, maxArrayLength: 1000 }),
    ].join("\n");
    for (const secret of [prf, k.priv]) {
      expect(dump).not.toContain(toHex(secret).slice(2));
      expect(dump).not.toContain(Array.from(secret).join(", "));
      expect(dump).not.toContain(JSON.stringify(Object.fromEntries(secret.entries())));
    }
    expect(JSON.parse(JSON.stringify(s)).owner).toBe(s.owner);
  });
});

describe("S6 keep-set and grantee-limit edges", () => {
  it("#34 revoke while another grantee expires at the boundary succeeds first try", async () => {
    const prf = rand();
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    await s.remember("edge", { kind: "note", text: "x" });
    await s.grant("edge", A.id, { scope: "read", expiresInSec: 86400, includeHistory: true });
    await s.grant("edge", B.id, { scope: "read", expiresInSec: 1000, includeHistory: true });
    const [, expiry] = await read<[number, bigint]>("grantOf", [s.owner, nsIdOf(prf, "edge"), B.id]);
    await chain.test.setNextBlockTimestamp({ timestamp: expiry - 1n });
    await chain.test.mine({ blocks: 1 });
    await chain.test.setNextBlockTimestamp({ timestamp: expiry });
    expect(await code(s.revoke("edge", [A.id]))).toBe("OK");
  }, LONG);

  it("#35 a 17th grant succeeds when one of 16 grantees has expired", async () => {
    const ids = Array.from({ length: 17 }, (_, i) => 200n + BigInt(i));
    for (const id of ids) await mintWithKeys(id, keys().pub);
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: rand() });
    await s.remember("crowd", { kind: "note", text: "x" });
    for (let i = 0; i < 16; i++) await s.grant("crowd", ids[i]!, { scope: "read", expiresInSec: i === 15 ? 60 : 86400, includeHistory: false });
    await chain.increaseTime(120);
    expect(await code(s.grant("crowd", ids[16]!, { scope: "read", expiresInSec: 3600, includeHistory: false }))).toBe("OK");
  }, LONG);
});

describe("S7 validation and robustness", () => {
  it("#36 out-of-range agentId, bad agent text, wrong operator wallet: typed errors, no tx", async () => {
    const prf = rand();
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    const n = await relayerNonce();
    expect(await code(s.grant("preferences", -1n, { scope: "read", expiresInSec: 60, includeHistory: true }))).toBe("INPUT_INVALID");
    expect(await code(s.grant("preferences", 2n ** 256n, { scope: "read", expiresInSec: 60, includeHistory: true }))).toBe("INPUT_INVALID");
    expect(await relayerNonce()).toBe(n);
    await s.remember("ops", { kind: "note", text: "x" });
    await s.grant("ops", A.id, { scope: "readwrite", expiresInSec: 3600, includeHistory: true });
    const nsId = nsIdOf(prf, "ops");
    expect(await code(agentA().remember(s.owner, nsId, { kind: "note", text: "" }))).toBe("INPUT_INVALID");
    const wrongOp = new EngramAgent({ config: base, agentId: A.id, x25519PrivateKey: A.priv, operator: chain.wallet(5) });
    const before = await chain.publicClient.getTransactionCount({ address: chain.wallet(5).account.address });
    expect(await code(wrongOp.remember(s.owner, nsId, { kind: "note", text: "x" }))).toBe("NOT_AUTHORIZED");
    expect(await chain.publicClient.getTransactionCount({ address: chain.wallet(5).account.address })).toBe(before);
  }, LONG);

  it("#37 relay handler: array owner -> 400, RPC down -> 502, never throws", async () => {
    const h = createRelayHandler({ config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl }, wallet: chain.wallet(1) });
    const r1 = await h({ owner: [chain.wallet(5).account.address], data: "0x3cb3b05a", deadline: "9999999999", signature: "0x" + "11".repeat(65) });
    expect([r1.status, r1.body.code]).toEqual([400, "BAD_REQUEST"]);
    const down = createRelayHandler({ config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: "http://127.0.0.1:9" }, wallet: chain.wallet(1) });
    const data = encodeFunctionData({ abi: memoryRegistryAbi, functionName: "useNonce", args: [] });
    const r2 = await down({ owner: chain.wallet(5).account.address, data, deadline: "9999999999", signature: "0x" + "11".repeat(65) });
    expect([r2.status, r2.body.code]).toEqual([502, "UPSTREAM_UNAVAILABLE"]);
  }, LONG);

  it("#39 logs source sees a fresh write immediately and drops negative seqs", async () => {
    const prf = rand();
    const src = logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n, chainId: 31337 });
    const s = await EngramOwner.fromPrf({ config: cfg({ source: src }), prfOutput: prf });
    await s.remember("head", { kind: "note", text: "one" });
    await s.recall("head");
    await s.remember("head", { kind: "note", text: "two" });
    expect((await s.recall("head")).entries.map((e) => e.text)).toEqual(["one", "two"]);
    const neg: MemorySource = { ...src, entries: async (q) => { const got = await src.entries(q); return [{ ...got[0]!, seq: -1n }, ...got]; } };
    const s2 = await EngramOwner.fromPrf({ config: cfg({ source: neg }), prfOutput: prf });
    expect((await s2.recall("head")).entries.map((e) => e.seq)).toEqual([0n, 1n]);
  }, LONG);

  it("#40 #41 popup: malformed replies ignored, bad requests rejected, no sync throw", async () => {
    class W {
      ls = new Set<(e: MessageEvent) => void>();
      popup = { closed: false };
      location = { origin: "https://planner.test" };
      open() { return this.popup; }
      addEventListener(_t: string, f: (e: MessageEvent) => void) { this.ls.add(f); }
      removeEventListener(_t: string, f: (e: MessageEvent) => void) { this.ls.delete(f); }
      emit(data: unknown) { for (const f of [...this.ls]) f({ origin: "https://vault.test", data, source: this.popup } as MessageEvent); }
    }
    const req = { vaultUrl: "https://vault.test", agentId: 7n, labels: ["preferences"], scope: "read" as const, expiresInSec: 3600 };
    const OK = { type: "engram:connect:result", v: 1, ok: true, owner: "0x" + "ab".repeat(20), granted: ["preferences"], txHash: "0x" + "cd".repeat(32) };
    const w = new W();
    const p = connectEngram({ ...req, window: w as never, pollMs: 20 });
    w.emit({ type: "engram:connect:result", v: 1, ok: true });
    w.emit({ ...OK, owner: "<img src=x>", txHash: "nope", granted: [{ evil: 1 }] });
    w.emit(OK);
    expect(await code(p)).toBe("OK");

    let sync = false;
    let bad: Promise<unknown> | undefined;
    try { bad = connectEngram({ ...req, labels: ["Bad"], window: new W() as never }); } catch { sync = true; }
    expect(sync).toBe(false);
    expect(await code(bad!)).toBe("INPUT_INVALID");

    const url = (id: string) => `https://vault.test/connect?v=1&agentId=${id}&labels=preferences&scope=read&expiresInSec=3600&origin=https%3A%2F%2Fplanner.test`;
    expect(await code(() => parseConnectRequest(url((2n ** 256n).toString())))).toBe("INPUT_INVALID");
    for (const card of [{ endpoints: "https://planner.test" }, { endpoints: [null] }, { endpoints: [{ endpoint: 42 }] }]) {
      expect(parseConnectRequest(url("7"), { agentCard: card as never }).originVerified).toBe(false);
    }
  });
});

describe("S7 graphql source robustness", () => {
  it("#38 partial data or an errors array is SOURCE_UNAVAILABLE (fallback applies); a stuck cursor terminates", async () => {
    let body = "{}";
    let requests = 0;
    const server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => { requests++; res.writeHead(200, { "content-type": "application/json" }); res.end(body); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/graphql`;
    try {
      const prf = rand();
      const s = await EngramOwner.fromPrf({ config: cfg({ source: firstAvailable([graphqlSource(url), base.source]) }), prfOutput: prf });
      await s.remember("partial", { kind: "note", text: "via logs" });
      for (const b of ['{"data":{}}', '{"data":{"Entry":null},"errors":[{"message":"field error"}]}']) {
        body = b;
        expect((await s.recall("partial")).entries.map((e) => e.text)).toEqual(["via logs"]);
      }
      const page = JSON.stringify({ data: { Entry: Array.from({ length: 500 }, () => ({ seq: "0", epoch: "0", byOwner: true, agentId: "0", ciphertext: "0x01", txHash: "0x00" })) } });
      body = page;
      requests = 0;
      await graphqlSource(url).entries({ owner: chain.registry, nsId: nsIdOf(prf, "partial") }).catch(() => undefined);
      expect(requests).toBeLessThan(5);
    } finally {
      server.close();
    }
  }, LONG);
});
