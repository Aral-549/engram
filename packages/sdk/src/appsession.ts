// App sessions (contracts/sdk.md "App client", cases 43-47). A grant says WHAT an agent may read; an app session
// proves WHO is asking the app: an EIP-712 signature by the owner key, made inside the vault (no extra prompt).
import { getAddress, isAddress, recoverTypedDataAddress, type Hex } from "viem";
import type { ChainConfig } from "./config.js";
import { EngramError } from "./errors.js";

export type AppSessionProof = { owner: Hex; agentId: string; origin: string; issuedAt: string; expiresAt: string; signature: Hex };

export const APP_SESSION_TYPES = {
  AppSession: [
    { name: "owner", type: "address" },
    { name: "agentId", type: "uint256" },
    { name: "origin", type: "string" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export const APP_SESSION_MAX_TTL_SEC = 30 * 86400;
const CLOCK_SKEW_SEC = 60;
const CANON = /^(0|[1-9]\d{0,77})$/;

export const appSessionDomain = (config: Pick<ChainConfig, "chainId" | "registry">) =>
  ({ name: "EngramAppSession", version: "1", chainId: config.chainId, verifyingContract: config.registry }) as const;

/** Exact http(s) origin (scheme://host[:port], no path), or undefined. */
export function exactOrigin(o: unknown): string | undefined {
  if (typeof o !== "string") return undefined;
  try {
    const u = new URL(o);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin === o ? o : undefined;
  } catch {
    return undefined;
  }
}

const denied = () => new EngramError("NOT_AUTHORIZED", "this app session is not valid for this app");

/**
 * App server: returns the owner address if `proof` was signed by that owner for this agent and origin and is
 * current. Throws NOT_AUTHORIZED otherwise. A valid proof is identity only; memory access still needs a grant.
 */
export async function verifyAppSession(
  proof: unknown,
  opts: { config: Pick<ChainConfig, "chainId" | "registry">; agentId: bigint; origin: string; now?: number },
): Promise<Hex> {
  const p = proof as Partial<AppSessionProof> | null;
  if (
    !p || typeof p !== "object" ||
    typeof p.owner !== "string" || !isAddress(p.owner) ||
    typeof p.agentId !== "string" || !CANON.test(p.agentId) ||
    typeof p.issuedAt !== "string" || !CANON.test(p.issuedAt) ||
    typeof p.expiresAt !== "string" || !CANON.test(p.expiresAt) ||
    typeof p.origin !== "string" || typeof p.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(p.signature)
  ) {
    throw denied();
  }
  const issuedAt = BigInt(p.issuedAt);
  const expiresAt = BigInt(p.expiresAt);
  const now = BigInt(Math.floor((opts.now ?? Date.now()) / 1000));
  if (BigInt(p.agentId) !== opts.agentId || p.origin !== opts.origin) throw denied();
  if (expiresAt <= now || issuedAt > now + BigInt(CLOCK_SKEW_SEC) || expiresAt - issuedAt > BigInt(APP_SESSION_MAX_TTL_SEC)) throw denied();
  let signer: Hex;
  try {
    signer = await recoverTypedDataAddress({
      domain: appSessionDomain(opts.config), types: APP_SESSION_TYPES, primaryType: "AppSession",
      message: { owner: p.owner as Hex, agentId: opts.agentId, origin: p.origin, issuedAt, expiresAt },
      signature: p.signature as Hex,
    });
  } catch {
    throw denied();
  }
  if (signer.toLowerCase() !== p.owner.toLowerCase()) throw denied();
  return getAddress(p.owner);
}
