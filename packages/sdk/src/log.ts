import { EngramError } from "./errors.js";

/** One structured line per SDK stage boundary (AGENTS.md rule 5). Never contains plaintext, keys, or wraps. */
export type LogLine = { stage: "sdk"; side: "owner" | "client" | "agent" | "relay"; op: string; traceId: string; ok: boolean; [k: string]: unknown };
export type Logger = (line: LogLine) => void;

export const defaultLogger: Logger = (line) => console.debug(JSON.stringify(line));

export const traceId = (): string =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");

const jsonSafe = (fields: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map((x) => (typeof x === "bigint" ? x.toString() : x)) : v]));

/** Wraps an operation: logs exit with duration and ok/code. Rethrows the original error. */
export async function traced<T>(
  logger: Logger,
  side: LogLine["side"],
  op: string,
  fields: Record<string, unknown>,
  fn: (extra: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  const id = traceId();
  const extra: Record<string, unknown> = {};
  try {
    const out = await fn(extra);
    logger({ stage: "sdk", side, op, traceId: id, ok: true, durationMs: Date.now() - t0, ...jsonSafe(fields), ...jsonSafe(extra) });
    return out;
  } catch (e) {
    const code = e instanceof EngramError ? e.code : "UNEXPECTED";
    // Class name only for unexpected errors: messages from libraries can embed call arguments.
    const errorClass = e instanceof EngramError ? undefined : (e as { name?: string })?.name ?? typeof e;
    logger({ stage: "sdk", side, op, traceId: id, ok: false, code, errorClass, durationMs: Date.now() - t0, ...jsonSafe(fields), ...jsonSafe(extra) });
    throw e;
  }
}
