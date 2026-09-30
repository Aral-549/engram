// Adversarial probes against BUGLOG B5 (copyBytes replacing .slice() on caller input) and the crypto.md
// promise "Returned keys are fresh copies; callers may zero their inputs without affecting outputs".
// Each test PASSES when behavior matches the spec and FAILS on a bug.
import { describe, expect, it } from "vitest";
import {
  deriveAccountWith,
  deriveNamespaceId,
  deriveNamespaceKey,
  encryptEntry,
  decryptEntry,
  wrapNamespaceKey,
  unwrapNamespaceKey,
  generateAgentKeyPair,
  EngramCryptoError,
  type BindingContext,
} from "../../../packages/crypto/src/index.js";

const hex = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("hex");
const utf8 = (s: string) => new TextEncoder().encode(s);
const prf = new Uint8Array(32).fill(0x02);
const ctx: BindingContext = { chainId: 10143n, registry: `0x${"11".repeat(20)}`, owner: `0x${"22".repeat(20)}` };
const nsId = deriveNamespaceId(prf, "work");
const nsKey = deriveNamespaceKey(prf, "work", 0);
const ENTRY_MAX = 2077;

async function code(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof EngramCryptoError) return e.code;
    return `NON_ENGRAM_ERROR:${(e as Error)?.constructor?.name}:${(e as Error)?.message}`;
  }
  return "OK";
}

function sab(src: Uint8Array): Uint8Array {
  const v = new Uint8Array(new SharedArrayBuffer(src.length));
  v.set(src);
  return v;
}

async function opens(env: Uint8Array, key: Uint8Array = nsKey): Promise<string | null> {
  try {
    return new TextDecoder().decode(await decryptEntry({ key, ctx, nsId, epoch: 0, envelope: env }));
  } catch {
    return null;
  }
}

/** A Uint8Array subclass that lies about its length (own `length` getter; internal [[ArrayLength]] differs). */
class LyingLength extends Uint8Array {
  claimed = 0;
  override get length(): number {
    return this.claimed;
  }
}
function lying(real: Uint8Array, claimed: number): Uint8Array {
  const v = new LyingLength(real.length);
  v.set(real);
  v.claimed = claimed;
  return v;
}

// ------------------------------------------------------------------ exotic backing stores

describe("copyBytes: exotic Uint8Array backings", () => {
  it("SharedArrayBuffer-backed key, nonce, plaintext, nsId: round trip works and inputs are untouched", async () => {
    const key = sab(nsKey);
    const pt = sab(utf8("shared"));
    const nonce = sab(new Uint8Array(12).fill(7));
    const ns = sab(nsId);
    const env = await encryptEntry({ key, ctx, nsId: ns, epoch: 0, plaintext: pt, nonce });
    expect(hex(key)).toBe(hex(nsKey));
    expect(new TextDecoder().decode(pt.slice())).toBe("shared");
    expect(await opens(env)).toBe("shared");
    const out = await decryptEntry({ key, ctx, nsId: ns, epoch: 0, envelope: sab(env) });
    expect(new TextDecoder().decode(out)).toBe("shared");
    expect(hex(key)).toBe(hex(nsKey));
  });

  it("Symbol.species override does not influence the copy (result is a plain, independent Uint8Array)", async () => {
    let speciesUsed = 0;
    class Species extends Uint8Array {
      static override get [Symbol.species]() {
        speciesUsed++;
        return Uint8Array;
      }
    }
    const k = new Species(32);
    k.set(nsKey);
    const env = await encryptEntry({ key: k, ctx, nsId, epoch: 0, plaintext: utf8("sp") });
    expect(hex(k)).toBe(hex(nsKey));
    expect(await opens(env)).toBe("sp");
    expect(speciesUsed).toBe(0);
  });

  it("detached key buffer -> EngramCryptoError INPUT_INVALID, not a raw TypeError", async () => {
    const k = new Uint8Array(nsKey);
    structuredClone(k.buffer, { transfer: [k.buffer] });
    expect(await code(() => encryptEntry({ key: k, ctx, nsId, epoch: 0, plaintext: utf8("x") }))).toBe("INPUT_INVALID");
  });

  it("pooled Node Buffers (small Buffer.from) for every input of wrap/unwrap are never zeroed or aliased", async () => {
    const agent = generateAgentKeyPair();
    const bKey = Buffer.from(nsKey);
    const bPub = Buffer.from(agent.publicKey);
    const bPriv = Buffer.from(agent.privateKey);
    const bNs = Buffer.from(nsId);
    const w = await wrapNamespaceKey({ ctx, nsId: bNs, epoch: 1, agentId: 9, nsKey: bKey, label: "work", agentX25519Public: bPub });
    const bEnv = Buffer.from(w);
    const envBefore = hex(bEnv);
    const r = await unwrapNamespaceKey({ ctx, nsId: bNs, epoch: 1, agentId: 9, envelope: bEnv, agentX25519Private: bPriv });
    expect(hex(bKey)).toBe(hex(nsKey));
    expect(hex(bPub)).toBe(hex(agent.publicKey));
    expect(hex(bPriv)).toBe(hex(agent.privateKey));
    expect(hex(bNs)).toBe(hex(nsId));
    expect(hex(bEnv)).toBe(envBefore);
    expect(hex(r.nsKey)).toBe(hex(nsKey));
    expect(r.nsKey.buffer).not.toBe(bEnv.buffer);
    expect(r.nsKey.byteLength).toBe(32);
    bEnv.fill(0);
    bPriv.fill(0);
    expect(hex(r.nsKey)).toBe(hex(nsKey));
  });

  it("two unwraps return independent nsKey buffers", async () => {
    const agent = generateAgentKeyPair();
    const w = await wrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 1, nsKey, label: "work", agentX25519Public: agent.publicKey });
    const p = { ctx, nsId, epoch: 0, agentId: 1, envelope: w, agentX25519Private: agent.privateKey };
    const a = await unwrapNamespaceKey(p);
    const b = await unwrapNamespaceKey(p);
    a.nsKey.fill(0);
    expect(hex(b.nsKey)).toBe(hex(nsKey));
  });

  it("deriveAccountWith: SharedArrayBuffer candidate -> accountKey is a fresh non-shared copy", () => {
    const good = deriveAccountWith(() => new Uint8Array(32).fill(0x05)).accountKey;
    const cand = sab(new Uint8Array(32).fill(0x05));
    const acc = deriveAccountWith(() => cand);
    expect(acc.accountKey.buffer instanceof SharedArrayBuffer).toBe(false);
    cand.fill(0);
    expect(hex(acc.accountKey)).toBe(hex(good));
  });
});

