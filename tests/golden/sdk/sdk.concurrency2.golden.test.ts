// Regression for BUGLOG DP-2 (contracts/sdk.md case 56). FROZEN: add cases, never edit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EngramOwner, createRelayHandler, inProcessRelayer, logsSource, type EngramConfig } from "../../../packages/sdk/src/index.js";
import { startLocalChain, type LocalChain } from "../../support/anvil.js";

let chain: LocalChain;
let config: EngramConfig;
beforeAll(async () => {
  chain = await startLocalChain();
  const handler = createRelayHandler({ config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl }, wallet: chain.wallet(1) });
  config = {
    chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl,
    source: logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n }), relayer: inProcessRelayer(handler),
  };
});
afterAll(() => chain?.stop());

describe("case 56", () => {
  it("five sessions of one owner each append 3 entries at once: all succeed, nothing written twice", async () => {
    const prf = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const sessions = await Promise.all(Array.from({ length: 5 }, () => EngramOwner.fromPrf({ config, prfOutput: new Uint8Array(prf) })));
    await sessions[0]!.remember("preferences", { kind: "note", text: "seed" });
    const results = await Promise.allSettled(sessions.map((s, k) => (async () => {
      for (let i = 0; i < 3; i++) await s.remember("preferences", { kind: "note", text: `s${k}-${i}` });
    })()));
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const texts = (await sessions[0]!.recall("preferences")).entries.map((e) => e.text);
    expect(texts).toHaveLength(16);
    expect(new Set(texts).size).toBe(16);
  }, 180_000);
});
