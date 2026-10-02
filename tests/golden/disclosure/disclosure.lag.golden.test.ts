// Golden test for contracts/disclosure.md D29: a lagging source does not hide a just-written memory.
// Written from the spec before the implementation. FROZEN: add cases, never edit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EngramOwner, createRelayHandler, inProcessRelayer, logsSource, type EngramConfig, type MemorySource } from "../../../packages/sdk/src/index.js";
import { startLocalChain, type LocalChain } from "../../support/anvil.js";

let chain: LocalChain;
let config: EngramConfig;
const APP = "https://app.x";

beforeAll(async () => {
  chain = await startLocalChain();
  const handler = createRelayHandler({ config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl }, wallet: chain.wallet(1) });
  config = {
    chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl,
    source: logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n }), relayer: inProcessRelayer(handler),
  };
});
afterAll(() => chain?.stop());

describe("D29 lag", () => {
  it("re-reads an incomplete folder briefly and answers with the fresh entry", async () => {
    const real = config.source;
    let lagging = 0;
    // For its first two reads after `lagging` is armed, the source hides the newest entry of the folder.
    const source: MemorySource = {
      ...real,
      entries: async (q) => {
        const all = await real.entries(q);
        if (lagging > 0) {
          lagging--;
          return all.slice(0, -1);
        }
        return all;
      },
    };
    const s = await EngramOwner.fromPrf({ config: { ...config, source }, prfOutput: globalThis.crypto.getRandomValues(new Uint8Array(32)) });
    await s.remember("preferences", { kind: "preference", text: "vegetarian" });
    await s.approve(7n, { origin: APP, labels: ["preferences"], scope: "readwrite", expiresInSec: 3600 });
    await s.propose(7n, APP, { kind: "fact", text: "allergic to peanuts" });
    lagging = 2;
    const t0 = Date.now();
    const r = await s.disclose({ agentId: 7n, origin: APP, query: "", mode: "full", round: 0 });
    expect(r.entries.map((e) => e.text).sort()).toEqual(["allergic to peanuts", "vegetarian"]);
    expect(Date.now() - t0).toBeLessThan(10_000);
    await s.flushLogs();
  }, 60_000);
});
