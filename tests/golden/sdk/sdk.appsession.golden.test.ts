// Golden tests for contracts/sdk.md app sessions (cases 43-47). Written before the implementation. FROZEN: add, never edit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import { toHex } from "viem";
import { deriveNamespaceId } from "../../../packages/crypto/src/index.js";
import {
  EngramAgent,
  EngramError,
  EngramOwner,
  createRelayHandler,
  inProcessRelayer,
  logsSource,
  verifyAppSession,
  type EngramConfig,
} from "../../../packages/sdk/src/index.js";
import { startLocalChain, type LocalChain } from "../../support/anvil.js";

let chain: LocalChain;
let config: EngramConfig;
const ORIGIN = "https://planner.test";
const A = (() => {
  const priv = x25519.utils.randomSecretKey();
  return { id: 7n, priv, pub: x25519.getPublicKey(priv) };
})();

async function code(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === "function" ? p() : p);
    return "OK";
  } catch (e) {
    return e instanceof EngramError ? e.code : `RAW:${(e as Error)?.constructor?.name}`;
  }
}

beforeAll(async () => {
  chain = await startLocalChain();
  const handler = createRelayHandler({ config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl }, wallet: chain.wallet(1) });
  config = {
    chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl,
    source: logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n }), relayer: inProcessRelayer(handler), logger: () => {},
  };
  await chain.mintAgent(A.id, chain.wallet(2).account.address);
  await EngramAgent.publishKeys({ config, agentId: A.id, x25519PublicKey: A.pub, operator: chain.wallet(3).account.address, holder: chain.wallet(2) });
}, 120_000);
afterAll(() => chain?.stop());

describe("app sessions", () => {
  it("#43 a proof verifies for the same agent and origin and yields the owner", async () => {
    const s = await EngramOwner.fromPrf({ config, prfOutput: new Uint8Array(32).fill(0x43) });
    const proof = await s.signAppSession({ agentId: A.id, origin: ORIGIN, ttlSec: 3600 });
    expect(await verifyAppSession(proof, { config, agentId: A.id, origin: ORIGIN })).toBe(s.owner);
    // survives a JSON round trip (it travels through postMessage and a cookie)
    expect(await verifyAppSession(JSON.parse(JSON.stringify(proof)), { config, agentId: A.id, origin: ORIGIN })).toBe(s.owner);
  });

  it("#44 another agentId or origin is NOT_AUTHORIZED", async () => {
    const s = await EngramOwner.fromPrf({ config, prfOutput: new Uint8Array(32).fill(0x44) });
    const proof = await s.signAppSession({ agentId: A.id, origin: ORIGIN, ttlSec: 3600 });
    expect(await code(verifyAppSession(proof, { config, agentId: 8n, origin: ORIGIN }))).toBe("NOT_AUTHORIZED");
    expect(await code(verifyAppSession(proof, { config, agentId: A.id, origin: "https://evil.test" }))).toBe("NOT_AUTHORIZED");
  });

  it("#45 expired, future-dated, and over-long proofs", async () => {
    const s = await EngramOwner.fromPrf({ config, prfOutput: new Uint8Array(32).fill(0x45) });
    const proof = await s.signAppSession({ agentId: A.id, origin: ORIGIN, ttlSec: 60 });
    const later = (Number(proof.expiresAt) + 1) * 1000;
    expect(await code(verifyAppSession(proof, { config, agentId: A.id, origin: ORIGIN, now: later }))).toBe("NOT_AUTHORIZED");
    const early = (Number(proof.issuedAt) - 120) * 1000;
    expect(await code(verifyAppSession(proof, { config, agentId: A.id, origin: ORIGIN, now: early }))).toBe("NOT_AUTHORIZED");
    expect(await code(s.signAppSession({ agentId: A.id, origin: ORIGIN, ttlSec: 31 * 86400 }))).toBe("INPUT_INVALID");
    expect(await code(s.signAppSession({ agentId: A.id, origin: "not an origin", ttlSec: 60 }))).toBe("INPUT_INVALID");
  });

  it("#46 tampered owner field or bad signatures are NOT_AUTHORIZED", async () => {
    const a = await EngramOwner.fromPrf({ config, prfOutput: new Uint8Array(32).fill(0x46) });
    const b = await EngramOwner.fromPrf({ config, prfOutput: new Uint8Array(32).fill(0x47) });
    const proof = await a.signAppSession({ agentId: A.id, origin: ORIGIN, ttlSec: 3600 });
    for (const bad of [
      { ...proof, owner: b.owner },
      { ...proof, signature: proof.signature.slice(0, 40) },
      { ...proof, signature: "0x" + "11".repeat(65) },
      { ...proof, issuedAt: String(Number(proof.issuedAt) - 1) },
      { ...proof, agentId: "abc" },
      null,
      "not a proof",
    ]) {
      expect(await code(verifyAppSession(bad as never, { config, agentId: A.id, origin: ORIGIN }))).toBe("NOT_AUTHORIZED");
    }
  });

  it("#47 a valid proof is not access: revoked grant still refuses the agent", async () => {
    const prf = new Uint8Array(32).fill(0x48);
    const s = await EngramOwner.fromPrf({ config, prfOutput: prf });
    await s.remember("preferences", { kind: "note", text: "x" });
    await s.grant("preferences", A.id, { scope: "read", expiresInSec: 3600, includeHistory: true });
    const proof = await s.signAppSession({ agentId: A.id, origin: ORIGIN, ttlSec: 3600 });
    await s.revoke("preferences", [A.id]);
    const owner = await verifyAppSession(proof, { config, agentId: A.id, origin: ORIGIN });
    const agent = new EngramAgent({ config, agentId: A.id, x25519PrivateKey: A.priv, operator: chain.wallet(3) });
    expect(await code(agent.recall(owner, toHex(deriveNamespaceId(prf, "preferences"))))).toBe("ACCESS_REVOKED");
  }, 120_000);
});
