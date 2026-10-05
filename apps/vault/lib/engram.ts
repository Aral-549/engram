// Browser-side Engram configuration for the vault.
import { deployments, firstAvailable, graphqlSource, httpRelayer, logsSource, type EngramConfig, type MemorySource } from "@engram/sdk";

export const EXPLORER = "https://testnet.monadvision.com";
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`;

let config: EngramConfig | undefined;

export function vaultConfig(): EngramConfig {
  if (config) return config;
  const d = deployments.monadTestnet;
  const sources: MemorySource[] = [];
  const indexer = process.env.NEXT_PUBLIC_INDEXER_URL;
  if (indexer) sources.push(graphqlSource(indexer));
  // Fallback: read events straight from chain (Monad's public RPC allows 100-block getLogs ranges; slow but indexer-free).
  sources.push(logsSource({ rpcUrl: d.rpcUrl, registry: d.registry, fromBlock: d.deployBlock, chainId: d.chainId, blockRange: 100n }));
  config = {
    chainId: d.chainId,
    registry: d.registry,
    identityRegistry: d.identityRegistry,
    rpcUrl: d.rpcUrl,
    source: firstAvailable(sources),
    relayer: httpRelayer("/api/relay"),
    logger: (line) => console.debug("[engram] " + JSON.stringify(line)),
  };
  return config;
}

export const rpId = () => window.location.hostname;

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function expiresIn(unixSec: bigint, now = Date.now()): string {
  const s = Number(unixSec) - Math.floor(now / 1000);
  if (s <= 0) return "expired";
  if (s < 3600) return `${Math.ceil(s / 60)} min left`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h left`;
  return `${Math.round(s / 86400)} days left`;
}

/** Human message for SDK errors; never shows internals. */
export function explain(e: unknown): string {
  const code = (e as { code?: string })?.code;
  switch (code) {
    case "PRF_UNAVAILABLE":
      return (e as Error).message;
    case "PASSKEY_CANCELLED":
      return "The passkey prompt was cancelled. Try again when you are ready.";
    case "SESSION_EXPIRED":
    case "SESSION_ENDED":
      return "Your vault locked itself after inactivity.";
    case "RELAYER_UNAVAILABLE":
      return "Could not reach the network relay. Check your connection and try again.";
    case "AGENT_KEYS_NOT_CURRENT":
      return "This agent's keys are not current (its identity may have changed hands). Access was not granted.";
    case "REAUTH_MISMATCH":
      return "A different passkey answered. Approve with the passkey you unlocked the vault with.";
    case "INPUT_INVALID":
      return (e as Error).message;
    case "SOURCE_UNAVAILABLE":
      return "Memory indexer is unavailable or not configured. To read and view your memories on Monad, set NEXT_PUBLIC_INDEXER_URL.";
    default:
      return "Something went wrong. Nothing was shared.";
  }
}

/**
 * Re-runs a read until `done` holds (the indexer trails the chain by up to ~1 s). Returns the last result either way;
 * the SDK's completeness check against chain `nextSeq` is what `done` usually tests.
 */
export async function untilSettled<T>(read: () => Promise<T>, done: (v: T) => boolean, tries = 12, delayMs = 500): Promise<T> {
  let v = await read();
  for (let i = 1; i < tries && !done(v); i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    v = await read();
  }
  return v;
}
