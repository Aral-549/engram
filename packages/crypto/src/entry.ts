import { EngramCryptoError, invalid } from "./errors.js";
import { utf8 } from "./encoding.js";

export type EntryKind = "fact" | "preference" | "note";

/** Plaintext memory entry, v1 (contracts/crypto.md). */
export type Entry = { v: 1; t: number; kind: EntryKind; text: string };

const KINDS: readonly string[] = ["fact", "preference", "note"];
const KEYS = ["kind", "t", "text", "v"];
const MAX_TEXT_CODE_POINTS = 1500;
const MAX_BYTES = 2048;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

type Snapshot = { v: unknown; t: unknown; kind: unknown; text: unknown };

/** Reads every field exactly once, so validation and serialization see the same values (BUGLOG B4). */
function snapshot(value: unknown): Snapshot | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "entry must be a JSON object";
  const keys = Object.keys(value).sort();
  if (keys.length !== KEYS.length || keys.some((k, i) => k !== KEYS[i])) return "entry must have exactly v, t, kind, text";
  const e = value as Record<string, unknown>;
  return { v: e.v, t: e.t, kind: e.kind, text: e.text };
}

/** Returns a reason string when the snapshot is not a valid v1 entry, else null. */
function problem(s: Snapshot): string | null {
  if (s.v !== 1) return "v must be 1";
  if (typeof s.t !== "number" || !Number.isSafeInteger(s.t) || s.t < 0) return "t must be a non-negative integer (unix ms)";
  if (typeof s.kind !== "string" || !KINDS.includes(s.kind)) return "kind must be fact, preference, or note";
  if (typeof s.text !== "string") return "text must be a string";
  if (LONE_SURROGATE.test(s.text)) return "text must be well-formed Unicode";
  const cps = [...s.text].length;
  if (cps < 1 || cps > MAX_TEXT_CODE_POINTS) return `text must be 1..${MAX_TEXT_CODE_POINTS} code points`;
  return null;
}

/** Canonical bytes of a validated snapshot: fixed key order, JSON.stringify escaping, no whitespace. */
function canonical(s: Snapshot): Uint8Array {
  return utf8(JSON.stringify({ v: s.v, t: s.t, kind: s.kind, text: s.text }));
}

/** Canonical encoding. Throws INPUT_INVALID for anything parseEntry would reject. */
export function encodeEntry(entry: Entry): Uint8Array {
  const s = snapshot(entry);
  if (typeof s === "string") invalid(s);
  const reason = problem(s as Snapshot);
  if (reason) invalid(reason);
  const bytes = canonical(s as Snapshot);
  if (bytes.length > MAX_BYTES) invalid(`encoded entry is ${bytes.length} bytes, max ${MAX_BYTES}`);
  return bytes;
}

/**
 * Validates decrypted bytes. Authentic ciphertext can still hold junk from a granted writer, so only the
 * exact canonical encoding is accepted (no padding, BOM, duplicate keys, reordering, or number variants).
 */
export function parseEntry(bytes: Uint8Array): Entry {
  const fail = (reason: string, cause?: unknown): never => {
    throw new EngramCryptoError("ENTRY_INVALID", reason, { cause });
  };
  if (!(bytes instanceof Uint8Array)) return fail("entry must be bytes");
  if (bytes.length > MAX_BYTES) return fail(`entry is ${bytes.length} bytes, max ${MAX_BYTES}`);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    return fail("entry is not valid UTF-8 JSON", cause);
  }
  const s = snapshot(value);
  if (typeof s === "string") return fail(s);
  const reason = problem(s);
  if (reason) return fail(reason);
  const expected = canonical(s);
  if (expected.length !== bytes.length || expected.some((b, i) => b !== bytes[i])) {
    return fail("entry is not in canonical encoding");
  }
  return { v: 1, t: s.t as number, kind: s.kind as EntryKind, text: s.text as string };
}
