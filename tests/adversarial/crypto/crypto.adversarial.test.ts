// Adversarial probes for contracts/crypto.md. Each test PASSES when the implementation behaves per spec
// and FAILS when a bug is found. Tests prefixed "gap:" record behavior the spec leaves undefined
// (they assert what the implementation currently decides, so they pass; see the review report).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
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

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));
const utf8 = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const prf = new Uint8Array(32).fill(0x01);
const ctx: BindingContext = { chainId: 10143n, registry: `0x${"11".repeat(20)}`, owner: `0x${"22".repeat(20)}` };
const nsId = deriveNamespaceId(prf, "preferences");
const key = deriveNamespaceKey(prf, "preferences", 0);
const P = 2n ** 255n - 19n;

function le32(u: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = u;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

async function code(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof EngramCryptoError) return e.code;
    return `NON_ENGRAM_ERROR:${(e as Error)?.constructor?.name}:${(e as Error)?.message}`;
  }
  return "OK";
}

async function goodWrap(agentPub: Uint8Array, agentId: bigint | number = 7) {
  return wrapNamespaceKey({ ctx, nsId, epoch: 0, agentId, nsKey: key, label: "preferences", agentX25519Public: agentPub });
}

// ------------------------------------------------------------------ envelope boundaries

describe("entry envelope length boundaries", () => {
  const withLen = (n: number) => {
    const e = new Uint8Array(n);
    e[0] = 0x01;
    return e;
  };
  it("29 bytes -> ENVELOPE_INVALID", async () => {
    expect(await code(() => decryptEntry({ key, ctx, nsId, epoch: 0, envelope: withLen(29) }))).toBe("ENVELOPE_INVALID");
  });
  it("30 bytes -> DECRYPT_FAILED (parsed, then authentication fails)", async () => {
    expect(await code(() => decryptEntry({ key, ctx, nsId, epoch: 0, envelope: withLen(30) }))).toBe("DECRYPT_FAILED");
  });
  it("2077 bytes -> DECRYPT_FAILED", async () => {
    expect(await code(() => decryptEntry({ key, ctx, nsId, epoch: 0, envelope: withLen(2077) }))).toBe("DECRYPT_FAILED");
  });
  it("2078 bytes -> ENVELOPE_INVALID", async () => {
    expect(await code(() => decryptEntry({ key, ctx, nsId, epoch: 0, envelope: withLen(2078) }))).toBe("ENVELOPE_INVALID");
  });
  it("2048-byte plaintext encrypts to exactly 2077 bytes and round trips", async () => {
    const pt = new Uint8Array(2048).fill(0x41);
    const env = await encryptEntry({ key, ctx, nsId, epoch: 0, plaintext: pt });
    expect(env.length).toBe(2077);
    expect(hex(await decryptEntry({ key, ctx, nsId, epoch: 0, envelope: env }))).toBe(hex(pt));
  });
  it("version bytes 0x00, 0x02, 0xff -> ENVELOPE_INVALID", async () => {
    const env = await encryptEntry({ key, ctx, nsId, epoch: 0, plaintext: utf8("x") });
    for (const v of [0x00, 0x02, 0xff]) {
      const e = env.slice();
      e[0] = v;
      expect(await code(() => decryptEntry({ key, ctx, nsId, epoch: 0, envelope: e }))).toBe("ENVELOPE_INVALID");
    }
  });
});

