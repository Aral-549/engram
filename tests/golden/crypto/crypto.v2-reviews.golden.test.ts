// Golden case 24 (contracts/crypto.md): the batched `reviews` reject record (contracts/provenance.md P20).
// Canonical strings written by hand from the spec key order. FROZEN: add cases, never edit.
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
const doc = (n: number, action = "reject", label = "p") =>
  `{"v":2,"t":5,"kind":"reviews","agent":"7","action":"${action}","targets":[${Array.from({ length: n }, (_, i) => `{"l":"${label}","s":"${i}"}`).join(",")}]}`;

describe("reviews batch (case 24)", () => {
  it("round-trips 1 and 50 targets byte-exactly", () => {
    for (const n of [1, 50]) {
      const s = doc(n);
      expect(parseAnyEntry(utf8(s))).toMatchObject({ v: 2, kind: "reviews" });
      expect(Buffer.from(encodeEntryV2(parseAnyEntry(utf8(s)) as never)).toString()).toBe(s);
    }
  });
  it("rejects 0 or 51 targets, reserved labels, and actions other than reject", async () => {
    for (const s of [doc(0), doc(51), doc(1, "confirm"), doc(1, "reject", "engram-log")]) expect(await code(() => parseAnyEntry(utf8(s))), s).toBe("ENTRY_INVALID");
  });
});
