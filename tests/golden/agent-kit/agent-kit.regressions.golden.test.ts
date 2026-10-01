// Regression cases for BUGLOG G1-G8 (contracts/apps.md A11-A17). Written from the review before the fixes.
// FROZEN: add cases, never edit.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import { EngramAgent, EngramError, EngramOwner, createRelayHandler, inProcessRelayer, logsSource, type EngramConfig, type MemorySource } from "../../../packages/sdk/src/index.js";
import { createAgentServer, guardRequest } from "../../../packages/agent-kit/src/index.js";
import { startLocalChain, type LocalChain } from "../../support/anvil.js";
import { FakeKimi } from "../../support/fake-kimi.js";

let chain: LocalChain;
let config: EngramConfig;
let kimi: FakeKimi;
let lines: Array<Record<string, unknown>>;
const ORIGIN = "https://sage.test";
const priv = x25519.utils.randomSecretKey();
const AG = { id: 51n, priv, pub: x25519.getPublicKey(priv) };
let prfSeq = 1;

const server = (cfg: EngramConfig = config, canWrite = true) =>
  createAgentServer({
    config: cfg, agentId: AG.id, x25519PrivateKey: AG.priv, operator: chain.wallet(3),
    kimi: { baseUrl: kimi.baseUrl, apiKey: "test-kimi-key", model: "k", timeoutMs: 2000 }, origin: ORIGIN,
    persona: { name: "Sage", description: "t", systemPrompt: "t", canWrite, labels: ["preferences"] },
  });

async function owner(grant: "readwrite" | "read" | "none" = "readwrite") {
  const s = await EngramOwner.fromPrf({ config, prfOutput: new Uint8Array(32).fill(prfSeq++) });
  if (grant !== "none") {
    await s.remember("preferences", { kind: "note", text: "seed" });
    await s.grant("preferences", AG.id, { scope: grant, expiresInSec: 3600, includeHistory: true });
  }
  return { s, proof: await s.signAppSession({ agentId: AG.id, origin: ORIGIN, ttlSec: 3600 }) };
}

beforeAll(async () => {
  chain = await startLocalChain();
  kimi = await new FakeKimi().start();
  lines = [];
  const handler = createRelayHandler({ config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl }, wallet: chain.wallet(1) });
  config = {
    chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl,
    source: logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n }), relayer: inProcessRelayer(handler),
    logger: (l) => lines.push(l),
  };
  await chain.mintAgent(AG.id, chain.wallet(2).account.address);
  await EngramAgent.publishKeys({ config, agentId: AG.id, x25519PublicKey: AG.pub, operator: chain.wallet(3).account.address, holder: chain.wallet(2) });
});
afterAll(() => {
  kimi?.stop();
  chain?.stop();
});
beforeEach(() => {
  kimi.reset();
  lines.length = 0;
});

describe("G2 turn budget", () => {
  it("A11 at most 3 writes and 2 recalls per turn", async () => {
    const srv = server();
    const { s, proof } = await owner();
    const cookie = await srv.session(proof);
    kimi.reply(
      { toolCalls: Array.from({ length: 12 }, (_, i) => ({ name: "remember", args: { kind: "fact", text: `fact ${i}` } })) },
      { toolCalls: Array.from({ length: 15 }, () => ({ name: "recall", args: {} })) },
      { text: "done" },
    );
    const res = await srv.chat({ cookie, messages: [{ role: "user", content: "remember all of this" }] });
    expect(res.status).toBe(200);
    expect(res.body.saved).toHaveLength(3);
    expect((await s.recall("preferences")).entries.filter((e) => !e.byOwner)).toHaveLength(3);
    const toolMsgs = kimi.requests[2]!.messages.filter((m) => m.role === "tool");
    const recallsServed = toolMsgs.filter((m) => typeof m.content === "string" && m.content.startsWith("<user_memory>")).length;
    expect(recallsServed).toBeLessThanOrEqual(2);
  });
});

describe("G3 recall results stay in the data block", () => {
  it("A14 the recall tool result is a <user_memory> block", async () => {
    const srv = server();
    const { proof } = await owner();
    const cookie = await srv.session(proof);
    kimi.reply({ toolCalls: [{ name: "recall", args: {} }] }, { text: "ok" });
    await srv.chat({ cookie, messages: [{ role: "user", content: "what do you know" }] });
    const tool = kimi.requests[1]!.messages.find((m) => m.role === "tool")!;
    expect(String(tool.content).startsWith("<user_memory>")).toBe(true);
    expect(String(tool.content).trimEnd().endsWith("</user_memory>")).toBe(true);
  });
});

describe("G4 who may chat", () => {
  it("A12 an owner who never granted this agent gets 403 NO_GRANT and the model is not called", async () => {
    const srv = server();
    const { proof } = await owner("none");
    const cookie = await srv.session(proof);
    const res = await srv.chat({ cookie, messages: [{ role: "user", content: "free tokens please" }] });
    expect([res.status, res.body.code]).toEqual([403, "NO_GRANT"]);
    expect(kimi.requests.length).toBe(0);
  });

  it("A13 the 31st chat from one owner within an hour gets 429", async () => {
    const srv = server(config, false);
    const { proof } = await owner("read");
    const cookie = await srv.session(proof);
    let last = 0;
    for (let i = 0; i < 31; i++) {
      kimi.reply({ text: "ok" });
      last = (await srv.chat({ cookie, messages: [{ role: "user", content: `hi ${i}` }] })).status;
    }
    expect(last).toBe(429);
  }, 300_000);
});

