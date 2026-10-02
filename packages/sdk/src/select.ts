// Selection rules for Disclosure mode (contracts/disclosure.md "Selection rules"). Pure: no I/O, no keys.

export type DisclosedEntry = { kind: string; text: string; by: "owner" | "self" };
export type Candidate = DisclosedEntry & { t: number; seq: bigint; label: string };
export type DisclosureMode = "relevant" | "full";

export const RELEVANT_CAP = 8;
export const FULL_CAP = 20;
const STOPWORDS = new Set("a an and are about any can do for i in is it know me my of on or please tell the to what with you your".split(" "));

/** NFKC + lowercase, split on anything that is not a letter, combining mark or digit; drop short tokens and stopwords. */
export function tokens(s: string): string[] {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((t) => [...t].length >= 2 && !STOPWORDS.has(t));
}

function matches(a: string, b: string): boolean {
  if (a === b) return true;
  const x = [...a];
  const y = [...b];
  const shorter = Math.min(x.length, y.length);
  if (shorter < 3) return false;
  let p = 0;
  while (p < shorter && x[p] === y[p]) p++;
  return p >= Math.min(5, shorter);
}

const newestFirst = (a: Candidate, b: Candidate) => b.t - a.t || (b.seq > a.seq ? 1 : b.seq < a.seq ? -1 : 0);

/** The candidates a disclosure returns, in order (callers log their refs). */
export function selectCandidates(query: string, candidates: Candidate[], mode: DisclosureMode): Candidate[] {
  if (mode === "full") return [...candidates].sort(newestFirst).slice(0, FULL_CAP);
  const q = [...new Set(tokens(query))];
  if (!q.length) return [];
  const scored: { c: Candidate; score: number }[] = [];
  for (const c of candidates) {
    const et = tokens(c.text);
    const score = q.filter((qt) => et.some((t) => matches(qt, t))).length;
    if (score > 0) scored.push({ c, score });
  }
  return scored.sort((a, b) => b.score - a.score || newestFirst(a.c, b.c)).slice(0, RELEVANT_CAP).map((s) => s.c);
}

export function selectEntries(query: string, candidates: Candidate[], mode: DisclosureMode): DisclosedEntry[] {
  return selectCandidates(query, candidates, mode).map(({ kind, text, by }) => ({ kind, text, by }));
}
