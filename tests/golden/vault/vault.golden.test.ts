// Golden tests for contracts/apps.md vault cases V1, V2. Written before the implementation. FROZEN: add, never edit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EngramOwner, createRelayHandler, inProcessRelayer, logsSource, type EngramConfig } from "../../../packages/sdk/src/index.js";
import { INDEX_LABEL, KNOWN_LABELS, addLabel, discoverLabels } from "../../../apps/vault/lib/discover.js";
import { fetchAgentCard } from "../../../apps/vault/lib/server/agent-card.js";
import { startLocalChain, type LocalChain } from "../../support/anvil.js";
import { FakeAuthenticator } from "../../support/fake-authenticator.js";

let chain: LocalChain;
let config: EngramConfig;

beforeAll(async () => {
  chain = await startLocalChain();
  const handler = createRelayHandler({ config: { chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl }, wallet: chain.wallet(1) });
  config = {
    chainId: 31337, registry: chain.registry, identityRegistry: chain.identityRegistry, rpcUrl: chain.rpcUrl,
    source: logsSource({ rpcUrl: chain.rpcUrl, registry: chain.registry, fromBlock: 0n }), relayer: inProcessRelayer(handler), logger: () => {},
  };
});
afterAll(() => chain?.stop());

describe("V1 stateless namespace discovery", () => {
  it("finds well-known and custom labels from the passkey alone", async () => {
    const auth = new FakeAuthenticator("v1");
    const s = await EngramOwner.signUp({ config, rpId: "vault.test", rpName: "Engram", userName: "v1", webAuthnClient: auth.client });
    await s.remember("preferences", { kind: "preference", text: "vegetarian" });
    await addLabel(s, "recipes");
    await addLabel(s, "recipes"); // idempotent
    await s.remember("recipes", { kind: "note", text: "dal makhani" });
    s.end();

    const s2 = await EngramOwner.signIn({ config, rpId: "vault.test", webAuthnClient: auth.syncedDevice().client });
    const found = await discoverLabels(s2);
    expect(found.map((f) => f.label).sort()).toEqual(["preferences", "recipes"]);
    expect(found.find((f) => f.label === "recipes")!.entries.map((e) => e.text)).toEqual(["dal makhani"]);
    expect(found.some((f) => f.label === INDEX_LABEL)).toBe(false);
    expect(KNOWN_LABELS).toContain("preferences");
  });

  it("rejects invalid custom labels", async () => {
    const s = await EngramOwner.fromPrf({ config, prfOutput: new Uint8Array(32).fill(0x71) });
    await expect(addLabel(s, "Recipes")).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(addLabel(s, INDEX_LABEL)).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
});

describe("V2 agent card fetch is hardened", () => {
  const card = { name: "Planner", description: "Trip planner", endpoints: [{ name: "web", endpoint: "https://planner.test" }] };
  const fakeFetch = (body: string, init: { status?: number; type?: string; delayMs?: number } = {}) =>
    (async (_url: string, opts?: { signal?: AbortSignal }) => {
      if (init.delayMs) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, init.delayMs);
          opts?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); });
        });
      }
      return new Response(body, { status: init.status ?? 200, headers: { "content-type": init.type ?? "application/json" } });
    }) as unknown as typeof fetch;

  it("returns a valid card", async () => {
    const r = await fetchAgentCard("https://cards.test/7.json", { fetch: fakeFetch(JSON.stringify(card)) });
    expect(r).toMatchObject({ ok: true, card: { name: "Planner" } });
  });

  it("refuses http, data, and javascript URIs without fetching", async () => {
    let called = false;
    const spy = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    for (const uri of ["http://cards.test/7.json", "data:application/json,{}", "javascript:alert(1)", "not a url", ""]) {
      const r = await fetchAgentCard(uri, { fetch: spy });
      expect(r).toMatchObject({ ok: false, status: 400, code: "BAD_URI" });
    }
    expect(called).toBe(false);
  });

  it("refuses non-JSON, oversized, and malformed cards", async () => {
    expect(await fetchAgentCard("https://c.test/a", { fetch: fakeFetch("<html>", { type: "text/html" }) })).toMatchObject({ ok: false, code: "NOT_JSON" });
    expect(await fetchAgentCard("https://c.test/a", { fetch: fakeFetch(JSON.stringify({ name: "x".repeat(70_000) })) })).toMatchObject({ ok: false, code: "TOO_LARGE" });
    expect(await fetchAgentCard("https://c.test/a", { fetch: fakeFetch("{not json") })).toMatchObject({ ok: false, code: "NOT_JSON" });
    expect(await fetchAgentCard("https://c.test/a", { fetch: fakeFetch(JSON.stringify([1, 2])) })).toMatchObject({ ok: false, code: "BAD_CARD" });
    expect(await fetchAgentCard("https://c.test/a", { fetch: fakeFetch("{}", { status: 404 }) })).toMatchObject({ ok: false, code: "UPSTREAM_STATUS" });
  });

  it("times out slow hosts", async () => {
    const r = await fetchAgentCard("https://c.test/slow", { fetch: fakeFetch("{}", { delayMs: 500 }), timeoutMs: 50 });
    expect(r).toMatchObject({ ok: false, status: 504, code: "TIMEOUT" });
  });

  it("keeps only known card fields (no arbitrary passthrough)", async () => {
    const r = await fetchAgentCard("https://c.test/a", { fetch: fakeFetch(JSON.stringify({ ...card, script: "<script>", extra: { a: 1 } })) });
    expect(r.ok && Object.keys(r.card).sort()).toEqual(["description", "endpoints", "name"]);
  });
});
