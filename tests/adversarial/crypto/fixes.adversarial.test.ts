// Adversarial probes against the 2026-10-01 fixes (BUGLOG B1-B4; contracts/crypto.md "review 2026-10-01").
// Each test PASSES when behavior matches the spec and FAILS on a bug. "gap:" tests record behavior the
// spec leaves undefined and assert the current decision.
import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import {
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
  type Entry,
} from "../../../packages/crypto/src/index.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const utf8 = (s: string) => new TextEncoder().encode(s);
const prf = new Uint8Array(32).fill(0x01);
const ctx: BindingContext = { chainId: 10143n, registry: `0x${"11".repeat(20)}`, owner: `0x${"22".repeat(20)}` };
const nsId = deriveNamespaceId(prf, "preferences");
const nsKey = deriveNamespaceKey(prf, "preferences", 0);
const P = 2n ** 255n - 19n;

function le32(u: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((u >> BigInt(8 * i)) & 0xffn);
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

// Deterministic PRNG so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 2 ** 32;
  };
}

// ------------------------------------------------------------------ zeroing / buffer aliasing

describe("fix: key copies zeroed after importKey must never touch caller buffers", () => {
  it("encryptEntry with a Node Buffer key leaves the caller's key intact", async () => {
    // Buffer is a Uint8Array subclass (passes assertBytes) whose .slice() is a VIEW, not a copy.
    const k = Buffer.from(nsKey);
    const before = hex(k);
    await encryptEntry({ key: k, ctx, nsId, epoch: 0, plaintext: utf8("x") });
    expect(hex(k)).toBe(before);
  });

  it("Buffer key: second encryption is still under the real key (decryptable with the original key)", async () => {
    const k = Buffer.from(nsKey);
    await encryptEntry({ key: k, ctx, nsId, epoch: 0, plaintext: utf8("first") });
    const env = await encryptEntry({ key: k, ctx, nsId, epoch: 0, plaintext: utf8("second") });
    // Evidence of the failure mode: if the caller's Buffer was zeroed, this envelope opens under the all-zero key.
    const underZero = await code(() => decryptEntry({ key: new Uint8Array(32), ctx, nsId, epoch: 0, envelope: env }));
    expect(underZero, "second envelope was encrypted under the all-zero key").toBe("DECRYPT_FAILED");
    const pt = await decryptEntry({ key: nsKey, ctx, nsId, epoch: 0, envelope: env });
    expect(new TextDecoder().decode(pt)).toBe("second");
  });

  it("decryptEntry with a Node Buffer key leaves the caller's key intact", async () => {
    const env = await encryptEntry({ key: nsKey, ctx, nsId, epoch: 0, plaintext: utf8("x") });
    const k = Buffer.from(nsKey);
    const before = hex(k);
    await decryptEntry({ key: k, ctx, nsId, epoch: 0, envelope: env });
    expect(hex(k)).toBe(before);
  });

  it("plain Uint8Array keys are never zeroed by encrypt/decrypt/wrap/unwrap", async () => {
    const k = new Uint8Array(nsKey);
    const agent = generateAgentKeyPair();
    const priv = new Uint8Array(agent.privateKey);
    const env = await encryptEntry({ key: k, ctx, nsId, epoch: 0, plaintext: utf8("x") });
    await decryptEntry({ key: k, ctx, nsId, epoch: 0, envelope: env });
    const w = await wrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, nsKey: k, label: "preferences", agentX25519Public: agent.publicKey });
    await unwrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, envelope: w, agentX25519Private: priv });
    expect(hex(k)).toBe(hex(nsKey));
    expect(hex(priv)).toBe(hex(agent.privateKey));
  });

  it("200 concurrent encrypt+decrypt calls sharing one key buffer all round trip", async () => {
    const k = new Uint8Array(nsKey);
    const jobs = Array.from({ length: 200 }, async (_, i) => {
      const env = await encryptEntry({ key: k, ctx, nsId, epoch: i, plaintext: utf8(`m${i}`) });
      const pt = await decryptEntry({ key: k, ctx, nsId, epoch: i, envelope: env });
      return new TextDecoder().decode(pt);
    });
    const out = await Promise.all(jobs);
    out.forEach((s, i) => expect(s).toBe(`m${i}`));
    expect(hex(k)).toBe(hex(nsKey));
  });

  it("50 concurrent wraps/unwraps with one agent key pair round trip", async () => {
    const agent = generateAgentKeyPair();
    const res = await Promise.all(
      Array.from({ length: 50 }, async (_, i) => {
        const w = await wrapNamespaceKey({ ctx, nsId, epoch: i, agentId: 7, nsKey, label: "preferences", agentX25519Public: agent.publicKey });
        return unwrapNamespaceKey({ ctx, nsId, epoch: i, agentId: 7, envelope: w, agentX25519Private: agent.privateKey });
      }),
    );
    for (const r of res) {
      expect(hex(r.nsKey)).toBe(hex(nsKey));
      expect(r.label).toBe("preferences");
    }
    // each result is an independent buffer
    res[0]!.nsKey.fill(0);
    expect(hex(res[1]!.nsKey)).toBe(hex(nsKey));
  });

  it("deriveAccountWith returns a fresh copy even when the candidate is a Node Buffer", () => {
    const cand = Buffer.alloc(32, 0x07);
    const acct = deriveAccountWith(() => cand);
    const before = hex(acct.accountKey);
    cand.fill(0);
    expect(hex(acct.accountKey)).toBe(before);
  });

  it("deriveAccountWith returns a fresh copy for a plain Uint8Array candidate", () => {
    const cand = new Uint8Array(32).fill(0x07);
    const acct = deriveAccountWith(() => cand);
    cand.fill(0);
    expect(hex(acct.accountKey)).toBe("07".repeat(32));
  });

  it("deriveAccountWith exhaustion throws EngramCryptoError INPUT_INVALID", async () => {
    expect(await code(() => deriveAccountWith(() => new Uint8Array(32).fill(0xff)))).toBe("INPUT_INVALID");
  });

  it("gap: a throwing candidate function propagates its own error (not wrapped)", async () => {
    const c = await code(() =>
      deriveAccountWith(() => {
        throw new RangeError("boom");
      }),
    );
    expect(c).toContain("NON_ENGRAM_ERROR:RangeError");
  });
});

