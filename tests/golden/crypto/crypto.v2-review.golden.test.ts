// Golden case 23 (contracts/crypto.md): the `review` entry (contracts/provenance.md). Canonical strings written by
// hand from the spec key order. Written from the spec before the implementation. FROZEN: add cases, never edit.
import { describe, expect, it } from "vitest";
import { encodeEntryV2, parseAnyEntry } from "../../../packages/crypto/src/index.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
async function code(f: () => unknown) {
  try {
    await f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "NO_THROW";
}
const confirm = '{"v":2,"t":5,"kind":"review","target":{"l":"preferences","s":"3"},"agent":"1965","action":"confirm","copy":"4"}';
const reject = '{"v":2,"t":5,"kind":"review","target":{"l":"preferences","s":"3"},"agent":"1965","action":"reject"}';

describe("review entry (case 23)", () => {
  it("round-trips confirm (with copy) and reject (without copy) byte-exactly", () => {
    for (const s of [confirm, reject]) {
      const doc = parseAnyEntry(utf8(s));
      expect(doc).toMatchObject({ v: 2, kind: "review" });
      expect(Buffer.from(encodeEntryV2(doc as never)).toString()).toBe(s);
    }
  });

  it("rejects malformed review records", async () => {
    const bad = [
      reject.replace('"action":"reject"', '"action":"reject","copy":"4"'),
      confirm.replace(',"copy":"4"', ""),
      reject.replace('"reject"', '"delete"'),
      reject.replace('"s":"3"', '"s":"03"'),
      reject.replace('"l":"preferences"', '"l":"engram-log"'),
      reject.replace('"agent":"1965"', '"agent":1965'),
      reject.replace('"target":{"l":"preferences","s":"3"}', '"target":{"l":"preferences"}'),
      reject.replace('{"v":2,"t":5,', '{"v":2,"t":5,"x":1,'),
    ];
    for (const s of bad) expect(await code(() => parseAnyEntry(utf8(s))), s).toBe("ENTRY_INVALID");
  });
});
