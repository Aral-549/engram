// Adversarial probes for contracts/sdk.md (and the parts of memory-registry.md / crypto.md the SDK drives).
// A probe PASSES on spec-correct behavior and FAILS on a bug. Probes named "gap-demo:" document behavior the spec
// does not rule on; they assert the observed behavior so the gap is visible (see the report).
// Runs against a local anvil chain with the real compiled MemoryRegistry (tests/support/anvil.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { inspect } from "node:util";
import { x25519 } from "@noble/curves/ed25519.js";
import {
  createWalletClient,
  encodeFunctionData,
  hexToBytes,
  http,
  keccak256,
  parseSignature,
  serializeCompactSignature,
  signatureToCompactSignature,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  decryptEntry,
  deriveAccount,
  deriveNamespaceId,
  deriveNamespaceKey,
  encodeEntry,
  encryptEntry,
  wrapNamespaceKey,
} from "@engram/crypto";
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
const LONG = 600_000;

const agentKeys = () => {
  const priv = x25519.utils.randomSecretKey();
  return { priv, pub: x25519.getPublicKey(priv) };
};
const A = { id: 7n, ...agentKeys() };
const B = { id: 9n, ...agentKeys() };
const randPrf = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

/** Outcome of a call: "OK", an EngramError code, or "RAW:<class>" for anything that is not an EngramError. */
async function outcome(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === "function" ? p() : p);
    return "OK";
  } catch (e) {
    if (e instanceof EngramError) return e.code;
    return `RAW:${(e as Error)?.constructor?.name}:${String((e as Error)?.message).slice(0, 120)}`;
  }
}
async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

let uniq = 0;
/** A logs source that builds a brand-new viem client per call, so viem's block-number cache can never be stale. */
function freshSource(): MemorySource {
  const mk = () => logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n, chainId: 2_000_000 + uniq++ });
  return {
    entries: (q) => mk().entries(q),
    wraps: (q) => mk().wraps(q),
    grantsForAgent: (a) => mk().grantsForAgent(a),
    grantsForOwner: (o) => mk().grantsForOwner(o),
    agentKeys: (a) => mk().agentKeys!(a),
  };
}
const config = (o: Partial<EngramConfig> = {}): EngramConfig => ({ ...base, ...o });
const agent = (which: typeof A, operatorIndex: number, cfg = base) =>
  new EngramAgent({ config: cfg, agentId: which.id, x25519PrivateKey: which.priv, operator: chain.wallet(operatorIndex) });