// ------------------------------------------------------------------ canonical X25519

describe("fix: canonical X25519 check", () => {
  it("never rejects keys from generateAgentKeyPair (1500 fresh pairs), and they unwrap", async () => {
    for (let i = 0; i < 1500; i++) {
      const a = generateAgentKeyPair();
      expect(a.publicKey[31]! & 0x80).toBe(0);
      if (i % 100 === 0) {
        const w = await wrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, nsKey, label: "preferences", agentX25519Public: a.publicKey });
        const r = await unwrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, envelope: w, agentX25519Private: a.privateKey });
        expect(hex(r.nsKey)).toBe(hex(nsKey));
      } else {
        // cheap path: the check runs before any await, so an invalid key would reject synchronously-ish
        await wrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, nsKey, label: "p", agentX25519Public: a.publicKey });
      }
    }
  }, 60_000);

  it("canonical keys just below p that are not low-order are accepted", async () => {
    let accepted = 0;
    for (let d = 2n; d < 40n; d++) {
      const pub = le32(P - d);
      let lowOrder = false;
      try {
        lowOrder = x25519.getSharedSecret(x25519.utils.randomSecretKey(), pub).every((b) => b === 0);
      } catch {
        lowOrder = true;
      }
      const c = await code(() => wrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, nsKey, label: "p", agentX25519Public: pub }));
      expect(c).toBe(lowOrder ? "INPUT_INVALID" : "OK");
      if (!lowOrder) accepted++;
    }
    expect(accepted).toBeGreaterThan(0);
  });

  it("u = p, p+2 (non-low-order alias of 2), p+9, 2^255-1, 9+2^255 are all INPUT_INVALID", async () => {
    for (const u of [P, P + 2n, P + 9n, 2n ** 255n - 1n, 9n + 2n ** 255n, 2n ** 256n - 1n]) {
      const c = await code(() => wrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, nsKey, label: "p", agentX25519Public: le32(u) }));
      expect(c, `u=${u}`).toBe("INPUT_INVALID");
    }
  });

  it("top bit set on every real public key -> INPUT_INVALID (50 keys)", async () => {
    for (let i = 0; i < 50; i++) {
      const pub = new Uint8Array(generateAgentKeyPair().publicKey);
      pub[31]! |= 0x80;
      expect(await code(() => wrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, nsKey, label: "p", agentX25519Public: pub }))).toBe(
        "INPUT_INVALID",
      );
    }
  });

  it("canonical check does not mutate the caller's public key buffer", async () => {
    const a = generateAgentKeyPair();
    const pub = new Uint8Array(a.publicKey);
    await wrapNamespaceKey({ ctx, nsId, epoch: 0, agentId: 7, nsKey, label: "p", agentX25519Public: pub });
    expect(hex(pub)).toBe(hex(a.publicKey));
  });
});

