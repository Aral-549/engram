// Measures tx-inclusion -> queryable-in-indexer latency (contracts/indexer.md lag target: < 3 s).
// Needs a running indexer (cd indexer && npm run dev) and the seed secrets in chain/.env.
//
//   GRAPHQL_URL=http://localhost:8090/v1/graphql npx tsx scripts/latency-probe.ts
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { deriveAccount, deriveNamespaceId, deriveNamespaceKey, encodeEntry, encryptEntry } from "@engram/crypto";

const env = Object.fromEntries(
  readFileSync("chain/.env", "utf8").split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const GRAPHQL = process.env.GRAPHQL_URL ?? "http://localhost:8080/v1/graphql";
const REGISTRY = JSON.parse(readFileSync("chain/deployments/10143.json", "utf8")).memoryRegistry as Hex;
const abi = JSON.parse(readFileSync("chain/out/MemoryRegistry.sol/MemoryRegistry.json", "utf8")).abi;
const bytes = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));

const transport = http(monadTestnet.rpcUrls.default.http[0]);
const pub = createPublicClient({ chain: monadTestnet, transport });
const relayer = createWalletClient({ chain: monadTestnet, transport, account: privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex) });
const prf = bytes(env.SEED_OWNER_PRF);
const owner = privateKeyToAccount(toHex(deriveAccount(prf).accountKey));
const nsId = toHex(deriveNamespaceId(prf, "preferences"));

async function gql(query: string) {
  const r = await fetch(GRAPHQL, { method: "POST", headers: { "content-type": "application/json", "x-hasura-admin-secret": "testing" }, body: JSON.stringify({ query }) });
  return (await r.json()) as { data?: any; errors?: unknown };
}

const [, epoch, nextSeq] = (await pub.readContract({ address: REGISTRY, abi, functionName: "namespaceOf", args: [owner.address, nsId] })) as [boolean, bigint, bigint];
const envelope = await encryptEntry({
  key: deriveNamespaceKey(prf, "preferences", epoch),
  ctx: { chainId: 10143n, registry: REGISTRY, owner: owner.address },
  nsId: bytes(nsId), epoch,
  plaintext: encodeEntry({ v: 1, t: Date.now(), kind: "note", text: `latency probe ${new Date().toISOString()}` }),
});
const data = encodeFunctionData({ abi, functionName: "appendAsOwner", args: [nsId, epoch, toHex(envelope)] } as never);
const nonce = (await pub.readContract({ address: REGISTRY, abi, functionName: "nonces", args: [owner.address] })) as bigint;
const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
const signature = await owner.signTypedData({
  domain: { name: "EngramMemoryRegistry", version: "1", chainId: 10143, verifyingContract: REGISTRY },
  types: { OwnerCall: [{ name: "owner", type: "address" }, { name: "dataHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
  primaryType: "OwnerCall",
  message: { owner: owner.address, dataHash: keccak256(data), nonce, deadline },
});

const tSend = Date.now();
const hash = await relayer.writeContract({ address: REGISTRY, abi, functionName: "relay", args: [owner.address, data, deadline, signature] } as never);
const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
const tIncluded = Date.now();
const id = `${owner.address.toLowerCase()}-${nsId}-${nextSeq}`;
let tIndexed = 0;
for (let i = 0; i < 300; i++) {
  const r = await gql(`{ Entry(where: { id: { _eq: "${id}" } }) { id } }`);
  if (r.data?.Entry?.length) { tIndexed = Date.now(); break; }
  await new Promise((res) => setTimeout(res, 100));
}
console.log(JSON.stringify({
  stage: "latency-probe", tx: hash, block: receipt.blockNumber.toString(), seq: nextSeq.toString(),
  sendToIncludedMs: tIncluded - tSend,
  includedToIndexedMs: tIndexed ? tIndexed - tIncluded : null,
  sendToIndexedMs: tIndexed ? tIndexed - tSend : null,
  targetMet: tIndexed ? tIndexed - tIncluded < 3000 : false,
}));
