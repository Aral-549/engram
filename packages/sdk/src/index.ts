// @engram/sdk -- implements contracts/sdk.md.
export { EngramError, type EngramErrorCode } from "./errors.js";
export type { Logger, LogLine } from "./log.js";
export type { EngramConfig, ChainConfig } from "./config.js";
export { deployments } from "./deployments.js";
export { memoryRegistryAbi, identityRegistryAbi } from "./abi.js";
export { logsSource, graphqlSource, firstAvailable, type MemorySource, type SourceEntry, type SourceGrant, type SourceWrap } from "./sources.js";
export {
  createRelayHandler,
  httpRelayer,
  inProcessRelayer,
  signOwnerCall,
  RELAYABLE,
  type RelayHandler,
  type RelayRequest,
  type RelayResponse,
  type Relayer,
} from "./relay.js";
export {
  EngramOwner,
  OwnerSession,
  SESSION_IDLE_MS,
  REAUTH_WINDOW_MS,
  type GrantScope,
  type GrantView,
  type RecallResult,
  type RecalledEntry,
} from "./owner.js";
export { EngramAgent, isCanonicalX25519, type InboxItem } from "./agent.js";
export {
  connectEngram,
  parseConnectRequest,
  replyToOpener,
  CONNECT_MESSAGE_TYPE,
  type AgentCard,
  type ConnectMessage,
  type ConnectRequest,
  type ConnectResult,
} from "./connect.js";
export { verifyAppSession, exactOrigin, APP_SESSION_MAX_TTL_SEC, type AppSessionProof } from "./appsession.js";