// ------------------------------------------------------------------ canonical entry encoding

const OVERHEAD = (t: number, kind: string) => utf8(JSON.stringify({ v: 1, t, kind, text: "" })).length;

describe("fix: parseEntry accepts exactly what encodeEntry produces", () => {
  // Palette of code units that stress JSON.stringify escaping, surrogates and byte widths.
  const PALETTE = [
    "a", "Z", "0", " ", '"', "\\", "/", "\u0000", "\u0001", "\u001f", "\b", "\f", "\n", "\r", "\t", "\u007f",
    "\u0080", "é", "é", " ", " ", "﻿", "�", "￾", "￿", "中",
    "😀", "􏿿", "𐀀", "\ud800", "\udc00", "\udbff", "\udfff", "<", "&", "\u0085",
  ];
  const wellFormed = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

  it("fuzz 4000 random texts: encode ok <=> spec-valid, and parse(encode(e)) === e", async () => {
    const r = rng(0xc0ffee);
    const kinds = ["fact", "preference", "note"] as const;
    for (let n = 0; n < 4000; n++) {
      const len = Math.floor(r() * (n % 10 === 0 ? 1600 : 40)) + (n % 17 === 0 ? 0 : 1);
      let text = "";
      for (let i = 0; i < len; i++) text += PALETTE[Math.floor(r() * PALETTE.length)];
      const t = n % 5 === 0 ? Number.MAX_SAFE_INTEGER : Math.floor(r() * 2 ** 42);
      const kind = kinds[n % 3]!;
      const e: Entry = { v: 1, t, kind, text };
      const cps = [...text].length;
      const bytesLen = utf8(JSON.stringify(e)).length;
      const expectOk = wellFormed(text) && cps >= 1 && cps <= 1500 && bytesLen <= 2048;
      let enc: Uint8Array | null = null;
      const c = await code(() => {
        enc = encodeEntry(e);
      });
      expect(c, `n=${n} len=${len}`).toBe(expectOk ? "OK" : "INPUT_INVALID");
      if (enc) {
        const back = parseEntry(enc);
        expect(back).toEqual(e);
        expect(hex(encodeEntry(back))).toBe(hex(enc));
      } else {
        // The same bytes a naive encoder would emit must also be refused by the reader.
        expect(await code(() => parseEntry(utf8(JSON.stringify(e))))).toBe("ENTRY_INVALID");
      }
    }
  }, 60_000);

  it("encoding of exactly 2048 bytes via escape-expanded text encodes and parses", async () => {
    const t = 1_790_000_000_000;
    const room = 2048 - OVERHEAD(t, "note");
    // "\u0001" expands to 6 bytes; fill the rest with ASCII
    const esc = Math.floor(room / 6);
    const text = "\u0001".repeat(esc) + "a".repeat(room - esc * 6);
    const e: Entry = { v: 1, t, kind: "note", text };
    const b = encodeEntry(e);
    expect(b.length).toBe(2048);
    expect(parseEntry(b)).toEqual(e);
  });

  it("2049-byte encoding: encodeEntry INPUT_INVALID, parseEntry of the same bytes ENTRY_INVALID", async () => {
    const t = 1_790_000_000_000;
    const room = 2049 - OVERHEAD(t, "fact");
    const text = "\u0001".repeat(Math.floor(room / 6)) + "a".repeat(room % 6);
    const e: Entry = { v: 1, t, kind: "fact", text };
    expect(utf8(JSON.stringify(e)).length).toBe(2049);
    expect(await code(() => encodeEntry(e))).toBe("INPUT_INVALID");
    expect(await code(() => parseEntry(utf8(JSON.stringify(e))))).toBe("ENTRY_INVALID");
  });

  it("1500 code points is accepted, 1501 is not (ASCII and 2-byte)", async () => {
    for (const ch of ["a", "é"]) {
      const room = ch === "a" ? 1500 : Math.min(1500, Math.floor((2048 - OVERHEAD(0, "fact")) / 2));
      const ok: Entry = { v: 1, t: 0, kind: "fact", text: ch.repeat(room) };
      expect(parseEntry(encodeEntry(ok))).toEqual(ok);
    }
    expect(await code(() => encodeEntry({ v: 1, t: 0, kind: "fact", text: "a".repeat(1501) }))).toBe("INPUT_INVALID");
    expect(await code(() => parseEntry(utf8(JSON.stringify({ v: 1, t: 0, kind: "fact", text: "a".repeat(1501) }))))).toBe(
      "ENTRY_INVALID",
    );
  });

  it("astral code points: 510 emoji (2040 text bytes) rejected for bytes, 400 accepted", async () => {
    const e: Entry = { v: 1, t: 0, kind: "fact", text: "\u{1F600}".repeat(510) }; // 2040 bytes + overhead > 2048
    expect(await code(() => encodeEntry(e))).toBe("INPUT_INVALID");
    const small: Entry = { v: 1, t: 0, kind: "fact", text: "\u{1F600}".repeat(400) };
    expect(parseEntry(encodeEntry(small))).toEqual(small);
  });

  it("parseEntry works on a subarray view with a non-zero byteOffset", () => {
    const e: Entry = { v: 1, t: 5, kind: "fact", text: "offset" };
    const enc = encodeEntry(e);
    const big = new Uint8Array(enc.length + 10);
    big.set(enc, 7);
    expect(parseEntry(big.subarray(7, 7 + enc.length))).toEqual(e);
  });

  it("parseEntry accepts a Node Buffer holding canonical bytes", () => {
    const e: Entry = { v: 1, t: 5, kind: "note", text: "buf" };
    expect(parseEntry(Buffer.from(encodeEntry(e)))).toEqual(e);
  });

  it("non-Uint8Array inputs -> ENTRY_INVALID (never a raw TypeError)", async () => {
    const enc = encodeEntry({ v: 1, t: 5, kind: "note", text: "x" });
    for (const v of [enc.buffer, new DataView(enc.buffer), null, undefined, "str", [1, 2], {}]) {
      expect(await code(() => parseEntry(v as unknown as Uint8Array))).toBe("ENTRY_INVALID");
    }
  });
});

