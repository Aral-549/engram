// @engram/crypto -- implements contracts/crypto.md. Pure functions: no network, storage, or logging.
export { EngramCryptoError, type EngramCryptoErrorCode } from "./errors.js";
export type { BindingContext, Hex } from "./encoding.js";
export { ROOT_SALT, deriveAccount, deriveAccountWith, deriveNamespaceId, deriveNamespaceKey, type OwnerAccount } from "./derive.js";
export {
  encryptEntry,
  decryptEntry,
  wrapNamespaceKey,
  unwrapNamespaceKey,
  generateAgentKeyPair,
  type EntryParams,
  type WrapParams,
} from "./envelope.js";
export { encodeEntry, parseEntry, type Entry, type EntryKind } from "./entry.js";
