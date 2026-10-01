// Regression case for BUGLOG S1 on the indexer side (contracts/indexer.md case 24). FROZEN: add, never edit.
import { describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";

const O = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const N = "0x" + "ab".repeat(32);
const NS = `${O.toLowerCase()}-${N}`;
const TX = "0x" + "7e".repeat(32);

describe("I3 chain-verifiable wraps", () => {
  it("#24 WrappedKey records the KeyWrapped txHash and logIndex", async () => {
    const ix: any = createTestIndexer();
    const ev = (event: string, params: Record<string, unknown>, block: number, logIndex: number) => ({
      contract: "MemoryRegistry", event, params, block: { number: block, timestamp: 1_790_000_000 }, transaction: { hash: TX }, logIndex,
    });
    await ix.process({ chains: { 10143: { simulate: [
      ev("NamespaceCreated", { owner: O, nsId: N }, 500, 0),
      ev("GrantSet", { owner: O, nsId: N, agentId: 7n, scope: 1n, expiry: 2_000_000_000n }, 501, 3),
      ev("KeyWrapped", { owner: O, nsId: N, agentId: 7n, epoch: 0n, wrap: "0x01" + "ef".repeat(93) }, 501, 4),
    ] } } });
    expect(await ix.WrappedKey.getOrThrow(`${NS}-7-0`)).toMatchObject({ txHash: TX, logIndex: 4 });
  });
});
