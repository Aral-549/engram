// Seeds real MemoryRegistry activity on Monad testnet for the indexer integration test.
// Exercises the real crypto path (encrypted entries, X25519 wraps) and the gasless relay.
//
//   npm run build -w @engram/crypto && npx tsx scripts/seed-testnet.ts
//
// Reads secrets from chain/.env (gitignored): DEPLOYER_PRIVATE_KEY (relayer, agent token holder, operator),
// SEED_OWNER_PRF (stands in for a passkey PRF output), SEED_AGENT_ID, SEED_AGENT_X25519_PRIVATE.
// Writes tests/integration/seed-output.json (public data only: addresses, ids, tx hashes, block range).
import { readFileSync, writeFileSync } from "node:fs";
import { x25519 } from "@noble/curves/ed25519.js";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseEther,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import {
  deriveAccount,
  deriveNamespaceId,
  deriveNamespaceKey,
  encodeEntry,
  encryptEntry,
  unwrapNamespaceKey,
  wrapNamespaceKey,
  type BindingContext,
} from "@engram/crypto";

const env = Object.fromEntries(
  readFileSync("chain/.env", "utf8")
    .split("\n")
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const need = (k: string) => env[k] ?? (() => { throw new Error(`missing ${k} in chain/.env`); })();
const deployment = JSON.parse(readFileSync("chain/deployments/10143.json", "utf8"));
const abi = JSON.parse(readFileSync("chain/out/MemoryRegistry.sol/MemoryRegistry.json", "utf8")).abi;
const REGISTRY = deployment.memoryRegistry as Hex;
const bytes = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));
const log = (op: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ stage: "seed", op, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

const transport = http(monadTestnet.rpcUrls.default.http[0]);
const pub = createPublicClient({ chain: monadTestnet, transport });
const relayer = privateKeyToAccount(need("DEPLOYER_PRIVATE_KEY") as Hex);
const relayerWallet = createWalletClient({ chain: monadTestnet, transport, account: relayer });

const prf = bytes(need("SEED_OWNER_PRF"));
const ownerAcc = deriveAccount(prf);
const owner = privateKeyToAccount(toHex(ownerAcc.accountKey));
const ownerWallet = createWalletClient({ chain: monadTestnet, transport, account: owner });
const agentId = BigInt(need("SEED_AGENT_ID"));
const agentPriv = bytes(need("SEED_AGENT_X25519_PRIVATE"));
const agentPub = x25519.getPublicKey(agentPriv);
const ctx: BindingContext = { chainId: BigInt(monadTestnet.id), registry: REGISTRY, owner: owner.address };
const LABEL = "preferences";
const nsId = toHex(deriveNamespaceId(prf, LABEL));

const txs: Record<string, Hex> = {};
const blocks: bigint[] = [];

async function send(name: string, wallet: typeof relayerWallet | typeof ownerWallet, functionName: string, args: unknown[]) {
  const hash = await wallet.writeContract({ address: REGISTRY, abi, functionName, args } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${name} reverted: ${hash}`);
  txs[name] = hash;
  blocks.push(r.blockNumber);
  log(name, { tx: hash, block: r.blockNumber, gasUsed: r.gasUsed });
  return r;
}

async function relay(name: string, functionName: string, args: unknown[]) {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const nonce = (await pub.readContract({ address: REGISTRY, abi, functionName: "nonces", args: [owner.address] })) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const { keccak256 } = await import("viem");
  const signature = await owner.signTypedData({
    domain: { name: "EngramMemoryRegistry", version: "1", chainId: monadTestnet.id, verifyingContract: REGISTRY },
    types: { OwnerCall: [
      { name: "owner", type: "address" }, { name: "dataHash", type: "bytes32" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] },
    primaryType: "OwnerCall",
    message: { owner: owner.address, dataHash: keccak256(data), nonce, deadline },
  });
  return send(name, relayerWallet, "relay", [owner.address, data, deadline, signature]);
}

async function nsState() {
  const [exists, epoch, nextSeq] = (await pub.readContract({ address: REGISTRY, abi, functionName: "namespaceOf", args: [owner.address, nsId] })) as [boolean, bigint, bigint];
  return { exists, epoch, nextSeq };
}

async function main() {
  log("start", { registry: REGISTRY, owner: owner.address, agentId, nsId });

  // Owner gas for its one direct tx (the rest is relayed, like production).
  if ((await pub.getBalance({ address: owner.address })) < parseEther("0.05")) {
    const hash = await relayerWallet.sendTransaction({ to: owner.address, value: parseEther("0.1") });
    await pub.waitForTransactionReceipt({ hash });
    log("fund-owner", { tx: hash });
  }

  const [curPub] = (await pub.readContract({ address: REGISTRY, abi, functionName: "agentKeysOf", args: [agentId] })) as [Hex, Hex];
  if (curPub.toLowerCase() !== toHex(agentPub).toLowerCase()) {
    await send("setAgentKeys", relayerWallet, "setAgentKeys", [agentId, toHex(agentPub), relayer.address]);
  }

  let s = await nsState();
  if (!s.exists) {
    await send("createNamespace(direct)", ownerWallet, "createNamespace", [nsId]);
    s = await nsState();
  }

  const entry = (text: string, kind: "fact" | "preference" = "preference") => encodeEntry({ v: 1, t: Date.now(), kind, text });
  const k0 = deriveNamespaceKey(prf, LABEL, s.epoch);
  const e1 = await encryptEntry({ key: k0, ctx, nsId: bytes(nsId), epoch: s.epoch, plaintext: entry("vegetarian") });
  await relay("appendAsOwner#1(relay)", "appendAsOwner", [nsId, s.epoch, toHex(e1)]);
  const e2 = await encryptEntry({ key: deriveNamespaceKey(prf, LABEL, s.epoch), ctx, nsId: bytes(nsId), epoch: s.epoch, plaintext: entry("allergic to peanuts") });
  await relay("appendAsOwner#2(relay)", "appendAsOwner", [nsId, s.epoch, toHex(e2)]);

  const wrap = await wrapNamespaceKey({ ctx, nsId: bytes(nsId), epoch: s.epoch, agentId, nsKey: deriveNamespaceKey(prf, LABEL, s.epoch), label: LABEL, agentX25519Public: agentPub });
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400);
  await relay("grant(relay)", "grant", [nsId, agentId, 3, expiry, [s.epoch], [toHex(wrap)]]);

  // The agent side: unwrap with its own X25519 key, write one entry as operator.
  const { nsKey } = await unwrapNamespaceKey({ ctx, nsId: bytes(nsId), epoch: s.epoch, agentId, envelope: wrap, agentX25519Private: agentPriv });
  const e3 = await encryptEntry({ key: nsKey, ctx, nsId: bytes(nsId), epoch: s.epoch, plaintext: entry("prefers window seats", "fact") });
  await send("appendAsAgent", relayerWallet, "appendAsAgent", [owner.address, nsId, agentId, s.epoch, toHex(e3)]);

  // Rotate, keeping the agent: exercises EpochRotated + KeyWrapped at the new epoch.
  const next = s.epoch + 1n;
  const rewrap = await wrapNamespaceKey({ ctx, nsId: bytes(nsId), epoch: next, agentId, nsKey: deriveNamespaceKey(prf, LABEL, next), label: LABEL, agentX25519Public: agentPub });
  await relay("rotate(relay)", "rotate", [nsId, [agentId], [toHex(rewrap)]]);

  const final = await nsState();
  const out = {
    _note: "Written by scripts/seed-testnet.ts. Public data only.",
    chainId: monadTestnet.id,
    registry: REGISTRY,
    owner: owner.address.toLowerCase(),
    agentId: agentId.toString(),
    nsId,
    startBlock: Number(blocks.reduce((a, b) => (b < a ? b : a))),
    endBlock: Number(blocks.reduce((a, b) => (b > a ? b : a))),
    epochAfter: final.epoch.toString(),
    nextSeqAfter: final.nextSeq.toString(),
    entriesThisRun: 3,
    txs,
  };
  writeFileSync("tests/integration/seed-output.json", JSON.stringify(out, null, 2) + "\n");
  log("done", out);
}

main().catch((e) => {
  console.error(JSON.stringify({ stage: "seed", op: "error", message: String(e?.shortMessage ?? e?.message ?? e) }));
  process.exit(1);
});
