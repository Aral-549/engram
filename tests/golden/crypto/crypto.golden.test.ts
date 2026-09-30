// Golden tests for contracts/crypto.md. Written from the spec before the implementation existed.
// Byte vectors come from generate_vectors.py (independent Python implementation). FROZEN: add cases, never edit.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ROOT_SALT,
  deriveAccount,
  deriveAccountWith,
  deriveNamespaceId,
  deriveNamespaceKey,
  encryptEntry,
  decryptEntry,
  encodeEntry,
  parseEntry,
  wrapNamespaceKey,
  unwrapNamespaceKey,
  generateAgentKeyPair,
  EngramCryptoError,
  type BindingContext,
} from "../../../packages/crypto/src/index.js";

const V = JSON.parse(readFileSync(new URL("./crypto-vectors.json", import.meta.url), "utf8"));

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));
const utf8 = (s: string) => new TextEncoder().encode(s);

const prfA = bytes(V.derivations.A.prfOutput);
const prfB = bytes(V.derivations.B.prfOutput);
const ctx: BindingContext = {
  chainId: BigInt(V.context.chainId),
  registry: V.context.registry,
  owner: V.context.owner,
};
const entryNsId = bytes(V.entry.nsId);
const entryKey = bytes(V.entry.nsKey);

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

describe("constants", () => {
  it("ROOT_SALT = sha256('engram.prf.v1')", () => {
    expect(hex(ROOT_SALT)).toBe(V.rootSalt);
  });
});

describe("derivation (cases 1-6)", () => {
  it("#1 prf A matches vector V1", () => {
    const acc = deriveAccount(prfA);
    expect(hex(acc.accountKey)).toBe(V.derivations.A.account.accountKey);
    expect(hex(acc.publicKey)).toBe(V.derivations.A.account.publicKey);
    expect(acc.owner).toBe(V.derivations.A.account.owner);
    for (const label of ["preferences", "work"]) {
      expect(hex(deriveNamespaceId(prfA, label))).toBe(V.derivations.A.nsId[label]);
      for (const e of [0, 1]) expect(hex(deriveNamespaceKey(prfA, label, e))).toBe(V.derivations.A.nsKey[label][e]);
    }
  });

  it("#2 deterministic: second call (another device) is byte-identical", () => {
    const a1 = deriveAccount(new Uint8Array(prfA));
    const a2 = deriveAccount(new Uint8Array(prfA));
    expect(hex(a1.accountKey)).toBe(hex(a2.accountKey));
    expect(hex(deriveNamespaceKey(prfA, "preferences", 0))).toBe(hex(deriveNamespaceKey(prfA, "preferences", 0)));
  });

  it("#3 prf B matches its vector and differs from A everywhere", () => {
    const b = deriveAccount(prfB);
    expect(hex(b.accountKey)).toBe(V.derivations.B.account.accountKey);
    expect(b.owner).toBe(V.derivations.B.account.owner);
    expect(b.owner).not.toBe(V.derivations.A.account.owner);
    expect(hex(deriveNamespaceId(prfB, "preferences"))).not.toBe(V.derivations.A.nsId.preferences);
    expect(hex(deriveNamespaceKey(prfB, "preferences", 0))).not.toBe(V.derivations.A.nsKey.preferences["0"]);
  });

  it("#4 epoch rotation changes the key", () => {
    expect(hex(deriveNamespaceKey(prfA, "preferences", 0))).not.toBe(hex(deriveNamespaceKey(prfA, "preferences", 1)));
  });

  it("#5 namespaces are isolated", () => {
    expect(hex(deriveNamespaceKey(prfA, "work", 0))).not.toBe(hex(deriveNamespaceKey(prfA, "preferences", 0)));
    expect(hex(deriveNamespaceId(prfA, "work"))).not.toBe(hex(deriveNamespaceId(prfA, "preferences")));
  });

  it("#6 account key never equals any namespace key or id", () => {
    const acc = hex(deriveAccount(prfA).accountKey);
    for (const label of ["preferences", "work", "a", "z9-x"]) {
      expect(hex(deriveNamespaceId(prfA, label))).not.toBe(acc);
      for (const e of [0, 1, 2]) expect(hex(deriveNamespaceKey(prfA, label, e))).not.toBe(acc);
    }
  });
});

