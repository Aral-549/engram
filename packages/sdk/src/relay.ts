// Gasless relay (contracts/memory-registry.md "Gasless path", contracts/apps.md "Relayer", sdk.md case 25).
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  isAddress,
  isHex,
  keccak256,
  recoverTypedDataAddress,
  type Account,
  type Chain,
  type Hex,
  type LocalAccount,
  type Transport,
  type WalletClient,
} from "viem";
import { memoryRegistryAbi } from "./abi.js";
import { clientsFor, loggerOf, type ChainConfig } from "./config.js";
import { EngramError } from "./errors.js";
import { traceId } from "./log.js";

export type RelayRequest = { owner: Hex; data: Hex; deadline: string; signature: Hex };
export interface Relayer {
  submit(req: RelayRequest): Promise<{ txHash: Hex }>;
}

export const OWNER_CALL_TYPES = {
  OwnerCall: [
    { name: "owner", type: "address" },
    { name: "dataHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const RELAYABLE = ["createNamespace", "appendAsOwner", "grant", "revoke", "rotate", "useNonce"] as const;
export const RELAY_DEADLINE_SECONDS = 300n;

export const ownerCallDomain = (config: Pick<ChainConfig, "chainId" | "registry">) =>
  ({ name: "EngramMemoryRegistry", version: "1", chainId: config.chainId, verifyingContract: config.registry }) as const;

/** Signs an owner call with the current chain nonce and a deadline of chain time + 300 s. */
export async function signOwnerCall(config: ChainConfig, account: LocalAccount, data: Hex): Promise<RelayRequest> {
  const { publicClient } = clientsFor(config);
  const [nonce, block] = await Promise.all([
    publicClient.readContract({ address: config.registry, abi: memoryRegistryAbi, functionName: "nonces", args: [account.address] }),
    publicClient.getBlock(),
  ]);
  const deadline = block.timestamp + RELAY_DEADLINE_SECONDS;
  const signature = await account.signTypedData({
    domain: ownerCallDomain(config),
    types: OWNER_CALL_TYPES,
    primaryType: "OwnerCall",
    message: { owner: account.address, dataHash: keccak256(data), nonce, deadline },
  });
  return { owner: account.address, data, deadline: deadline.toString(), signature };
}

// ------------------------------------------------------------------------------------------ clients

/** POSTs to a relay endpoint (the vault's /api/relay). */
export function httpRelayer(url: string): Relayer {
  return {
    async submit(req) {
      let res: Response;
      try {
        res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
      } catch (e) {
        throw new EngramError("RELAYER_UNAVAILABLE", "the relayer could not be reached; try again shortly", { cause: e });
      }
      const body = (await res.json().catch(() => ({}))) as { txHash?: Hex; code?: string; message?: string };
      if (res.status >= 500 && !body.code) throw new EngramError("RELAYER_UNAVAILABLE", `the relayer failed (HTTP ${res.status})`);
      if (!res.ok || !body.txHash) throw new EngramError("RELAY_REJECTED", body.message ?? `relay rejected: ${body.code}`, { detail: body.code });
      return { txHash: body.txHash };
    },
  };
}

/** Calls a relay handler in-process (server-side use and tests). */
export function inProcessRelayer(handler: RelayHandler): Relayer {
  return {
    async submit(req) {
      const res = await handler(req);
      if (res.status !== 200 || !res.body.txHash) {
        throw new EngramError("RELAY_REJECTED", res.body.message ?? `relay rejected: ${res.body.code}`, { detail: res.body.code });
      }
      return { txHash: res.body.txHash };
    },
  };
}

// ------------------------------------------------------------------------------------------ server handler

export type RelayResponse = { status: number; body: { txHash?: Hex; code?: string; message?: string } };
export type RelayHandler = (body: unknown) => Promise<RelayResponse>;

type Wallet = WalletClient<Transport, Chain | undefined, Account>;

/**
 * Validates, simulates, and submits relayed owner calls. Order: shape, rate limit, selector, deadline,
 * signature (against the chain nonce), simulation. Nothing is sent unless every check passes.
 */
export function createRelayHandler(opts: {
  config: ChainConfig;
  wallet: Wallet;
  limits?: { perOwnerPerMinute?: number; globalPerMinute?: number };
  clock?: () => number;
}): RelayHandler {
  const { config, wallet } = opts;
  const { publicClient } = clientsFor(config);
  const log = loggerOf(config);
  const perOwner = opts.limits?.perOwnerPerMinute ?? 30;
  const global = opts.limits?.globalPerMinute ?? 300;
  const clock = opts.clock ?? Date.now;
  const hits = new Map<string, number[]>();
  let queue: Promise<unknown> = Promise.resolve();

  const reject = (status: number, code: string, message: string): RelayResponse => ({ status, body: { code, message } });
  const within = (key: string, limit: number) => {
    const now = clock();
    const list = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    list.push(now);
    hits.set(key, list);
    return list.length <= limit;
  };

  return async (raw) => {
    const t0 = Date.now();
    const id = traceId();
    const done = (res: RelayResponse, fields: Record<string, unknown> = {}) => {
      log({ stage: "sdk", side: "relay", op: "relay", traceId: id, ok: res.status === 200, code: res.body.code, status: res.status, durationMs: Date.now() - t0, ...fields });
      return res;
    };
    const b = raw as Partial<RelayRequest> | null;
    if (!b || typeof b !== "object" || !isAddress(String(b.owner)) || !isHex(b.data) || !isHex(b.signature) || !/^\d{1,20}$/.test(String(b.deadline))) {
      return done(reject(400, "BAD_REQUEST", "expected { owner, data, deadline, signature }"));
    }
    const owner = b.owner as Hex;
    if (!within("*", global) || !within(owner.toLowerCase(), perOwner)) return done(reject(429, "RATE_LIMITED", "too many requests"), { owner });

    let fn: string;
    try {
      fn = decodeFunctionData({ abi: memoryRegistryAbi, data: b.data }).functionName;
    } catch {
      return done(reject(400, "SELECTOR_NOT_ALLOWED", "calldata is not a registry call"), { owner });
    }
    if (!(RELAYABLE as readonly string[]).includes(fn)) return done(reject(400, "SELECTOR_NOT_ALLOWED", `${fn} cannot be relayed`), { owner, fn });

    const deadline = BigInt(b.deadline!);
    const [nonce, block] = await Promise.all([
      publicClient.readContract({ address: config.registry, abi: memoryRegistryAbi, functionName: "nonces", args: [owner] }),
      publicClient.getBlock(),
    ]);
    if (deadline < block.timestamp) return done(reject(400, "EXPIRED", "deadline has passed"), { owner, fn });

    let signer: Hex | undefined;
    try {
      signer = await recoverTypedDataAddress({
        domain: ownerCallDomain(config), types: OWNER_CALL_TYPES, primaryType: "OwnerCall",
        message: { owner, dataHash: keccak256(b.data), nonce, deadline }, signature: b.signature,
      });
    } catch {
      signer = undefined;
    }
    if (!signer || signer.toLowerCase() !== owner.toLowerCase()) return done(reject(400, "BAD_SIGNATURE", "signature does not match owner and nonce"), { owner, fn });

    // Serialize sends so the relayer wallet's nonces never collide.
    const run = queue.then(async (): Promise<RelayResponse> => {
      try {
        const { request } = await publicClient.simulateContract({
          account: wallet.account, address: config.registry, abi: memoryRegistryAbi, functionName: "relay",
          args: [owner, b.data!, deadline, b.signature!],
        });
        const txHash = await wallet.writeContract(request as never);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== "success") return reject(500, "TX_REVERTED", "relay transaction reverted");
        return { status: 200, body: { txHash } };
      } catch (e) {
        const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : undefined;
        const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
        if (name) return reject(400, name, `registry rejected the call: ${name}`);
        return reject(502, "RELAY_FAILED", "could not submit the relay transaction");
      }
    });
    queue = run.catch(() => undefined);
    return done(await run, { owner, fn });
  };
}
