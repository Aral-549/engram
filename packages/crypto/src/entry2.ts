// Entry documents v2 (contracts/crypto.md "Additions for Disclosure mode"): agent-proposed memories, approval
// policies and the disclosure log. Same rules as v1: strict keys, canonical bytes only, at most 2048 bytes.
// v1 parseEntry is untouched and keeps rejecting v2; parseAnyEntry reads both.
import { EngramCryptoError, invalid } from "./errors.js";
import { utf8 } from "./encoding.js";
import { parseEntry, type Entry, type EntryKind } from "./entry.js";

export type MemoryEntryV2 = { v: 2; t: number; kind: EntryKind; text: string; src: { agent: string } };
export type PolicyEntry = { v: 2; t: number; kind: "policy"; agent: string; origin: string; labels: string[]; scope: "read" | "readwrite"; exp: number; active: boolean };
export type LogEntry = {
  v: 2; t: number; kind: "log"; agent: string; origin: string; q: string; mode: "relevant" | "full" | "write";
  refs: { l: string; s: string }[]; n: number; round: number;
};
/** One read in a batched log (disclosure.md D35): the log fields without v/kind, with their own timestamp. */
export type LogItem = Omit<LogEntry, "v" | "kind">;
export type LogsEntry = { v: 2; t: number; kind: "logs"; items: LogItem[] };
/** The owner's verdict on one agent proposal (contracts/provenance.md). `copy` is the confirmed copy's seq. */
export type ReviewEntry =
  | { v: 2; t: number; kind: "review"; target: { l: string; s: string }; agent: string; action: "confirm"; copy: string }
  | { v: 2; t: number; kind: "review"; target: { l: string; s: string }; agent: string; action: "reject" };
/** Batched rejections (provenance.md P20): one record for up to 50 proposals of one agent. */
export type ReviewsEntry = { v: 2; t: number; kind: "reviews"; agent: string; action: "reject"; targets: { l: string; s: string }[] };
export type EntryV2 = MemoryEntryV2 | PolicyEntry | LogEntry | LogsEntry | ReviewEntry | ReviewsEntry;
export type AnyEntry = Entry | EntryV2;

const MAX_BYTES = 2048;
const UINT256_MAX = (1n << 256n) - 1n;
const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DEC_RE = /^(0|[1-9][0-9]*)$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MEMORY_KINDS = ["fact", "preference", "note"];

type Doc = Record<string, unknown>;
const isObj = (v: unknown): v is Doc => v !== null && typeof v === "object" && !Array.isArray(v);
const sameKeys = (o: Doc, keys: string[]) => {
  const k = Object.keys(o).sort();
  const want = [...keys].sort();
  return k.length === want.length && k.every((x, i) => x === want[i]);
};
const nonNegInt = (v: unknown, max = Number.MAX_SAFE_INTEGER) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
const decimal = (v: unknown) => typeof v === "string" && v.length <= 78 && DEC_RE.test(v) && BigInt(v) <= UINT256_MAX;
const text = (v: unknown, min: number, max: number) =>
  typeof v === "string" && !LONE_SURROGATE.test(v) && [...v].length >= min && [...v].length <= max;
const label = (v: unknown) => typeof v === "string" && LABEL_RE.test(v) && !v.startsWith("engram-");
function exactOrigin(v: unknown): boolean {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin === v;
  } catch {
    return false;
  }
}