describe("wrap envelope length boundaries", () => {
  const { privateKey } = generateAgentKeyPair();
  const withLen = (n: number) => {
    const e = new Uint8Array(n);
    e[0] = 0x01;
    e[1] = 9; // a valid, non-low-order u coordinate so we reach AES-GCM
    return e;
  };
  const unwrap = (envelope: Uint8Array) =>
    unwrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, envelope, agentX25519Private: privateKey });
  it("93 bytes -> ENVELOPE_INVALID", async () => expect(await code(() => unwrap(withLen(93)))).toBe("ENVELOPE_INVALID"));
  it("94 bytes -> DECRYPT_FAILED", async () => expect(await code(() => unwrap(withLen(94)))).toBe("DECRYPT_FAILED"));
  it("125 bytes -> DECRYPT_FAILED", async () => expect(await code(() => unwrap(withLen(125)))).toBe("DECRYPT_FAILED"));
  it("126 bytes -> ENVELOPE_INVALID", async () => expect(await code(() => unwrap(withLen(126)))).toBe("ENVELOPE_INVALID"));
  it("low-order ephemeral key inside the envelope -> an EngramCryptoError, not a crash", async () => {
    const e = new Uint8Array(94);
    e[0] = 0x01; // ephPub = all zero
    expect(await code(() => unwrap(e))).toBe("DECRYPT_FAILED");
  });
  it("wrap with a 32-char label is exactly 125 bytes", async () => {
    const { publicKey } = generateAgentKeyPair();
    const label = "a".repeat(32);
    const w = await wrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, nsKey: key, label, agentX25519Public: publicKey });
    expect(w.length).toBe(125);
  });
});

describe("non-Uint8Array inputs are rejected with stable codes, never crash", () => {
  const good = new Uint8Array(40);
  good[0] = 1;
  for (const [name, env] of [
    ["ArrayBuffer", good.buffer],
    ["number[]", Array.from(good)],
    ["string", "01".repeat(40)],
    ["null", null],
    ["DataView", new DataView(good.buffer)],
  ] as const) {
    it(`decryptEntry envelope as ${name} -> ENVELOPE_INVALID`, async () => {
      expect(await code(() => decryptEntry({ key, ctx, nsId, epoch: 0, envelope: env as never }))).toBe("ENVELOPE_INVALID");
    });
    it(`unwrap envelope as ${name} -> ENVELOPE_INVALID`, async () => {
      const { privateKey } = generateAgentKeyPair();
      expect(
        await code(() => unwrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, envelope: env as never, agentX25519Private: privateKey })),
      ).toBe("ENVELOPE_INVALID");
    });
  }
  it("prfOutput as ArrayBuffer / number[] / string / 32-char string -> INPUT_INVALID", async () => {
    for (const p of [new ArrayBuffer(32), Array(32).fill(1), "x".repeat(32), null, undefined]) {
      expect(await code(() => deriveAccount(p as never))).toBe("INPUT_INVALID");
      expect(await code(() => deriveNamespaceKey(p as never, "a", 0))).toBe("INPUT_INVALID");
    }
  });
  it("ctx null / missing / wrong types -> INPUT_INVALID (not TypeError)", async () => {
    const bad: unknown[] = [null, undefined, 5, "ctx", {}, { chainId: 1n }, { chainId: 1n, registry: ctx.registry }, [1, 2, 3]];
    for (const c of bad) {
      expect(await code(() => encryptEntry({ key, ctx: c as never, nsId, epoch: 0, plaintext: utf8("x") }))).toBe("INPUT_INVALID");
    }
  });
});

