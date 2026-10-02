// Regression for BUGLOG D-3 / contracts/disclosure.md D30: indexer lag must never undo a revoke.
// FROZEN: add cases, never edit.
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

describe("D30 revoke vs lag", () => {
  it("a stale refresh after a local revoke still answers NOT_APPROVED", async () => {
    const real = config.source;
    let hideNewest = false;
    const source: MemorySource = { ...real, entries: async (q) => (hideNewest ? (await real.entries(q)).slice(0, -1) : real.entries(q)) };
    let now = Date.now();
    const s = await EngramOwner.fromPrf({ config: { ...config, source }, prfOutput: globalThis.crypto.getRandomValues(new Uint8Array(32)), clock: () => now });
    await s.remember("preferences", { kind: "preference", text: "jazz" });
    await s.approve(7n, { origin: APP, labels: ["preferences"], scope: "read", expiresInSec: 3600 });
    await s.disapprove(7n);
    hideNewest = true; // from now on the source never shows the newest entry of any folder, including the revoke
    now += 5000; // the policy cache is stale and will be refreshed
    const r = await s.disclose({ agentId: 7n, origin: APP, query: "jazz", mode: "relevant", round: 0 }).then(
      () => "ANSWERED",
      (e) => (e as { code?: string }).code,
    );
    expect(r).toBe("NOT_APPROVED");
  }, 60_000);
});