describe("fix: lone-surrogate rejection", () => {
  const cases: [string, boolean][] = [
    ["😀", true],
    ["a😀b", true],
    ["􏿿", true],
    ["𐀀𐀀", true],
    ["\ud800", false],
    ["a\ud800", false],
    ["\udc00", false],
    ["\udc00a", false],
    ["\udc00\ud800", false],
    ["\ud800𐀀", false],
    ["𐀀\udc00", false],
    ["😀\ude00", false],
    ["x\udfff", false],
  ];
  for (const [text, ok] of cases) {
    it(`${JSON.stringify(text)} -> ${ok ? "accepted" : "rejected"} by both encode and parse`, async () => {
      const e: Entry = { v: 1, t: 0, kind: "fact", text };
      expect(await code(() => encodeEntry(e))).toBe(ok ? "OK" : "INPUT_INVALID");
      expect(await code(() => parseEntry(utf8(JSON.stringify(e))))).toBe(ok ? "OK" : "ENTRY_INVALID");
    });
  }

  it("escaped valid pair (\\ud83d\\ude00) in the bytes is refused as non-canonical", async () => {
    const b = utf8('{"v":1,"t":0,"kind":"fact","text":"\\ud83d\\ude00"}');
    expect(await code(() => parseEntry(b))).toBe("ENTRY_INVALID");
  });

  it("raw CESU-8 encoded surrogate bytes are refused", async () => {
    const pre = utf8('{"v":1,"t":0,"kind":"fact","text":"');
    const post = utf8('"}');
    const b = new Uint8Array([...pre, 0xed, 0xa0, 0x80, ...post]);
    expect(await code(() => parseEntry(b))).toBe("ENTRY_INVALID");
  });
});