describe("views with non-zero byteOffset are read correctly (no slice/subarray leaks)", () => {
  it("envelope, key, nsId as subarray views of a larger buffer round trip", async () => {
    const env = await encryptEntry({ key, ctx, nsId, epoch: 0, plaintext: utf8("hello") });
    const big = new Uint8Array(env.length + 100).fill(0xee);
    big.set(env, 50);
    const kbig = new Uint8Array(96).fill(0xdd);
    kbig.set(key, 17);
    const nbig = new Uint8Array(96).fill(0xcc);
    nbig.set(nsId, 33);
    const out = await decryptEntry({
      key: kbig.subarray(17, 49),
      ctx,
      nsId: nbig.subarray(33, 65),
      epoch: 0,
      envelope: big.subarray(50, 50 + env.length),
    });
    expect(new TextDecoder().decode(out)).toBe("hello");
  });
  it("plaintext as a subarray view encrypts only the view", async () => {
    const big = utf8("XXXXhelloYYYY");
    const env = await encryptEntry({ key, ctx, nsId, epoch: 0, plaintext: big.subarray(4, 9) });
    expect(new TextDecoder().decode(await decryptEntry({ key, ctx, nsId, epoch: 0, envelope: env }))).toBe("hello");
  });
  it("Node Buffer (pooled, non-zero byteOffset) inputs work", async () => {
    const kb = Buffer.from(hex(key), "hex");
    const nb = Buffer.from(hex(nsId), "hex");
    const env = await encryptEntry({ key: kb, ctx, nsId: nb, epoch: 0, plaintext: Buffer.from("hi") });
    const out = await decryptEntry({ key, ctx, nsId, epoch: 0, envelope: Buffer.from(env) });
    expect(Buffer.from(out).toString()).toBe("hi");
  });
  it("wrap/unwrap with subarray views of agent keys and envelope", async () => {
    const { privateKey, publicKey } = generateAgentKeyPair();
    const pb = new Uint8Array(64).fill(0xaa);
    pb.set(publicKey, 7);
    const w = await goodWrap(pb.subarray(7, 39));
    const wb = new Uint8Array(w.length + 11).fill(0x55);
    wb.set(w, 5);
    const sb = new Uint8Array(64).fill(0x99);
    sb.set(privateKey, 13);
    const r = await unwrapNamespaceKey({
      ctx, nsId, epoch: 0, agentId: 7, envelope: wb.subarray(5, 5 + w.length), agentX25519Private: sb.subarray(13, 45),
    });
    expect(hex(r.nsKey)).toBe(hex(key));
  });
});

// ------------------------------------------------------------------ caller buffer mutation

describe("no function mutates caller-owned buffers", () => {
  it("encryptEntry leaves key, nsId, plaintext, nonce untouched", async () => {
    const k = key.slice(), n = nsId.slice(), pt = utf8("abc"), nonce = new Uint8Array(12).fill(3);
    const snap = [hex(k), hex(n), hex(pt), hex(nonce)];
    await encryptEntry({ key: k, ctx, nsId: n, epoch: 0, plaintext: pt, nonce });
    expect([hex(k), hex(n), hex(pt), hex(nonce)]).toEqual(snap);
  });
  it("wrapNamespaceKey leaves nsKey, agentPub, ephemeralPrivate, nonce untouched", async () => {
    const { publicKey } = generateAgentKeyPair();
    const eph = new Uint8Array(32).fill(0x0e), nonce = new Uint8Array(12).fill(0x0b), k = key.slice(), pub = publicKey.slice();
    const snap = [hex(k), hex(pub), hex(eph), hex(nonce)];
    await wrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, nsKey: k, label: "preferences", agentX25519Public: pub, ephemeralPrivate: eph, nonce });
    expect([hex(k), hex(pub), hex(eph), hex(nonce)]).toEqual(snap);
  });
  it("wrapNamespaceKey with a high-bit agent pub does not clear the caller's bit", async () => {
    const { publicKey } = generateAgentKeyPair();
    const pub = publicKey.slice();
    pub[31] |= 0x80;
    const before = hex(pub);
    await code(() => goodWrap(pub));
    expect(hex(pub)).toBe(before);
  });
  it("unwrapNamespaceKey leaves envelope and private key untouched", async () => {
    const { privateKey, publicKey } = generateAgentKeyPair();
    const w = await goodWrap(publicKey);
    const snap = [hex(w), hex(privateKey)];
    await unwrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, envelope: w, agentX25519Private: privateKey });
    expect([hex(w), hex(privateKey)]).toEqual(snap);
  });
  it("decryptEntry leaves envelope and key untouched", async () => {
    const env = await encryptEntry({ key, ctx, nsId, epoch: 0, plaintext: utf8("x") });
    const k = key.slice();
    const snap = [hex(env), hex(k)];
    await decryptEntry({ key: k, ctx, nsId, epoch: 0, envelope: env });
    expect([hex(env), hex(k)]).toEqual(snap);
  });
  it("unwrapped nsKey is an independent copy (does not alias library-zeroed memory)", async () => {
    const { privateKey, publicKey } = generateAgentKeyPair();
    const w = await goodWrap(publicKey);
    const r1 = await unwrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, envelope: w, agentX25519Private: privateKey });
    await unwrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, envelope: w, agentX25519Private: privateKey });
    expect(hex(r1.nsKey)).toBe(hex(key));
  });
  it("spec (review): deriveAccountWith returns a copy, not the candidate buffer (was gap)", () => {
    const cand = new Uint8Array(32).fill(0x05);
    const acc = deriveAccountWith(() => cand);
    expect(acc.accountKey).not.toBe(cand);
    cand.fill(0);
    expect(acc.accountKey.every((b) => b === 0x05)).toBe(true);
  });
});

