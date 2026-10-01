// Registers ANY agent with Engram (contracts/integration.md cases 1-8): an ERC-8004 identity whose tokenURI is the
// agent card, its X25519 key + operator in the MemoryRegistry, and a funded operator. Idempotent per --out file.
//
//   HOLDER_PRIVATE_KEY=0x... npx tsx scripts/register-agent.ts --name "My agent" --origin https://my-agent.example
//
// Writes the agent's secrets to the --out env file (0600) and prints the agent-card.json to serve. Never prints keys.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { x25519 } from "@noble/curves/ed25519.js";
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, http, isAddress, parseAbi, parseEther, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { EngramAgent, deployments, exactOrigin } from "@engram/sdk";

const log = (op: string, f: Record<string, unknown> = {}) => console.error(JSON.stringify({ stage: "register-agent", op, ok: !f.error, ...f }));
const die = (error: string): never => {
  log("abort", { error });
  process.exit(1);
};

// ------------------------------------------------------------------ preflight: nothing below sends a transaction
const { values: a } = parseArgs({
  options: {
    name: { type: "string" }, description: { type: "string", default: "" }, origin: { type: "string" },
    out: { type: "string", default: ".env.engram-agent" }, "card-url": { type: "string" }, fund: { type: "string", default: "0.2" },
  },
});
const origin = exactOrigin(a.origin) ?? die(`--origin must be an exact origin like https://app.example (no path, no trailing slash, lowercase host, no default port); got "${a.origin ?? ""}"`);
const cardUrl = a["card-url"] ?? `${origin}/agent-card.json`;
try {
  if (!/^https?:$/.test(new URL(cardUrl).protocol)) throw 0;
} catch {
  die("--card-url must be an http(s) URL");
}
if ((a.description ?? "").length > 280) die("--description is limited to 280 characters");
if (!/^\d+(\.\d+)?$/.test(a.fund ?? "")) die("--fund must be a MON amount like 0.2");
const holderKey = process.env.HOLDER_PRIVATE_KEY;
if (!holderKey || !/^0x[0-9a-fA-F]{64}$/.test(holderKey)) die("set HOLDER_PRIVATE_KEY to the 0x-prefixed 32-byte key of the wallet that owns (or will own) the agent");

const d = deployments.monadTestnet;
const rpcUrl = process.env.RPC_URL ?? d.rpcUrl;
const registry = (process.env.REGISTRY ?? d.registry) as Hex;
const identityRegistry = (process.env.IDENTITY_REGISTRY ?? d.identityRegistry) as Hex;
if (!isAddress(registry) || !isAddress(identityRegistry)) die("REGISTRY and IDENTITY_REGISTRY must be addresses");

const prev: Record<string, string> = existsSync(a.out!)
  ? Object.fromEntries(readFileSync(a.out!, "utf8").split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]))
  : {};
if (prev.ENGRAM_REGISTRY && prev.ENGRAM_REGISTRY.toLowerCase() !== registry.toLowerCase()) {
  die(`${a.out} was written for registry ${prev.ENGRAM_REGISTRY}, not ${registry}; use another --out`);
}
if (!prev.AGENT_ID && !a.name) die("--name is required on the first run");
if (a.name && (a.name.length < 1 || a.name.length > 64)) die("--name must be 1-64 characters");

// ------------------------------------------------------------------ chain
const transport = http(rpcUrl);
const pub = createPublicClient({ transport });
const chainId = await pub.getChainId().catch(() => die(`cannot reach RPC ${rpcUrl}`));
if (prev.ENGRAM_CHAIN_ID && Number(prev.ENGRAM_CHAIN_ID) !== chainId) die(`${a.out} was written for chain ${prev.ENGRAM_CHAIN_ID}, not ${chainId}`);
const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const holder = createWalletClient({ chain, transport, account: privateKeyToAccount(holderKey as Hex) });
const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

