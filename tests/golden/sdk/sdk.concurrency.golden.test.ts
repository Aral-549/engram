// Regression for BUGLOG DP-1 (contracts/sdk.md case 55): two sessions of one owner writing at once.
// FROZEN: add cases, never edit.
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

describe("case 55", () => {
  it("three sessions of one owner each append 4 entries concurrently: all succeed", async () => {
    const prf = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const a = await EngramOwner.fromPrf({ config, prfOutput: prf });
    const b = await EngramOwner.fromPrf({ config, prfOutput: new Uint8Array(prf) });
    const c = await EngramOwner.fromPrf({ config, prfOutput: new Uint8Array(prf) });
    await a.remember("preferences", { kind: "note", text: "seed" }); // folder exists, so both sides only append
    const run = (s: typeof a, tag: string) => (async () => {
      const out: bigint[] = [];
      for (let i = 0; i < 4; i++) out.push((await s.remember("preferences", { kind: "note", text: `${tag}${i}` })).seq);
      return out;
    })();
    // Three sessions (e.g. a vault tab and two bridge strips) writing at once: the hardest common case.
    const [x, y, z] = await Promise.all([run(a, "a"), run(b, "b"), run(c, "c")]);
    expect(new Set([...x, ...y, ...z]).size).toBe(12);
    expect((await a.recall("preferences")).entries).toHaveLength(13);
  }, 120_000);
});
