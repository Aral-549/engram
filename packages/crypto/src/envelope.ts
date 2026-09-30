import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf32 } from "./derive.js";
import { EngramCryptoError, invalid } from "./errors.js";
import { assertLabel, concat, contextBytes, takeBytes, toEpoch, toUint256, uintBE, utf8, type BindingContext } from "./encoding.js";

const VERSION = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const MAX_PLAINTEXT = 2048;
const ENTRY_MIN = 1 + NONCE_LEN + 1 + TAG_LEN; // 30
const ENTRY_MAX = 1 + NONCE_LEN + MAX_PLAINTEXT + TAG_LEN; // 2077
const WRAP_MIN = 1 + 32 + NONCE_LEN + 32 + 1 + TAG_LEN; // 94
const WRAP_MAX = WRAP_MIN + 31; // 125, label <= 32 bytes

const X25519_P = 2n ** 255n - 19n;

const ENTRY_AAD_PREFIX = utf8("engram.v1/entry");
const WRAP_AAD_PREFIX = utf8("engram.v1/wrap");

export type EntryParams = {
  key: Uint8Array;
  ctx: BindingContext;
  nsId: Uint8Array;
  epoch: bigint | number;
};

export type WrapParams = {
  ctx: BindingContext;
  nsId: Uint8Array;
  epoch: bigint | number;
  agentId: bigint | number;
};

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new EngramCryptoError("INPUT_INVALID", "WebCrypto (crypto.subtle) is unavailable in this environment");
  return s;
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/**
 * All inputs here are already private copies taken with `takeBytes` (see BUGLOG B5, B6): every public
 * function captures and validates its parameters synchronously before its first `await`.
 */
async function aesGcm(op: "encrypt" | "decrypt", key: Uint8Array<ArrayBuffer>, nonce: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer>) {
  const k = await subtle().importKey("raw", key, "AES-GCM", false, [op]).finally(() => key.fill(0));
  try {
    return new Uint8Array(await subtle()[op]({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, k, data));
  } catch (cause) {
    throw new EngramCryptoError("DECRYPT_FAILED", "authentication failed: wrong key, context, or tampered data", { cause });
  }
}

function entryAad(ctx: BindingContext, nsId: Uint8Array, epoch: bigint | number): Uint8Array<ArrayBuffer> {
  return concat(ENTRY_AAD_PREFIX, contextBytes(ctx), nsId, uintBE(toEpoch(epoch), 8));
}

function wrapAad(ctx: BindingContext, nsId: Uint8Array, epoch: bigint | number, agentId: bigint | number): Uint8Array<ArrayBuffer> {
  return concat(WRAP_AAD_PREFIX, contextBytes(ctx), nsId, uintBE(toEpoch(epoch), 8), uintBE(toUint256(agentId, "agentId"), 32));
}

/** `0x01 || nonce(12) || AES-256-GCM(key, nonce, plaintext, aad)`. `nonce` is for test vectors only. */
export async function encryptEntry(p: EntryParams & { plaintext: Uint8Array; nonce?: Uint8Array }): Promise<Uint8Array> {
  const key = takeBytes(p.key, "key", 32);
  const nsId = takeBytes(p.nsId, "nsId", 32);
  const aad = entryAad(p.ctx, nsId, p.epoch);
  const plaintext = takeBytes(p.plaintext, "plaintext", 1, MAX_PLAINTEXT);
  const suppliedNonce = p.nonce;
  const nonce = suppliedNonce === undefined ? randomBytes(NONCE_LEN) : takeBytes(suppliedNonce, "nonce", NONCE_LEN);
  const ct = await aesGcm("encrypt", key, nonce, plaintext, aad);
  return concat(Uint8Array.of(VERSION), nonce, ct);
}

export async function decryptEntry(p: EntryParams & { envelope: Uint8Array }): Promise<Uint8Array> {
  const key = takeBytes(p.key, "key", 32);
  const nsId = takeBytes(p.nsId, "nsId", 32);
  const aad = entryAad(p.ctx, nsId, p.epoch);
  const env = takeBytes(p.envelope, "entry envelope", ENTRY_MIN, ENTRY_MAX, "ENVELOPE_INVALID");
  if (env[0] !== VERSION) throw new EngramCryptoError("ENVELOPE_INVALID", "not a v1 entry envelope");
  return aesGcm("decrypt", key, env.slice(1, 1 + NONCE_LEN), env.slice(1 + NONCE_LEN), aad);
}

/** RFC 7748 decoders mask the top bit and reduce mod p; a non-canonical key would still agree on the
 * shared secret but not on the KEK salt, so the agent could never unwrap (BUGLOG B1). */
function assertCanonicalX25519(pub: Uint8Array): void {
  if ((pub[31]! & 0x80) !== 0) invalid("agent public key is not canonical (top bit set)");
  let u = 0n;
  for (let i = 31; i >= 0; i--) u = (u << 8n) | BigInt(pub[i]!);
  if (u >= X25519_P) invalid("agent public key is not canonical (u >= 2^255-19)");
}

function sharedSecret(priv: Uint8Array, pub: Uint8Array, onFail: () => never): Uint8Array {
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(priv, pub);
  } catch {
    return onFail();
  }
  if (shared.every((b) => b === 0)) return onFail();
  return shared;
}

