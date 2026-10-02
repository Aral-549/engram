// Flags agent proposals that look like instructions aimed at an AI (contracts/provenance.md P14-P16).
// A warning for the owner's review, never a block: some real preferences ("Always respond in Hindi") are flagged.

const ZERO_WIDTH = /[​-‍⁠﻿]/g;
const MARKERS = ["http://", "https://", "www.", "</", "<user_memory", "```", '"role"', "tool_call", "function_call"];
const PHRASES = [
  "ignore previous", "ignore all", "ignore the above", "disregard", "you are now", "act as", "pretend to be",
  "always respond", "always reply", "never tell", "do not tell", "don't tell", "jailbreak", "new instructions",
  "you must", "you should",
];
const ROLE_PREFIX = /(^|\n)\s*(system|assistant|developer)\s*:/;

export function looksLikeInstruction(text: string): boolean {
  if (typeof text !== "string") return false;
  const t = text.normalize("NFKC").toLowerCase().replace(ZERO_WIDTH, "");
  return MARKERS.some((m) => t.includes(m)) || ROLE_PREFIX.test(t) || PHRASES.some((p) => t.includes(p));
}
