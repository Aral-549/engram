// Golden tests for the selection rules in contracts/disclosure.md ("Selection rules", relevant and full mode).
// Written from the spec before the implementation. FROZEN: add cases, never edit.
import { describe, expect, it } from "vitest";
import { selectEntries, type Candidate } from "../../../packages/sdk/src/select.js";

let seq = 0n;
const c = (text: string, t: number, by: "owner" | "self" = "owner"): Candidate => ({ kind: "preference", text, by, t, seq: seq++, label: "preferences" });
const texts = (r: { text: string }[]) => r.map((e) => e.text);

describe("relevant mode", () => {
  const pool = [c("vegetarian", 1), c("allergic to peanuts", 2), c("likes jazz", 3)];

  it("D6 a dinner question with 'allergy' returns only the allergy entry", () => {
    expect(texts(selectEntries("Plan dinner, any allergy concerns?", pool, "relevant"))).toEqual(["allergic to peanuts"]);
  });

  it("prefix rule: veg -> vegetarian, allergy -> allergic, tea -> team (documented false positive)", () => {
    expect(texts(selectEntries("veg options", pool, "relevant"))).toEqual(["vegetarian"]);
    expect(texts(selectEntries("team lunch", [c("drinks tea", 1)], "relevant"))).toEqual(["drinks tea"]);
  });

  it("D7 a question made only of stopwords returns nothing", () => {
    expect(selectEntries("What do you know about me?", pool, "relevant")).toEqual([]);
  });

  it("D8 no match returns nothing", () => {
    expect(selectEntries("quantum chromodynamics", pool, "relevant")).toEqual([]);
  });

  it("tokens shorter than 3 never match by prefix; short tokens below 2 are dropped", () => {
    expect(selectEntries("x y", [c("xylophone", 1)], "relevant")).toEqual([]);
  });

  it("orders by score, then newest first, and caps at 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => c(`train trip ${i}`, i));
    const both = c("train and flights", 100);
    const r = selectEntries("train flights", [...many, both], "relevant");
    expect(r).toHaveLength(8);
    expect(r[0]!.text).toBe("train and flights"); // score 2
    expect(texts(r.slice(1, 3))).toEqual(["train trip 11", "train trip 10"]); // newest first among score 1
  });

  it("normalises with NFKC and case, and tokenises non-Latin scripts on letters and digits", () => {
    expect(texts(selectEntries("ＶＥＧＥＴＡＲＩＡＮ", pool, "relevant"))).toEqual(["vegetarian"]);
    expect(texts(selectEntries("मैं शाकाहारी", [c("शाकाहारी भोजन", 1)], "relevant"))).toEqual(["शाकाहारी भोजन"]);
  });

  it("returns kind, text and by only", () => {
    const [e] = selectEntries("jazz", pool, "relevant");
    expect(Object.keys(e!).sort()).toEqual(["by", "kind", "text"]);
  });
});

describe("full mode", () => {
  it("D7 returns the newest 20 entries", () => {
    const many = Array.from({ length: 25 }, (_, i) => c(`fact ${i}`, i));
    const r = selectEntries("", many, "full");
    expect(r).toHaveLength(20);
    expect(r[0]!.text).toBe("fact 24");
  });
});
