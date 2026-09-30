// Agent side (server). Spec: contracts/sdk.md "Agent", cases 5-11, 20, KEY_MISMATCH edge.
import { x25519 } from "@noble/curves/ed25519.js";
import {
  EngramCryptoError,
  decryptEntry,
  encodeEntry,
  encryptEntry,
  parseEntry,
  unwrapNamespaceKey,
  type BindingContext,
  type EntryKind,
} from "@engram/crypto";
import { decodeEventLog, hexToBytes, toHex, type Account, type Chain, type Hex, type Transport, type WalletClient } from "viem";
import { memoryRegistryAbi } from "./abi.js";
import { chainReads } from "./chain.js";
import { clientsFor, loggerOf, type EngramConfig } from "./config.js";
import { EngramError, fail } from "./errors.js";
import { traced } from "./log.js";
import { dedupe, missing, type GrantScope, type RecalledEntry } from "./owner.js";

type Wallet = WalletClient<Transport, Chain | undefined, Account>;

export type InboxItem = {
  owner: Hex;
  nsId: Hex;
  label: string | undefined;
  scope: GrantScope;
  expiry: bigint;
  generation: number;
  /** Epochs this agent holds keys for (current-generation wraps it could open). */
  epochs: bigint[];
};

const X25519_P = 2n ** 255n - 19n;
/** Same rule as the crypto package (BUGLOG B1): top bit clear and u < p. */
export function isCanonicalX25519(pub: Uint8Array): boolean {
  if (pub.length !== 32 || (pub[31]! & 0x80) !== 0) return false;
  let u = 0n;
  for (let i = 31; i >= 0; i--) u = (u << 8n) | BigInt(pub[i]!);
  return u < X25519_P;
}

export class EngramAgent {
  readonly agentId: bigint;
  private readonly priv: Uint8Array;

  constructor(private readonly opts: { config: EngramConfig; agentId: bigint; x25519PrivateKey: Uint8Array; operator: Wallet }) {
    this.agentId = BigInt(opts.agentId);
    this.priv = new Uint8Array(opts.x25519PrivateKey);
  }

  /** Publishes the agent's X25519 key and operator (`setAgentKeys`). Must be sent by the ERC-8004 token holder. */
  static async publishKeys(opts: { config: Pick<EngramConfig, "chainId" | "rpcUrl" | "registry">; agentId: bigint; x25519PublicKey: Uint8Array; operator: Hex; holder: Wallet }) {
    if (!isCanonicalX25519(opts.x25519PublicKey)) fail("INPUT_INVALID", "X25519 public key is not canonical");
    const hash = await opts.holder.writeContract({
      address: opts.config.registry, abi: memoryRegistryAbi, functionName: "setAgentKeys",
      args: [opts.agentId, toHex(opts.x25519PublicKey), opts.operator], chain: opts.holder.chain,
    });
    const r = await clientsFor(opts.config).publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") fail("TX_REVERTED", "setAgentKeys reverted");
    return hash;
  }

  static publicKeyFor(x25519PrivateKey: Uint8Array): Uint8Array {
    return x25519.getPublicKey(x25519PrivateKey);
  }

  private get config() {
    return this.opts.config;
  }
  private get log() {
    return loggerOf(this.config);
  }
  private get reads() {
    return chainReads(this.config);
  }
  private ctx(owner: Hex): BindingContext {
    return { chainId: BigInt(this.config.chainId), registry: this.config.registry, owner };
  }

  /** Opens every current-generation wrap it can; logs KEY_MISMATCH for wraps its key cannot open. */
  private async keysFor(owner: Hex, nsId: Hex, generation: number) {
    const keys = new Map<bigint, Uint8Array>();
    let label: string | undefined;
    for (const w of await this.config.source.wraps({ owner, nsId, agentId: this.agentId })) {
      if (w.generation !== generation) continue;
      try {
        const r = await unwrapNamespaceKey({ ctx: this.ctx(owner), nsId: hexToBytes(nsId), epoch: w.epoch, agentId: this.agentId, envelope: hexToBytes(w.wrap), agentX25519Private: this.priv });
        keys.set(w.epoch, r.nsKey);
        label = r.label;
      } catch (e) {
        if (!(e instanceof EngramCryptoError)) throw e;
        this.log({ stage: "sdk", side: "agent", op: "unwrap", traceId: "-", ok: false, code: "KEY_MISMATCH", agentId: this.agentId.toString(), epoch: w.epoch.toString() });
      }
    }
    return { keys, label };
  }