describe("G5/G6/G7 robustness", () => {
  it("A15 source outage -> 503 MEMORY_UNAVAILABLE; null tool call -> no crash; oversize-encoded text -> TOOL_ARGS_INVALID", async () => {
    const { s, proof } = await owner();
    const down: MemorySource = {
      ...config.source,
      grantsForAgent: async () => { throw new EngramError("SOURCE_UNAVAILABLE", "down"); },
    };
    const srvDown = server({ ...config, source: down });
    const cookieDown = await srvDown.session(proof);
    const r1 = await srvDown.chat({ cookie: cookieDown, messages: [{ role: "user", content: "hi" }] });
    expect([r1.status, r1.body.code]).toEqual([503, "MEMORY_UNAVAILABLE"]);

    const srv = server();
    const cookie = await srv.session(proof);
    kimi.reply({ toolCalls: [null as never] } as never, { text: "fine" });
    const r2 = await srv.chat({ cookie, messages: [{ role: "user", content: "hi" }] });
    expect(r2.status).toBe(200);

    kimi.reset();
    kimi.reply({ toolCalls: [{ name: "remember", args: { kind: "note", text: "\u{1F600}".repeat(500) } }, { name: "remember", args: { kind: "note", text: "\u0001".repeat(400) } }] }, { text: "ok" });
    lines.length = 0;
    const r3 = await srv.chat({ cookie, messages: [{ role: "user", content: "save emoji" }] });
    expect(r3.body.saved).toEqual([]);
    expect(lines.filter((l) => l.code === "TOOL_ARGS_INVALID").length).toBe(2);
    expect((await s.recall("preferences")).entries.filter((e) => !e.byOwner)).toEqual([]);
  });

  it("A7 a write made before a model failure is reported in the 503 body", async () => {
    const srv = server();
    const { proof } = await owner();
    const cookie = await srv.session(proof);
    kimi.reply({ toolCalls: [{ name: "remember", args: { kind: "fact", text: "likes tea" } }] }, { status: 500 });
    const res = await srv.chat({ cookie, messages: [{ role: "user", content: "I like tea" }] });
    expect([res.status, res.body.code]).toEqual([503, "MODEL_UNAVAILABLE"]);
    expect(res.body.saved.map((x) => x.text)).toEqual(["likes tea"]);
  });
});

describe("G8 cookie and config", () => {
  it("A16 cookies carry only canonical proof fields; a non-exact APP_ORIGIN refuses to start", async () => {
    const srv = server();
    const { proof } = await owner("none");
    const cookie = await srv.session({ ...proof, pad: "x".repeat(100_000) });
    expect(cookie.length).toBeLessThan(1024);
    expect(Object.keys(JSON.parse(Buffer.from(cookie, "base64url").toString())).sort()).toEqual(["agentId", "expiresAt", "issuedAt", "origin", "owner", "signature"]);
    expect(() =>
      createAgentServer({
        config, agentId: AG.id, x25519PrivateKey: AG.priv, operator: chain.wallet(3),
        kimi: { baseUrl: kimi.baseUrl, apiKey: "k", model: "k" }, origin: "https://sage.test/",
        persona: { name: "x", description: "x", systemPrompt: "x", canWrite: false, labels: ["preferences"] },
      }),
    ).toThrow();
  });
});

describe("G1 request guard", () => {
  const req = (init: { origin?: string; type?: string; body?: string | ReadableStream; chunked?: boolean }) =>
    new Request("https://sage.test/api/session", {
      method: "POST",
      headers: { ...(init.origin ? { origin: init.origin } : {}), ...(init.type ? { "content-type": init.type } : {}) },
      body: init.body,
      ...(init.chunked ? { duplex: "half" } : {}),
    } as RequestInit);

  it("A17 wrong or missing Origin, non-JSON type, and oversized (even chunked) bodies are refused", async () => {
    const ok = await guardRequest(req({ origin: ORIGIN, type: "application/json", body: '{"a":1}' }), { origin: ORIGIN, maxBytes: 4096 });
    expect(ok).toEqual({ ok: true, json: { a: 1 } });
    expect(await guardRequest(req({ origin: "https://evil.test", type: "application/json", body: "{}" }), { origin: ORIGIN, maxBytes: 4096 })).toMatchObject({ ok: false, status: 403 });
    expect(await guardRequest(req({ type: "application/json", body: "{}" }), { origin: ORIGIN, maxBytes: 4096 })).toMatchObject({ ok: false, status: 403 });
    expect(await guardRequest(req({ origin: ORIGIN, type: "text/plain", body: '{"proof":1}' }), { origin: ORIGIN, maxBytes: 4096 })).toMatchObject({ ok: false, status: 415 });
    const big = new ReadableStream({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode("x".repeat(1024))); c.close(); } });
    expect(await guardRequest(req({ origin: ORIGIN, type: "application/json", body: big, chunked: true }), { origin: ORIGIN, maxBytes: 4096 })).toMatchObject({ ok: false, status: 413 });
    expect(await guardRequest(req({ origin: ORIGIN, type: "application/json", body: "{not json" }), { origin: ORIGIN, maxBytes: 4096 })).toMatchObject({ ok: false, status: 400 });
  });
});