describe("entry envelopes (cases 7-12, 16)", () => {
  const pt = utf8(V.entry.plaintext);
  const base = { key: entryKey, ctx, nsId: entryNsId, epoch: 0 };

  it("#16 decrypts the Python-generated envelope", async () => {
    const out = await decryptEntry({ ...base, envelope: bytes(V.entry.envelope) });
    expect(new TextDecoder().decode(out)).toBe(V.entry.plaintext);
  });

  it("#16b encrypting with the vector nonce reproduces the Python envelope exactly", async () => {
    const env = await encryptEntry({ ...base, plaintext: pt, nonce: bytes(V.entry.nonce) });
    expect(hex(env)).toBe(V.entry.envelope);
  });

  it("#7 round trip", async () => {
    const env = await encryptEntry({ ...base, plaintext: pt });
    expect(hex(await decryptEntry({ ...base, envelope: env }))).toBe(hex(pt));
  });

  it("#8 wrong epoch key fails", async () => {
    await expectCode(
      decryptEntry({ ...base, key: deriveNamespaceKey(prfA, "preferences", 1), envelope: bytes(V.entry.envelope) }),
      "DECRYPT_FAILED",
    );
  });

  it("#8b right key but wrong epoch in AAD fails", async () => {
    await expectCode(decryptEntry({ ...base, epoch: 1, envelope: bytes(V.entry.envelope) }), "DECRYPT_FAILED");
  });

  it("#9 different owner in context fails", async () => {
    await expectCode(
      decryptEntry({ ...base, ctx: { ...ctx, owner: V.derivations.B.account.owner }, envelope: bytes(V.entry.envelope) }),
      "DECRYPT_FAILED",
    );
  });

  it("#10 different chainId or registry fails", async () => {
    const env = bytes(V.entry.envelope);
    await expectCode(decryptEntry({ ...base, ctx: { ...ctx, chainId: 143n }, envelope: env }), "DECRYPT_FAILED");
    await expectCode(
      decryptEntry({ ...base, ctx: { ...ctx, registry: "0x2222222222222222222222222222222222222222" }, envelope: env }),
      "DECRYPT_FAILED",
    );
  });

  it("#9b different nsId fails", async () => {
    await expectCode(
      decryptEntry({ ...base, nsId: deriveNamespaceId(prfA, "work"), envelope: bytes(V.entry.envelope) }),
      "DECRYPT_FAILED",
    );
  });

  it("#11 any single bit flip fails", async () => {
    const env = bytes(V.entry.envelope);
    for (let i = 1; i < env.length; i++) {
      const t = new Uint8Array(env);
      t[i]! ^= 0x01;
      await expectCode(decryptEntry({ ...base, envelope: t }), "DECRYPT_FAILED");
    }
  });

  it("#12 fresh nonce: same plaintext encrypts differently", async () => {
    const a = await encryptEntry({ ...base, plaintext: pt });
    const b = await encryptEntry({ ...base, plaintext: pt });
    expect(hex(a)).not.toBe(hex(b));
  });
});

describe("key wraps (cases 13-15)", () => {
  const w = V.wrap;
  const base = { ctx, nsId: entryNsId, epoch: 0, agentId: 7n };

  it("#13a unwraps the Python-generated envelope", async () => {
    const r = await unwrapNamespaceKey({ ...base, envelope: bytes(w.envelope), agentX25519Private: bytes(w.agentX25519Private) });
    expect(hex(r.nsKey)).toBe(V.entry.nsKey);
    expect(r.label).toBe("preferences");
  });

  it("#13b wrapping with vector ephemeral key and nonce reproduces the Python envelope", async () => {
    const env = await wrapNamespaceKey({
      ...base,
      nsKey: entryKey,
      label: "preferences",
      agentX25519Public: bytes(w.agentX25519Public),
      ephemeralPrivate: bytes(w.ephemeralPrivate),
      nonce: bytes(w.nonce),
    });
    expect(hex(env)).toBe(w.envelope);
    expect(env.length).toBe(93 + "preferences".length);
  });

  it("#13c round trip with a generated agent key pair", async () => {
    const agent = generateAgentKeyPair();
    const env = await wrapNamespaceKey({ ...base, nsKey: entryKey, label: "work", agentX25519Public: agent.publicKey });
    const r = await unwrapNamespaceKey({ ...base, envelope: env, agentX25519Private: agent.privateKey });
    expect(hex(r.nsKey)).toBe(hex(entryKey));
    expect(r.label).toBe("work");
  });

  it("#14 another agent's key cannot unwrap", async () => {
    const other = generateAgentKeyPair();
    await expectCode(
      unwrapNamespaceKey({ ...base, envelope: bytes(w.envelope), agentX25519Private: other.privateKey }),
      "DECRYPT_FAILED",
    );
  });

  it("#15 wrap for agentId 7 cannot be opened claiming agentId 8", async () => {
    await expectCode(
      unwrapNamespaceKey({ ...base, agentId: 8n, envelope: bytes(w.envelope), agentX25519Private: bytes(w.agentX25519Private) }),
      "DECRYPT_FAILED",
    );
  });

  it("#15b wrap bound to epoch and owner", async () => {
    const env = bytes(w.envelope);
    const priv = bytes(w.agentX25519Private);
    await expectCode(unwrapNamespaceKey({ ...base, epoch: 1, envelope: env, agentX25519Private: priv }), "DECRYPT_FAILED");
    await expectCode(
      unwrapNamespaceKey({ ...base, ctx: { ...ctx, owner: V.derivations.B.account.owner }, envelope: env, agentX25519Private: priv }),
      "DECRYPT_FAILED",
    );
  });
});