/** Validates any v2 document and returns it rebuilt in canonical key order, or a reason string. */
function canonicalV2(d: unknown): EntryV2 | string {
  if (!isObj(d)) return "entry must be a JSON object";
  // Read each field once into a plain snapshot (BUGLOG B4).
  const s: Doc = { ...d };
  if (s.v !== 2) return "v must be 2";
  if (!nonNegInt(s.t)) return "t must be a non-negative integer (unix ms)";
  if (typeof s.kind !== "string") return "kind must be a string";
  if (MEMORY_KINDS.includes(s.kind)) {
    if (!sameKeys(s, ["v", "t", "kind", "text", "src"])) return "memory v2 must have exactly v, t, kind, text, src";
    if (!text(s.text, 1, 1500)) return "text must be 1..1500 well-formed code points";
    const src = isObj(s.src) ? { ...s.src } : null;
    if (!src || !sameKeys(src, ["agent"]) || !decimal(src.agent)) return "src must be {agent: decimal uint256}";
    return { v: 2, t: s.t as number, kind: s.kind as EntryKind, text: s.text as string, src: { agent: src.agent as string } };
  }
  if (s.kind === "policy") {
    if (!sameKeys(s, ["v", "t", "kind", "agent", "origin", "labels", "scope", "exp", "active"])) return "policy has wrong keys";
    if (!decimal(s.agent)) return "agent must be a decimal uint256";
    if (!exactOrigin(s.origin)) return "origin must be an exact http(s) origin";
    const labels = Array.isArray(s.labels) ? [...s.labels] : null;
    if (!labels || labels.length < 1 || labels.length > 8 || !labels.every(label) || new Set(labels).size !== labels.length) {
      return "labels must be 1..8 unique, non-reserved labels";
    }
    if (s.scope !== "read" && s.scope !== "readwrite") return "scope must be read or readwrite";
    if (!nonNegInt(s.exp)) return "exp must be a non-negative integer (unix ms)";
    if (typeof s.active !== "boolean") return "active must be a boolean";
    return { v: 2, t: s.t as number, kind: "policy", agent: s.agent as string, origin: s.origin as string, labels: labels as string[], scope: s.scope, exp: s.exp as number, active: s.active };
  }
  if (s.kind === "reviews") {
    if (!sameKeys(s, ["v", "t", "kind", "agent", "action", "targets"])) return "reviews has wrong keys";
    if (!decimal(s.agent)) return "agent must be a decimal uint256";
    if (s.action !== "reject") return "a reviews batch can only reject";
    const ts = Array.isArray(s.targets) ? [...s.targets] : null;
    if (!ts || ts.length < 1 || ts.length > 50) return "targets must be 1..50";
    const out: { l: string; s: string }[] = [];
    for (const t of ts) {
      const x = isObj(t) ? { ...t } : null;
      if (!x || !sameKeys(x, ["l", "s"]) || !label(x.l) || !decimal(x.s)) return "each target must be {l: label, s: decimal seq}";
      out.push({ l: x.l as string, s: x.s as string });
    }
    return { v: 2, t: s.t as number, kind: "reviews", agent: s.agent as string, action: "reject", targets: out };
  }
  if (s.kind === "review") {
    const confirm = s.action === "confirm";
    if (!sameKeys(s, confirm ? ["v", "t", "kind", "target", "agent", "action", "copy"] : ["v", "t", "kind", "target", "agent", "action"])) return "review has wrong keys";
    if (!confirm && s.action !== "reject") return "action must be confirm or reject";
    const tg = isObj(s.target) ? { ...s.target } : null;
    if (!tg || !sameKeys(tg, ["l", "s"]) || !label(tg.l) || !decimal(tg.s)) return "target must be {l: label, s: decimal seq}";
    if (!decimal(s.agent)) return "agent must be a decimal uint256";
    const target = { l: tg.l as string, s: tg.s as string };
    if (confirm) {
      if (!decimal(s.copy)) return "copy must be a decimal seq";
      return { v: 2, t: s.t as number, kind: "review", target, agent: s.agent as string, action: "confirm", copy: s.copy as string };
    }
    return { v: 2, t: s.t as number, kind: "review", target, agent: s.agent as string, action: "reject" };
  }
  if (s.kind === "logs") {
    if (!sameKeys(s, ["v", "t", "kind", "items"])) return "logs has wrong keys";
    const items = Array.isArray(s.items) ? [...s.items] : null;
    if (!items || items.length < 1 || items.length > 20) return "items must be 1..20 log items";
    const out: LogItem[] = [];
    for (const it of items) {
      if (!isObj(it) || !sameKeys(it, ["t", "agent", "origin", "q", "mode", "refs", "n", "round"])) return "each log item has wrong keys";
      const c = logFields({ ...it });
      if (typeof c === "string") return c;
      out.push(c);
    }
    return { v: 2, t: s.t as number, kind: "logs", items: out };
  }
  if (s.kind === "log") {
    if (!sameKeys(s, ["v", "t", "kind", "agent", "origin", "q", "mode", "refs", "n", "round"])) return "log has wrong keys";
    const c = logFields(s);
    if (typeof c === "string") return c;
    return { v: 2, t: c.t, kind: "log", agent: c.agent, origin: c.origin, q: c.q, mode: c.mode, refs: c.refs, n: c.n, round: c.round }; // spec key order
  }
  return "unknown v2 kind";
}

