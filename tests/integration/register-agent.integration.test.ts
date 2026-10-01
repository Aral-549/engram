// Integration (contracts/integration.md cases 1, 2, 8 and E2 on real data): registers a fresh agent on Monad
// testnet with scripts/register-agent.ts, reruns it, then a new owner grants that agent and the minimal agent
// example reads the memory back through the local indexer. Needs: chain/.env DEPLOYER_PRIVATE_KEY (holder),
// the vault relay on http://localhost:3100 and the indexer on http://localhost:8090.
// Run: cd packages/agent-kit && INTEGRATION=1 npx vitest run ../../tests/integration/register-agent.integration.test.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EngramOwner, deployments, graphqlSource, httpRelayer, type EngramConfig } from "../../packages/sdk/src/index.js";
import { createMinimalAgent } from "../../examples/minimal-agent/agent.js";

const root = new URL("../../", import.meta.url).pathname;
const env = Object.fromEntries(
  readFileSync(join(root, "chain/.env"), "utf8").split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const out = join(mkdtempSync(join(tmpdir(), "engram-reg-")), "agent.env");
const ORIGIN = "http://localhost:3300";
const d = deployments.monadTestnet;

function run() {
  const r = spawnSync("npx", ["tsx", "scripts/register-agent.ts", "--name", "Engram integration probe", "--origin", ORIGIN, "--out", out, "--fund", "0.05"], {
    cwd: root, encoding: "utf8", timeout: 240_000, env: { ...process.env, HOLDER_PRIVATE_KEY: env.DEPLOYER_PRIVATE_KEY },
  });
  const ops = (r.stderr ?? "").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { op: string });
  return { code: r.status, stdout: r.stdout ?? "", all: (r.stdout ?? "") + (r.stderr ?? ""), ops: ops.map((o) => o.op) };
}
const readEnv = () => Object.fromEntries(readFileSync(out, "utf8").split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

describe("register-agent + minimal agent on Monad testnet", () => {
  it("registers, is idempotent, never prints secrets, and the example reads granted memory", async () => {
    // case 1
    const first = run();
    expect(first.code, first.all).toBe(0);
    expect(first.ops).toEqual(expect.arrayContaining(["registered", "keys-published", "operator-funded", "done"]));
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const e = readEnv();
    expect(JSON.parse(first.stdout).endpoints[0].endpoint).toBe(ORIGIN);
    // case 8
    for (const secret of [e.AGENT_X25519_PRIVATE_KEY!, e.AGENT_OPERATOR_KEY!, env.DEPLOYER_PRIVATE_KEY!]) expect(first.all).not.toContain(secret.slice(2));

    // case 2
    const second = run();
    expect(second.code, second.all).toBe(0);
    expect(second.ops).toContain("reused");
    expect(second.ops).not.toContain("registered");
    expect(second.ops).not.toContain("keys-published");
    expect(second.ops).not.toContain("operator-funded");
    expect(readEnv().AGENT_ID).toBe(e.AGENT_ID);

    // E2 on real data: a new owner grants the new agent through the vault relay; the example reads it.
    const config: EngramConfig = {
      chainId: d.chainId, registry: d.registry, identityRegistry: d.identityRegistry, rpcUrl: d.rpcUrl,
      source: graphqlSource("http://localhost:8090/v1/graphql"), relayer: httpRelayer("http://localhost:3100/api/relay"),
    };
    const agentId = BigInt(e.AGENT_ID!);
    const owner = await EngramOwner.fromPrf({ config, prfOutput: globalThis.crypto.getRandomValues(new Uint8Array(32)) });
    await owner.remember("preferences", { kind: "preference", text: "integration probe: prefers window seats" });
    await owner.grant("preferences", agentId, { scope: "read", expiresInSec: 3600, includeHistory: true });
    const proof = await owner.signAppSession({ agentId, origin: ORIGIN, ttlSec: 600 });

    const app = createMinimalAgent({
      config, agentId, x25519PrivateKey: new Uint8Array(Buffer.from(e.AGENT_X25519_PRIVATE_KEY!.slice(2), "hex")), origin: ORIGIN, name: "probe",
    });
    const s = await app.handle(new Request(`${ORIGIN}/session`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ proof }) }));
    expect(s.status).toBe(200);
    const cookie = (s.headers.get("set-cookie") ?? "").split(";")[0]!;
    let body: { entries: { text: string }[]; complete: boolean } = { entries: [], complete: false };
    for (let i = 0; i < 20 && !(body.complete && body.entries.length); i++) {
      if (i) await new Promise((r) => setTimeout(r, 500)); // indexer lag
      body = await (await app.handle(new Request(`${ORIGIN}/memory`, { headers: { cookie } }))).json();
    }
    expect(body.entries.map((x) => x.text)).toEqual(["integration probe: prefers window seats"]);
  }, 600_000);
});