// ------------------------------------------------------------------ X25519

describe("X25519 public key validation", () => {
  const lowOrder = [
    0n,
    1n,
    P - 1n,
    325606250916557431795983626356110631294008115727848805560023387167927233504n,
    39382357235489614581723060781553021112529911719440698176882885853963445705823n,
  ];
  it("every small-order u (5 canonical) -> INPUT_INVALID", async () => {
    for (const u of lowOrder) expect(await code(() => goodWrap(le32(u)))).toBe("INPUT_INVALID");
  });
  it("non-canonical encodings of small-order u (u+p, and top bit set) -> INPUT_INVALID", async () => {
    const encs: Uint8Array[] = [le32(P), le32(P + 1n)];
    for (const u of lowOrder) {
      const b = le32(u);
      b[31] |= 0x80;
      encs.push(b);
    }
    for (const e of encs) expect(await code(() => goodWrap(e))).toBe("INPUT_INVALID");
  });
  it("case 13 with a non-canonical (top-bit-set) encoding of the agent's own public key: either rejected or unwrappable", async () => {
    // RFC 7748: the top bit is masked, so this is the SAME public key as far as X25519 is concerned.
    const { privateKey, publicKey } = generateAgentKeyPair();
    const nc = publicKey.slice();
    nc[31] |= 0x80;
    let w: Uint8Array;
    try {
      w = await goodWrap(nc);
    } catch (e) {
      expect((e as EngramCryptoError).code).toBe("INPUT_INVALID");
      return; // rejecting non-canonical keys is spec-compatible
    }
    const r = await unwrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, envelope: w, agentX25519Private: privateKey });
    expect(hex(r.nsKey)).toBe(hex(key));
  });
  it("case 13 with a u+p non-canonical encoding (u in 2..18): either rejected or unwrappable", async () => {
    // Construct an agent whose public u is small is infeasible; instead show the wrap accepts u+p for u=9 (base point).
    const enc = le32(P + 9n);
    const res = await code(() => goodWrap(enc));
    // A wrap to u+p is not decryptable by anyone whose canonical pub is 9 (salt uses raw bytes). Spec-compatible only if rejected.
    expect(res).toBe("INPUT_INVALID");
  });
});

// ------------------------------------------------------------------ labels, epochs, ids

describe("label validation (no normalization)", () => {
  const bad: unknown[] = [
    "Preferences", "prefs ", " prefs", "", "a".repeat(33), "prefs\n", "prefs\r\n", "\nprefs", "-prefs", "pre_fs", "pre.fs",
    "prefs\u0000", "\u0430bc", "\u2170", "\uff41", "pr\u00e9fs", "e\u0301", 1, null, undefined, ["a"], new String("abc"),
  ];
  it("rejects every malformed label with INPUT_INVALID", async () => {
    for (const l of bad) {
      expect(await code(() => deriveNamespaceId(prf, l as never)), JSON.stringify(String(l))).toBe("INPUT_INVALID");
      expect(await code(() => deriveNamespaceKey(prf, l as never, 0))).toBe("INPUT_INVALID");
    }
  });
  it("accepts 1-char, 32-char, trailing hyphen, all-digit labels", () => {
    for (const l of ["a", "0", "a".repeat(32), "a-", "0123", "a--b"]) expect(() => deriveNamespaceId(prf, l)).not.toThrow();
  });
  it("wrap rejects a bad label", async () => {
    const { publicKey } = generateAgentKeyPair();
    expect(
      await code(() => wrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, nsKey: key, label: "Bad", agentX25519Public: publicKey })),
    ).toBe("INPUT_INVALID");
  });
});

