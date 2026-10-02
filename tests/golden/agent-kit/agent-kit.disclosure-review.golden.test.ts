// Regression cases for the Disclosure-mode review on the agent server (BUGLOG DA-5, DA-7, DA-9, DA-3;
// contracts/apps.md A25-A27, disclosure.md D33). No chain. FROZEN: add cases, never edit.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EngramOwner, type EngramConfig, type MemorySource } from "../../../packages/sdk/src/index.js";
import { createAgentServer, type Limits } from "../../../packages/agent-kit/src/index.js";
import { FakeKimi } from "../../support/fake-kimi.js";

const ORIGIN = "https://sage.test";
const AGENT = 1965n;
const SECRET = "test-continuation-secret-0123456789abcdef";
const boom = async () => { throw new Error("no chain reads in disclosure mode"); };
const config: EngramConfig = {
  chainId: 31337, registry: "0x00000000000000000000000000000000000000aa", identityRegistry: "0x00000000000000000000000000000000000000bb",
  rpcUrl: "http://127.0.0.1:1", source: new Proxy({}, { get: () => boom }) as unknown as MemorySource, relayer: { submit: boom as never },
};
let kimi: FakeKimi;
const server = (limits?: Limits) =>
  createAgentServer({
    config, agentId: AGENT, origin: ORIGIN, mode: "disclosure", continuationSecret: SECRET, limits,
    kimi: { baseUrl: kimi.baseUrl, apiKey: "test-kimi-key", model: "k", timeoutMs: 2000 },
    persona: { name: "Sage", description: "t", systemPrompt: "SECRET-PERSONA-PROMPT", canWrite: true, labels: ["preferences"] },
  });
async function cookieFor(srv: ReturnType<typeof server>) {
  const s = await EngramOwner.fromPrf({ config, prfOutput: globalThis.crypto.getRandomValues(new Uint8Array(32)) });
  return srv.session(await s.signAppSession({ agentId: AGENT, origin: ORIGIN, ttlSec: 3600, pairwise: true }));
}
const user = (t: string) => [{ role: "user" as const, content: t }];

beforeAll(async () => {
  kimi = await new FakeKimi().start();
});
afterAll(() => kimi?.stop());
beforeEach(() => kimi.reset());

describe("continuation hardening", () => {
  it("A25 a continuation is accepted once; continue counts toward the owner's limit", async () => {
    const srv = server({ perOwnerPerHour: 3 });
    const cookie = await cookieFor(srv);
    kimi.reply({ toolCalls: [{ name: "recall", args: { query: "x" } }] }, { text: "ok" }, { text: "again" });
    const r1 = await srv.chat({ cookie, messages: user("q"), disclosed: [], memory: "ok" });
    const result = { id: r1.body.pending!.id, ok: true, entries: [] };
    expect((await srv.continue({ cookie, continuation: r1.body.continuation!, result })).status).toBe(200);
    const replay = await srv.continue({ cookie, continuation: r1.body.continuation!, result });
    expect([replay.status, replay.body.code]).toEqual([400, "BAD_CONTINUATION"]);
    // chat (1) + continue (1) used 2 of 3; one more chat is fine, the next is limited
    kimi.reply({ text: "fine" });
    expect((await srv.chat({ cookie, messages: user("q2"), disclosed: [], memory: "ok" })).status).toBe(200);
    expect((await srv.chat({ cookie, messages: user("q3"), disclosed: [], memory: "ok" })).status).toBe(429);
  });

  it("A26 a long but accepted conversation can still use tools", async () => {
    const srv = server();
    const cookie = await cookieFor(srv);
    const turns = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `${i} ${"word ".repeat(600)}` }));
    const disclosed = Array.from({ length: 8 }, (_, i) => ({ kind: "fact", text: `memory ${i} ${"z".repeat(1500)}`, by: "owner" as const }));
    kimi.reply({ toolCalls: [{ name: "recall", args: { query: "x" } }] });
    const r = await srv.chat({ cookie, messages: turns, disclosed, memory: "ok" });
    expect(r.status).toBe(200);
    expect(r.body.pending?.tool).toBe("recall");
  });

  it("A27 a continuation reveals nothing without the secret", async () => {
    const srv = server();
    const cookie = await cookieFor(srv);
    kimi.reply({ toolCalls: [{ name: "recall", args: { query: "x" } }] });
    const r = await srv.chat({ cookie, messages: user("tell me something"), disclosed: [{ kind: "fact", text: "visible-memory", by: "owner" }], memory: "ok" });
    const raw = Buffer.from(r.body.continuation!.replace(/\./g, ""), "base64url").toString("latin1");
    for (const needle of ["SECRET-PERSONA-PROMPT", "visible-memory", "tell me something", '"convo"']) expect(raw.includes(needle)).toBe(false);
  });

  it("D33 a remember receipt without a txHash is accepted and reported", async () => {
    const srv = server();
    const cookie = await cookieFor(srv);
    kimi.reply({ toolCalls: [{ name: "remember", args: { kind: "fact", text: "likes tea" } }] }, { text: "Saved." });
    const r1 = await srv.chat({ cookie, messages: user("I like tea"), disclosed: [], memory: "ok" });
    const r2 = await srv.continue({ cookie, continuation: r1.body.continuation!, result: { id: r1.body.pending!.id, ok: true, seq: "1" } });
    expect(r2.body.saved).toEqual([{ kind: "fact", text: "likes tea", seq: "1" }]);
  });
});
