// Regression cases for BUGLOG B1-B4 and review decisions (contracts/crypto.md, "review 2026-10-01").
// Written from the bug reports before the fixes. FROZEN: add cases, never edit or delete.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  deriveAccountWith,
  encodeEntry,
  parseEntry,
  unwrapNamespaceKey,
  wrapNamespaceKey,
  EngramCryptoError,
  type BindingContext,
  type Entry,
} from "../../../packages/crypto/src/index.js";

const V = JSON.parse(readFileSync(new URL("./crypto-vectors.json", import.meta.url), "utf8"));
const bytes = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));
const utf8 = (s: string) => new TextEncoder().encode(s);
const ctx: BindingContext = { chainId: BigInt(V.context.chainId), registry: V.context.registry, owner: V.context.owner };

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

const P = 2n ** 255n - 19n;
function leBytes(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((x >> BigInt(8 * i)) & 0xffn);
  return out;
}

describe("B1: agent X25519 public key must be canonical", () => {
  const base = { ctx, nsId: bytes(V.entry.nsId), epoch: 0, agentId: 7n, nsKey: bytes(V.entry.nsKey), label: "preferences" };
  const agentPub = bytes(V.wrap.agentX25519Public);

  it("top bit of byte 31 set -> INPUT_INVALID", async () => {
    const k = new Uint8Array(agentPub);
    k[31]! |= 0x80;
    await expectCode(wrapNamespaceKey({ ...base, agentX25519Public: k }), "INPUT_INVALID");
  });

  it("u + p encodings (u >= p) -> INPUT_INVALID", async () => {
    for (const u of [0n, 1n, 9n, 18n]) {
      await expectCode(wrapNamespaceKey({ ...base, agentX25519Public: leBytes(P + u) }), "INPUT_INVALID");
    }
  });

  it("largest canonical u (p - 1) is not rejected for being non-canonical", async () => {
    // p-1 is a valid canonical encoding; it may still be rejected as low-order, but never silently accepted-then-broken
    try {
      const env = await wrapNamespaceKey({ ...base, agentX25519Public: leBytes(P - 1n) });
      expect(env.length).toBe(93 + "preferences".length);
    } catch (e) {
      expect((e as EngramCryptoError).code).toBe("INPUT_INVALID");
    }
  });

  it("canonical vector key still wraps and unwraps", async () => {
    const env = await wrapNamespaceKey({ ...base, agentX25519Public: agentPub });
    const r = await unwrapNamespaceKey({
      ctx, nsId: base.nsId, epoch: 0, agentId: 7n, envelope: env, agentX25519Private: bytes(V.wrap.agentX25519Private),
    });
    expect(Buffer.from(r.nsKey).toString("hex")).toBe(V.entry.nsKey);
  });
});

describe("B2 + review: parseEntry accepts only the canonical encoding", () => {
  const canonical = V.entry.plaintext as string;

  it("canonical vector plaintext is accepted", () => {
    expect(parseEntry(utf8(canonical)).text).toBe("vegetarian, allergic to peanuts");
  });

  it("document over 2048 bytes -> ENTRY_INVALID", async () => {
    const big = JSON.stringify({ v: 1, t: 0, kind: "note", text: "\u{1F600}".repeat(1500) });
    expect(utf8(big).length).toBeGreaterThan(2048);
    await expectCode(() => parseEntry(utf8(big)), "ENTRY_INVALID");
  });

  it("whitespace padding, BOM, pretty-printing -> ENTRY_INVALID", async () => {
    await expectCode(() => parseEntry(utf8(canonical + " ".repeat(2100))), "ENTRY_INVALID");
    await expectCode(() => parseEntry(utf8(canonical + " ")), "ENTRY_INVALID");
    await expectCode(() => parseEntry(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(canonical)])), "ENTRY_INVALID");
    await expectCode(() => parseEntry(utf8(JSON.stringify(JSON.parse(canonical), null, 2))), "ENTRY_INVALID");
  });

  it("duplicate keys and reordered keys -> ENTRY_INVALID", async () => {
    await expectCode(() => parseEntry(utf8('{"v":1,"t":1,"kind":"fact","text":"benign","text":"evil"}')), "ENTRY_INVALID");
    await expectCode(() => parseEntry(utf8('{"t":1,"v":1,"kind":"fact","text":"x"}')), "ENTRY_INVALID");
  });

  it("non-canonical numbers -> ENTRY_INVALID", async () => {
    for (const s of [
      '{"v":1.0,"t":1,"kind":"fact","text":"x"}',
      '{"v":1,"t":1e3,"kind":"fact","text":"x"}',
      '{"v":1,"t":-0,"kind":"fact","text":"x"}',
      '{"v":1,"t":01,"kind":"fact","text":"x"}',
    ]) {
      await expectCode(() => parseEntry(utf8(s)), "ENTRY_INVALID");
    }
  });

  it("non-canonical string escapes -> ENTRY_INVALID", async () => {
    await expectCode(() => parseEntry(utf8('{"v":1,"t":1,"kind":"fact","text":"\\u0078"}')), "ENTRY_INVALID");
  });

  it("lone surrogates in text are rejected by both parse and encode", async () => {
    await expectCode(() => parseEntry(utf8('{"v":1,"t":1,"kind":"fact","text":"a\\ud800b"}')), "ENTRY_INVALID");
    await expectCode(() => encodeEntry({ v: 1, t: 1, kind: "fact", text: "a\ud800b" }), "INPUT_INVALID");
  });

  it("encode -> parse round trip holds for escapes that JSON.stringify produces", () => {
    const e: Entry = { v: 1, t: 5, kind: "note", text: 'quote " backslash \\ newline \n tab \t ctrl \u0001 emoji \u{1F600}' };
    expect(parseEntry(encodeEntry(e))).toEqual(e);
  });
});

describe("B3: every failure carries a code", () => {
  it("exhausted account candidates -> EngramCryptoError INPUT_INVALID", async () => {
    await expectCode(() => deriveAccountWith(() => new Uint8Array(32)), "INPUT_INVALID");
  });
});

describe("B4: encodeEntry output is always parseable (no TOCTOU)", () => {
  it("getter that changes value between reads cannot smuggle an invalid kind", async () => {
    let reads = 0;
    const tricky = {
      v: 1,
      t: 1,
      text: "x",
      get kind() {
        reads++;
        return reads <= 2 ? "fact" : "evil";
      },
    } as unknown as Entry;
    let out: Uint8Array | undefined;
    try {
      out = encodeEntry(tricky);
    } catch (e) {
      expect((e as EngramCryptoError).code).toBe("INPUT_INVALID");
      return;
    }
    expect(parseEntry(out).kind).toBe("fact");
  });
});

describe("review: returned keys are independent copies", () => {
  it("zeroing the candidate buffer after deriveAccountWith does not zero accountKey", () => {
    const cand = bytes(V.derivations.A.account.accountKey);
    const acc = deriveAccountWith(() => cand);
    cand.fill(0);
    expect(Buffer.from(acc.accountKey).toString("hex")).toBe(V.derivations.A.account.accountKey);
  });
});