describe("edge cases", () => {
  it("prf output must be exactly 32 bytes", async () => {
    for (const n of [0, 31, 33, 64]) {
      await expectCode(() => deriveAccount(new Uint8Array(n)), "INPUT_INVALID");
      await expectCode(() => deriveNamespaceId(new Uint8Array(n), "preferences"), "INPUT_INVALID");
      await expectCode(() => deriveNamespaceKey(new Uint8Array(n), "preferences", 0), "INPUT_INVALID");
    }
  });

  it("labels are validated, never normalized", async () => {
    for (const bad of ["Preferences", "prefs ", " prefs", "", "-prefs", "a".repeat(33), "prеfs", "pre_fs", "préfs"]) {
      await expectCode(() => deriveNamespaceId(prfA, bad), "INPUT_INVALID");
      await expectCode(() => deriveNamespaceKey(prfA, bad, 0), "INPUT_INVALID");
    }
    expect(() => deriveNamespaceId(prfA, "a".repeat(32))).not.toThrow();
    expect(() => deriveNamespaceId(prfA, "0-9")).not.toThrow();
  });

  it("epoch range is 0..2^64-1 integers", async () => {
    for (const bad of [-1, 1.5, Number.NaN, 2n ** 64n, -1n]) {
      await expectCode(() => deriveNamespaceKey(prfA, "preferences", bad as number), "INPUT_INVALID");
    }
    expect(() => deriveNamespaceKey(prfA, "preferences", 2n ** 64n - 1n)).not.toThrow();
  });

  it("epoch as number and bigint derive the same key", () => {
    expect(hex(deriveNamespaceKey(prfA, "preferences", 1))).toBe(hex(deriveNamespaceKey(prfA, "preferences", 1n)));
  });

  it("invalid first HKDF candidate retries with the next counter", () => {
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const toBytes = (x: bigint) => bytes(x.toString(16).padStart(64, "0"));
    const good = bytes(V.derivations.A.account.accountKey);
    const seq = [new Uint8Array(32), toBytes(n), toBytes(n + 1n), good];
    const acc = deriveAccountWith((counter) => seq[counter]!);
    expect(acc.counter).toBe(3);
    expect(hex(acc.accountKey)).toBe(hex(good));
    expect(acc.owner).toBe(V.derivations.A.account.owner);
  });

  it("plaintext must be 1..2048 bytes", async () => {
    const base = { key: entryKey, ctx, nsId: entryNsId, epoch: 0 };
    await expectCode(encryptEntry({ ...base, plaintext: new Uint8Array(0) }), "INPUT_INVALID");
    await expectCode(encryptEntry({ ...base, plaintext: new Uint8Array(2049) }), "INPUT_INVALID");
    const max = await encryptEntry({ ...base, plaintext: new Uint8Array(2048) });
    expect(max.length).toBe(1 + 12 + 2048 + 16);
  });

  it("short or unknown-version envelopes are ENVELOPE_INVALID, not crashes", async () => {
    const base = { key: entryKey, ctx, nsId: entryNsId, epoch: 0 };
    await expectCode(decryptEntry({ ...base, envelope: new Uint8Array(29) }), "ENVELOPE_INVALID");
    const v2 = bytes(V.entry.envelope);
    v2[0] = 0x02;
    await expectCode(decryptEntry({ ...base, envelope: v2 }), "ENVELOPE_INVALID");
    const wb = { ctx, nsId: entryNsId, epoch: 0, agentId: 7n, agentX25519Private: bytes(V.wrap.agentX25519Private) };
    await expectCode(unwrapNamespaceKey({ ...wb, envelope: new Uint8Array(93) }), "ENVELOPE_INVALID");
    const w2 = bytes(V.wrap.envelope);
    w2[0] = 0x00;
    await expectCode(unwrapNamespaceKey({ ...wb, envelope: w2 }), "ENVELOPE_INVALID");
  });

  it("all-zero / low-order agent public key is rejected", async () => {
    const base = { ctx, nsId: entryNsId, epoch: 0, agentId: 7n, nsKey: entryKey, label: "preferences" };
    await expectCode(wrapNamespaceKey({ ...base, agentX25519Public: new Uint8Array(32) }), "INPUT_INVALID");
    const one = new Uint8Array(32);
    one[0] = 1; // u = 1 is a low-order point
    await expectCode(wrapNamespaceKey({ ...base, agentX25519Public: one }), "INPUT_INVALID");
  });

  it("nsKey must be 32 bytes, nsId 32 bytes, agentId non-negative < 2^256", async () => {
    const base = { ctx, nsId: entryNsId, epoch: 0, plaintext: utf8("x") };
    await expectCode(encryptEntry({ ...base, key: new Uint8Array(16) }), "INPUT_INVALID");
    await expectCode(encryptEntry({ ...base, key: entryKey, nsId: new Uint8Array(31) }), "INPUT_INVALID");
    const agent = generateAgentKeyPair();
    const wb = { ctx, nsId: entryNsId, epoch: 0, nsKey: entryKey, label: "preferences", agentX25519Public: agent.publicKey };
    await expectCode(wrapNamespaceKey({ ...wb, agentId: -1n }), "INPUT_INVALID");
    await expectCode(wrapNamespaceKey({ ...wb, agentId: 2n ** 256n }), "INPUT_INVALID");
  });

  it("context addresses must be 20-byte hex, chainId non-negative", async () => {
    const base = { key: entryKey, nsId: entryNsId, epoch: 0, plaintext: utf8("x") };
    await expectCode(encryptEntry({ ...base, ctx: { ...ctx, owner: "0x1234" as `0x${string}` } }), "INPUT_INVALID");
    await expectCode(encryptEntry({ ...base, ctx: { ...ctx, registry: "0xzz11111111111111111111111111111111111111" as `0x${string}` } }), "INPUT_INVALID");
    await expectCode(encryptEntry({ ...base, ctx: { ...ctx, chainId: -1n } }), "INPUT_INVALID");
  });

  it("owner address comparison is case-insensitive (checksummed vs lowercase give same AAD)", async () => {
    const out = await decryptEntry({
      key: entryKey,
      ctx: { ...ctx, owner: V.context.owner.toLowerCase() },
      nsId: entryNsId,
      epoch: 0,
      envelope: bytes(V.entry.envelope),
    });
    expect(new TextDecoder().decode(out)).toBe(V.entry.plaintext);
  });
});