const nsIdOf = (prf: Uint8Array, label: string) => toHex(deriveNamespaceId(prf, label));
const relayerNonce = () => chain.publicClient.getTransactionCount({ address: chain.wallet(1).account.address });
const read = <T>(functionName: string, args: unknown[]) =>
  chain.publicClient.readContract({ address: chain.registry, abi: memoryRegistryAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
const OWNER_CALL = { OwnerCall: [{ name: "owner", type: "address" }, { name: "dataHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] } as const;

/** Directly funded wallet for an owner PRF (bypasses the relayer, like golden #17). */
async function ownerWallet(prf: Uint8Array) {
  const acc = privateKeyToAccount(toHex(deriveAccount(prf).accountKey));
  await chain.test.setBalance({ address: acc.address, value: 10n ** 18n });
  return createWalletClient({ chain: chain.chain, transport: http(chain.rpcUrl), account: acc });
}

async function mintWithKeys(id: bigint, pub: Uint8Array, holderIndex = 5) {
  await chain.mintAgent(id, chain.wallet(holderIndex).account.address);
  const h = await chain.wallet(holderIndex).writeContract({
    address: chain.registry, abi: memoryRegistryAbi, functionName: "setAgentKeys", args: [id, toHex(pub), chain.wallet(holderIndex).account.address],
  });
  await chain.publicClient.waitForTransactionReceipt({ hash: h });
}

beforeAll(async () => {
  chain = await startLocalChain();
  lines = [];
  const handler = createRelayHandler({
    config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl },
    wallet: chain.wallet(1),
    limits: { perOwnerPerMinute: 10_000, globalPerMinute: 100_000 },
  });
  base = {
    chainId: 31337,
    registry: chain.registry,
    identityRegistry: chain.identityRegistry,
    rpcUrl: chain.rpcUrl,
    source: freshSource(),
    relayer: inProcessRelayer(handler),
    logger: (line) => lines.push(line),
  };
  await chain.mintAgent(A.id, chain.wallet(2).account.address);
  await chain.mintAgent(B.id, chain.wallet(4).account.address);
  await EngramAgent.publishKeys({ config: base, agentId: A.id, x25519PublicKey: A.pub, operator: chain.wallet(3).account.address, holder: chain.wallet(2) });
  await EngramAgent.publishKeys({ config: base, agentId: B.id, x25519PublicKey: B.pub, operator: chain.wallet(4).account.address, holder: chain.wallet(4) });
}, LONG);

afterAll(() => chain?.stop());

// ================================================================================================ secret leakage

/** Every serialization an app, logger, or error reporter might apply to a value. */
function serializations(v: unknown): string {
  const out: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = v;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as Error;
    try { out.push(JSON.stringify(cur, (_k, x) => (typeof x === "bigint" ? x.toString() : x))); } catch { /* circular */ }
    out.push(String(cur), String(e.message), String(e.stack), inspect(cur, { depth: 20, maxArrayLength: 10_000, breakLength: Infinity }));
    cur = e.cause;
  }
  return out.join("\n");
}
/** Needles for a byte secret: hex, and the {"0":..} / "[ a, b, ... ]" forms JSON and inspect use for Uint8Array. */
function needles(bytes: Uint8Array): string[] {
  const hex = toHex(bytes).slice(2);
  return [hex, hex.toUpperCase(), JSON.stringify(Object.fromEntries(bytes.entries())), Array.from(bytes).join(", ")];
}
function leaks(haystack: string, secrets: Record<string, Uint8Array | string>): string[] {
  const found: string[] = [];
  for (const [name, s] of Object.entries(secrets)) {
    const ns = typeof s === "string" ? [s] : needles(s);
    if (ns.some((n) => haystack.includes(n))) found.push(name);
  }
  return found;
}

describe("secret leakage", () => {
  it("leak: JSON.stringify / inspect of an OwnerSession must not expose the PRF output", async () => {
    const prf = randPrf();
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    const dump = [JSON.stringify(s), inspect(s, { depth: 10, maxArrayLength: 1000, breakLength: Infinity })].join("\n");
    expect(leaks(dump, { prf })).toEqual([]);
    s.end();
  });

  it("leak: JSON.stringify / inspect of an EngramAgent must not expose its X25519 private key", () => {
    const k = agentKeys();
    const a = new EngramAgent({ config: base, agentId: 999n, x25519PrivateKey: k.priv, operator: chain.wallet(5) });
    const dump = [JSON.stringify(a, (_k, x) => (typeof x === "bigint" ? x.toString() : x)), inspect(a, { depth: 10, maxArrayLength: 1000, breakLength: Infinity })].join("\n");
    expect(leaks(dump, { x25519Private: k.priv })).toEqual([]);
  });

  it("leak: errors (incl. cause chain, JSON, inspect) and log lines across failure paths carry no PRF, keys, or plaintext", async () => {
    const prf = randPrf();
    const marker = `PLAINTEXT-MARKER-${toHex(randPrf()).slice(2, 18)}`;
    const acc = deriveAccount(prf);
    const secrets = {
      prf, accountKey: acc.accountKey, nsKey0: deriveNamespaceKey(prf, "leaky", 0), nsKey1: deriveNamespaceKey(prf, "leaky", 1),
      agentPriv: A.priv, plaintext: marker,
    };
    lines.length = 0;
    const errs: unknown[] = [];
    // relayer unreachable
    const s1 = await EngramOwner.fromPrf({ config: config({ relayer: httpRelayer("http://127.0.0.1:9/api/relay") }), prfOutput: prf });
    errs.push(await caught(s1.remember("leaky", { kind: "note", text: marker })));
    // relay rejected (NotGrantee) and invalid input paths
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    await s.remember("leaky", { kind: "note", text: marker });
    errs.push(await caught(s.revoke("leaky", [424242n])));
    errs.push(await caught(s.grant("leaky", 5555n, { scope: "read", expiresInSec: 60, includeHistory: true })));
    errs.push(await caught(s.remember("leaky", { kind: "bogus" as never, text: marker })));
    errs.push(await caught(s.remember("leaky", { kind: "note", text: marker.repeat(200) })));
    // lying source returning junk ciphertext (decrypt failure path) and a throwing source
    const junk: MemorySource = { ...base.source, entries: async () => [{ seq: 0n, epoch: 0n, byOwner: true, agentId: 0n, ciphertext: "0x01" as Hex, txHash: "0x00" as Hex }] };
    const s2 = await EngramOwner.fromPrf({ config: config({ source: junk }), prfOutput: prf });
    await s2.recall("leaky");
    const throwing: MemorySource = { ...base.source, entries: async () => { throw new Error("boom"); } };
    const s3 = await EngramOwner.fromPrf({ config: config({ source: throwing }), prfOutput: prf });
    errs.push(await caught(s3.recall("leaky")));
    // agent write with a wallet that is not its operator (viem error with calldata)
    await s.grant("leaky", A.id, { scope: "readwrite", expiresInSec: 3600, includeHistory: true });
    errs.push(await caught(agent(A, 5).remember(s.owner, nsIdOf(prf, "leaky"), { kind: "note", text: marker })));
    // in-flight call when the session ends (Mera SESSION_ENDED path)
    const p = s.remember("leaky", { kind: "note", text: marker });
    s.end();
    errs.push(await caught(p));
    const present = errs.filter(Boolean);
    expect(present.length).toBeGreaterThanOrEqual(7);
    const hay = present.map(serializations).join("\n") + "\n" + JSON.stringify(lines);
    expect(leaks(hay, secrets)).toEqual([]);
  }, LONG);
});

// ================================================================================================ session scoping

describe("session scoping", () => {
  it("session: a call in flight when end() runs rejects with EngramError SESSION_ENDED and writes nothing", async () => {
    const prf = randPrf();
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    await s.remember("inflight", { kind: "note", text: "first" });
    const nsId = nsIdOf(prf, "inflight");
    const p = s.remember("inflight", { kind: "note", text: "after end" });
    s.end();
    const got = await outcome(p);
    const [, , nextSeq] = await read<[boolean, bigint, bigint]>("namespaceOf", [s.owner, nsId]);
    expect({ got, nextSeq }).toEqual({ got: "SESSION_ENDED", nextSeq: 1n });
  }, LONG);

  it("session: recall in flight when end() runs must not return a silently empty 'complete' result", async () => {
    const prf = randPrf();
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    await s.remember("inflight", { kind: "note", text: "visible" });
    const p = s.recall("inflight");
    s.end();
    let res: unknown;
    const got = await outcome(p.then((r) => (res = r)));
    // Spec-correct: SESSION_ENDED. Bug: resolves with entries decrypted under keys derived from a zeroed PRF.
    expect({ got, res }).toEqual({ got: "SESSION_ENDED", res: undefined });
  }, LONG);

  it("session: the wall clock stepping backwards must not extend the 60 s prompt-free grant window", async () => {
    let now = 50_000_000;
    const auth = new FakeAuthenticator("clock-back");
    const s = await EngramOwner.signUp({ config: base, rpId: RP, rpName: "Engram", userName: "cb", webAuthnClient: auth.client, clock: () => now });
    await s.remember("preferences", { kind: "note", text: "x" });
    const g0 = auth.calls.get;
    now -= 10 * 60_000; // NTP / user steps the clock back 10 minutes right after sign-in
    now += 5 * 60_000; // 5 real minutes pass
    await s.grant("preferences", A.id, { scope: "read", expiresInSec: 3600, includeHistory: true });
    expect(auth.calls.get - g0).toBe(1); // 5 minutes since the ceremony: must re-prompt
  }, LONG);

  it("session: cancelled grant re-prompt -> PASSKEY_CANCELLED, no tx", async () => {
    let now = 60_000_000;
    const auth = new FakeAuthenticator("cancel-reprompt");
    const s = await EngramOwner.signUp({ config: base, rpId: RP, rpName: "Engram", userName: "cr", webAuthnClient: auth.client, clock: () => now });
    await s.remember("preferences", { kind: "note", text: "x" });
    now += 90_000;
    auth.cancelNext = true;
    const n = await relayerNonce();
    expect(await outcome(s.grant("preferences", A.id, { scope: "read", expiresInSec: 3600, includeHistory: true }))).toBe("PASSKEY_CANCELLED");
    expect(await relayerNonce()).toBe(n);
  }, LONG);

  it("session: revoke/rotate/cancelPending never prompt and do not refresh the grant window", async () => {
    let now = 70_000_000;
    const auth = new FakeAuthenticator("no-refresh");
    const s = await EngramOwner.signUp({ config: base, rpId: RP, rpName: "Engram", userName: "nr", webAuthnClient: auth.client, clock: () => now });
    await s.remember("preferences", { kind: "note", text: "x" });
    const g0 = auth.calls.get;
    now += 120_000;
    await s.grant("preferences", A.id, { scope: "read", expiresInSec: 3600, includeHistory: true });
    expect(auth.calls.get).toBe(g0 + 1);
    now += 120_000;
    await s.rotate("preferences");
    await s.revoke("preferences", [A.id]);
    await s.cancelPending();
    expect(auth.calls.get).toBe(g0 + 1);
    await s.grant("preferences", B.id, { scope: "read", expiresInSec: 3600, includeHistory: true });
    expect(auth.calls.get).toBe(g0 + 2);
  }, LONG);

  it("session: idle expiry is enforced for grants() too", async () => {
    let now = 80_000_000;
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: randPrf(), clock: () => now });
    now += 15 * 60_000 + 1;
    expect(await outcome(s.grants())).toBe("SESSION_EXPIRED");
    expect(await outcome(s.remember("preferences", { kind: "note", text: "x" }))).toBe("SESSION_ENDED");
  });
});

// ================================================================================================ relay handler

describe("relay handler", () => {
  async function signFor(prfOrKey: Hex, data: Hex, opts: { nonce?: bigint; deadline?: bigint; chainId?: number } = {}) {
    const owner = privateKeyToAccount(prfOrKey);
    const nonce = opts.nonce ?? (await read<bigint>("nonces", [owner.address]));
    const deadline = opts.deadline ?? (await chain.publicClient.getBlock()).timestamp + 300n;
    const signature = await owner.signTypedData({
      domain: { name: "EngramMemoryRegistry", version: "1", chainId: opts.chainId ?? 31337, verifyingContract: chain.registry },
      types: OWNER_CALL, primaryType: "OwnerCall", message: { owner: owner.address, dataHash: keccak256(data), nonce, deadline },
    });
    return { owner: owner.address, data, deadline: deadline.toString(), signature };
  }
  const handlerWith = (limits?: { perOwnerPerMinute?: number; globalPerMinute?: number }, rpcUrl?: string) =>
    createRelayHandler({ config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: rpcUrl ?? chain.rpcUrl }, wallet: chain.wallet(1), limits });

  it("relay: array-typed owner in a JSON body returns 400 instead of throwing", async () => {
    const h = handlerWith();
    const body = { owner: [chain.wallet(5).account.address], data: "0x3cb3b05a" + "00".repeat(32), deadline: "9999999999", signature: "0x" + "11".repeat(65) };
    const got = await h(JSON.parse(JSON.stringify(body))).then((r) => r.status, (e) => `THREW:${(e as Error).message}`);
    expect(got).toBe(400);
  });

  it("relay: RPC failure resolves to a 5xx status instead of throwing", async () => {
    const h = handlerWith(undefined, "http://127.0.0.1:9");
    const key = toHex(randPrf());
    const data = encodeFunctionData({ abi: memoryRegistryAbi, functionName: "useNonce", args: [] });
    const body = { owner: privateKeyToAccount(key).address, data, deadline: "9999999999", signature: "0x" + "11".repeat(65) };
    const got = await h(body).then((r) => `status ${r.status} ${r.body.code}`, (e) => `THREW:${(e as Error).constructor.name}: ${(e as Error).message.split("\n")[0]}`);
    expect(got).toMatch(/^status 5\d\d/);
  });

  it("relay: forged-signature requests naming a victim owner must not exhaust the victim's per-owner rate limit", async () => {
    const h = handlerWith({ perOwnerPerMinute: 30, globalPerMinute: 100_000 });
    const prf = randPrf();
    const victim = await EngramOwner.fromPrf({ config: config({ relayer: inProcessRelayer(h) }), prfOutput: prf });
    const data = encodeFunctionData({ abi: memoryRegistryAbi, functionName: "useNonce", args: [] });
    for (let i = 0; i < 30; i++) {
      await h({ owner: victim.owner, data, deadline: "9999999999", signature: "0x" + "11".repeat(65) }); // attacker holds no key
    }
    const e = await caught(victim.cancelPending());
    expect(e === undefined ? "OK" : `${(e as EngramError).code}/${(e as EngramError).detail}`).toBe("OK");
  }, LONG);

  it("relay: owner hex-case variations share one rate-limit bucket", async () => {
    const h = handlerWith({ perOwnerPerMinute: 3, globalPerMinute: 100_000 });
    const addr = privateKeyToAccount(toHex(randPrf())).address;
    const data = encodeFunctionData({ abi: memoryRegistryAbi, functionName: "useNonce", args: [] });
    const statuses: number[] = [];
    for (const o of [addr, addr.toLowerCase(), addr, addr.toLowerCase()])
      statuses.push((await h({ owner: o, data, deadline: "9999999999", signature: "0x" + "11".repeat(65) })).status);
    expect(statuses.at(-1)).toBe(429);
  });

  it("relay: high-s, wrong-chain, wrong-registry, and EIP-2098 compact signatures never send a tx", async () => {
    const h = handlerWith();
    const prf = randPrf();
    const key = toHex(deriveAccount(prf).accountKey);
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    await s.remember("sigs", { kind: "note", text: "x" }); // namespace exists, so a valid call would succeed
    const data = encodeFunctionData({ abi: memoryRegistryAbi, functionName: "appendAsOwner", args: [nsIdOf(prf, "sigs"), 0n, toHex(new Uint8Array(30).fill(1))] });
    const good = await signFor(key, data);
    const sig = parseSignature(good.signature);
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = toHex(new Uint8Array([...hexToBytes(sig.r), ...hexToBytes(toHex(N - BigInt(sig.s), { size: 32 })), sig.yParity === 0 ? 28 : 27]));
    const wrongChain = await signFor(key, data, { chainId: 143 });
    const compact = serializeCompactSignature(signatureToCompactSignature(sig));
    const n = await relayerNonce();
    const r1 = await h({ ...good, signature: highS });
    const r2 = await h(wrongChain);
    const r3 = await h({ ...good, signature: compact });
    expect([r1.status, r2.status]).toEqual([400, 400]);
    expect(typeof r3.status).toBe("number");
    expect(await relayerNonce()).toBe(n);
  }, LONG);

  it("relay: a reverting request in the serialized queue does not poison concurrent valid ones", async () => {
    const h = handlerWith();
    const mk = async () => {
      const prf = randPrf();
      const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
      await s.remember("q", { kind: "note", text: "x" });
      return { prf, key: toHex(deriveAccount(prf).accountKey) };
    };
    const [o1, o3] = [await mk(), await mk()];
    const o2 = toHex(randPrf()); // no namespace: its append reverts NoNamespace
    const ct = toHex(new Uint8Array(30).fill(2));
    const reqs = await Promise.all([
      signFor(o1.key, encodeFunctionData({ abi: memoryRegistryAbi, functionName: "appendAsOwner", args: [nsIdOf(o1.prf, "q"), 0n, ct] })),
      signFor(o2, encodeFunctionData({ abi: memoryRegistryAbi, functionName: "appendAsOwner", args: [keccak256("0x01"), 0n, ct] })),
      signFor(o3.key, encodeFunctionData({ abi: memoryRegistryAbi, functionName: "appendAsOwner", args: [nsIdOf(o3.prf, "q"), 0n, ct] })),
    ]);
    const res = await Promise.all(reqs.map((r) => h(r)));
    expect(res.map((r) => [r.status, r.body.code ?? "ok"])).toEqual([[200, "ok"], [400, "NoNamespace"], [200, "ok"]]);
  }, LONG);
});

