// Adversarial probes against the agent hardening (commit b65f8a4) and the integration example, written in a
// separate pass from the implementation (AGENTS.md rule 2). Each probe tries to break a clause of
// contracts/apps.md (Turn budget, Who may chat, Errors, A10-A17) or contracts/integration.md (E1-E6).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import { EngramAgent, EngramOwner, createRelayHandler, inProcessRelayer, logsSource, type EngramConfig, type MemorySource } from "../../../packages/sdk/src/index.js";
import { createAgentServer, guardRequest, type Limits } from "../../../packages/agent-kit/src/index.js";
import { createMinimalAgent } from "../../../examples/minimal-agent/agent.js";
import { startLocalChain, type LocalChain } from "../../support/anvil.js";
import { FakeKimi } from "../../support/fake-kimi.js";

let chain: LocalChain;
let config: EngramConfig;
let kimi: FakeKimi;
const ORIGIN = "https://sage.test";
const priv = x25519.utils.randomSecretKey();
const AG = { id: 81n, priv, pub: x25519.getPublicKey(priv) };
const OTHER = 82n;

const server = (o: { cfg?: EngramConfig; limits?: Limits; labels?: string[] } = {}) =>
  createAgentServer({
    config: o.cfg ?? config, agentId: AG.id, x25519PrivateKey: AG.priv, operator: chain.wallet(3),
    kimi: { baseUrl: kimi.baseUrl, apiKey: "test-kimi-key", model: "k", timeoutMs: 2000 }, origin: ORIGIN,
    persona: { name: "Sage", description: "t", systemPrompt: "t", canWrite: true, labels: o.labels ?? ["preferences"] }, limits: o.limits,
  });

async function owner(grants: { label: string; text: string }[] = [{ label: "preferences", text: "seed" }]) {
  const s = await EngramOwner.fromPrf({ config, prfOutput: globalThis.crypto.getRandomValues(new Uint8Array(32)) });
  for (const g of grants) {
    await s.remember(g.label, { kind: "note", text: g.text });
    await s.grant(g.label, AG.id, { scope: "readwrite", expiresInSec: 3600, includeHistory: true });
  }
  return { s, proof: await s.signAppSession({ agentId: AG.id, origin: ORIGIN, ttlSec: 3600 }) };
}
const hi = [{ role: "user" as const, content: "hi" }];

beforeAll(async () => {
  chain = await startLocalChain();
  kimi = await new FakeKimi().start();
  const handler = createRelayHandler({ config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl }, wallet: chain.wallet(1) });
  config = {
    chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl,
    source: logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n }), relayer: inProcessRelayer(handler),
  };
  await chain.mintAgent(AG.id, chain.wallet(2).account.address);
  await chain.mintAgent(OTHER, chain.wallet(2).account.address);
  await EngramAgent.publishKeys({ config, agentId: AG.id, x25519PublicKey: AG.pub, operator: chain.wallet(3).account.address, holder: chain.wallet(2) });
});
afterAll(() => {
  kimi?.stop();
  chain?.stop();
});
beforeEach(() => kimi.reset());

describe("rate limits", () => {
  it("global-budget-burn: one owner over its own limit must not use up the global budget for everyone", async () => {
    const srv = server({ limits: { perOwnerPerHour: 5, globalPerHour: 20 } });
    const a = await owner();
    const b = await owner();
    const ca = await srv.session(a.proof);
    const cb = await srv.session(b.proof);
    for (let i = 0; i < 30; i++) {
      kimi.reply({ text: "ok" });
      await srv.chat({ cookie: ca, messages: hi });
    }
    kimi.reply({ text: "ok" });
    expect((await srv.chat({ cookie: cb, messages: hi })).status).toBe(200); // B sent 1 message; 5 of 20 used by A
  }, 300_000);
});