describe("fix: non-canonical byte forms are refused", () => {
  const good = '{"v":1,"t":1000,"kind":"fact","text":"hi"}';
  const variants = [
    ["uppercase unicode escape", '{"v":1,"t":1000,"kind":"fact","text":"\\u0048i"}'],
    ["escaped slash", '{"v":1,"t":1000,"kind":"fact","text":"h\\/i"}'],
    ["uppercase control escape", '{"v":1,"t":1000,"kind":"fact","text":"h\\u001Fi"}'],
    ["\\u000a instead of \\n", '{"v":1,"t":1000,"kind":"fact","text":"h\\u000ai"}'],
    ["t as 1e3", '{"v":1,"t":1e3,"kind":"fact","text":"hi"}'],
    ["t as 1000.0", '{"v":1,"t":1000.0,"kind":"fact","text":"hi"}'],
    ["v as 1.0", '{"v":1.0,"t":1000,"kind":"fact","text":"hi"}'],
    ["key order", '{"t":1000,"v":1,"kind":"fact","text":"hi"}'],
    ["trailing newline", good + "\n"],
    ["leading BOM", "﻿" + good],
    ["duplicate text key", '{"v":1,"t":1000,"kind":"fact","text":"x","text":"hi"}'],
    ["escaped key", '{"\\u0076":1,"t":1000,"kind":"fact","text":"hi"}'],
  ];
  it("canonical form itself parses", () => {
    expect(parseEntry(utf8(good))).toEqual({ v: 1, t: 1000, kind: "fact", text: "hi" });
  });
  for (const [name, s] of variants) {
    it(`${name} -> ENTRY_INVALID`, async () => {
      expect(await code(() => parseEntry(utf8(s!)))).toBe("ENTRY_INVALID");
    });
  }
});

describe("fix: snapshot (B4) under hostile objects", () => {
  it("Proxy whose get trap flips kind/text each read still yields bytes parseEntry accepts", async () => {
    let reads = 0;
    const target = { v: 1, t: 1, kind: "fact", text: "ok" };
    const p = new Proxy(target, {
      get(tg, k) {
        reads++;
        if (k === "kind") return reads % 2 ? "fact" : "evil";
        if (k === "text") return reads % 2 ? "ok" : { toJSON: () => "x".repeat(5000) };
        return Reflect.get(tg, k);
      },
    });
    let enc: Uint8Array | null = null;
    const c = await code(() => {
      enc = encodeEntry(p as unknown as Entry);
    });
    if (c === "OK") expect(await code(() => parseEntry(enc!))).toBe("OK");
    else expect(c).toBe("INPUT_INVALID");
  });

  it("getter-based entry (kind getter changes) cannot produce unparsable bytes", async () => {
    let n = 0;
    const e = {
      v: 1,
      t: 1,
      get kind() {
        return n++ === 0 ? "fact" : "evil";
      },
      text: "x",
    };
    let enc: Uint8Array | null = null;
    const c = await code(() => {
      enc = encodeEntry(e as unknown as Entry);
    });
    if (c === "OK") expect(await code(() => parseEntry(enc!))).toBe("OK");
    else expect(c).toBe("INPUT_INVALID");
  });

  it("-0 as t: encode normalizes to 0 and parse round trips to t=0", () => {
    const b = encodeEntry({ v: 1, t: -0, kind: "fact", text: "z" });
    expect(new TextDecoder().decode(b)).toBe('{"v":1,"t":0,"kind":"fact","text":"z"}');
    expect(Object.is(parseEntry(b).t, 0)).toBe(true);
  });

  it("parseEntry returns a fresh object (no __proto__ or extra props from the document)", () => {
    const r = parseEntry(encodeEntry({ v: 1, t: 2, kind: "note", text: "__proto__" }));
    expect(Object.keys(r).sort()).toEqual(["kind", "t", "text", "v"]);
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
  });
});
