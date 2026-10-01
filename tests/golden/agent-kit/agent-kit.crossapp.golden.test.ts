// Golden case A9 (contracts/apps.md): memory saved through one agent app is visible to another app the owner granted.
// The headline demo claim. FROZEN: add cases, never edit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import { EngramAgent, EngramOwner, createRelayHandler, inProcessRelayer, logsSource, type EngramConfig } from "../../../packages/sdk/src/index.js";
import { createAgentServer } from "../../../packages/agent-kit/src/index.js";
import { startLocalChain, type LocalChain } from "../../support/anvil.js";
import { FakeKimi } from "../../support/fake-kimi.js";

let chain: LocalChain;
let config: EngramConfig;
let kimi: FakeKimi;
const mk = (id: bigint) => {
  const priv = x25519.utils.randomSecretKey();
  return { id, priv, pub: x25519.getPublicKey(priv) };
};
const SAGE = mk(31n);
const WAY = mk(32n);

beforeAll(async () => {
  chain = await startLocalChain();
  kimi = await new FakeKimi().start();
  const handler = createRelayHandler({ config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl }, wallet: chain.wallet(1) });
  config = {
    chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl,
    source: logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n }), relayer: inProcessRelayer(handler), logger: () => {},
  };
  for (const [a, op] of [[SAGE, 3], [WAY, 4]] as const) {
    await chain.mintAgent(a.id, chain.wallet(2).account.address);
    await EngramAgent.publishKeys({ config, agentId: a.id, x25519PublicKey: a.pub, operator: chain.wallet(op).account.address, holder: chain.wallet(2) });
  }
});
afterAll(() => {
  kimi?.stop();
  chain?.stop();
});

const server = (a: typeof SAGE, op: number, canWrite: boolean, origin: string) =>
  createAgentServer({
    config, agentId: a.id, x25519PrivateKey: a.priv, operator: chain.wallet(op),
    kimi: { baseUrl: kimi.baseUrl, apiKey: "test-kimi-key", model: "kimi-test", timeoutMs: 2000 }, origin,
    persona: { name: canWrite ? "Sage" : "Wayfarer", description: "t", systemPrompt: "t", canWrite, labels: ["preferences"] },
  });

describe("cross-app memory", () => {
  it("A9 what Sage saves, Wayfarer sees, only after the owner grants Wayfarer", async () => {
    const owner = await EngramOwner.fromPrf({ config, prfOutput: new Uint8Array(32).fill(0x99) });
    await owner.grant("preferences", SAGE.id, { scope: "readwrite", expiresInSec: 3600, includeHistory: true });
    const sage = server(SAGE, 3, true, "https://sage.test");
    const sageCookie = await sage.session(await owner.signAppSession({ agentId: SAGE.id, origin: "https://sage.test", ttlSec: 3600 }));
    kimi.reply({ toolCalls: [{ name: "remember", args: { kind: "preference", text: "vegetarian" } }] }, { text: "saved" });
    expect((await sage.chat({ cookie: sageCookie, messages: [{ role: "user", content: "I'm vegetarian" }] })).body.saved).toHaveLength(1);

    const way = server(WAY, 4, false, "https://wayfarer.test");
    const wayCookie = await way.session(await owner.signAppSession({ agentId: WAY.id, origin: "https://wayfarer.test", ttlSec: 3600 }));
    kimi.reset();
    kimi.reply({ text: "generic plan" });
    const before = await way.chat({ cookie: wayCookie, messages: [{ role: "user", content: "plan dinner" }] });
    expect([before.status, before.body.code]).toEqual([403, "NO_GRANT"]); // never granted: no model call at all (A12)
    expect(kimi.requests.length).toBe(0);

    await owner.grant("preferences", WAY.id, { scope: "read", expiresInSec: 3600, includeHistory: true });
    kimi.reset();
    kimi.reply({ text: "vegetarian plan" });
    const after = await way.chat({ cookie: wayCookie, messages: [{ role: "user", content: "plan dinner" }] });
    expect(after.body.accessRevoked).toBe(false);
    const memoryMsg = kimi.requests[0]!.messages.find((m) => typeof m.content === "string" && m.content.startsWith("<user_memory>"));
    expect(memoryMsg?.content).toContain("vegetarian");
  });
});
