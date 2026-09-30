// Local chain for SDK tests: starts anvil and deploys the REAL compiled contracts from chain/out
// (MemoryRegistry + the MockIdentity ERC-721 standing in for ERC-8004). Not a golden file.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Anvil's well-known dev keys (public, local-only).
export const ANVIL_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
];

const root = new URL("../../", import.meta.url);
const artifact = (path: string) => JSON.parse(readFileSync(new URL(`chain/out/${path}`, root), "utf8"));

export type LocalChain = Awaited<ReturnType<typeof startLocalChain>>;

export async function startLocalChain(port = 18545 + Math.floor(Math.random() * 1000)) {
  const rpcUrl = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn(`${homedir()}/.config/.foundry/bin/anvil`, ["--port", String(port), "--silent", "--hardfork", "prague"], { stdio: "ignore" });
  const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  for (let i = 0; i < 100; i++) {
    try {
      await publicClient.getBlockNumber();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const wallet = (i: number) => createWalletClient({ chain, transport, account: privateKeyToAccount(ANVIL_KEYS[i]!) });
  const test = createTestClient({ chain, transport, mode: "anvil" });

  const deployer = wallet(0);
  const mock = artifact("MockIdentity.sol/MockIdentity.json");
  const reg = artifact("MemoryRegistry.sol/MemoryRegistry.json");
  const idHash = await deployer.deployContract({ abi: mock.abi, bytecode: mock.bytecode.object });
  const identityRegistry = (await publicClient.waitForTransactionReceipt({ hash: idHash })).contractAddress!;
  const regHash = await deployer.deployContract({ abi: reg.abi, bytecode: reg.bytecode.object, args: [identityRegistry] });
  const registry = (await publicClient.waitForTransactionReceipt({ hash: regHash })).contractAddress!;

  return {
    rpcUrl,
    chain,
    publicClient,
    wallet,
    test,
    registry: registry as Hex,
    identityRegistry: identityRegistry as Hex,
    identityAbi: mock.abi,
    /** Mint an ERC-8004 stand-in token to `to` (anyone may mint on the mock). */
    async mintAgent(agentId: bigint, to: Hex) {
      const h = await deployer.writeContract({ address: identityRegistry, abi: mock.abi, functionName: "mint", args: [to, agentId] });
      await publicClient.waitForTransactionReceipt({ hash: h });
    },
    async increaseTime(seconds: number) {
      await test.increaseTime({ seconds });
      await test.mine({ blocks: 1 });
    },
    stop() {
      proc.kill();
    },
  };
}
