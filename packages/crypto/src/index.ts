// @engram/crypto -- implements contracts/crypto.md. Pure functions: no network, storage, or logging.
export { EngramCryptoError, type EngramCryptoErrorCode } from "./errors.js";
export type { BindingContext, Hex } from "./encoding.js";
export { ROOT_SALT, deriveAccount, deriveAccountWith, deriveNamespaceId, deriveNamespaceKey, derivePairwise, type OwnerAccount, type PairwiseIdentity } from "./derive.js";
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
export { encodeEntryV2, parseAnyEntry, type AnyEntry, type EntryV2, type LogEntry, type LogItem, type LogsEntry, type MemoryEntryV2, type PolicyEntry, type ReviewEntry } from "./entry2.js";
