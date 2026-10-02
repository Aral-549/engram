import { getEvmAddress, type EvmAddress } from "@category-labs/mera";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { assertLabel, takeBytes, toEpoch, utf8 } from "./encoding.js";
import { EngramCryptoError } from "./errors.js";

/** The only PRF salt Engram uses: sha256("engram.prf.v1"). One passkey ceremony per session. */
export const ROOT_SALT: Uint8Array = sha256(utf8("engram.prf.v1"));

const HKDF_SALT = utf8("engram.v1");
const SECP256K1_N = secp256k1.Point.CURVE().n;
const MAX_ACCOUNT_COUNTER = 255;

export type OwnerAccount = {
  /** secp256k1 private key. Keep in memory only; hand to a Mera signing session. */
  accountKey: Uint8Array;
  /** 65-byte uncompressed public key. */
  publicKey: Uint8Array;
  /** EIP-55 checksummed owner address. */
  owner: EvmAddress;
  /** HKDF counter that produced a valid scalar (0 in practice). */
  counter: number;
};

export function hkdf32(ikm: Uint8Array, info: string, salt: Uint8Array = HKDF_SALT): Uint8Array {
  return hkdf(sha256, ikm, salt, utf8(info), 32);
}

function takePrf(prfOutput: Uint8Array): Uint8Array<ArrayBuffer> {
  return takeBytes(prfOutput, "prfOutput", 32);
}

/**
 * Derives the owner's secp256k1 account from a candidate generator. Exposed so the retry path
 * (candidate is 0 or >= n) can be tested; application code uses {@link deriveAccount}.
 */
export function deriveAccountWith(candidate: (counter: number) => Uint8Array): OwnerAccount {
  for (let counter = 0; counter <= MAX_ACCOUNT_COUNTER; counter++) {
    const key = takeBytes(candidate(counter), "account key candidate", 32); // private copy (BUGLOG B5, B6)
    const scalar = BigInt("0x" + bytesToHex(key));
    if (scalar === 0n || scalar >= SECP256K1_N) {
      key.fill(0);
      continue;
    }
    const publicKey = secp256k1.getPublicKey(key, false);
    return { accountKey: key, publicKey, owner: getEvmAddress(publicKey), counter };
  }
  throw new EngramCryptoError("INPUT_INVALID", "no valid secp256k1 scalar after 256 candidates");
}

export function deriveAccount(prfOutput: Uint8Array): OwnerAccount {
  const prf = takePrf(prfOutput);
  try {
    return deriveAccountWith((counter) => hkdf32(prf, `engram.v1/account/secp256k1/${counter}`));
  } finally {
    prf.fill(0);
  }
}

/** Opaque onchain namespace id: reveals nothing about the label. */
export function deriveNamespaceId(prfOutput: Uint8Array, label: string): Uint8Array {
  const prf = takePrf(prfOutput);
  assertLabel(label);
  return hkdf32(prf, `engram.v1/nsid/${label}`);
}

/** AES-256-GCM key for one namespace epoch. Reconstructible from the passkey alone. */
export function deriveNamespaceKey(prfOutput: Uint8Array, label: string, epoch: bigint | number): Uint8Array {
  const prf = takePrf(prfOutput);
  assertLabel(label);
  return hkdf32(prf, `engram.v1/nskey/${label}/${toEpoch(epoch).toString(10)}`);
}

export type PairwiseIdentity = { key: Uint8Array; address: EvmAddress; counter: number };
const UINT256_MAX = (1n << 256n) - 1n;

/**
 * Per-agent pseudonymous secp256k1 identity (contracts/crypto.md, Disclosure mode). Stable across devices, distinct
 * per agent, never used onchain. An agent sees only this address, so agents cannot correlate one user.
 */
export function derivePairwise(prfOutput: Uint8Array, agentId: bigint): PairwiseIdentity {
  if (typeof agentId !== "bigint" || agentId < 0n || agentId > UINT256_MAX) throw new EngramCryptoError("INPUT_INVALID", "agentId must be a uint256 bigint");
  const prf = takePrf(prfOutput);
  try {
    const a = deriveAccountWith((counter) => hkdf32(prf, `engram.v1/pairwise/secp256k1/${agentId.toString(10)}/${counter}`));
    return { key: a.accountKey, address: a.owner, counter: a.counter };
  } finally {
    prf.fill(0);
  }
}