export function generateAgentKeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const { secretKey, publicKey } = x25519.keygen();
  return { privateKey: secretKey, publicKey };
}

/**
 * Wraps one namespace epoch key for one agent (X25519 + HKDF + AES-256-GCM).
 * `ephemeralPrivate` and `nonce` exist for test vectors only; production calls omit them.
 */
export async function wrapNamespaceKey(
  p: WrapParams & {
    nsKey: Uint8Array;
    label: string;
    agentX25519Public: Uint8Array;
    ephemeralPrivate?: Uint8Array;
    nonce?: Uint8Array;
  },
): Promise<Uint8Array> {
  const nsId = takeBytes(p.nsId, "nsId", 32);
  const aad = wrapAad(p.ctx, nsId, p.epoch, p.agentId);
  const nsKey = takeBytes(p.nsKey, "nsKey", 32);
  const label = p.label;
  assertLabel(label);
  const agentPub = takeBytes(p.agentX25519Public, "agentX25519Public", 32);
  assertCanonicalX25519(agentPub);
  const suppliedEph = p.ephemeralPrivate;
  const ephPriv = suppliedEph === undefined ? x25519.utils.randomSecretKey() : takeBytes(suppliedEph, "ephemeralPrivate", 32);
  const suppliedNonce = p.nonce;
  const nonce = suppliedNonce === undefined ? randomBytes(NONCE_LEN) : takeBytes(suppliedNonce, "nonce", NONCE_LEN);
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = sharedSecret(ephPriv, agentPub, () => invalid("agent public key is invalid or low-order"));
  const kek = hkdf32(shared, "engram.v1/wrap", concat(ephPub, agentPub));
  const body = concat(nsKey, utf8(label));
  shared.fill(0);
  ephPriv.fill(0);
  nsKey.fill(0);
  try {
    const ct = await aesGcm("encrypt", new Uint8Array(kek), nonce, body, aad);
    return concat(Uint8Array.of(VERSION), ephPub, nonce, ct);
  } finally {
    kek.fill(0);
    body.fill(0);
  }
}

export async function unwrapNamespaceKey(
  p: WrapParams & { envelope: Uint8Array; agentX25519Private: Uint8Array },
): Promise<{ nsKey: Uint8Array; label: string }> {
  const nsId = takeBytes(p.nsId, "nsId", 32);
  const aad = wrapAad(p.ctx, nsId, p.epoch, p.agentId);
  const priv = takeBytes(p.agentX25519Private, "agentX25519Private", 32);
  const env = takeBytes(p.envelope, "wrap envelope", WRAP_MIN, WRAP_MAX, "ENVELOPE_INVALID");
  if (env[0] !== VERSION) throw new EngramCryptoError("ENVELOPE_INVALID", "not a v1 wrap envelope");
  const ephPub = env.slice(1, 33);
  const agentPub = x25519.getPublicKey(priv);
  const shared = sharedSecret(priv, ephPub, () => {
    priv.fill(0);
    throw new EngramCryptoError("DECRYPT_FAILED", "wrap has an invalid ephemeral key");
  });
  priv.fill(0);
  const kek = hkdf32(shared, "engram.v1/wrap", concat(ephPub, agentPub));
  shared.fill(0);
  let pt: Uint8Array;
  try {
    pt = await aesGcm("decrypt", new Uint8Array(kek), env.slice(33, 33 + NONCE_LEN), env.slice(33 + NONCE_LEN), aad);
  } finally {
    kek.fill(0);
  }
  const label = new TextDecoder().decode(pt.subarray(32));
  const nsKey = pt.slice(0, 32);
  pt.fill(0);
  try {
    assertLabel(label);
  } catch {
    nsKey.fill(0);
    throw new EngramCryptoError("ENVELOPE_INVALID", "authenticated wrap carries an invalid label");
  }
  return { nsKey, label };
}