// ================================================================================================ owner correctness

describe("owner writes", () => {
  it("owner: a relayer that returns an old txHash must not make revoke report success while the agent stays active", async () => {
    let fake: Hex | undefined;
    const lying: Relayer = { submit: async (req) => (fake ? { txHash: fake } : base.relayer.submit(req)) };
    const prf = randPrf();
    const s = await EngramOwner.fromPrf({ config: config({ relayer: lying }), prfOutput: prf });
    await s.remember("lying-relayer", { kind: "note", text: "x" });
    const g = await s.grant("lying-relayer", A.id, { scope: "readwrite", expiresInSec: 3600, includeHistory: true });
    fake = g.txHash; // relayer (vault API, or anything between) silently drops the revoke and replays an old hash
    const got = await outcome(s.revoke("lying-relayer", [A.id]));
    const stillActive = await read<boolean>("isActive", [s.owner, nsIdOf(prf, "lying-relayer"), A.id]);
    expect({ reportedSuccess: got === "OK", stillActive }).not.toEqual({ reportedSuccess: true, stillActive: true });
  }, LONG);

  it("owner: remember must not accept another owner's EntryAppended as its own write", async () => {
    let fake: Hex | undefined;
    const lying: Relayer = { submit: async (req) => (fake ? { txHash: fake } : base.relayer.submit(req)) };
    const other = await EngramOwner.fromPrf({ config: base, prfOutput: randPrf() });
    await other.remember("x", { kind: "note", text: "a" });
    const foreign = await other.remember("x", { kind: "note", text: "b" }); // seq 1 in someone else's namespace
    const prf = randPrf();
    const s = await EngramOwner.fromPrf({ config: config({ relayer: lying }), prfOutput: prf });
    await s.remember("mine", { kind: "note", text: "real" });
    fake = foreign.txHash;
    const res = await s.remember("mine", { kind: "note", text: "dropped" }).then((r) => r, () => undefined);
    const [, , nextSeq] = await read<[boolean, bigint, bigint]>("namespaceOf", [s.owner, nsIdOf(prf, "mine")]);
    expect({ resolved: res !== undefined, nextSeq }).not.toEqual({ resolved: true, nextSeq: 1n });
  }, LONG);

  it("owner: a grantee that switches to a low-order X25519 key must not block revoking a different agent", async () => {
    const X = { id: 31n, ...agentKeys() };
    await mintWithKeys(X.id, X.pub);
    const prf = randPrf();
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    await s.remember("block", { kind: "note", text: "x" });
    await s.grant("block", X.id, { scope: "read", expiresInSec: 3600, includeHistory: true });
    await s.grant("block", B.id, { scope: "read", expiresInSec: 3600, includeHistory: true });
    // The malicious grantee (still the token holder, so keys stay "current") sets a canonical but low-order key (u = 1).
    const lowOrder = new Uint8Array(32);
    lowOrder[0] = 1;
    const h = await chain.wallet(5).writeContract({ address: chain.registry, abi: memoryRegistryAbi, functionName: "setAgentKeys", args: [X.id, toHex(lowOrder), chain.wallet(5).account.address] });
    await chain.publicClient.waitForTransactionReceipt({ hash: h });
    const got = await outcome(s.revoke("block", [B.id]));
    const bActive = await read<boolean>("isActive", [s.owner, nsIdOf(prf, "block"), B.id]);
    expect({ got, bActive }).toEqual({ got: "OK", bActive: false });
  }, LONG);

  it("owner: rotate wrap failure surfaces as an EngramError (not a raw crypto error)", async () => {
    const X = { id: 32n, ...agentKeys() };
    await mintWithKeys(X.id, X.pub);
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: randPrf() });
    await s.remember("block2", { kind: "note", text: "x" });
    await s.grant("block2", X.id, { scope: "read", expiresInSec: 3600, includeHistory: true });
    const nonCanonical = new Uint8Array(32).fill(0x05);
    nonCanonical[31] = 0x85;
    const h = await chain.wallet(5).writeContract({ address: chain.registry, abi: memoryRegistryAbi, functionName: "setAgentKeys", args: [X.id, toHex(nonCanonical), chain.wallet(5).account.address] });
    await chain.publicClient.waitForTransactionReceipt({ hash: h });
    const got = await outcome(s.rotate("block2"));
    expect(got).not.toMatch(/^RAW:/);
  }, LONG);

  it("owner: revoke of a non-grantee and of a duplicate id fail with a typed error and no epoch change", async () => {
    const prf = randPrf();
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    await s.remember("nongrantee", { kind: "note", text: "x" });
    await s.grant("nongrantee", A.id, { scope: "read", expiresInSec: 3600, includeHistory: true });
    expect(await outcome(s.revoke("nongrantee", [424242n]))).toBe("RELAY_REJECTED");
    expect(await outcome(s.revoke("nongrantee", [A.id, A.id]))).toBe("RELAY_REJECTED");
    const [, epoch] = await read<[boolean, bigint, bigint]>("namespaceOf", [s.owner, nsIdOf(prf, "nongrantee")]);
    expect(epoch).toBe(0n);
  }, LONG);

  it("owner: grant with a negative or > uint256 agentId -> INPUT_INVALID before any tx", async () => {
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: randPrf() });
    const n = await relayerNonce();
    expect(await outcome(s.grant("preferences", -1n, { scope: "read", expiresInSec: 60, includeHistory: true }))).toBe("INPUT_INVALID");
    expect(await outcome(s.grant("preferences", 2n ** 256n, { scope: "read", expiresInSec: 60, includeHistory: true }))).toBe("INPUT_INVALID");
    expect(await relayerNonce()).toBe(n);
  });

  it("owner: two tabs doing the first remember on a new label concurrently (NamespaceExists race) both succeed", async () => {
    const prf = randPrf();
    const s1 = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    const s2 = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    // Timing-dependent: tab2's re-signed createNamespace can lose the next nonce to tab1's append (retry budget is 1).
    const failures: string[] = [];
    for (let round = 0; round < 4; round++) {
      const r = await Promise.allSettled([s1.remember(`fresh-${round}`, { kind: "note", text: "t1" }), s2.remember(`fresh-${round}`, { kind: "note", text: "t2" })]);
      for (const x of r) if (x.status === "rejected") failures.push(`${(x.reason as EngramError).code}/${(x.reason as EngramError).detail}`);
    }
    expect(failures).toEqual([]);
  }, LONG);

  it("gap-demo: 4 concurrent sessions of one owner -- stale-nonce retry is only once, so some writes fail (loudly)", async () => {
    const prf = randPrf();
    const s0 = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    await s0.remember("many", { kind: "note", text: "seed" });
    const sessions = await Promise.all([0, 1, 2, 3].map(() => EngramOwner.fromPrf({ config: base, prfOutput: prf })));
    const r = await Promise.allSettled(sessions.map((s, i) => s.remember("many", { kind: "note", text: `tab${i}` })));
    const failed = r.filter((x) => x.status === "rejected") as PromiseRejectedResult[];
    process.stderr.write(`[gap-demo] 4 concurrent remembers: ${4 - failed.length} ok, ${failed.length} failed (${failed.map((f) => (f.reason as EngramError).detail).join(",")})\n`);
    for (const f of failed) expect(f.reason).toBeInstanceOf(EngramError);
  }, LONG);
});

