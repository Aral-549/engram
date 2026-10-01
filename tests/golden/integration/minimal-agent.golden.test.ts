// Golden tests for examples/minimal-agent (contracts/integration.md cases E1-E6).
// Written from the spec before the implementation. FROZEN: add cases, never edit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import { EngramAgent, EngramOwner, createRelayHandler, inProcessRelayer, logsSource, type EngramConfig } from "../../../packages/sdk/src/index.js";
import { createMinimalAgent } from "../../../examples/minimal-agent/agent.js";
import { startLocalChain, type LocalChain } from "../../support/anvil.js";

let chain: LocalChain;
let config: EngramConfig;
const ORIGIN = "https://notes.example";
const priv = x25519.utils.randomSecretKey();
const AG = { id: 61n, priv, pub: x25519.getPublicKey(priv) };
let app: ReturnType<typeof createMinimalAgent>;

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(ORIGIN + path, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const get = (path: string, cookie?: string) => new Request(ORIGIN + path, { headers: cookie ? { cookie } : {} });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

async function connected(memories: string[]) {
  const s = await EngramOwner.fromPrf({ config, prfOutput: globalThis.crypto.getRandomValues(new Uint8Array(32)) });
  for (const m of memories) await s.remember("preferences", { kind: "preference", text: m });
  await s.grant("preferences", AG.id, { scope: "read", expiresInSec: 3600, includeHistory: true });
  const proof = await s.signAppSession({ agentId: AG.id, origin: ORIGIN, ttlSec: 3600 });
  const res = await app.handle(post("/session", { proof }));
  return { s, res, cookie: cookieOf(res) };
}

beforeAll(async () => {
  chain = await startLocalChain();
  const handler = createRelayHandler({ config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl }, wallet: chain.wallet(1) });
  config = {
    chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl,
    source: logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n }), relayer: inProcessRelayer(handler),
  };
  await chain.mintAgent(AG.id, chain.wallet(2).account.address);
  await EngramAgent.publishKeys({ config, agentId: AG.id, x25519PublicKey: AG.pub, operator: chain.wallet(3).account.address, holder: chain.wallet(2) });
  app = createMinimalAgent({ config, agentId: AG.id, x25519PrivateKey: AG.priv, origin: ORIGIN, name: "Notes", description: "example" });
});
afterAll(() => chain?.stop());

describe("minimal agent example", () => {
  it("E1 a vault-signed proof sets an httpOnly SameSite=Strict cookie", async () => {
    const { res } = await connected([]);
    expect(res.status).toBe(200);
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
  });

  it("E2 /memory returns the granted entries", async () => {
    const { cookie } = await connected(["likes rain", "early riser"]);
    const res = await app.handle(get("/memory", cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { kind: string; text: string }[]; complete: boolean };
    expect(body.entries.map((e) => e.text)).toEqual(["likes rain", "early riser"]);
    expect(body.complete).toBe(true);
  });

  it("E3 /memory without or with a bad cookie is 401", async () => {
    expect((await app.handle(get("/memory"))).status).toBe(401);
    expect((await app.handle(get("/memory", "engram_session=garbage"))).status).toBe(401);
  });

  it("E4 after revoke /memory returns no entries and revoked: true", async () => {
    const { s, cookie } = await connected(["secret plan"]);
    await s.revoke("preferences", [AG.id]);
    const res = await app.handle(get("/memory", cookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ entries: [], revoked: true });
    expect(JSON.stringify(body)).not.toContain("secret plan");
  });

  it("E5 cross-origin or non-JSON /session is refused", async () => {
    const { s } = await connected([]);
    const proof = await s.signAppSession({ agentId: AG.id, origin: ORIGIN, ttlSec: 3600 });
    expect((await app.handle(post("/session", { proof }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await app.handle(post("/session", { proof }, { "content-type": "text/plain" }))).status).toBe(415);
  });

  it("E6 /agent-card.json lists the app origin as an endpoint", async () => {
    const res = await app.handle(get("/agent-card.json"));
    expect(res.status).toBe(200);
    const card = (await res.json()) as { name: string; endpoints: { endpoint: string }[] };
    expect(card.name).toBe("Notes");
    expect(card.endpoints[0]!.endpoint).toBe(ORIGIN);
  });
});
