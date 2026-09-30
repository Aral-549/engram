// Regression cases for BUGLOG B5 (second adversarial pass). Written before the fix. FROZEN: add cases, never edit.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveAccountWith, decryptEntry, encryptEntry, type BindingContext } from "../../../packages/crypto/src/index.js";

const V = JSON.parse(readFileSync(new URL("./crypto-vectors.json", import.meta.url), "utf8"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ctx: BindingContext = { chainId: BigInt(V.context.chainId), registry: V.context.registry, owner: V.context.owner };
const nsId = Buffer.from(V.entry.nsId, "hex");

describe("B5: Node Buffer inputs are never zeroed or aliased", () => {
  it("encryptEntry leaves a Buffer key intact, and a second encryption uses the real key", async () => {
    const key = Buffer.from(V.entry.nsKey, "hex");
    const base = { key, ctx, nsId, epoch: 0 };
    await encryptEntry({ ...base, plaintext: new TextEncoder().encode("one") });
    expect(hex(key)).toBe(V.entry.nsKey);
    const env = await encryptEntry({ ...base, plaintext: new TextEncoder().encode("two") });
    const out = await decryptEntry({ ...base, key: new Uint8Array(Buffer.from(V.entry.nsKey, "hex")), envelope: env });
    expect(new TextDecoder().decode(out)).toBe("two");
  });

  it("decryptEntry leaves a Buffer key intact", async () => {
    const key = Buffer.from(V.entry.nsKey, "hex");
    await decryptEntry({ key, ctx, nsId, epoch: 0, envelope: Buffer.from(V.entry.envelope, "hex") });
    expect(hex(key)).toBe(V.entry.nsKey);
  });

  it("deriveAccountWith returns a fresh copy of a Buffer candidate, and never zeroes a rejected Buffer candidate", () => {
    const good = Buffer.from(V.derivations.A.account.accountKey, "hex");
    const bad = Buffer.alloc(32, 0xff); // >= n, rejected
    const acc = deriveAccountWith((c) => (c === 0 ? bad : good));
    expect(bad.every((b) => b === 0xff)).toBe(true);
    good.fill(0);
    expect(hex(acc.accountKey)).toBe(V.derivations.A.account.accountKey);
  });
});