describe("owner: 16 grantees and the 17th agent", () => {
  const ids = Array.from({ length: 17 }, (_, i) => 100n + BigInt(i));
  const prf = randPrf();
  let s: Awaited<ReturnType<typeof EngramOwner.fromPrf>>;

  beforeAll(async () => {
    for (const id of ids) await mintWithKeys(id, agentKeys().pub);
    s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    await s.remember("crowd", { kind: "note", text: "x" });
    for (let i = 0; i < 16; i++) await s.grant("crowd", ids[i]!, { scope: "read", expiresInSec: i === 15 ? 60 : 86400, includeHistory: false });
  }, LONG);

  it("owner: rotate with 16 live grantees succeeds", async () => {
    expect(await outcome(s.rotate("crowd"))).toBe("OK");
  }, LONG);

  it("owner: 17th grant when one of 16 grantees has expired succeeds (memory-registry: 'the SDK rotates before adding a 17th agent')", async () => {
    await chain.increaseTime(120);
    const e = await caught(s.grant("crowd", ids[16]!, { scope: "read", expiresInSec: 3600, includeHistory: false }));
    expect(e === undefined ? "OK" : `${(e as EngramError).code}/${(e as EngramError).detail}`).toBe("OK");
  }, LONG);
});

describe("owner: keep-set race", () => {
  it("owner: revoke while another grantee expires between the SDK's chain-time read and execution still succeeds (sdk #21 retry)", async () => {
    const prf = randPrf();
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    await s.remember("race", { kind: "note", text: "x" });
    await s.grant("race", A.id, { scope: "read", expiresInSec: 86400, includeHistory: true });
    await s.grant("race", B.id, { scope: "read", expiresInSec: 1000, includeHistory: true });
    const [, expiry] = await read<[number, bigint]>("grantOf", [s.owner, nsIdOf(prf, "race"), B.id]);
    await chain.test.setNextBlockTimestamp({ timestamp: expiry - 1n });
    await chain.test.mine({ blocks: 1 }); // latest block: B still live for 1 more second
    await chain.test.setNextBlockTimestamp({ timestamp: expiry }); // the revoke executes in the block where B expires
    const e = await caught(s.revoke("race", [A.id]));
    const after = await read<readonly bigint[]>("granteesOf", [s.owner, nsIdOf(prf, "race")]);
    const ts = (await chain.publicClient.getBlock()).timestamp;
    process.stderr.write(`[keep-set race] expiry=${expiry} latestTs=${ts} grantees=${after} err=${e ? `${(e as EngramError).code}/${(e as EngramError).detail}` : "none"}\n`);
    expect(e === undefined ? "OK" : `${(e as EngramError).code}/${(e as EngramError).detail}`).toBe("OK");
  }, LONG);
});

