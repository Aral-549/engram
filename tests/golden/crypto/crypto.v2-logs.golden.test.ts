// Golden case 22 (contracts/crypto.md): the batched `logs` entry. Canonical strings below were written by hand from
// the spec (key order as listed there) and checked against JSON.stringify of the same objects.
// FROZEN: add cases, never edit.
import { describe, expect, it } from "vitest";
import { encodeEntryV2, parseAnyEntry } from "../../../packages/crypto/src/index.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const item = (i: number) => `{"t":${i},"agent":"7","origin":"https://app.x","q":"q${i}","mode":"relevant","refs":[{"l":"preferences","s":"${i}"}],"n":1,"round":0}`;
async function code(f: () => unknown) {
  try {
    await f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "NO_THROW";
}

describe("logs batch entry (case 22)", () => {
  it("round-trips 1 and 20 items byte-exactly", () => {
    // 20 full items would exceed the 2048-byte entry cap, so the 20-item case uses minimal items.
    const tiny = (i: number) => `{"t":${i},"agent":"7","origin":"https://app.x","q":"","mode":"full","refs":[],"n":0,"round":0}`;
    for (const [n, f] of [[1, item], [20, tiny]] as const) {
      const s = `{"v":2,"t":5,"kind":"logs","items":[${Array.from({ length: n }, (_, i) => f(i)).join(",")}]}`;
      const doc = parseAnyEntry(utf8(s));
      expect(doc).toMatchObject({ v: 2, kind: "logs" });
      expect(Buffer.from(encodeEntryV2(doc as never)).toString()).toBe(s);
    }
  });

  it("rejects empty, oversized and malformed batches", async () => {
    const bad = [
      '{"v":2,"t":5,"kind":"logs","items":[]}',
      `{"v":2,"t":5,"kind":"logs","items":[${Array.from({ length: 21 }, (_, i) => item(i % 3)).join(",")}]}`,
      `{"v":2,"t":5,"kind":"logs","items":[${item(1).replace('"round":0', '"round":0,"x":1')}]}`,
      `{"v":2,"t":5,"kind":"logs","items":[${item(1).replace('"mode":"relevant"', '"mode":"peek"')}]}`,
      `{"v":2,"t":5,"kind":"logs","items":[${item(1).replace('"agent":"7"', '"agent":"07"')}]}`,
      `{"v":2,"t":5,"kind":"logs","items":[${item(1).replace('{"t":1,', '{')}]}`,
      `{"v":2,"t":5,"kind":"logs","items":[${item(1)}],"extra":1}`,
    ];
    for (const s of bad) expect(await code(() => parseAnyEntry(utf8(s))), s).toBe("ENTRY_INVALID");
  });
});
