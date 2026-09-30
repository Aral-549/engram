// A deterministic stand-in for a synced passkey provider (iCloud Keychain, 1Password), implementing Mera's
// WebAuthnClient interface so the real Mera ceremony code runs in tests. Not a golden file.
//
// PRF(credential, rpId, salt) = HMAC-SHA256(credentialSecret, rpId || salt): same credential + rpId + salt gives the
// same 32 bytes on every "device" that shares the store, different salt or rpId gives unrelated output.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { WebAuthnClient } from "@category-labs/mera";

type Credential = { id: Uint8Array; secret: Uint8Array; rpId: string };

export class FakeAuthenticator {
  readonly credentials: Credential[] = [];
  calls = { create: 0, get: 0 };
  /** Simulate an authenticator/browser without the PRF extension. */
  prfSupported = true;
  /** Make the next ceremony fail like a user pressing cancel. */
  cancelNext = false;
  /** When set, `get` answers with this credential index instead of the first match. */
  answerWith: number | undefined;
  private counter = 0;

  constructor(private readonly seed = "engram-test") {}

  /** A second "device" syncing the same credential store (same secrets). */
  syncedDevice(): FakeAuthenticator {
    const other = new FakeAuthenticator(this.seed);
    other.credentials.push(...this.credentials);
    return other;
  }

  private prf(c: Credential, rpId: string, salt: Uint8Array): Uint8Array {
    return hmac(sha256, c.secret, new Uint8Array([...new TextEncoder().encode(rpId), ...salt]));
  }

  private checkCancel() {
    if (this.cancelNext) {
      this.cancelNext = false;
      throw new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
    }
  }

  readonly client: WebAuthnClient = {
    createCredential: async (req) => {
      this.calls.create++;
      this.checkCancel();
      const n = this.counter++;
      const id = sha256(new TextEncoder().encode(`${this.seed}/id/${n}`));
      const secret = sha256(new TextEncoder().encode(`${this.seed}/secret/${n}`));
      const cred = { id, secret, rpId: req.rp.id };
      this.credentials.push(cred);
      return {
        credentialId: id,
        transports: ["internal"],
        prfEnabled: this.prfSupported,
        prfOutput: this.prfSupported ? this.prf(cred, req.rp.id, req.prfSalt) : undefined,
      };
    },
    getCredential: async (req) => {
      this.calls.get++;
      this.checkCancel();
      const matching = this.credentials.filter((c) => c.rpId === req.rpId);
      const cred = this.answerWith !== undefined ? matching[this.answerWith] : matching[0];
      if (!cred) throw new DOMException("No credentials available.", "NotAllowedError");
      return { credentialId: cred.id, prfOutput: this.prfSupported ? this.prf(cred, req.rpId, req.prfSalt) : undefined };
    },
  };
}
