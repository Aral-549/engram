// Regression cases for BUGLOG B6 (third adversarial pass). Written before the fix. FROZEN: add cases, never edit.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decryptEntry,
  deriveAccount,
  deriveAccountWith,
  encryptEntry,
  unwrapNamespaceKey,
  wrapNamespaceKey,
  EngramCryptoError,
  type BindingContext,
} from "../../../packages/crypto/src/index.js";

const V = JSON.parse(readFileSync(new URL("./crypto-vectors.json", import.meta.url), "utf8"));
const bytes = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const ctx: BindingContext = { chainId: BigInt(V.context.chainId), registry: V.context.registry, owner: V.context.owner };
const base = () => ({ key: bytes(V.entry.nsKey), ctx, nsId: bytes(V.entry.nsId), epoch: 0 });

async function expectCode(p: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(EngramCryptoError);
    expect((e as EngramCryptoError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, got success`);
}

/** A Uint8Array that lies about its length. */
class LyingLength extends Uint8Array {
  override get length(): number {
    return 32;
  }
}

describe("B6a: inputs are captured synchronously at call time", () => {
  it("zeroing plaintext right after calling encryptEntry does not change what is encrypted", async () => {
    const pt = new TextEncoder().encode("vegetarian");
    const pending = encryptEntry({ ...base(), plaintext: pt });
    pt.fill(0);
    const env = await pending;
    const out = await decryptEntry({ ...base(), envelope: env });
    expect(new TextDecoder().decode(out)).toBe("vegetarian");
  });

  it("zeroing a supplied nonce right after the call does not change the envelope", async () => {
    const nonce = bytes(V.entry.nonce);
    const pending = encryptEntry({ ...base(), plaintext: new TextEncoder().encode(V.entry.plaintext), nonce });
    nonce.fill(0);
    expect(Buffer.from(await pending).toString("hex")).toBe(V.entry.envelope);
  });

  it("zeroing the key right after the call does not change the key used", async () => {
    const b = base();
    const pending = encryptEntry({ ...b, plaintext: new TextEncoder().encode("x") });
    b.key.fill(0);
    const env = await pending;
    await expect(decryptEntry({ ...base(), envelope: env })).resolves.toBeInstanceOf(Uint8Array);
  });

  it("zeroing an envelope right after calling decryptEntry does not change what is decrypted", async () => {
    const env = bytes(V.entry.envelope);
    const pending = decryptEntry({ ...base(), envelope: env });
    env.fill(0);
    expect(new TextDecoder().decode(await pending)).toBe(V.entry.plaintext);
  });

  it("a resizable-buffer view grown after the call cannot exceed the size limit", async () => {
    const rab = new ArrayBuffer(10, { maxByteLength: 4096 });
    const view = new Uint8Array(rab);
    view.fill(0x41);
    const pending = encryptEntry({ ...base(), plaintext: view });
    rab.resize(4000);
    const env = await pending;
    expect(env.length).toBe(1 + 12 + 10 + 16);
  });
});

describe("B6b: lengths are checked on the bytes actually used", () => {
  it("a key that claims 32 bytes but holds 16 is rejected", async () => {
    const liar = new LyingLength(16);
    await expectCode(encryptEntry({ ...base(), key: liar, plaintext: new Uint8Array([1]) }), "INPUT_INVALID");
    await expectCode(decryptEntry({ ...base(), key: liar, envelope: bytes(V.entry.envelope) }), "INPUT_INVALID");
  });

  it("an nsKey that claims 32 bytes but holds 16 is rejected by wrap", async () => {
    await expectCode(
      wrapNamespaceKey({
        ctx, nsId: bytes(V.entry.nsId), epoch: 0, agentId: 7n, label: "preferences",
        nsKey: new LyingLength(16), agentX25519Public: bytes(V.wrap.agentX25519Public),
      }),
      "INPUT_INVALID",
    );
  });

  it("a prf or candidate that lies about its length is rejected with INPUT_INVALID", async () => {
    await expectCode(() => deriveAccount(new LyingLength(31)), "INPUT_INVALID");
    await expectCode(() => deriveAccountWith(() => new LyingLength(31)), "INPUT_INVALID");
  });

  it("a params getter read more than once cannot swap the key", async () => {
    let reads = 0;
    const p = {
      ...base(),
      plaintext: new Uint8Array([1]),
      get key() {
        reads++;
        return reads === 1 ? bytes(V.entry.nsKey) : new Uint8Array(16);
      },
    };
    const env = await encryptEntry(p);
    await expect(decryptEntry({ ...base(), envelope: env })).resolves.toBeInstanceOf(Uint8Array);
  });

  it("a detached buffer is INPUT_INVALID, not a TypeError", async () => {
    const buf = new ArrayBuffer(32);
    const key = new Uint8Array(buf);
    structuredClone(buf, { transfer: [buf] });
    await expectCode(encryptEntry({ ...base(), key, plaintext: new Uint8Array([1]) }), "INPUT_INVALID");
  });

  it("unwrap private key that lies about its length is rejected", async () => {
    await expectCode(
      unwrapNamespaceKey({
        ctx, nsId: bytes(V.entry.nsId), epoch: 0, agentId: 7n,
        envelope: bytes(V.wrap.envelope), agentX25519Private: new LyingLength(16),
      }),
      "INPUT_INVALID",
    );
  });
});
