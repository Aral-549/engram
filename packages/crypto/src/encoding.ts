import { EngramCryptoError, invalid, type EngramCryptoErrorCode } from "./errors.js";

export type Hex = `0x${string}`;

/** Binds ciphertext to one deployment and one owner (AAD). */
export type BindingContext = {
  chainId: bigint | number;
  registry: Hex;
  owner: Hex;
};

const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT64_MAX = 2n ** 64n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;

export const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function uintBE(value: bigint, byteLength: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(byteLength);
  let v = value;
  for (let i = byteLength - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Takes a byte input exactly once: copies it synchronously into fresh memory (`new Uint8Array(x)`, never
 * `.slice()`, which returns a view for Node Buffers) and validates the COPY's
 * real length (never the input's `.length` getter). Callers then use only the returned copy, so later
 * mutation, resizing, or zeroing of the input cannot change what is validated or used (BUGLOG B5, B6).
 */
export function takeBytes(
  value: unknown,
  name: string,
  min: number,
  max: number = min,
  code: EngramCryptoErrorCode = "INPUT_INVALID",
): Uint8Array<ArrayBuffer> {
  const fail = (): never => {
    throw new EngramCryptoError(code, min === max ? `${name} must be ${min} bytes` : `${name} must be ${min}..${max} bytes`);
  };
  if (!(value instanceof Uint8Array)) return fail();
  let copy: Uint8Array<ArrayBuffer>;
  try {
    copy = new Uint8Array(value);
  } catch {
    return fail();
  }
  if (copy.byteLength < min || copy.byteLength > max) return fail();
  return copy;
}

export function assertLabel(label: string): void {
  if (typeof label !== "string" || !LABEL_RE.test(label)) {
    invalid("label must match ^[a-z0-9][a-z0-9-]{0,31}$ (no normalization is applied)");
  }
}

export function toEpoch(epoch: bigint | number): bigint {
  if (typeof epoch === "number") {
    if (!Number.isSafeInteger(epoch) || epoch < 0) invalid("epoch must be a non-negative integer");
    return BigInt(epoch);
  }
  if (typeof epoch !== "bigint" || epoch < 0n || epoch > UINT64_MAX) invalid("epoch must be in 0..2^64-1");
  return epoch;
}

export function toUint256(value: bigint | number, name: string): bigint {
  const v = typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : value;
  if (typeof v !== "bigint" || v < 0n || v > UINT256_MAX) invalid(`${name} must be in 0..2^256-1`);
  return v as bigint;
}

export function addressBytes(address: string, name: string): Uint8Array<ArrayBuffer> {
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) invalid(`${name} must be a 20-byte 0x address`);
  return new Uint8Array(address.slice(2).match(/../g)!.map((b) => parseInt(b, 16)));
}

/** chainId (32) || registry (20) || owner (20), shared prefix of entry and wrap AAD. */
export function contextBytes(ctx: BindingContext): Uint8Array<ArrayBuffer> {
  if (ctx === null || typeof ctx !== "object") invalid("ctx is required");
  return concat(
    uintBE(toUint256(ctx.chainId, "chainId"), 32),
    addressBytes(ctx.registry, "registry"),
    addressBytes(ctx.owner, "owner"),
  );
}