// ================================================================================================ recall / sources

describe("recall completeness and lying sources", () => {
  it("recall: logsSource must see an entry written right after a previous read (no stale cached head)", async () => {
    const src = logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n, chainId: 31337 });
    const prf = randPrf();
    const s = await EngramOwner.fromPrf({ config: config({ source: src }), prfOutput: prf });
    await s.remember("fresh-head", { kind: "note", text: "one" });
    await s.recall("fresh-head"); // primes viem's 4 s block-number cache
    const w = await ownerWallet(prf);
    const ct = await encryptEntry({
      key: deriveNamespaceKey(prf, "fresh-head", 0), ctx: { chainId: 31337n, registry: chain.registry, owner: s.owner },
      nsId: deriveNamespaceId(prf, "fresh-head"), epoch: 0, plaintext: encodeEntry({ v: 1, t: 1, kind: "note", text: "two" }),
    });
    const h = await w.writeContract({ address: chain.registry, abi: memoryRegistryAbi, functionName: "appendAsOwner", args: [nsIdOf(prf, "fresh-head"), 0n, toHex(ct)] });
    for (let i = 0; i < 100; i++) { // poll quickly (viem's default 4 s receipt polling would let the cache expire)
      if (await chain.publicClient.getTransactionReceipt({ hash: h }).then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const r = await s.recall("fresh-head");
    expect({ texts: r.entries.map((e) => e.text), complete: r.complete }).toEqual({ texts: ["one", "two"], complete: true });
  }, LONG);

  it("recall: a source-supplied negative seq is never returned as an entry", async () => {
    const prf = randPrf();
    const real = freshSource();
    const lying: MemorySource = {
      ...real,
      entries: async (q) => {
        const got = await real.entries(q);
        return [{ ...got[0]!, seq: -1n }, ...got];
      },
    };
    const s = await EngramOwner.fromPrf({ config: config({ source: lying }), prfOutput: prf });
    await s.remember("negseq", { kind: "note", text: "only" });
    const r = await s.recall("negseq");
    expect(r.entries.map((e) => e.seq)).toEqual([0n]);
  }, LONG);

  it("gap-demo: a lying source substitutes an authentic older ciphertext for a seq; recall reports complete with no skips", async () => {
    const prf = randPrf();
    const real = freshSource();
    const lying: MemorySource = {
      ...real,
      entries: async (q) => {
        const got = await real.entries(q);
        return got.map((e) => (e.seq === 2n ? { ...e, ciphertext: got[0]!.ciphertext } : e)); // AAD binds epoch, not seq
      },
    };
    const s = await EngramOwner.fromPrf({ config: config({ source: lying }), prfOutput: prf });
    for (const t of ["a", "b", "c", "d"]) await s.remember("subst", { kind: "note", text: t });
    const r = await s.recall("subst");
    expect({ texts: r.entries.map((e) => e.text), complete: r.complete, skipped: r.skipped }).toEqual({ texts: ["a", "b", "a", "d"], complete: true, skipped: 0 });
  }, LONG);

  it("recall: a source lying about an entry's epoch makes it count as skipped, never silently vanish", async () => {
    const prf = randPrf();
    const real = freshSource();
    const lying: MemorySource = { ...real, entries: async (q) => (await real.entries(q)).map((e) => ({ ...e, epoch: e.epoch + 1n })) };
    const s = await EngramOwner.fromPrf({ config: config({ source: lying }), prfOutput: prf });
    await s.remember("epochlie", { kind: "note", text: "x" });
    const r = await s.recall("epochlie");
    expect({ n: r.entries.length, skipped: r.skipped, complete: r.complete }).toEqual({ n: 0, skipped: 1, complete: true });
  }, LONG);
});

