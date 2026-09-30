import { createPublicClient, defineChain, http, type Chain, type Hex, type PublicClient } from "viem";
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
    const chain = defineChain({
      id: config.chainId,
      name: config.chainId === 10143 ? "Monad Testnet" : config.chainId === 143 ? "Monad" : `chain-${config.chainId}`,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });
    c = { chain, publicClient: createPublicClient({ chain, transport: http(config.rpcUrl) }) as PublicClient };
    clients.set(key, c);
  }
  return c;
}

export const loggerOf = (config: { logger?: Logger }): Logger => config.logger ?? defaultLogger;
