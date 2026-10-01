// Regression cases for BUGLOG H1-H3 (contracts/apps.md A18-A20), found by the hardening adversarial pass.
// FROZEN: add cases, never edit.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import { EngramAgent, EngramOwner, createRelayHandler, inProcessRelayer, logsSource, type EngramConfig, type MemorySource } from "../../../packages/sdk/src/index.js";
import { createAgentServer, guardRequest, type Limits } from "../../../packages/agent-kit/src/index.js";
import { startLocalChain, type LocalChain } from "../../support/anvil.js";
import { FakeKimi } from "../../support/fake-kimi.js";

let chain: LocalChain;
let config: EngramConfig;
let kimi: FakeKimi;
const ORIGIN = "https://sage.test";
const priv = x25519.utils.randomSecretKey();
const AG = { id: 91n, priv, pub: x25519.getPublicKey(priv) };
const hi = [{ role: "user" as const, content: "hi" }];

const server = (cfg: EngramConfig = config, limits?: Limits) =>
  createAgentServer({
    config: cfg, agentId: AG.id, x25519PrivateKey: AG.priv, operator: chain.wallet(3),
    kimi: { baseUrl: kimi.baseUrl, apiKey: "test-kimi-key", model: "k", timeoutMs: 2000 }, origin: ORIGIN,
    persona: { name: "Sage", description: "t", systemPrompt: "t", canWrite: true, labels: ["preferences"] }, limits,
  });

async function owner() {
  const s = await EngramOwner.fromPrf({ config, prfOutput: globalThis.crypto.getRandomValues(new Uint8Array(32)) });
  await s.remember("preferences", { kind: "note", text: "seed" });
  await s.grant("preferences", AG.id, { scope: "readwrite", expiresInSec: 3600, includeHistory: true });
  return s.signAppSession({ agentId: AG.id, origin: ORIGIN, ttlSec: 3600 });
}

beforeAll(async () => {
  chain = await startLocalChain();
  kimi = await new FakeKimi().start();
  const handler = createRelayHandler({ config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl }, wallet: chain.wallet(1) });
  config = {
    chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl,
    source: logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n }), relayer: inProcessRelayer(handler),
  };
  await chain.mintAgent(AG.id, chain.wallet(2).account.address);
  await EngramAgent.publishKeys({ config, agentId: AG.id, x25519PublicKey: AG.pub, operator: chain.wallet(3).account.address, holder: chain.wallet(2) });
});
afterAll(() => {
  kimi?.stop();
  chain?.stop();
});
beforeEach(() => kimi.reset());

describe("hardening regressions", () => {
  it("A18 one owner over its limit does not exhaust the global budget (H1)", async () => {
    const srv = server(config, { perOwnerPerHour: 5, globalPerHour: 20 });
    const ca = await srv.session(await owner());
    const cb = await srv.session(await owner());
    for (let i = 0; i < 30; i++) {
      kimi.reply({ text: "ok" });
      await srv.chat({ cookie: ca, messages: hi });
    }
    kimi.reply({ text: "ok" });
    expect((await srv.chat({ cookie: cb, messages: hi })).status).toBe(200);
  }, 300_000);

  it("A19 a never-complete source costs one ~3 s wait per turn, not one per recall (H2)", async () => {
    const holey: MemorySource = { ...config.source, entries: async (q) => (await config.source.entries(q)).filter((e) => e.seq !== 0n) };
    const srv = server({ ...config, source: holey });
    const cookie = await srv.session(await owner());
    kimi.reply({ toolCalls: [{ name: "recall", args: {} }] }, { toolCalls: [{ name: "recall", args: {} }] }, { text: "ok" });
    const t0 = Date.now();
    expect((await srv.chat({ cookie, messages: hi })).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(6000);
  }, 60_000);

  it("A20 content types that merely start with application/json are refused (H3)", async () => {
    const mk = (t: string) => new Request(`${ORIGIN}/x`, { method: "POST", headers: { origin: ORIGIN, "content-type": t }, body: "{}" });
    for (const t of ["application/jsonp", "application/json-seq", "text/json"]) {
      expect(await guardRequest(mk(t), { origin: ORIGIN, maxBytes: 64 }), t).toMatchObject({ ok: false, status: 415 });
    }
    expect(await guardRequest(mk("Application/JSON; charset=utf-8"), { origin: ORIGIN, maxBytes: 64 })).toMatchObject({ ok: true });
  });
});