describe("lag retry", () => {
  it("permanently-incomplete: a source that never completes must not stall each recall tool call again", async () => {
    const { proof } = await owner([{ label: "preferences", text: "a" }]);
    const holey: MemorySource = { ...config.source, entries: async (q) => (await config.source.entries(q)).filter((e) => e.seq !== 0n) };
    const srv = server({ cfg: { ...config, source: holey } });
    const cookie = await srv.session(proof);
    kimi.reply({ toolCalls: [{ name: "recall", args: {} }] }, { toolCalls: [{ name: "recall", args: {} }] }, { text: "ok" });
    const t0 = Date.now();
    const r = await srv.chat({ cookie, messages: hi });
    const ms = Date.now() - t0;
    expect(r.status).toBe(200);
    // Spec A10: wait ~3 s once, then answer with what it has. Three full waits (initial + 2 tool recalls) = ~9 s.
    expect(ms).toBeLessThan(6000);
  }, 60_000);
});

describe("label isolation", () => {
  it("multi-label: a 'work' grant listed first never reaches the model of a 'preferences' persona", async () => {
    const { proof } = await owner([{ label: "work", text: "salary is confidential-123" }, { label: "preferences", text: "likes tea" }]);
    const srv = server();
    const cookie = await srv.session(proof);
    kimi.reply({ toolCalls: [{ name: "recall", args: {} }] }, { text: "ok" });
    await srv.chat({ cookie, messages: hi });
    const sent = JSON.stringify(kimi.requests);
    expect(sent).toContain("likes tea");
    expect(sent).not.toContain("confidential-123");
  });
});

describe("guardRequest edges", () => {
  const mk = (headers: Record<string, string>, body?: BodyInit) => new Request("https://sage.test/x", { method: "POST", headers, body });
  const O = { origin: ORIGIN, maxBytes: 16 };
  it("charset param ok; Origin null refused; empty body 400; exactly max ok; max+1 413; lying content-length 413", async () => {
    expect(await guardRequest(mk({ origin: ORIGIN, "content-type": "application/json; charset=utf-8" }, '{"a":1}'), O)).toMatchObject({ ok: true });
    expect(await guardRequest(mk({ origin: "null", "content-type": "application/json" }, "{}"), O)).toMatchObject({ ok: false, status: 403 });
    expect(await guardRequest(mk({ origin: ORIGIN, "content-type": "application/json" }), O)).toMatchObject({ ok: false, status: 400 });
    expect(await guardRequest(mk({ origin: ORIGIN, "content-type": "application/json" }, `{"a":"${"x".repeat(8)}"}`), O)).toMatchObject({ ok: true }); // 16 bytes
    expect(await guardRequest(mk({ origin: ORIGIN, "content-type": "application/json" }, `{"a":"${"x".repeat(9)}"}`), O)).toMatchObject({ ok: false, status: 413 });
    expect(await guardRequest(mk({ origin: ORIGIN, "content-type": "application/json", "content-length": "2" }, `{"a":"${"x".repeat(50)}"}`), O)).toMatchObject({ ok: false });
  });
  it("content-type look-alikes are refused", async () => {
    for (const t of ["application/jsonp", "application/json-seq", "text/json"]) {
      expect(await guardRequest(mk({ origin: ORIGIN, "content-type": t }, "{}"), O), t).toMatchObject({ ok: false, status: 415 });
    }
  });
});

describe("minimal agent example", () => {
  it("rejects proofs for another agent, oversized cookies, and never throws on garbage", async () => {
    const app = createMinimalAgent({ config, agentId: AG.id, x25519PrivateKey: AG.priv, origin: ORIGIN, name: "n" });
    const s = await EngramOwner.fromPrf({ config, prfOutput: globalThis.crypto.getRandomValues(new Uint8Array(32)) });
    const foreign = await s.signAppSession({ agentId: OTHER, origin: ORIGIN, ttlSec: 600 });
    const post = (body: unknown) => new Request(`${ORIGIN}/session`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await app.handle(post({ proof: foreign }))).status).toBe(401);
    expect((await app.handle(post(null))).status).toBe(401);
    expect((await app.handle(post({ proof: "x" }))).status).toBe(401);
    const big = `engram_session=${"A".repeat(5000)}`;
    expect((await app.handle(new Request(`${ORIGIN}/memory`, { headers: { cookie: big } }))).status).toBe(401);
    const fake = `engram_session=${Buffer.from(JSON.stringify({ ...foreign })).toString("base64url")}`;
    expect((await app.handle(new Request(`${ORIGIN}/memory`, { headers: { cookie: fake } }))).status).toBe(401);
  });
});
