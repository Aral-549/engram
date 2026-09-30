export type EngramCryptoErrorCode = "INPUT_INVALID" | "DECRYPT_FAILED" | "ENVELOPE_INVALID" | "ENTRY_INVALID";

/** Every failure in this package is an EngramCryptoError with a stable code (contracts/crypto.md). */
export class EngramCryptoError extends Error {
  readonly code: EngramCryptoErrorCode;

  constructor(code: EngramCryptoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EngramCryptoError";
    this.code = code;
  }
}

export const invalid = (message: string): never => {
  throw new EngramCryptoError("INPUT_INVALID", message);
};