describe("agent", () => {
  async function grantedOwner(label: string, scope: "read" | "readwrite") {
    const prf = randPrf();
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    await s.remember(label, { kind: "note", text: "owner entry" });
    await s.grant(label, A.id, { scope, expiresInSec: 3600, includeHistory: true });
    return { prf, s, nsId: nsIdOf(prf, label) };
  }

  it("agent: a forged wrap injected by the source must not become the key agent.remember encrypts under (exfiltration)", async () => {
    const { prf, s, nsId } = await grantedOwner("forged-wrap", "readwrite");
    const attackerKey = randPrf();
    const ctx = { chainId: 31337n, registry: chain.registry, owner: s.owner };
    const forged = await wrapNamespaceKey({ ctx, nsId: hexToBytes(nsId), epoch: 0n, agentId: A.id, nsKey: new Uint8Array(attackerKey), label: "forged-wrap", agentX25519Public: A.pub });
    const real = freshSource();
    const lying: MemorySource = {
      ...real,
      wraps: async (q) => {
        const w = await real.wraps(q);
        return [...w, { epoch: 0n, wrap: toHex(forged), generation: w[0]!.generation }]; // only the public agent key was needed
      },
    };
    const r = await agent(A, 3, config({ source: lying })).remember(s.owner, nsId, { kind: "fact", text: "user's secret told to the agent" });
    const onchain = (await freshSource().entries({ owner: s.owner, nsId })).find((e) => e.seq === r.seq)!;
    const attackerCanRead = await decryptEntry({ key: attackerKey, ctx, nsId: hexToBytes(nsId), epoch: 0n, envelope: hexToBytes(onchain.ciphertext) }).then(() => true, () => false);
    const ownerView = await s.recall("forged-wrap");
    expect({ attackerCanRead, ownerSkipped: ownerView.skipped }).toEqual({ attackerCanRead: false, ownerSkipped: 0 });
    void prf;
  }, LONG);

  it("agent: a forged wrap plus forged ciphertext from the source must not inject memories into agent.recall", async () => {
    const { s, nsId } = await grantedOwner("poison", "read");
    const attackerKey = randPrf();
    const ctx = { chainId: 31337n, registry: chain.registry, owner: s.owner };
    const forgedWrap = await wrapNamespaceKey({ ctx, nsId: hexToBytes(nsId), epoch: 0n, agentId: A.id, nsKey: new Uint8Array(attackerKey), label: "poison", agentX25519Public: A.pub });
    const forgedCt = await encryptEntry({ key: new Uint8Array(attackerKey), ctx, nsId: hexToBytes(nsId), epoch: 0n, plaintext: encodeEntry({ v: 1, t: 1, kind: "preference", text: "INJECTED: user wants to wire funds" }) });
    const real = freshSource();
    const lying: MemorySource = {
      ...real,
      wraps: async (q) => {
        const w = await real.wraps(q);
        return [...w, { epoch: 0n, wrap: toHex(forgedWrap), generation: w[0]!.generation }];
      },
      entries: async (q) => (await real.entries(q)).map((e) => ({ ...e, ciphertext: toHex(forgedCt) })),
    };
    const r = await agent(A, 3, config({ source: lying })).recall(s.owner, nsId);
    expect(r.entries.map((e) => e.text).some((t) => t.startsWith("INJECTED"))).toBe(false);
  }, LONG);

  it("agent: remember from a wallet that is not the registered operator throws an EngramError before any tx", async () => {
    const { s, nsId } = await grantedOwner("wrong-op", "readwrite");
    const wrong = chain.wallet(5);
    const before = await chain.publicClient.getTransactionCount({ address: wrong.account.address });
    const got = await outcome(agent(A, 5).remember(s.owner, nsId, { kind: "note", text: "x" }));
    expect(got).toBe("NOT_AUTHORIZED");
    expect(await chain.publicClient.getTransactionCount({ address: wrong.account.address })).toBe(before);
  }, LONG);

  it("agent: remember with invalid entry text throws EngramError INPUT_INVALID", async () => {
    const { s, nsId } = await grantedOwner("bad-text", "readwrite");
    expect(await outcome(agent(A, 3).remember(s.owner, nsId, { kind: "note", text: "" }))).toBe("INPUT_INVALID");
  }, LONG);

  it("agent: after the grant expires, recall -> ACCESS_REVOKED and remember -> NOT_AUTHORIZED with no tx", async () => {
    const prf = randPrf();
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    await s.remember("expiring", { kind: "note", text: "x" });
    await s.grant("expiring", A.id, { scope: "readwrite", expiresInSec: 30, includeHistory: true });
    await chain.increaseTime(60);
    const nsId = nsIdOf(prf, "expiring");
    const before = await chain.publicClient.getTransactionCount({ address: chain.wallet(3).account.address });
    expect(await outcome(agent(A, 3).recall(s.owner, nsId))).toBe("ACCESS_REVOKED");
    expect(await outcome(agent(A, 3).remember(s.owner, nsId, { kind: "note", text: "late" }))).toBe("NOT_AUTHORIZED");
    expect(await chain.publicClient.getTransactionCount({ address: chain.wallet(3).account.address })).toBe(before);
  }, LONG);
});