describe("entry JSON validation", () => {
  it("accepts a valid entry and round-trips it", () => {
    const e = parseEntry(utf8(V.entry.plaintext));
    expect(e).toEqual({ v: 1, t: 1790000000000, kind: "preference", text: "vegetarian, allergic to peanuts" });
    expect(parseEntry(encodeEntry(e))).toEqual(e);
  });

  it("rejects malformed entries with ENTRY_INVALID", async () => {
    const bad = [
      "not json",
      "[]",
      "null",
      '{"v":2,"t":1,"kind":"fact","text":"x"}',
      '{"v":1,"t":1.5,"kind":"fact","text":"x"}',
      '{"v":1,"t":-1,"kind":"fact","text":"x"}',
      '{"v":1,"t":1,"kind":"secret","text":"x"}',
      '{"v":1,"t":1,"kind":"fact","text":""}',
      `{"v":1,"t":1,"kind":"fact","text":"${"x".repeat(1501)}"}`,
      '{"v":1,"t":1,"kind":"fact"}',
      '{"v":1,"t":1,"kind":"fact","text":"x","extra":true}',
      '{"v":1,"t":1,"kind":"fact","text":5}',
    ];
    for (const s of bad) await expectCode(() => parseEntry(utf8(s)), "ENTRY_INVALID");
    await expectCode(() => parseEntry(new Uint8Array([0xff, 0xfe])), "ENTRY_INVALID");
  });

  it("encodeEntry refuses entries that would exceed 2048 bytes", async () => {
    // 700 code points of a 4-byte UTF-8 char = 2800 bytes: under 1500 code points, over 2048 bytes
    await expectCode(() => encodeEntry({ v: 1, t: 1, kind: "note", text: "\u{20000}".repeat(700) }), "INPUT_INVALID");
  });
});
