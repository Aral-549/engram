import { EngramCryptoError } from "@engram/crypto";

export type EngramErrorCode =
  | "INPUT_INVALID"
  | "PRF_UNAVAILABLE"
  | "PASSKEY_CANCELLED"
  | "SESSION_ENDED"
  | "SESSION_EXPIRED"
  | "REAUTH_MISMATCH"
  | "ACCESS_REVOKED"
  | "NOT_AUTHORIZED"
  | "AGENT_KEYS_NOT_CURRENT"
  | "RELAYER_UNAVAILABLE"
  | "RELAY_REJECTED"
  | "TX_REVERTED"
  | "SOURCE_UNAVAILABLE"
  | "POPUP_BLOCKED"
  | "USER_CANCELLED"
  // Disclosure mode (contracts/disclosure.md)
  | "NOT_APPROVED"
  | "EXPIRED"
  | "BAD_REQUEST"
  | "RATE_LIMITED"
  | "READ_ONLY"
  | "QUOTA"
  | "VAULT_LOCKED"
  | "BRIDGE_TIMEOUT";

/** Every SDK failure is an EngramError with a stable code (contracts/sdk.md). Messages never carry key material. */
export class EngramError extends Error {
  readonly code: EngramErrorCode;
  /** Machine-readable detail, e.g. the relay handler's rejection code or a decoded contract error name. */
  readonly detail: string | undefined;

  constructor(code: EngramErrorCode, message: string, options?: { cause?: unknown; detail?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "EngramError";
    this.code = code;
    this.detail = options?.detail;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, detail: this.detail };
  }
}

export const fail = (code: EngramErrorCode, message: string, detail?: string): never => {
  throw new EngramError(code, message, { detail });
};

/** Runs `fn`, converting crypto-package input errors into EngramError so callers see one error type. */
export function crypto<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof EngramCryptoError && e.code === "INPUT_INVALID") throw new EngramError("INPUT_INVALID", e.message);
    throw e;
  }
}

export async function cryptoAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof EngramCryptoError && e.code === "INPUT_INVALID") throw new EngramError("INPUT_INVALID", e.message);
    throw e;
  }
}