// ================================================================================================ source implementations

describe("sources", () => {
  let server: Server;
  let url = "";
  let reply: (body: string) => string = () => "{}";
  let requests = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(reply(body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address() as { port: number };
    url = `http://127.0.0.1:${addr.port}/v1/graphql`;
  });
  afterAll(() => server?.close());

  it("graphqlSource: partial/erroring responses are SOURCE_UNAVAILABLE so firstAvailable falls back to logs", async () => {
    const prf = randPrf();
    const cfg = config({ source: firstAvailable([graphqlSource(url), freshSource()]) });
    const s = await EngramOwner.fromPrf({ config: cfg, prfOutput: prf });
    await s.remember("partial", { kind: "note", text: "via logs" });
    const results: string[] = [];
    for (const body of ['{"data":{}}', '{"data":{"Entry":null},"errors":[{"message":"field error"}]}']) {
      reply = () => body;
      results.push(await outcome(s.recall("partial")));
    }
    expect(results).toEqual(["OK", "OK"]);
  }, LONG);

  it("graphqlSource: malformed JSON / HTTP errors -> SOURCE_UNAVAILABLE", async () => {
    reply = () => "not json{";
    expect(await outcome(graphqlSource(url).entries({ owner: chain.registry, nsId: keccak256("0x01") }))).toBe("SOURCE_UNAVAILABLE");
    expect(await outcome(graphqlSource("http://127.0.0.1:9/v1/graphql").grantsForAgent(1n))).toBe("SOURCE_UNAVAILABLE");
  });

  it("graphqlSource: a page cursor that never advances terminates instead of looping", async () => {
    const page = JSON.stringify({ data: { Entry: Array.from({ length: 500 }, () => ({ seq: "0", epoch: "0", byOwner: true, agentId: "0", ciphertext: "0x01", txHash: "0x00" })) } });
    requests = 0;
    reply = () => (requests > 40 ? '{"data":{"Entry":[]}}' : page);
    await graphqlSource(url).entries({ owner: chain.registry, nsId: keccak256("0x01") }).catch(() => undefined);
    expect(requests).toBeLessThan(40);
  });

  it("logsSource: blockRange 0n fails fast with a typed error (no infinite loop)", async () => {
    const src = logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n, blockRange: 0n, chainId: 3_000_001 });
    const got = await Promise.race([outcome(src.entries({ owner: chain.registry, nsId: keccak256("0x01") })), new Promise<string>((r) => setTimeout(() => r("HANG"), 8000))]);
    expect(got === "INPUT_INVALID" || got === "SOURCE_UNAVAILABLE").toBe(true);
  }, 20_000);

  it("logsSource: blockRange 1n and fromBlock past head", async () => {
    const prf = randPrf();
    const s = await EngramOwner.fromPrf({ config: base, prfOutput: prf });
    await s.remember("ranges", { kind: "note", text: "x" });
    const head = await chain.publicClient.getBlockNumber();
    const q = { owner: s.owner, nsId: nsIdOf(prf, "ranges") };
    const one = await logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: head - 3n, blockRange: 1n, chainId: 3_000_002 }).entries(q);
    const past = await logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: head + 100n, chainId: 3_000_003 }).entries(q);
    expect([one.length, past.length]).toEqual([1, 0]);
  }, LONG);

  it("firstAvailable: a non-SOURCE_UNAVAILABLE error from the first source surfaces (no silent fallback)", async () => {
    const bad: MemorySource = { ...base.source, entries: async () => { throw new EngramError("INPUT_INVALID", "x"); } };
    expect(await outcome(firstAvailable([bad, base.source]).entries({ owner: chain.registry, nsId: keccak256("0x01") }))).toBe("INPUT_INVALID");
  });
});