/** Shared field rules of a log record (`log` entries and `logs` items), rebuilt in canonical key order. */
function logFields(s: Doc): LogItem | string {
  {
    if (!nonNegInt(s.t)) return "t must be a non-negative integer (unix ms)";
    if (!decimal(s.agent)) return "agent must be a decimal uint256";
    if (!exactOrigin(s.origin)) return "origin must be an exact http(s) origin";
    if (!text(s.q, 0, 200)) return "q must be 0..200 well-formed code points";
    if (s.mode !== "relevant" && s.mode !== "full" && s.mode !== "write") return "mode must be relevant, full or write";
    const refs = Array.isArray(s.refs) ? [...s.refs] : null;
    if (!refs || refs.length > 20) return "refs must be an array of at most 20";
    const out: { l: string; s: string }[] = [];
    for (const r of refs) {
      const x = isObj(r) ? { ...r } : null;
      if (!x || !sameKeys(x, ["l", "s"]) || !label(x.l) || !decimal(x.s)) return "each ref must be {l: label, s: decimal seq}";
      out.push({ l: x.l as string, s: x.s as string });
    }
    if (!nonNegInt(s.n, 20)) return "n must be an integer 0..20";
    if (!nonNegInt(s.round, 3)) return "round must be an integer 0..3";
    return { t: s.t as number, agent: s.agent as string, origin: s.origin as string, q: s.q as string, mode: s.mode as LogItem["mode"], refs: out, n: s.n as number, round: s.round as number };
  }
}

/** Canonical bytes of a v2 document. Throws INPUT_INVALID for anything parseAnyEntry would reject. */
export function encodeEntryV2(doc: EntryV2): Uint8Array {
  const c = canonicalV2(doc);
  if (typeof c === "string") invalid(c);
  const bytes = utf8(JSON.stringify(c));
  if (bytes.length > MAX_BYTES) invalid(`encoded entry is ${bytes.length} bytes, max ${MAX_BYTES}`);
  return bytes;
}

/** Reads a decrypted v1 or v2 document. Only the exact canonical encoding is accepted. */
export function parseAnyEntry(input: Uint8Array): AnyEntry {
  const fail = (reason: string, cause?: unknown): never => {
    throw new EngramCryptoError("ENTRY_INVALID", reason, { cause });
  };
  if (!(input instanceof Uint8Array)) return fail("entry must be bytes");
  const bytes = new Uint8Array(input); // private copy before any use (BUGLOG B5)
  if (bytes.length > MAX_BYTES) return fail(`entry is ${bytes.length} bytes, max ${MAX_BYTES}`);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    return fail("entry is not valid UTF-8 JSON", cause);
  }
  if (isObj(value) && value.v === 1) return parseEntry(bytes);
  const c = canonicalV2(value);
  if (typeof c === "string") return fail(c);
  const expected = utf8(JSON.stringify(c));
  if (expected.length !== bytes.length || expected.some((b, i) => b !== bytes[i])) return fail("entry is not in canonical encoding");
  return c;
}