describe("epoch / agentId / chainId validation and number-vs-bigint equality", () => {
  it("epoch: negative, fractional, NaN, Infinity, string, 2^64, -1n, null -> INPUT_INVALID", async () => {
    for (const e of [-1, 1.5, NaN, Infinity, -Infinity, "0", "1", 2n ** 64n, -1n, null, undefined, {}, true]) {
      expect(await code(() => deriveNamespaceKey(prf, "a", e as never)), String(e)).toBe("INPUT_INVALID");
    }
  });
  it("epoch 2^64-1 (bigint) accepted and in AAD", async () => {
    const e = 2n ** 64n - 1n;
    const k = deriveNamespaceKey(prf, "a", e);
    const env = await encryptEntry({ key: k, ctx, nsId, epoch: e, plaintext: utf8("x") });
    expect(await code(() => decryptEntry({ key: k, ctx, nsId, epoch: e - 1n, envelope: env }))).toBe("DECRYPT_FAILED");
  });
  it("-0 epoch is the same as 0", () => {
    expect(hex(deriveNamespaceKey(prf, "a", -0))).toBe(hex(deriveNamespaceKey(prf, "a", 0)));
  });
  it("epoch as number and bigint produce the same entry AAD (cross-decrypt)", async () => {
    const env = await encryptEntry({ key, ctx, nsId, epoch: 5, plaintext: utf8("x") });
    expect(await code(() => decryptEntry({ key, ctx, nsId, epoch: 5n, envelope: env }))).toBe("OK");
  });
  it("agentId as number and bigint produce the same wrap AAD", async () => {
    const { privateKey, publicKey } = generateAgentKeyPair();
    const w = await goodWrap(publicKey, 7);
    expect(await code(() => unwrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7n, envelope: w, agentX25519Private: privateKey }))).toBe("OK");
  });
  it("chainId as number and bigint produce the same AAD", async () => {
    const env = await encryptEntry({ key, ctx: { ...ctx, chainId: 10143 }, nsId, epoch: 0, plaintext: utf8("x") });
    expect(await code(() => decryptEntry({ key, ctx: { ...ctx, chainId: 10143n }, nsId, epoch: 0, envelope: env }))).toBe("OK");
  });
  it("agentId / chainId: negative, fractional, unsafe number, 2^256, string -> INPUT_INVALID", async () => {
    const { publicKey } = generateAgentKeyPair();
    for (const v of [-1, 1.5, NaN, 2 ** 53, 1e21, 2n ** 256n, -1n, "7", null]) {
      expect(await code(() => goodWrap(publicKey, v as never)), String(v)).toBe("INPUT_INVALID");
      expect(await code(() => encryptEntry({ key, ctx: { ...ctx, chainId: v as never }, nsId, epoch: 0, plaintext: utf8("x") }))).toBe("INPUT_INVALID");
    }
  });
  it("gap: number epochs above 2^53-1 are rejected even when exactly representable (2^60)", async () => {
    expect(await code(() => deriveNamespaceKey(prf, "a", 2 ** 60))).toBe("INPUT_INVALID");
    expect(await code(() => deriveNamespaceKey(prf, "a", 2n ** 60n))).toBe("OK");
  });
});

describe("address handling", () => {
  it("rejects 0X prefix, no prefix, 39/41 hex chars, non-hex, whitespace, newline", async () => {
    const good = "22".repeat(20);
    for (const a of [`0X${good}`, good, `0x${good.slice(1)}`, `0x${good}2`, `0x${good.slice(2)}zz`, ` 0x${good}`, `0x${good} `, `0x${good}\n`, `0x${"g".repeat(40)}`, 123, null]) {
      expect(await code(() => encryptEntry({ key, ctx: { ...ctx, owner: a as never }, nsId, epoch: 0, plaintext: utf8("x") })), String(a)).toBe("INPUT_INVALID");
    }
  });
  it("invalid-checksum mixed case is accepted and equal to lowercase (spec: any case)", async () => {
    const lower = { ...ctx, owner: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const };
    const mixed = { ...ctx, owner: "0xABcdefabcdefabcdefabcdefabcdefabcdefabCD" as const };
    const env = await encryptEntry({ key, ctx: lower, nsId, epoch: 0, plaintext: utf8("x") });
    expect(await code(() => decryptEntry({ key, ctx: mixed, nsId, epoch: 0, envelope: env }))).toBe("OK");
  });
});

