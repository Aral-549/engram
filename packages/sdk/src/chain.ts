// Chain reads that decide access and keys (never taken from a MemorySource).
import type { Hex } from "viem";
import { identityRegistryAbi, memoryRegistryAbi } from "./abi.js";
import { clientsFor, type ChainConfig } from "./config.js";

export function chainReads(config: ChainConfig) {
  const { publicClient } = clientsFor(config);
  const read = <T>(functionName: string, args: readonly unknown[]) =>
    publicClient.readContract({ address: config.registry, abi: memoryRegistryAbi, functionName: functionName as never, args: args as never }) as Promise<T>;

  return {
    async namespace(owner: Hex, nsId: Hex) {
      const [exists, epoch, nextSeq] = await read<[boolean, bigint, bigint]>("namespaceOf", [owner, nsId]);
      return { exists, epoch, nextSeq };
    },
    grantees: (owner: Hex, nsId: Hex) => read<readonly bigint[]>("granteesOf", [owner, nsId]),
    async grant(owner: Hex, nsId: Hex, agentId: bigint) {
      const [scope, expiry] = await read<[number, bigint]>("grantOf", [owner, nsId, agentId]);
      return { scope: Number(scope), expiry };
    },
    isActive: (owner: Hex, nsId: Hex, agentId: bigint) => read<boolean>("isActive", [owner, nsId, agentId]),
    hasCurrentKeys: (agentId: bigint) => read<boolean>("hasCurrentKeys", [agentId]),
    async agentKeys(agentId: bigint) {
      const [x25519Pub, operator] = await read<[Hex, Hex]>("agentKeysOf", [agentId]);
      return { x25519Pub, operator };
    },
    async chainTime() {
      return (await publicClient.getBlock()).timestamp;
    },
    async tokenURI(agentId: bigint): Promise<string | undefined> {
      try {
        const uri = (await publicClient.readContract({ address: config.identityRegistry, abi: identityRegistryAbi, functionName: "tokenURI", args: [agentId] })) as string;
        return uri || undefined;
      } catch {
        return undefined;
      }
    },
  };
}
