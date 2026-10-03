// Flags agent proposals that look like instructions aimed at an AI (contracts/provenance.md P14-P16, P24, P25).
// A warning for the owner's review, never a block: some real preferences ("Always respond in Hindi") are flagged, and
// other languages, encodings and paraphrases are not caught. Linear time: no backtracking regexes.

const MAX_CHARS = 5000;
const MARKERS = ["http://", "https://", "www.", "javascript:", "data:", "</", "<user_memory", "```", '"role"', "tool_call", "function_call"];
const PHRASES = [
  "ignore previous", "ignore all", "ignore the above", "disregard", "you are now", "act as", "pretend to be",
  "always respond", "always reply", "never tell", "do not tell", "don't tell", "jailbreak", "new instructions",
  "you must", "you should", "forget everything", "forget all", "override your", "your rules", "new rules",
];
const SQUASHED = PHRASES.map((p) => p.replace(/[^a-z]/g, "")).filter((p) => p.length >= 8);
const ROLES = ["system", "assistant", "developer"];
// Common Cyrillic and Greek look-alikes of Latin letters (NFKC does not fold these).
const HOMOGLYPHS: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i",
  "ј": "j", "ѕ": "s", "ԁ": "d", "һ": "h", "к": "k", "м": "m", "т": "t", "в": "b",
  "α": "a", "ο": "o", "ρ": "p", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "τ": "t",
};
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(t: string): string {
  return t.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,5});/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return String.fromCodePoint(Math.min(parseInt(k.slice(2), 16), 0x10ffff));
    if (k.startsWith("#")) return String.fromCodePoint(Math.min(parseInt(k.slice(1), 10), 0x10ffff));
    return ENTITIES[k] ?? m;
  });
}

function normalise(text: string): string {
  let t = decodeEntities(text.slice(0, MAX_CHARS)).normalize("NFKC").toLowerCase();
  t = t.replace(/\p{Cf}/gu, ""); // zero-width characters, soft hyphen, bidi controls
  t = [...t].map((c) => HOMOGLYPHS[c] ?? c).join("");
  return t;
}

export function looksLikeInstruction(text: string): boolean {
  if (typeof text !== "string") return false;
  const t = normalise(text);
  const spaced = t.replace(/\s+/g, " ");
  if (MARKERS.some((m) => spaced.includes(m))) return true;
  if (PHRASES.some((p) => spaced.includes(p))) return true;
  const squashed = t.replace(/[^a-z]/g, "");
  if (SQUASHED.some((p) => squashed.includes(p))) return true;
  // Role prefixes at the start of any line, e.g. "assistant: ...": a line scan, linear time (BUGLOG PR-5).
  for (const line of t.split("\n")) {
    const l = line.trimStart();
    for (const r of ROLES) {
      if (l.startsWith(r) && l.slice(r.length).trimStart().startsWith(":")) return true;
    }
  }
  return false;
}