// ------------------------------------------------------------------ plaintext bounds

describe("plaintext bounds", () => {
  it("0 and 2049 bytes -> INPUT_INVALID; non-Uint8Array plaintext -> INPUT_INVALID", async () => {
    for (const pt of [new Uint8Array(0), new Uint8Array(2049), "hello", [1, 2], new ArrayBuffer(4), null]) {
      expect(await code(() => encryptEntry({ key, ctx, nsId, epoch: 0, plaintext: pt as never }))).toBe("INPUT_INVALID");
    }
  });
  it("nonce of 11 / 13 bytes -> INPUT_INVALID", async () => {
    for (const n of [new Uint8Array(11), new Uint8Array(13)]) {
      expect(await code(() => encryptEntry({ key, ctx, nsId, epoch: 0, plaintext: utf8("x"), nonce: n }))).toBe("INPUT_INVALID");
    }
  });
});

// ------------------------------------------------------------------ account derivation

describe("account derivation", () => {
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  it("retries past 0, n, n+1, 2^256-1 candidates", () => {
    const bad = [le32(0n), bytes(n.toString(16)), bytes((n + 1n).toString(16)), new Uint8Array(32).fill(0xff)];
    const acc = deriveAccountWith((c) => (c < bad.length ? bad[c] : new Uint8Array(32).fill(0x07)));
    expect(acc.counter).toBe(4);
  });
  it("accepts n-1 (the largest valid scalar)", () => {
    const acc = deriveAccountWith(() => bytes((n - 1n).toString(16)));
    expect(acc.counter).toBe(0);
  });
  it("exhausting every candidate throws an EngramCryptoError (package rule: every failure has a stable code)", async () => {
    const c = await code(() => deriveAccountWith(() => new Uint8Array(32)));
    expect(c).not.toMatch(/^NON_ENGRAM_ERROR/);
  });
  it("candidate of wrong length -> INPUT_INVALID", async () => {
    expect(await code(() => deriveAccountWith(() => new Uint8Array(31)))).toBe("INPUT_INVALID");
  });
});

// ------------------------------------------------------------------ entry JSON

