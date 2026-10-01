import { createPublicClient, defineChain, http, type Chain, type Hex, type PublicClient } from "viem";
import { monad, monadTestnet } from "viem/chains";
import type { Logger } from "./log.js";
import { defaultLogger } from "./log.js";
import type { MemorySource } from "./sources.js";
import type { Relayer } from "./relay.js";

/** Chain coordinates plus pluggable I/O (contracts/sdk.md "Inputs"). */
export type EngramConfig = {
  chainId: number;
  registry: Hex;
  identityRegistry: Hex;
  rpcUrl: string;
  /** Where entries, wraps, and grants are read from. Access and key decisions always use chain reads. */
  source: MemorySource;
  /** How owner actions reach the chain (gasless relay or direct). */
  relayer: Relayer;
  logger?: Logger;
};

export type ChainConfig = Pick<EngramConfig, "chainId" | "registry" | "identityRegistry" | "rpcUrl"> & { logger?: Logger };

const clients = new Map<string, { chain: Chain; publicClient: PublicClient }>();

export function chainFor(config: Pick<EngramConfig, "chainId" | "rpcUrl">): Chain {
  return clientsFor(config).chain;
}

export function clientsFor(config: Pick<EngramConfig, "chainId" | "rpcUrl">) {
  const key = `${config.chainId}|${config.rpcUrl}`;
  let c = clients.get(key);
  if (!c) {
    // Known Monad chains carry Multicall3, so concurrent contract reads are batched into one eth_call. Public RPCs
    // rate-limit bursts; batching plus retry with backoff keeps a page of reads to a few requests (BUGLOG V-RPC1).
    const known = config.chainId === monadTestnet.id ? monadTestnet : config.chainId === monad.id ? monad : undefined;
    const chain = known
      ? { ...known, rpcUrls: { default: { http: [config.rpcUrl] } } }
      : defineChain({
          id: config.chainId,
          name: `chain-${config.chainId}`,
          nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
          rpcUrls: { default: { http: [config.rpcUrl] } },
        });
    const transport = http(config.rpcUrl, { retryCount: 5, retryDelay: 300 });
    // viem polls receipts every 4 s by default; Monad finalizes in ~0.6 s, so poll at 250 ms.
    const publicClient = createPublicClient({
      chain,
      transport,
      pollingInterval: 250,
      batch: known ? { multicall: { wait: 16 } } : undefined,
    }) as PublicClient;
    c = { chain, publicClient };
    clients.set(key, c);
  }
  return c;
}

export const loggerOf = (config: { logger?: Logger }): Logger => config.logger ?? defaultLogger;
