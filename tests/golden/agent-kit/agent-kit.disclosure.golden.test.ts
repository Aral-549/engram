// Golden tests for the agent server in Disclosure mode: contracts/apps.md A21-A24 and contracts/disclosure.md D21-D25.
// No chain: the server must never read it in this mode (dead RPC, throwing source). Written from the spec before the
// implementation. FROZEN: add cases, never edit.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EngramOwner, type EngramConfig, type MemorySource } from "../../../packages/sdk/src/index.js";
import { createAgentServer } from "../../../packages/agent-kit/src/index.js";
import { FakeKimi } from "../../support/fake-kimi.js";

const ORIGIN = "https://sage.test";
const AGENT = 1965n;
const SECRET = "test-continuation-secret-0123456789abcdef";
const boom = async () => { throw new Error("the agent server must not read the chain in disclosure mode"); };
const deadSource = new Proxy({}, { get: () => boom }) as unknown as MemorySource;
const config: EngramConfig = {
  chainId: 31337, registry: "0x00000000000000000000000000000000000000aa", identityRegistry: "0x00000000000000000000000000000000000000bb",
  rpcUrl: "http://127.0.0.1:1", source: deadSource, relayer: { submit: boom as never },
};
let kimi: FakeKimi;

const server = (canWrite = true, secret = SECRET) =>
  createAgentServer({
    config, agentId: AGENT, origin: ORIGIN, mode: "disclosure", continuationSecret: secret,
    kimi: { baseUrl: kimi.baseUrl, apiKey: "test-kimi-key", model: "k", timeoutMs: 2000 },
    persona: { name: "Sage", description: "t", systemPrompt: "You are Sage.", canWrite, labels: ["preferences"] },
  });

async function cookieFor(srv: ReturnType<typeof server>, prf = globalThis.crypto.getRandomValues(new Uint8Array(32))) {
  const s = await EngramOwner.fromPrf({ config, prfOutput: prf });
  const proof = await s.signAppSession({ agentId: AGENT, origin: ORIGIN, ttlSec: 3600, pairwise: true });
  return { cookie: await srv.session(proof), pairwise: s.pairwise(AGENT) };
}
const user = (t: string) => [{ role: "user" as const, content: t }];
const memMsgs = (i: number) => kimi.requests[i]!.messages.filter((m) => typeof m.content === "string" && m.content.startsWith("<user_memory>"));

beforeAll(async () => {
  kimi = await new FakeKimi().start();
});
afterAll(() => kimi?.stop());
beforeEach(() => kimi.reset());