describe("parseEntry strictness", () => {
  const ok = (o: object) => utf8(JSON.stringify(o));
  it("rejects __proto__, constructor, extra keys, missing keys", async () => {
    for (const s of [
      '{"v":1,"t":0,"kind":"fact","text":"a","__proto__":{}}',
      '{"v":1,"t":0,"kind":"fact","text":"a","constructor":1}',
      '{"v":1,"t":0,"kind":"fact"}',
      '{"v":1,"t":0,"kind":"fact","text":"a","extra":null}',
      '{"v":1,"t":0,"kind":"fact","__proto__":"x"}',
    ]) {
      expect(await code(() => parseEntry(utf8(s))), s).toBe("ENTRY_INVALID");
    }
  });
  it("rejects wrong types / values", async () => {
    for (const s of [
      "null", "[]", "1", '"s"', "true", "",
      '{"v":2,"t":0,"kind":"fact","text":"a"}', '{"v":"1","t":0,"kind":"fact","text":"a"}',
      '{"v":1,"t":-1,"kind":"fact","text":"a"}', '{"v":1,"t":1.5,"kind":"fact","text":"a"}',
      '{"v":1,"t":"0","kind":"fact","text":"a"}', '{"v":1,"t":1e400,"kind":"fact","text":"a"}',
      '{"v":1,"t":0,"kind":"Fact","text":"a"}', '{"v":1,"t":0,"kind":"fact","text":""}',
      '{"v":1,"t":0,"kind":"fact","text":1}', '{"v":1,"t":NaN,"kind":"fact","text":"a"}',
    ]) {
      expect(await code(() => parseEntry(utf8(s))), s).toBe("ENTRY_INVALID");
    }
  });
  it("invalid UTF-8 and non-Uint8Array input -> ENTRY_INVALID", async () => {
    expect(await code(() => parseEntry(new Uint8Array([0x7b, 0xff, 0x7d])))).toBe("ENTRY_INVALID");
    expect(await code(() => parseEntry(Uint8Array.of(0xed, 0xa0, 0x80)))).toBe("ENTRY_INVALID"); // UTF-8-encoded surrogate
    expect(await code(() => parseEntry("{}" as never))).toBe("ENTRY_INVALID");
    expect(await code(() => parseEntry(null as never))).toBe("ENTRY_INVALID");
  });
  it("text of exactly 1500 astral code points is accepted by count (not UTF-16 length)", () => {
    const text = "\u{1F600}".repeat(500);
    expect(() => parseEntry(ok({ v: 1, t: 0, kind: "note", text }))).not.toThrow();
    expect(parseEntry(ok({ v: 1, t: 0, kind: "note", text: "a".repeat(1500) })).text.length).toBe(1500);
    expect(() => parseEntry(ok({ v: 1, t: 0, kind: "note", text: "a".repeat(1501) }))).toThrow();
  });
  it("spec: the encoded document must fit in 2048 bytes -- parseEntry rejects a >2048-byte document", async () => {
    // 1500 code points (valid count) of 4-byte characters = 6000+ bytes of JSON.
    const big = ok({ v: 1, t: 0, kind: "note", text: "\u{1F600}".repeat(1500) });
    expect(big.length).toBeGreaterThan(2048);
    expect(await code(() => encodeEntry({ v: 1, t: 0, kind: "note", text: "\u{1F600}".repeat(1500) }))).toBe("INPUT_INVALID");
    expect(await code(() => parseEntry(big))).toBe("ENTRY_INVALID");
  });
  it("spec: a >2048-byte document made of whitespace padding is rejected by parseEntry", async () => {
    const doc = utf8('{"v":1,"t":0,"kind":"fact","text":"a"}' + " ".repeat(2100));
    expect(await code(() => parseEntry(doc))).toBe("ENTRY_INVALID");
  });
  it("spec (review): duplicate JSON keys are rejected (was gap)", async () => {
    expect(await code(() => parseEntry(utf8('{"v":1,"t":0,"kind":"fact","text":"benign","text":"evil"}')))).toBe("ENTRY_INVALID");
  });
  it("spec (review): leading UTF-8 BOM is rejected (was gap)", async () => {
    expect(await code(() => parseEntry(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('{"v":1,"t":0,"kind":"fact","text":"a"}')])))).toBe("ENTRY_INVALID");
  });
  it("spec (review): lone surrogate via \\ud800 escape is rejected (was gap)", async () => {
    expect(await code(() => parseEntry(utf8('{"v":1,"t":0,"kind":"fact","text":"\\ud800"}')))).toBe("ENTRY_INVALID");
  });
  it("spec (review): t = -0, 1.0, 1e3 rejected as non-canonical; t = 2^53 rejected (was gap)", async () => {
    expect(await code(() => parseEntry(utf8('{"v":1,"t":-0,"kind":"fact","text":"a"}')))).toBe("ENTRY_INVALID");
    expect(await code(() => parseEntry(utf8('{"v":1.0,"t":1e3,"kind":"fact","text":"a"}')))).toBe("ENTRY_INVALID");
    expect(await code(() => parseEntry(utf8('{"v":1,"t":9007199254740992,"kind":"fact","text":"a"}')))).toBe("ENTRY_INVALID");
  });
  it("encodeEntry(x) always yields bytes parseEntry accepts (getter TOCTOU)", async () => {
    let reads = 0;
    const tricky = {
      v: 1 as const,
      t: 0,
      get kind() {
        return reads++ < 2 ? "fact" : "evil"; // validation reads kind twice, JSON.stringify reads it a third time
      },
      text: "a",
    };
    let encoded: Uint8Array | null = null;
    try {
      encoded = encodeEntry(tricky as never);
    } catch {
      return; // rejecting is fine
    }
    expect(await code(() => parseEntry(encoded!))).toBe("OK");
  });
  it("encodeEntry rejects non-objects and extra keys with INPUT_INVALID", async () => {
    for (const e of [null, undefined, 1, "x", [], { v: 1, t: 0, kind: "fact", text: "a", x: 1 }]) {
      expect(await code(() => encodeEntry(e as never))).toBe("INPUT_INVALID");
    }
  });
});