// ================================================================================================ popup protocol

describe("connect popup protocol", () => {
  class FakeWindow {
    listeners = new Set<(e: MessageEvent) => void>();
    popup: { closed: boolean } | null = { closed: false };
    location = { origin: "https://planner.test" };
    open() {
      return this.popup;
    }
    addEventListener(_t: string, f: (e: MessageEvent) => void) {
      this.listeners.add(f);
    }
    removeEventListener(_t: string, f: (e: MessageEvent) => void) {
      this.listeners.delete(f);
    }
    emit(origin: string, data: unknown, source: unknown = this.popup) {
      for (const f of [...this.listeners]) f({ origin, data, source } as MessageEvent);
    }
  }
  const req = { vaultUrl: "https://vault.test", agentId: 7n, labels: ["preferences"], scope: "read" as const, expiresInSec: 3600 };
  const OK = { type: "engram:connect:result", v: 1, ok: true, owner: "0x" + "ab".repeat(20), granted: ["preferences"], txHash: "0x" + "cd".repeat(32) };

  it("connect: an ok:true message missing owner is malformed and ignored (case 14), the real reply still resolves", async () => {
    const w = new FakeWindow();
    const p = connectEngram({ ...req, window: w as never, pollMs: 20 });
    w.emit("https://vault.test", { type: "engram:connect:result", v: 1, ok: true });
    w.emit("https://vault.test", OK);
    expect(await outcome(p)).toBe("OK");
  });

  it("connect: ok:true with a non-address owner, non-hex txHash, or non-string granted does not resolve", async () => {
    const w = new FakeWindow();
    const p = connectEngram({ ...req, window: w as never, pollMs: 20 });
    let settled: unknown = "pending";
    p.then((v) => (settled = v), () => (settled = "rejected"));
    w.emit("https://vault.test", { ...OK, owner: "<img src=x onerror=alert(1)>", txHash: "not-a-hash", granted: [{ evil: 1 }] });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled === "pending" || settled === "rejected" ? "not resolved" : JSON.stringify(settled)).toBe("not resolved");
    w.popup!.closed = true;
  });

  it("parseConnectRequest: origin tricks are rejected", () => {
    const u = (origin: string) => `https://vault.test/connect?v=1&agentId=7&labels=preferences&scope=read&expiresInSec=3600&origin=${encodeURIComponent(origin)}`;
    const bad = ["https://planner.test/", "https://PLANNER.test", "https://planner.test:443", "https://u:p@planner.test", "null", "javascript:alert(1)", "data:text/html,x", "https://plannér.test", " https://planner.test", "https://planner.test#x", "ftp://planner.test", ""];
    const got = bad.map((o) => { try { parseConnectRequest(u(o)); return `ACCEPTED ${o}`; } catch (e) { return e instanceof EngramError ? e.code : `RAW ${o}`; } });
    expect(got.every((g) => g === "INPUT_INVALID")).toBe(true);
    expect(parseConnectRequest(u("https://planner.test")).origin).toBe("https://planner.test");
  });

  it("parseConnectRequest: agentId above uint256 -> INPUT_INVALID", () => {
    const big = (2n ** 256n).toString();
    const url = `https://vault.test/connect?v=1&agentId=${big}&labels=preferences&scope=read&expiresInSec=3600&origin=https%3A%2F%2Fplanner.test`;
    expect(() => parseConnectRequest(url)).toThrow(EngramError);
  });

  it("parseConnectRequest: a malformed agent card (from the agent's own tokenURI) yields originVerified false, not a TypeError", () => {
    const url = "https://vault.test/connect?v=1&agentId=7&labels=preferences&scope=read&expiresInSec=3600&origin=https%3A%2F%2Fplanner.test";
    const results = [{ endpoints: "https://planner.test" }, { endpoints: [null] }, { endpoints: [{ endpoint: 42 }] }].map((card) => {
      try {
        return parseConnectRequest(url, { agentCard: card as never }).originVerified;
      } catch (e) {
        return `THREW ${(e as Error).constructor.name}`;
      }
    });
    expect(results).toEqual([false, false, false]);
  });

  // Was a gap-demo; now specified (sdk.md case 41): canonical decimals only, no duplicate or empty labels.
  it("parseConnectRequest rejects non-canonical numbers and duplicate or empty labels", () => {
    const url = (exp: string, labels: string, id = "7") => `https://vault.test/connect?v=1&agentId=${id}&labels=${labels}&scope=read&expiresInSec=${exp}&origin=https%3A%2F%2Fplanner.test`;
    for (const [exp, labels, id] of [["1e3", "a", "7"], ["0x10", "a", "7"], ["3600", "a,a", "7"], ["3600", "a,,b", "7"], ["3600", "a", "0007"], ["+5", "a", "7"]]) {
      expect(() => parseConnectRequest(url(exp!, labels!, id))).toThrow(EngramError);
    }
    expect(parseConnectRequest(url("3600", "a,b")).labels).toEqual(["a", "b"]);
  });

  it("connect: invalid input rejects the returned promise instead of throwing synchronously", async () => {
    const w = new FakeWindow();
    let sync = false;
    let p: Promise<unknown> | undefined;
    try {
      p = connectEngram({ ...req, labels: ["Bad"], window: w as never });
    } catch {
      sync = true;
    }
    if (p) await p.catch(() => undefined);
    expect(sync).toBe(false);
  });
});