let agentId = prev.AGENT_ID ? BigInt(prev.AGENT_ID) : undefined;
if (agentId !== undefined) {
  const owner = await pub.readContract({ address: identityRegistry, abi: identityAbi, functionName: "ownerOf", args: [agentId] }).catch(() => undefined);
  if (!owner || owner.toLowerCase() !== holder.account.address.toLowerCase()) die(`holder ${holder.account.address} does not own agent ${agentId}`);
}
const xPriv = prev.AGENT_X25519_PRIVATE_KEY ? new Uint8Array(Buffer.from(prev.AGENT_X25519_PRIVATE_KEY.replace(/^0x/, ""), "hex")) : x25519.utils.randomSecretKey();
const opKey = (prev.AGENT_OPERATOR_KEY as Hex | undefined) ?? generatePrivateKey();
const operator = privateKeyToAccount(opKey);

const save = () => {
  const lines = [
    "# Written by scripts/register-agent.ts. Contains secrets: keep out of git.",
    `AGENT_ID=${agentId}`,
    `AGENT_NAME=${(a.name ?? prev.AGENT_NAME ?? "agent").replace(/[\r\n]/g, " ")}`,
    `AGENT_X25519_PRIVATE_KEY=${toHex(xPriv)}`,
    `AGENT_OPERATOR_KEY=${opKey}`,
    `APP_ORIGIN=${origin}`,
    `ENGRAM_REGISTRY=${registry}`,
    `ENGRAM_CHAIN_ID=${chainId}`,
  ];
  writeFileSync(a.out!, lines.join("\n") + "\n", { mode: 0o600 });
};

try {
  if (agentId === undefined) {
    const hash = await holder.writeContract({ address: identityRegistry, abi: identityAbi, functionName: "register", args: [cardUrl] });
    const r = await pub.waitForTransactionReceipt({ hash });
    for (const l of r.logs) {
      try {
        const ev = decodeEventLog({ abi: identityAbi, data: l.data, topics: l.topics });
        if (ev.eventName === "Registered") agentId = ev.args.agentId;
      } catch {
        /* other log */
      }
    }
    if (agentId === undefined) die("registration tx had no Registered event");
    save(); // persist immediately so a rerun resumes instead of registering twice
    log("registered", { agentId: agentId!.toString(), tx: hash, tokenURI: cardUrl });
  } else {
    log("reused", { agentId: agentId.toString() });
  }

  const [curPub, curOp] = (await pub.readContract({
    address: registry, abi: parseAbi(["function agentKeysOf(uint256) view returns (bytes32, address)"]), functionName: "agentKeysOf", args: [agentId!],
  })) as [Hex, Hex];
  if (curPub.toLowerCase() !== toHex(x25519.getPublicKey(xPriv)).toLowerCase() || curOp.toLowerCase() !== operator.address.toLowerCase()) {
    const tx = await EngramAgent.publishKeys({ config: { chainId, rpcUrl, registry }, agentId: agentId!, x25519PublicKey: x25519.getPublicKey(xPriv), operator: operator.address, holder });
    log("keys-published", { agentId: agentId!.toString(), operator: operator.address, tx });
  }

  const fund = parseEther(a.fund!);
  // Top up only below half the requested amount, so reruns never fund again (BUGLOG K1).
  if (fund > 0n && (await pub.getBalance({ address: operator.address })) < fund / 2n) {
    const tx = await holder.sendTransaction({ to: operator.address, value: fund });
    await pub.waitForTransactionReceipt({ hash: tx });
    log("operator-funded", { operator: operator.address, amount: a.fund, tx });
  }
  save();
  log("done", { agentId: agentId!.toString(), out: a.out, operator: operator.address });
} catch (e) {
  die(`chain call failed: ${(e as Error).name}: ${((e as { shortMessage?: string }).shortMessage ?? (e as Error).message).split("\n")[0]}`);
}

// Serve this at the card URL; listing the origin is what makes the vault show your app as verified.
console.log(JSON.stringify({ name: a.name ?? prev.AGENT_NAME ?? "agent", description: a.description, endpoints: [{ name: "web", endpoint: origin }] }, null, 2));
