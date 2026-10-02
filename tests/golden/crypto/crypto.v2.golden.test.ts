// Golden tests for the Disclosure-mode additions to contracts/crypto.md (cases 17-21): pairwise identity keys and
// v2 entry documents. Vectors come from the independent Python reference (generate_vectors_v2.py).
// Written from the spec before the implementation. FROZEN: add cases, never edit.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveAccount, derivePairwise, encodeEntryV2, parseAnyEntry, parseEntry } from "../../../packages/crypto/src/index.js";

const V = JSON.parse(readFileSync(new URL("./crypto-vectors-v2.json", import.meta.url), "utf8"));
const hex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const utf8 = (s: string) => new TextEncoder().encode(s);
async function code(f: () => unknown) {
  try {
    await f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "NO_THROW";
}

describe("pairwise identity (cases 17, 18)", () => {
  it("17 matches the Python vectors and differs from the account key", () => {
    for (const p of V.pairwise) {
      const r = derivePairwise(hex(p.prf), BigInt(p.agentId));
      expect(toHex(r.key)).toBe(p.key);
      expect(r.address).toBe(p.address);
      expect(r.counter).toBe(p.counter);
    }
    const prf = hex(V.pairwise[0].prf);
    const acct = deriveAccount(prf);
    expect(acct.owner).toBe(V.account_prf1.address);
    const a7 = derivePairwise(prf, 7n);
    const a8 = derivePairwise(prf, 8n);
    expect(new Set([acct.owner, a7.address, a8.address]).size).toBe(3);
    expect(toHex(a7.key)).not.toBe(toHex(acct.accountKey));
  });

  it("18 is stable: same prf, same agent -> same key, on any call", () => {
    const prf = hex(V.pairwise[0].prf);
    expect(toHex(derivePairwise(prf, 7n).key)).toBe(toHex(derivePairwise(new Uint8Array(prf), 7n).key));
  });

  it("rejects bad inputs with INPUT_INVALID", async () => {
    expect(await code(() => derivePairwise(new Uint8Array(31), 7n))).toBe("INPUT_INVALID");
    expect(await code(() => derivePairwise(new Uint8Array(32), -1n))).toBe("INPUT_INVALID");
    expect(await code(() => derivePairwise(new Uint8Array(32), 2n ** 256n))).toBe("INPUT_INVALID");
  });
});

describe("entry v2 (cases 19-21)", () => {
  it("19 parseAnyEntry accepts every reference v2 document byte-exactly; v1 parseEntry still rejects them", async () => {
    for (const s of V.entries_v2 as string[]) {
      const doc = parseAnyEntry(utf8(s));
      expect(doc.v).toBe(2);
      expect(Buffer.from(encodeEntryV2(doc as never)).toString("utf8")).toBe(s);
      expect(await code(() => parseEntry(utf8(s)))).toBe("ENTRY_INVALID");
    }
  });

  it("19b parseAnyEntry also accepts canonical v1", () => {
    const v1 = '{"v":1,"t":1,"kind":"note","text":"hello"}';
    expect(parseAnyEntry(utf8(v1))).toEqual({ v: 1, t: 1, kind: "note", text: "hello" });
  });

  it("20 rejects malformed v2 documents with ENTRY_INVALID", async () => {
    const bad = [
      '{"v":2,"t":1,"kind":"fact","text":"x"}', // memory without src
      '{"v":2,"t":1,"kind":"fact","text":"x","src":{}}',
      '{"v":2,"t":1,"kind":"fact","text":"x","src":{"agent":"07"}}',
      '{"v":2,"t":1,"kind":"fact","text":"x","src":{"agent":"-7"}}',
      '{"v":2,"t":1,"kind":"fact","text":"x","src":{"agent":7}}',
      '{"v":2,"t":1,"kind":"fact","src":{"agent":"7"},"text":"x"}', // key order
      '{"v":2,"t":1,"kind":"fact","text":"x","src":{"agent":"7"},"extra":1}',
      '{"v":2,"t":1,"kind":"policy","agent":"7","origin":"https://app.x","labels":[],"scope":"read","exp":0,"active":true}',
      `{"v":2,"t":1,"kind":"policy","agent":"7","origin":"https://app.x","labels":[${Array.from({ length: 9 }, (_, i) => `"l${i}"`).join(",")}],"scope":"read","exp":0,"active":true}`,
      '{"v":2,"t":1,"kind":"policy","agent":"7","origin":"https://app.x","labels":["a","a"],"scope":"read","exp":0,"active":true}',
      '{"v":2,"t":1,"kind":"policy","agent":"7","origin":"https://app.x","labels":["engram-log"],"scope":"read","exp":0,"active":true}',
      '{"v":2,"t":1,"kind":"policy","agent":"7","origin":"https://app.x/","labels":["a"],"scope":"read","exp":0,"active":true}',
      '{"v":2,"t":1,"kind":"policy","agent":"7","origin":"https://app.x","labels":["a"],"scope":"write","exp":0,"active":true}',
      '{"v":2,"t":1,"kind":"policy","agent":"7","origin":"https://app.x","labels":["a"],"scope":"read","exp":-1,"active":true}',
      '{"v":2,"t":1,"kind":"policy","agent":"7","origin":"https://app.x","labels":["a"],"scope":"read","exp":0,"active":1}',
      `{"v":2,"t":1,"kind":"log","agent":"7","origin":"https://app.x","q":"","mode":"full","refs":[${Array.from({ length: 21 }, () => '{"l":"a","s":"1"}').join(",")}],"n":0,"round":0}`,
      '{"v":2,"t":1,"kind":"log","agent":"7","origin":"https://app.x","q":"","mode":"full","refs":[],"n":21,"round":0}',
      '{"v":2,"t":1,"kind":"log","agent":"7","origin":"https://app.x","q":"","mode":"full","refs":[],"n":0,"round":4}',
      '{"v":2,"t":1,"kind":"log","agent":"7","origin":"https://app.x","q":"","mode":"peek","refs":[],"n":0,"round":0}',
      '{"v":2,"t":1,"kind":"log","agent":"7","origin":"https://app.x","q":"","mode":"full","refs":[{"l":"a","s":"01"}],"n":0,"round":0}',
      `{"v":2,"t":1,"kind":"log","agent":"7","origin":"https://app.x","q":"${"q".repeat(201)}","mode":"full","refs":[],"n":0,"round":0}`,
      '{"v":2,"t":1,"kind":"secret","text":"x","src":{"agent":"7"}}',
      ' {"v":2,"t":1,"kind":"fact","text":"x","src":{"agent":"7"}}', // whitespace
    ];
    for (const s of bad) expect(await code(() => parseAnyEntry(utf8(s))), s).toBe("ENTRY_INVALID");
    const huge = `{"v":2,"t":1,"kind":"fact","text":"x","src":{"agent":"${"9".repeat(78)}"}}`; // >= 2^256
    expect(await code(() => parseAnyEntry(utf8(huge)))).toBe("ENTRY_INVALID");
  });

  it("21 encodeEntryV2 refuses a document over 2048 bytes, and invalid documents, with INPUT_INVALID", async () => {
    const big = { v: 2, t: 1, kind: "fact", text: "é".repeat(1100), src: { agent: "7" } }; // 2200+ bytes
    expect(await code(() => encodeEntryV2(big as never))).toBe("INPUT_INVALID");
    expect(await code(() => encodeEntryV2({ v: 2, t: 1, kind: "fact", text: "x" } as never))).toBe("INPUT_INVALID");
  });
});