describe("disclosure mode agent server", () => {
  it("A21 disclosed memory reaches the model only inside <user_memory>; no chain reads", async () => {
    const srv = server();
    const { cookie } = await cookieFor(srv);
    kimi.reply({ text: "Here is a vegetarian plan." });
    const r = await srv.chat({ cookie, messages: user("plan dinner"), disclosed: [{ kind: "preference", text: "vegetarian", by: "owner" }], memory: "ok" });
    expect(r.status).toBe(200);
    expect(r.body.reply).toBe("Here is a vegetarian plan.");
    const msgs = kimi.requests[0]!.messages;
    const withVeg = msgs.filter((m) => typeof m.content === "string" && m.content.includes("vegetarian"));
    expect(withVeg).toHaveLength(1);
    expect(withVeg[0]!.content!.startsWith("<user_memory>")).toBe(true);
    expect(withVeg[0]!.role).toBe("system");
  });

  it("D22/D23 a recall tool call becomes a pending request; continuing feeds the answer back as <user_memory>", async () => {
    const srv = server();
    const { cookie } = await cookieFor(srv);
    kimi.reply({ toolCalls: [{ name: "recall", args: { query: "diet" } }] }, { text: "You are vegetarian." });
    const r1 = await srv.chat({ cookie, messages: user("what is my diet?"), disclosed: [], memory: "ok" });
    expect(r1.status).toBe(200);
    expect(r1.body.pending).toMatchObject({ tool: "recall", args: { query: "diet", mode: "relevant" } });
    expect(typeof r1.body.continuation).toBe("string");
    const r2 = await srv.continue({ cookie, continuation: r1.body.continuation!, result: { id: r1.body.pending!.id, ok: true, entries: [{ kind: "preference", text: "vegetarian", by: "owner" }] } });
    expect(r2.status).toBe(200);
    expect(r2.body.reply).toBe("You are vegetarian.");
    const tool = kimi.requests[1]!.messages.find((m) => m.role === "tool")!;
    expect(String(tool.content).startsWith("<user_memory>")).toBe(true);
    expect(String(tool.content)).toContain("vegetarian");
  });

  it("A22 remember becomes a pending write; the vault's receipt is reported in saved", async () => {
    const srv = server();
    const { cookie } = await cookieFor(srv);
    kimi.reply({ toolCalls: [{ name: "remember", args: { kind: "preference", text: "prefers window seats" } }] }, { text: "Saved." });
    const r1 = await srv.chat({ cookie, messages: user("I prefer window seats"), disclosed: [], memory: "ok" });
    expect(r1.body.pending).toMatchObject({ tool: "remember", args: { kind: "preference", text: "prefers window seats" } });
    const tx = "0x" + "ab".repeat(32);
    const r2 = await srv.continue({ cookie, continuation: r1.body.continuation!, result: { id: r1.body.pending!.id, ok: true, seq: "5", txHash: tx } });
    expect(r2.body.reply).toBe("Saved.");
    expect(r2.body.saved).toEqual([{ kind: "preference", text: "prefers window seats", seq: "5", txHash: tx }]);
  });

  it("a read-only persona offers no remember tool", async () => {
    const srv = server(false);
    const { cookie } = await cookieFor(srv);
    kimi.reply({ text: "ok" });
    await srv.chat({ cookie, messages: user("hi"), disclosed: [], memory: "ok" });
    expect((kimi.requests[0]!.tools ?? []).map((t) => t.function.name)).toEqual(["recall"]);
  });

  it("A23/D24 tampered, expired, cross-owner and mismatched continuations are refused without calling the model", async () => {
    const srv = server();
    const a = await cookieFor(srv);
    const b = await cookieFor(srv);
    kimi.reply({ toolCalls: [{ name: "recall", args: { query: "x" } }] });
    const r1 = await srv.chat({ cookie: a.cookie, messages: user("q"), disclosed: [], memory: "ok" });
    const c = r1.body.continuation!;
    const id = r1.body.pending!.id;
    const calls = kimi.requests.length;
    const flip = c.slice(0, 10) + (c[10] === "A" ? "B" : "A") + c.slice(11);
    const bad = [
      await srv.continue({ cookie: a.cookie, continuation: flip, result: { id, ok: true, entries: [] } }),
      await srv.continue({ cookie: b.cookie, continuation: c, result: { id, ok: true, entries: [] } }),
      await srv.continue({ cookie: a.cookie, continuation: c, result: { id: "other", ok: true, entries: [] } }),
      await srv.continue({ cookie: a.cookie, continuation: "garbage", result: { id, ok: true, entries: [] } }),
      await server(true, "another-secret-another-secret-0123456789").continue({ cookie: a.cookie, continuation: c, result: { id, ok: true, entries: [] } }),
    ];
    for (const r of bad) expect([r.status, r.body.code]).toEqual([400, "BAD_CONTINUATION"]);
    expect(kimi.requests.length).toBe(calls);
  });

  it("A23 a continuation older than 120 s is refused", async () => {
    let now = Date.now();
    const srv = createAgentServer({
      config, agentId: AGENT, origin: ORIGIN, mode: "disclosure", continuationSecret: SECRET, clock: () => now,
      kimi: { baseUrl: kimi.baseUrl, apiKey: "test-kimi-key", model: "k", timeoutMs: 2000 },
      persona: { name: "Sage", description: "t", systemPrompt: "t", canWrite: true, labels: ["preferences"] },
    });
    const { cookie } = await cookieFor(srv);
    kimi.reply({ toolCalls: [{ name: "recall", args: { query: "x" } }] });
    const r1 = await srv.chat({ cookie, messages: user("q"), disclosed: [], memory: "ok" });
    now += 121_000;
    const r2 = await srv.continue({ cookie, continuation: r1.body.continuation!, result: { id: r1.body.pending!.id, ok: true, entries: [] } });
    expect([r2.status, r2.body.code]).toEqual([400, "BAD_CONTINUATION"]);
  });

  it("D25 never more than 3 tool rounds, even across continuations", async () => {
    const srv = server();
    const { cookie } = await cookieFor(srv);
    for (let i = 0; i < 6; i++) kimi.reply({ toolCalls: [{ name: "remember", args: { kind: "fact", text: `fact ${i}` } }] });
    let r = await srv.chat({ cookie, messages: user("remember lots"), disclosed: [], memory: "ok" });
    let loops = 0;
    while (r.body.pending && loops++ < 10) {
      r = await srv.continue({ cookie, continuation: r.body.continuation!, result: { id: r.body.pending.id, ok: true, seq: String(loops), txHash: "0x" + "cd".repeat(32) } });
    }
    expect(r.status).toBe(200);
    expect(r.body.pending).toBeUndefined();
    expect(kimi.requests.length).toBeLessThanOrEqual(4);
  });

  it("A24/D21 revoked or locked memory: the model is told, and no tools are offered", async () => {
    const srv = server();
    const { cookie } = await cookieFor(srv);
    kimi.reply({ text: "What do you like?" }, { text: "Unlock it." });
    const r = await srv.chat({ cookie, messages: user("plan dinner"), disclosed: [], memory: "revoked" });
    expect(r.body.accessRevoked).toBe(true);
    expect(kimi.requests[0]!.tools ?? []).toEqual([]);
    expect(JSON.stringify(kimi.requests[0]!.messages[0])).toMatch(/revoked/i);
    await srv.chat({ cookie, messages: user("plan dinner"), disclosed: [], memory: "locked" });
    expect(kimi.requests[1]!.tools ?? []).toEqual([]);
    expect(JSON.stringify(kimi.requests[1]!.messages[0])).toMatch(/locked/i);
  });

  it("disclosed entries are capped at 20 and 4000 characters each", async () => {
    const srv = server();
    const { cookie } = await cookieFor(srv);
    kimi.reply({ text: "ok" });
    const disclosed = Array.from({ length: 30 }, (_, i) => ({ kind: "fact", text: `entry-${i} ${"x".repeat(5000)}`, by: "owner" as const }));
    await srv.chat({ cookie, messages: user("hi"), disclosed, memory: "ok" });
    const block = String(memMsgs(0)[0]!.content);
    expect(block.split("\n").filter((l) => l.startsWith("{")).length).toBe(20);
    expect(block).not.toContain("x".repeat(4001));
  });

  it("startup refuses disclosure mode without a strong continuation secret", () => {
    expect(() => server(true, "short")).toThrow();
  });
});
