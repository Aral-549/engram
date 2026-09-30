// Integration: real Monad testnet data (seeded by scripts/seed-testnet.ts) -> HyperSync -> handlers ->
// entities -> decrypt. Needs ENVIO_API_TOKEN in indexer/.env and the seed secrets in chain/.env.
// Run: cd indexer && npm run test:integration
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";
import {
  decryptEntry,
  deriveNamespaceKey,
  parseEntry,
  unwrapNamespaceKey,
  type BindingContext,
} from "../../packages/crypto/src/index.js";

const seed = JSON.parse(readFileSync(new URL("./seed-output.json", import.meta.url), "utf8"));
const env = Object.fromEntries(
  readFileSync(new URL("../../chain/.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const bytes = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));
const AGENT_REGISTERED_BLOCK = 67063365; // agent 1961 register tx 0x988261ef...5d1d
const NS = `${seed.owner}-${seed.nsId}`;
const ctx: BindingContext = { chainId: 10143n, registry: seed.registry, owner: seed.owner };

describe("indexer against real Monad testnet data", () => {
  it("indexes the seeded namespace, grant, wraps, and agent, and the ciphertext decrypts", async () => {
    const ix: any = createTestIndexer();
    const t0 = Date.now();
    await ix.process({ chains: { 10143: { startBlock: AGENT_REGISTERED_BLOCK, endBlock: seed.endBlock } } });
    console.log(JSON.stringify({ stage: "integration", op: "process", blocks: seed.endBlock - AGENT_REGISTERED_BLOCK + 1, ms: Date.now() - t0 }));

    expect(await ix.IndexerError.getAll()).toEqual([]);

    const ns = await ix.Namespace.getOrThrow(NS);
    expect(ns.epoch).toBe(BigInt(seed.epochAfter));
    expect(ns.nextSeq).toBe(BigInt(seed.nextSeqAfter));
    expect(ns.granteeCount).toBe(1);

    const agent = await ix.Agent.getOrThrow(seed.agentId);
    expect(agent.keysCurrent).toBe(true);
    expect(agent.tokenOwner).toBe(env.DEPLOYER_ADDRESS.toLowerCase());

    const grant = await ix.Grant.getOrThrow(`${NS}-${seed.agentId}`);
    expect(grant).toMatchObject({ active: true, scope: 3 });

    // Owner side: re-derive epoch keys from the (simulated) passkey PRF and decrypt the last 3 entries.
    const prf = bytes(env.SEED_OWNER_PRF);
    const last = Number(seed.nextSeqAfter);
    const texts: string[] = [];
    for (let seq = last - 3; seq < last; seq++) {
      const e = await ix.Entry.getOrThrow(`${NS}-${seq}`);
      const key = deriveNamespaceKey(prf, "preferences", e.epoch);
      const pt = await decryptEntry({ key, ctx, nsId: bytes(seed.nsId), epoch: e.epoch, envelope: bytes(e.ciphertext) });
      texts.push(parseEntry(pt).text);
    }
    expect(texts).toEqual(["vegetarian", "allergic to peanuts", "prefers window seats"]);
    const byAgent = await ix.Entry.getOrThrow(`${NS}-${last - 1}`);
    expect(byAgent).toMatchObject({ byOwner: false, agentId: BigInt(seed.agentId) });

    // Agent side: open every indexed wrap with the agent's own X25519 key.
    const wraps = (await ix.WrappedKey.getAll()).filter((w: any) => w.grant_id === `${NS}-${seed.agentId}`);
    expect(wraps.length).toBeGreaterThanOrEqual(2);
    for (const w of wraps) {
      const { nsKey, label } = await unwrapNamespaceKey({
        ctx, nsId: bytes(seed.nsId), epoch: w.epoch, agentId: BigInt(seed.agentId),
        envelope: bytes(w.wrap), agentX25519Private: bytes(env.SEED_AGENT_X25519_PRIVATE),
      });
      expect(label).toBe("preferences");
      expect(Buffer.from(nsKey).toString("hex")).toBe(Buffer.from(deriveNamespaceKey(prf, "preferences", w.epoch)).toString("hex"));
    }
  });
});