// ------------------------------------------------------------------ length checked on one view, copied from another

describe("assertBytes vs copyBytes disagree on length", () => {
  it("key claiming length 32 but holding 16 bytes must be rejected (never AES-128)", async () => {
    const k = lying(nsKey.subarray(0, 16), 32);
    const r = await code(() => encryptEntry({ key: k, ctx, nsId, epoch: 0, plaintext: utf8("x") }));
    expect(r, "encrypted under a 16-byte key while the API requires 32").toBe("INPUT_INVALID");
  });

  it("nsKey claiming length 32 but holding 16 bytes must be rejected by wrapNamespaceKey", async () => {
    const agent = generateAgentKeyPair();
    const r = await code(() =>
      wrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 1, nsKey: lying(nsKey.subarray(0, 16), 32), label: "work", agentX25519Public: agent.publicKey }),
    );
    expect(r).toBe("INPUT_INVALID");
  });

  it("deriveAccountWith candidate claiming 32 but holding 31 bytes -> EngramCryptoError INPUT_INVALID", async () => {
    const r = await code(() => deriveAccountWith(() => lying(new Uint8Array(31).fill(3), 32)));
    expect(r).toBe("INPUT_INVALID");
  });
});

// ------------------------------------------------------------------ inputs read more than once / after an await

describe("inputs are snapshotted before use", () => {
  it("params.key getter read twice: validated key must be the key used", async () => {
    let reads = 0;
    const p = {
      ctx,
      nsId,
      epoch: 0,
      plaintext: utf8("getter"),
      get key() {
        reads++;
        return reads === 1 ? nsKey : nsKey.slice(0, 16);
      },
    };
    const r = await code(async () => {
      const env = await encryptEntry(p);
      if ((await opens(env)) !== "getter") throw new Error("envelope does not open under the validated 32-byte key");
    });
    expect(r, `key getter read ${reads} times`).toMatch(/^(OK|INPUT_INVALID)$/);
  });

  it("caller zeroes plaintext right after calling encryptEntry (before awaiting): output is unaffected", async () => {
    const pt = utf8("secret note");
    const pending = encryptEntry({ key: nsKey, ctx, nsId, epoch: 0, plaintext: pt });
    pt.fill(0);
    const env = await pending;
    expect(await opens(env)).toBe("secret note");
  });

  it("caller zeroes a caller-supplied nonce right after calling: envelope nonce equals the nonce used", async () => {
    const nonce = new Uint8Array(12).fill(9);
    const pending = encryptEntry({ key: nsKey, ctx, nsId, epoch: 0, plaintext: utf8("n"), nonce });
    nonce.fill(0);
    const env = await pending;
    expect(hex(env.subarray(1, 13))).toBe("09".repeat(12));
    expect(await opens(env)).toBe("n");
  });

  it("length-tracking view over a resizable buffer grown after the call cannot yield an oversize envelope", async () => {
    const ab = new ArrayBuffer(10, { maxByteLength: 4096 });
    const pt = new Uint8Array(ab); // length-tracking
    pt.fill(0x41);
    const pending = encryptEntry({ key: nsKey, ctx, nsId, epoch: 0, plaintext: pt });
    ab.resize(4000);
    const env = await pending;
    expect(env.length).toBeLessThanOrEqual(ENTRY_MAX);
    expect(await opens(env)).toBe("A".repeat(10));
  });
});
