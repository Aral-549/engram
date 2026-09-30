import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf32 } from "./derive.js";
import { EngramCryptoError, invalid } from "./errors.js";
import { assertBytes, assertLabel, concat, contextBytes, toEpoch, toUint256, uintBE, utf8, type BindingContext } from "./encoding.js";

const VERSION = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const MAX_PLAINTEXT = 2048;
const ENTRY_MIN = 1 + NONCE_LEN + 1 + TAG_LEN; // 30
const ENTRY_MAX = 1 + NONCE_LEN + MAX_PLAINTEXT + TAG_LEN; // 2077
const WRAP_MIN = 1 + 32 + NONCE_LEN + 32 + 1 + TAG_LEN; // 94
const WRAP_MAX = WRAP_MIN + 31; // 125, label <= 32 bytes

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

async function aesGcm(op: "encrypt" | "decrypt", key: Uint8Array, nonce: Uint8Array, data: Uint8Array, aad: Uint8Array) {
  const k = await subtle().importKey("raw", key.slice(), "AES-GCM", false, [op]);
  const params = { name: "AES-GCM", iv: nonce.slice(), additionalData: aad.slice(), tagLength: 128 };
  try {
    return new Uint8Array(await subtle()[op](params, k, data.slice()));
  } catch (cause) {
    throw new EngramCryptoError("DECRYPT_FAILED", "authentication failed: wrong key, context, or tampered data", { cause });
  }
}

function entryAad(p: EntryParams): Uint8Array<ArrayBuffer> {
  assertBytes(p.key, 32, "key");
  assertBytes(p.nsId, 32, "nsId");
  return concat(ENTRY_AAD_PREFIX, contextBytes(p.ctx), p.nsId, uintBE(toEpoch(p.epoch), 8));
}

function wrapAad(p: WrapParams): Uint8Array<ArrayBuffer> {
  assertBytes(p.nsId, 32, "nsId");
  return concat(
    WRAP_AAD_PREFIX,
    contextBytes(p.ctx),
    p.nsId,
    uintBE(toEpoch(p.epoch), 8),
    uintBE(toUint256(p.agentId, "agentId"), 32),
  );
}

/** `0x01 || nonce(12) || AES-256-GCM(key, nonce, plaintext, aad)`. `nonce` is for test vectors only. */
export async function encryptEntry(p: EntryParams & { plaintext: Uint8Array; nonce?: Uint8Array }): Promise<Uint8Array> {
  const aad = entryAad(p);
  if (!(p.plaintext instanceof Uint8Array) || p.plaintext.length < 1 || p.plaintext.length > MAX_PLAINTEXT) {
    invalid(`plaintext must be 1..${MAX_PLAINTEXT} bytes`);
  }
  const nonce = p.nonce ?? randomBytes(NONCE_LEN);
  assertBytes(nonce, NONCE_LEN, "nonce");
  const ct = await aesGcm("encrypt", p.key, nonce, p.plaintext, aad);
  return concat(Uint8Array.of(VERSION), nonce, ct);
}

export async function decryptEntry(p: EntryParams & { envelope: Uint8Array }): Promise<Uint8Array> {
  const aad = entryAad(p);
  const env = p.envelope;
  if (!(env instanceof Uint8Array) || env.length < ENTRY_MIN || env.length > ENTRY_MAX || env[0] !== VERSION) {
    throw new EngramCryptoError("ENVELOPE_INVALID", "not a v1 entry envelope");
  }
  return aesGcm("decrypt", p.key, env.subarray(1, 1 + NONCE_LEN), env.subarray(1 + NONCE_LEN), aad);
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
  const aad = wrapAad(p);
  assertBytes(p.nsKey, 32, "nsKey");
  assertLabel(p.label);
  assertBytes(p.agentX25519Public, 32, "agentX25519Public");
  const ephPriv = p.ephemeralPrivate ?? x25519.utils.randomSecretKey();
  assertBytes(ephPriv, 32, "ephemeralPrivate");
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = sharedSecret(ephPriv, p.agentX25519Public, () => invalid("agent public key is invalid or low-order"));
  const kek = hkdf32(shared, "engram.v1/wrap", concat(ephPub, p.agentX25519Public));
  const nonce = p.nonce ?? randomBytes(NONCE_LEN);
  assertBytes(nonce, NONCE_LEN, "nonce");
  try {
    const ct = await aesGcm("encrypt", kek, nonce, concat(p.nsKey, utf8(p.label)), aad);
    return concat(Uint8Array.of(VERSION), ephPub, nonce, ct);
  } finally {
    shared.fill(0);
    kek.fill(0);
    if (!p.ephemeralPrivate) ephPriv.fill(0);
  }
}

export async function unwrapNamespaceKey(
  p: WrapParams & { envelope: Uint8Array; agentX25519Private: Uint8Array },
): Promise<{ nsKey: Uint8Array; label: string }> {
  const aad = wrapAad(p);
  assertBytes(p.agentX25519Private, 32, "agentX25519Private");
  const env = p.envelope;
  if (!(env instanceof Uint8Array) || env.length < WRAP_MIN || env.length > WRAP_MAX || env[0] !== VERSION) {
    throw new EngramCryptoError("ENVELOPE_INVALID", "not a v1 wrap envelope");
  }
  const ephPub = env.subarray(1, 33);
  const agentPub = x25519.getPublicKey(p.agentX25519Private);
  const shared = sharedSecret(p.agentX25519Private, ephPub, () => {
    throw new EngramCryptoError("DECRYPT_FAILED", "wrap has an invalid ephemeral key");
  });
  const kek = hkdf32(shared, "engram.v1/wrap", concat(ephPub, agentPub));
  let pt: Uint8Array;
  try {
    pt = await aesGcm("decrypt", kek, env.subarray(33, 33 + NONCE_LEN), env.subarray(33 + NONCE_LEN), aad);
  } finally {
    shared.fill(0);
    kek.fill(0);
  }
  const label = new TextDecoder().decode(pt.subarray(32));
  try {
    assertLabel(label);
  } catch {
    throw new EngramCryptoError("ENVELOPE_INVALID", "authenticated wrap carries an invalid label");
  }
  return { nsKey: pt.slice(0, 32), label };
}
