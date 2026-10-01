// Golden tests for scripts/register-agent.ts (contracts/integration.md cases 3-6, 8). These are the cases that
// must fail before any transaction; cases 1, 2 and 7 run against Monad testnet in tests/integration.
// Written from the spec before the implementation. FROZEN: add cases, never edit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANVIL_KEYS, startLocalChain, type LocalChain } from "../../support/anvil.js";

const root = new URL("../../../", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "engram-register-"));
const HOLDER = ANVIL_KEYS[4]!;
let chain: LocalChain;

function run(args: string[], env: Record<string, string | undefined>) {
  const r = spawnSync("npx", ["tsx", "scripts/register-agent.ts", ...args], {
    cwd: root, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, HOLDER_PRIVATE_KEY: undefined, RPC_URL: undefined, REGISTRY: undefined, IDENTITY_REGISTRY: undefined, ...env },
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
const local = () => ({ HOLDER_PRIVATE_KEY: HOLDER, RPC_URL: chain.rpcUrl, REGISTRY: chain.registry, IDENTITY_REGISTRY: chain.identityRegistry });
const txCount = () => chain.publicClient.getTransactionCount({ address: chain.wallet(4).account.address });

beforeAll(async () => {
  chain = await startLocalChain();
});
afterAll(() => chain?.stop());

describe("register-agent preflight", () => {
  it("3 a non-exact or non-http(s) origin exits 1 before any transaction", async () => {
    const before = await txCount();
    for (const origin of ["https://app.example/", "https://app.example/path", "ftp://app.example", "https://App.example:443", "not a url"]) {
      const r = run(["--name", "X", "--origin", origin, "--out", join(dir, "o.env")], local());
      expect(r.code, origin).toBe(1);
      expect(r.out.toLowerCase()).toContain("origin");
    }
    expect(await txCount()).toBe(before);
  });

  it("4 a missing or malformed holder key exits 1 before any transaction", async () => {
    const before = await txCount();
    expect(run(["--name", "X", "--origin", "https://app.example", "--out", join(dir, "k.env")], { ...local(), HOLDER_PRIVATE_KEY: undefined }).code).toBe(1);
    expect(run(["--name", "X", "--origin", "https://app.example", "--out", join(dir, "k.env")], { ...local(), HOLDER_PRIVATE_KEY: "0x1234" }).code).toBe(1);
    expect(await txCount()).toBe(before);
  });

  it("5 an env file naming an agent the holder does not own exits 1 before any transaction", async () => {
    await chain.mintAgent(77n, chain.wallet(2).account.address); // owned by someone else
    const file = join(dir, "foreign.env");
    writeFileSync(file, `AGENT_ID=77\nENGRAM_REGISTRY=${chain.registry}\nENGRAM_CHAIN_ID=31337\nAPP_ORIGIN=https://app.example\n`);
    const before = await txCount();
    const r = run(["--name", "X", "--origin", "https://app.example", "--out", file], local());
    expect(r.code).toBe(1);
    expect(r.out).toContain("does not own agent 77");
    expect(await txCount()).toBe(before);
  });

  it("6 an env file written for a different registry exits 1 before any transaction", async () => {
    const file = join(dir, "stale.env");
    writeFileSync(file, `AGENT_ID=5\nENGRAM_REGISTRY=0x0000000000000000000000000000000000000001\nENGRAM_CHAIN_ID=31337\nAPP_ORIGIN=https://app.example\n`);
    const before = await txCount();
    const r = run(["--name", "X", "--origin", "https://app.example", "--out", file], local());
    expect(r.code).toBe(1);
    expect(r.out.toLowerCase()).toContain("registry");
    expect(readFileSync(file, "utf8")).toContain("ENGRAM_REGISTRY=0x0000000000000000000000000000000000000001"); // untouched
    expect(await txCount()).toBe(before);
  });

  it("8 output never contains the holder key", () => {
    const r = run(["--name", "X", "--origin", "https://app.example/", "--out", join(dir, "s.env")], local());
    expect(r.out).not.toContain(HOLDER.slice(2));
  });
});

describe("register-agent resume", () => {
  it("9 resumes a registered agent: publishes keys and funds once; a rerun does neither (BUGLOG K1)", async () => {
    await chain.mintAgent(78n, chain.wallet(4).account.address); // owned by the holder
    const file = join(dir, "resume.env");
    writeFileSync(file, `AGENT_ID=78\nENGRAM_REGISTRY=${chain.registry}\nENGRAM_CHAIN_ID=31337\nAPP_ORIGIN=https://app.example\n`);
    const ops = (out: string) => out.split("\n").filter((l) => l.includes('"stage":"register-agent"')).map((l) => (JSON.parse(l) as { op: string }).op);
    const first = run(["--origin", "https://app.example", "--out", file, "--fund", "0.05"], local());
    expect(first.code, first.out).toBe(0);
    expect(ops(first.out)).toEqual(expect.arrayContaining(["reused", "keys-published", "operator-funded", "done"]));
    const second = run(["--origin", "https://app.example", "--out", file, "--fund", "0.05"], local());
    expect(second.code, second.out).toBe(0);
    expect(ops(second.out)).not.toContain("keys-published");
    expect(ops(second.out)).not.toContain("operator-funded");
  });
});