  private async currentGrant(owner: Hex, nsId: Hex) {
    const rows = await this.config.source.grantsForAgent(this.agentId);
    return rows.find((g) => g.owner.toLowerCase() === owner.toLowerCase() && g.nsId.toLowerCase() === nsId.toLowerCase() && g.active);
  }

  async inbox(): Promise<InboxItem[]> {
    return traced(this.log, "agent", "inbox", { agentId: this.agentId }, async (extra) => {
      const out: InboxItem[] = [];
      for (const g of await this.config.source.grantsForAgent(this.agentId)) {
        if (!g.active || !(await this.reads.isActive(g.owner, g.nsId, this.agentId))) continue;
        const { keys, label } = await this.keysFor(g.owner, g.nsId, g.generation);
        const onchain = await this.reads.grant(g.owner, g.nsId, this.agentId);
        out.push({
          owner: g.owner, nsId: g.nsId, label, scope: onchain.scope === 3 ? "readwrite" : "read", expiry: onchain.expiry,
          generation: g.generation, epochs: [...keys.keys()].sort((a, b) => (a < b ? -1 : 1)),
        });
      }
      extra.count = out.length;
      return out;
    });
  }

  async recall(owner: Hex, nsId: Hex) {
    return traced(this.log, "agent", "recall", { agentId: this.agentId }, async (extra) => {
      if (!(await this.reads.isActive(owner, nsId, this.agentId))) fail("ACCESS_REVOKED", "this agent's access to the namespace was revoked or has expired");
      const grant = await this.currentGrant(owner, nsId);
      const { keys, label } = await this.keysFor(owner, nsId, grant?.generation ?? 1);
      const ns = await this.reads.namespace(owner, nsId);
      const got = dedupe(await this.config.source.entries({ owner, nsId }), ns.nextSeq);
      const missingSeqs = missing(got, ns.nextSeq);
      const entries: RecalledEntry[] = [];
      let skipped = 0;
      for (const e of got) {
        const key = keys.get(e.epoch);
        if (!key) {
          skipped++;
          continue;
        }
        try {
          const pt = await decryptEntry({ key, ctx: this.ctx(owner), nsId: hexToBytes(nsId), epoch: e.epoch, envelope: hexToBytes(e.ciphertext) });
          entries.push({ ...parseEntry(pt), seq: e.seq, epoch: e.epoch, byOwner: e.byOwner, agentId: e.agentId, txHash: e.txHash });
        } catch {
          skipped++;
        }
      }
      Object.assign(extra, { count: entries.length, skipped, missingSeqs });
      return { label, entries, skipped, complete: missingSeqs.length === 0, missingSeqs };
    });
  }

  async remember(owner: Hex, nsId: Hex, entry: { kind: EntryKind; text: string }) {
    return traced(this.log, "agent", "remember", { agentId: this.agentId }, async () => {
      const [onchain, active, ns] = await Promise.all([
        this.reads.grant(owner, nsId, this.agentId),
        this.reads.isActive(owner, nsId, this.agentId),
        this.reads.namespace(owner, nsId),
      ]);
      if (!active || onchain.scope !== 3) fail("NOT_AUTHORIZED", "this agent has no active read-write grant for the namespace");
      const grant = await this.currentGrant(owner, nsId);
      const { keys } = await this.keysFor(owner, nsId, grant?.generation ?? 1);
      const key = keys.get(ns.epoch);
      if (!key) fail("NOT_AUTHORIZED", "this agent holds no key for the namespace's current epoch");
      const plaintext = encodeEntry({ v: 1, t: Date.now(), kind: entry.kind, text: entry.text });
      const envelope = await encryptEntry({ key: key!, ctx: this.ctx(owner), nsId: hexToBytes(nsId), epoch: ns.epoch, plaintext });
      const hash = await this.opts.operator.writeContract({
        address: this.config.registry, abi: memoryRegistryAbi, functionName: "appendAsAgent",
        args: [owner, nsId, this.agentId, ns.epoch, toHex(envelope)], chain: this.opts.operator.chain,
      });
      const receipt = await clientsFor(this.config).publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") fail("TX_REVERTED", "appendAsAgent reverted");
      for (const l of receipt.logs) {
        try {
          const ev = decodeEventLog({ abi: memoryRegistryAbi, data: l.data, topics: l.topics as never });
          if (ev.eventName === "EntryAppended") return { seq: (ev.args as { seq: bigint }).seq, txHash: hash };
        } catch {
          /* not ours */
        }
      }
      throw new EngramError("TX_REVERTED", "appendAsAgent emitted no EntryAppended");
    });
  }
}
