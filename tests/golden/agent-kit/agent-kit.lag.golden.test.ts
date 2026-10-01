// Golden case A10 (contracts/apps.md): an indexer that lags the chain must not make the agent forget fresh memories.
// FROZEN: add cases, never edit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import { EngramAgent, EngramOwner, createRelayHandler, inProcessRelayer, logsSource, type EngramConfig, type MemorySource } from "../../../packages/sdk/src/index.js";
import { createAgentServer } from "../../../packages/agent-kit/src/index.js";
import { startLocalChain, type LocalChain } from "../../support/anvil.js";
import { FakeKimi } from "../../support/fake-kimi.js";

let chain: LocalChain;
let base: EngramConfig;
let kimi: FakeKimi;
const priv = x25519.utils.randomSecretKey();
const AG = { id: 41n, priv, pub: x25519.getPublicKey(priv) };

beforeAll(async () => {
  chain = await startLocalChain();
  kimi = await new FakeKimi().start();
  const handler = createRelayHandler({ config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl }, wallet: chain.wallet(1) });
  base = {
    chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl,
    source: logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n }), relayer: inProcessRelayer(handler), logger: () => {},
  };
  await chain.mintAgent(AG.id, chain.wallet(2).account.address);
  await EngramAgent.publishKeys({ config: base, agentId: AG.id, x25519PublicKey: AG.pub, operator: chain.wallet(3).account.address, holder: chain.wallet(2) });
});
afterAll(() => {
  kimi?.stop();
  chain?.stop();
});

describe("indexer lag", () => {
  it("A10 the agent waits briefly for a lagging source and answers with every memory", async () => {
    const owner = await EngramOwner.fromPrf({ config: base, prfOutput: new Uint8Array(32).fill(0xa1) });
    await owner.remember("preferences", { kind: "preference", text: "vegetarian" });
    await owner.remember("preferences", { kind: "preference", text: "allergic to peanuts" });
    await owner.grant("preferences", AG.id, { scope: "read", expiresInSec: 3600, includeHistory: true });
    // A source that serves only the first entry for its first two reads, like an indexer that is catching up.
    let reads = 0;
    const real = base.source;
    const lagging: MemorySource = { ...real, entries: async (q) => (reads++ < 2 ? (await real.entries(q)).slice(0, 1) : real.entries(q)) };
    const srv = createAgentServer({
      config: { ...base, source: lagging }, agentId: AG.id, x25519PrivateKey: AG.priv, operator: chain.wallet(3),
      kimi: { baseUrl: kimi.baseUrl, apiKey: "test-kimi-key", model: "k", timeoutMs: 2000 }, origin: "https://lag.test",
      persona: { name: "Lag", description: "t", systemPrompt: "t", canWrite: false, labels: ["preferences"] },
    });
    const cookie = await srv.session(await owner.signAppSession({ agentId: AG.id, origin: "https://lag.test", ttlSec: 3600 }));
    kimi.reply({ text: "ok" });
    const t0 = Date.now();
    await srv.chat({ cookie, messages: [{ role: "user", content: "what do you know?" }] });
    const block = kimi.requests[0]!.messages.find((m) => typeof m.content === "string" && m.content.startsWith("<user_memory>"))!;
    expect(block.content).toContain("vegetarian");
    expect(block.content).toContain("allergic to peanuts");
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});
