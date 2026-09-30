import { EngramCryptoError, invalid } from "./errors.js";
import { utf8 } from "./encoding.js";

export type EntryKind = "fact" | "preference" | "note";

/** Plaintext memory entry, v1 (contracts/crypto.md). */
export type Entry = { v: 1; t: number; kind: EntryKind; text: string };

const KINDS: readonly string[] = ["fact", "preference", "note"];
const KEYS = ["kind", "t", "text", "v"];
const MAX_TEXT_CODE_POINTS = 1500;
const MAX_BYTES = 2048;

/** Returns a reason string when `value` is not a valid v1 entry, else null. */
function problem(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "entry must be a JSON object";
  const keys = Object.keys(value).sort();
  if (keys.length !== KEYS.length || keys.some((k, i) => k !== KEYS[i])) return "entry must have exactly v, t, kind, text";
  const e = value as Record<string, unknown>;
  if (e.v !== 1) return "v must be 1";
  if (typeof e.t !== "number" || !Number.isSafeInteger(e.t) || e.t < 0) return "t must be a non-negative integer (unix ms)";
  if (typeof e.kind !== "string" || !KINDS.includes(e.kind)) return "kind must be fact, preference, or note";
  if (typeof e.text !== "string") return "text must be a string";
  const cps = [...e.text].length;
  if (cps < 1 || cps > MAX_TEXT_CODE_POINTS) return `text must be 1..${MAX_TEXT_CODE_POINTS} code points`;
  return null;
}

/** Canonical encoding (fixed key order). Throws INPUT_INVALID for anything parseEntry would reject. */
export function encodeEntry(entry: Entry): Uint8Array {
  const reason = problem(entry);
  if (reason) invalid(reason);
  const bytes = utf8(JSON.stringify({ v: entry.v, t: entry.t, kind: entry.kind, text: entry.text }));
  if (bytes.length > MAX_BYTES) invalid(`encoded entry is ${bytes.length} bytes, max ${MAX_BYTES}`);
  return bytes;
}

/** Validates decrypted bytes. Authentic ciphertext can still hold junk from a granted writer. */
export function parseEntry(bytes: Uint8Array): Entry {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new EngramCryptoError("ENTRY_INVALID", "entry is not valid UTF-8 JSON", { cause });
  }
  const reason = problem(value);
  if (reason) throw new EngramCryptoError("ENTRY_INVALID", reason);
  return value as Entry;
}