// ------------------------------------------------------------------ cross-implementation at max values

describe("cross-impl (Python, pyca/cryptography) at boundary values", () => {
  // Generated by a throwaway script mirroring generate_vectors.py: prf=32x0x33, label = "a" + 30 hyphens + "z",
  // epoch = 2^64-1, chainId = 2^256-1, agentId = 2^256-1, registry = 0xff..ff, owner = 0x00..01,
  // entry plaintext = 2048 x "x", entry nonce 12x0x0c, agent priv 32x0x07, eph priv 32x0x0e, wrap nonce 12x0x0b.
  const xprf = new Uint8Array(32).fill(0x33);
  const label = "a" + "-".repeat(30) + "z";
  const E = 2n ** 64n - 1n;
  const xctx: BindingContext = { chainId: 2n ** 256n - 1n, registry: `0x${"ff".repeat(20)}`, owner: `0x${"00".repeat(19)}01` };
  it("nsId and nsKey at epoch 2^64-1 with a 32-char label match Python", () => {
    expect(hex(deriveNamespaceId(xprf, label))).toBe("629b6c11b16ae4ef3a9ddcf6825cdd21039613c37e09e4e122f90997453e6443");
    expect(hex(deriveNamespaceKey(xprf, label, E))).toBe("4ae7dee90e13896702f8149162e8100302f1edcf26a772a926f69c34c42947f7");
  });
  it("2077-byte entry envelope at max chainId/epoch matches Python byte for byte", async () => {
    const env = await encryptEntry({
      key: deriveNamespaceKey(xprf, label, E), ctx: xctx, nsId: deriveNamespaceId(xprf, label), epoch: E,
      plaintext: utf8("x".repeat(2048)), nonce: new Uint8Array(12).fill(0x0c),
    });
    expect(env.length).toBe(2077);
    expect(sha(env)).toBe("a41d287b2a2aae61634f0544ac31e65fb39d3813d2b099f38097bb86861978ed");
  });
  it("125-byte wrap at max agentId/chainId/epoch matches Python and unwraps", async () => {
    const agentPriv = new Uint8Array(32).fill(0x07);
    const w = await wrapNamespaceKey({
      ctx: xctx, nsId: deriveNamespaceId(xprf, label), epoch: E, agentId: 2n ** 256n - 1n,
      nsKey: deriveNamespaceKey(xprf, label, E), label, agentX25519Public: bytes("13be4feaeaf204c7fd3358fc9c00721881d174278128227ec674f37f7fe97b6d"),
      ephemeralPrivate: new Uint8Array(32).fill(0x0e), nonce: new Uint8Array(12).fill(0x0b),
    });
    expect(hex(w)).toBe(
      "015855784cb3c8c796d84ac93e8f4a53dab0bb31e80960042cfa87f03a4293b3080b0b0b0b0b0b0b0b0b0b0b0b777e76f3c6c2eaa05d0ccd4d4549326fb664d65556c52cbf6317739a7a8f628b174e4a068a2cbd190aaf581848f93254ff7586c70c871c6970ccdc098fe824ce5a61350ead49bcfd293ba80a6d5cebe4",
    );
    const r = await unwrapNamespaceKey({ ctx: xctx, nsId: deriveNamespaceId(xprf, label), epoch: E, agentId: 2n ** 256n - 1n, envelope: w, agentX25519Private: agentPriv });
    expect(r.label).toBe(label);
  });
});
