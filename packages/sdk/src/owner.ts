// Owner side (vault origin only). Spec: contracts/sdk.md "Owner", "Session scoping".
import {
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  getPasskeyPrfOutput,
  isMeraError,
  type Secp256k1SigningSession,
  type WebAuthnClient,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import {
  ROOT_SALT,
  decryptEntry,
  deriveAccount,
  deriveNamespaceId,
  deriveNamespaceKey,
  encodeEntry,
  encryptEntry,
  parseEntry,
  wrapNamespaceKey,
  type BindingContext,
  type Entry,
  type EntryKind,
} from "@engram/crypto";
import { decodeEventLog, encodeFunctionData, hexToBytes, toHex, type Hex, type LocalAccount } from "viem";
import { memoryRegistryAbi } from "./abi.js";
import { chainReads } from "./chain.js";
import { clientsFor, loggerOf, type EngramConfig } from "./config.js";
import { EngramError, crypto, cryptoAsync, fail } from "./errors.js";
import { traced } from "./log.js";
import { signOwnerCall } from "./relay.js";

export const SESSION_IDLE_MS = 15 * 60 * 1000;
export const REAUTH_WINDOW_MS = 60 * 1000;
const MAX_EXPIRY_SEC = 365 * 86400;

export type GrantScope = "read" | "readwrite";
export type RecalledEntry = Entry & { seq: bigint; epoch: bigint; byOwner: boolean; agentId: bigint; txHash: Hex };
export type RecallResult = { entries: RecalledEntry[]; skipped: number; complete: boolean; missingSeqs: bigint[] };
export type GrantView = {
  nsId: Hex;
  label: string | undefined;
  agentId: bigint;
  agentURI: string | undefined;
  scope: GrantScope;
  expiry: bigint;
  active: boolean;
  keysCurrent: boolean;
};

const PRF_HELP =
  "This passkey provider does not support the PRF extension that Engram needs. Use iCloud Keychain (Safari/iOS/macOS), Google Password Manager (Chrome/Android), or 1Password.";

function passkeyError(e: unknown): never {
  if (isMeraError(e) && e.code === "PRF_UNAVAILABLE") throw new EngramError("PRF_UNAVAILABLE", PRF_HELP, { cause: e });
  if (isMeraError(e) && e.code === "PASSKEY_OPERATION_FAILED") throw new EngramError("PASSKEY_CANCELLED", "the passkey prompt was cancelled or failed", { cause: e });
  throw e;
}

type Reauth = () => Promise<Uint8Array>;

export class EngramOwner {
  /** Creates a passkey (one ceremony) and opens a session. */
  static async signUp(opts: { config: EngramConfig; rpId: string; rpName: string; userName: string; webAuthnClient?: WebAuthnClient; clock?: () => number }) {
    const res = await createPasskeyWithPrfOutput({
      rp: { id: opts.rpId, name: opts.rpName },
      user: { name: opts.userName, displayName: opts.userName },
      prfSalt: ROOT_SALT,
      webAuthnClient: opts.webAuthnClient,
    }).catch(passkeyError);
    return OwnerSession.open(opts.config, res.prfOutput, reauthFor(opts.rpId, res.credentialId, opts.webAuthnClient), opts.clock);
  }

  /** Signs in with an existing passkey (one ceremony). Nothing is read from local storage. */
  static async signIn(opts: { config: EngramConfig; rpId: string; webAuthnClient?: WebAuthnClient; clock?: () => number }) {
    const res = await getPasskeyPrfOutput({ rpId: opts.rpId, prfSalt: ROOT_SALT, webAuthnClient: opts.webAuthnClient }).catch(passkeyError);
    return OwnerSession.open(opts.config, res.prfOutput, reauthFor(opts.rpId, res.credentialId, opts.webAuthnClient), opts.clock);
  }

  /** Advanced/testing: open a session from a PRF output directly. Without `reauth`, grants never re-prompt. */
  static async fromPrf(opts: { config: EngramConfig; prfOutput: Uint8Array; reauth?: Reauth; clock?: () => number }) {
    return OwnerSession.open(opts.config, opts.prfOutput, opts.reauth, opts.clock);
  }
}

function reauthFor(rpId: string, credentialId: string, webAuthnClient?: WebAuthnClient): Reauth {
  return async () =>
    (await getPasskeyPrfOutput({ rpId, credential: { credentialId }, prfSalt: ROOT_SALT, webAuthnClient }).catch(passkeyError)).prfOutput;
}

export class OwnerSession {
  readonly owner: Hex;
  private readonly prf: Uint8Array;
  private readonly signing: Secp256k1SigningSession;
  private readonly account: LocalAccount;
  private readonly labels = new Map<string, string>(); // nsId -> label seen in this session
  private ended = false;
  private lastActivity: number;
  private lastCeremony: number;

  private constructor(
    private readonly config: EngramConfig,
    prf: Uint8Array,
    private readonly reauth: Reauth | undefined,
    private readonly clock: () => number,
  ) {
    this.prf = new Uint8Array(prf);
    const acc = crypto(() => deriveAccount(this.prf));
    this.signing = createSecp256k1SigningSession({ privateKey: acc.accountKey });
    acc.accountKey.fill(0);
    this.account = toViemAccount(this.signing) as LocalAccount;
    this.owner = acc.owner;
    this.lastActivity = this.lastCeremony = clock();
  }

  static async open(config: EngramConfig, prf: Uint8Array, reauth: Reauth | undefined, clock: () => number = Date.now) {
    return new OwnerSession(config, prf, reauth, clock);
  }

  private get log() {
    return loggerOf(this.config);
  }
  private get reads() {
    return chainReads(this.config);
  }
  private get ctx(): BindingContext {
    return { chainId: BigInt(this.config.chainId), registry: this.config.registry, owner: this.owner };
  }

  /** Session guard: ended / idle-expired checks and activity bump. */
  private touch() {
    if (this.ended) fail("SESSION_ENDED", "this session has ended; sign in again");
    if (this.clock() - this.lastActivity > SESSION_IDLE_MS) {
      this.end();
      fail("SESSION_EXPIRED", "the session expired after 15 minutes of inactivity; unlock with your passkey");
    }
    this.lastActivity = this.clock();
  }

  private nsIdOf(label: string): Hex {
    const id = toHex(crypto(() => deriveNamespaceId(this.prf, label)));
    this.labels.set(id.toLowerCase(), label);
    return id;
  }

  private nsKey(label: string, epoch: bigint) {
    return deriveNamespaceKey(this.prf, label, epoch);
  }

  /** Signs and relays one owner call; re-signs once if another tab consumed the nonce first. */
  private async relay(functionName: string, args: readonly unknown[]) {
    const data = encodeFunctionData({ abi: memoryRegistryAbi, functionName: functionName as never, args: args as never });
    for (let attempt = 0; ; attempt++) {
      const req = await signOwnerCall(this.config, this.account, data);
      try {
        const { txHash } = await this.config.relayer.submit(req);
        return clientsFor(this.config).publicClient.waitForTransactionReceipt({ hash: txHash });
      } catch (e) {
        const stale = e instanceof EngramError && (e.detail === "BAD_SIGNATURE" || e.detail === "BadSignature");
        if (!stale || attempt >= 1) throw e;
      }
    }
  }

  async remember(label: string, entry: { kind: EntryKind; text: string }): Promise<{ seq: bigint; txHash: Hex }> {
    return traced(this.log, "owner", "remember", { label }, async () => {
      this.touch();
      const nsId = this.nsIdOf(label);
      const plaintext = crypto(() => encodeEntry({ v: 1, t: Date.now(), kind: entry.kind, text: entry.text }));
      for (let attempt = 0; ; attempt++) {
        const ns = await this.reads.namespace(this.owner, nsId);
        if (!ns.exists) await this.relay("createNamespace", [nsId]).catch((e) => {
          if (!(e instanceof EngramError && e.detail === "NamespaceExists")) throw e;
        });
        const envelope = await encryptEntry({ key: this.nsKey(label, ns.epoch), ctx: this.ctx, nsId: hexToBytes(nsId), epoch: ns.epoch, plaintext });
        try {
          const receipt = await this.relay("appendAsOwner", [nsId, ns.epoch, toHex(envelope)]);
          return { seq: seqFrom(receipt.logs), txHash: receipt.transactionHash };
        } catch (e) {
          if (!(e instanceof EngramError && e.detail === "WrongEpoch") || attempt >= 1) throw e; // rotated meanwhile
        }
      }
    });
  }

  async recall(label: string): Promise<RecallResult> {
    return traced(this.log, "owner", "recall", { label }, async (extra) => {
      this.touch();
      const nsId = this.nsIdOf(label);
      const ns = await this.reads.namespace(this.owner, nsId);
      if (!ns.exists) return { entries: [], skipped: 0, complete: true, missingSeqs: [] };
      const got = dedupe(await this.config.source.entries({ owner: this.owner, nsId }), ns.nextSeq);
      const missingSeqs = missing(got, ns.nextSeq);
      const entries: RecalledEntry[] = [];
      let skipped = 0;
      for (const e of got) {
        try {
          const pt = await decryptEntry({ key: this.nsKey(label, e.epoch), ctx: this.ctx, nsId: hexToBytes(nsId), epoch: e.epoch, envelope: hexToBytes(e.ciphertext) });
          entries.push({ ...parseEntry(pt), seq: e.seq, epoch: e.epoch, byOwner: e.byOwner, agentId: e.agentId, txHash: e.txHash });
        } catch {
          skipped++;
        }
      }
      Object.assign(extra, { count: entries.length, skipped, missingSeqs });
      return { entries, skipped, complete: missingSeqs.length === 0, missingSeqs };
    });
  }

  /** Shares a namespace with an ERC-8004 agent. Re-prompts the passkey unless a ceremony happened in the last 60 s. */
  async grant(label: string, agentId: bigint, opts: { scope: GrantScope; expiresInSec: number; includeHistory: boolean }) {
    return traced(this.log, "owner", "grant", { label, agentId, scope: opts.scope }, async () => {
      this.touch();
      const nsId = this.nsIdOf(label);
      if (opts.scope !== "read" && opts.scope !== "readwrite") fail("INPUT_INVALID", "scope must be read or readwrite");
      if (!Number.isSafeInteger(opts.expiresInSec) || opts.expiresInSec <= 0 || opts.expiresInSec > MAX_EXPIRY_SEC) {
        fail("INPUT_INVALID", "expiresInSec must be 1..31536000 (365 days)");
      }
      // All checks that can fail happen before the passkey prompt.
      if (!(await this.reads.hasCurrentKeys(agentId))) {
        fail("AGENT_KEYS_NOT_CURRENT", `agent ${agentId} has no current keys (not published, or its ERC-8004 token changed hands)`);
      }
      const keys = await this.reads.agentKeys(agentId);
      const sourceKeys = await this.config.source.agentKeys?.(agentId).catch(() => undefined);
      if (sourceKeys && sourceKeys.x25519Pub.toLowerCase() !== keys.x25519Pub.toLowerCase()) {
        this.log({ stage: "sdk", side: "owner", op: "grant", traceId: "-", ok: true, code: "SOURCE_KEYS_MISMATCH", agentId: agentId.toString() });
      }
      let ns = await this.reads.namespace(this.owner, nsId);
      const epochs: bigint[] = [];
      for (let e = opts.includeHistory ? 0n : ns.epoch; e <= ns.epoch; e++) epochs.push(e);
      const wraps = await cryptoAsync(() =>
        Promise.all(epochs.map((epoch) =>
          wrapNamespaceKey({ ctx: this.ctx, nsId: hexToBytes(nsId), epoch, agentId, nsKey: this.nsKey(label, epoch), label, agentX25519Public: hexToBytes(keys.x25519Pub) }),
        )),
      );
      await this.freshCeremony();
      if (!ns.exists) {
        await this.relay("createNamespace", [nsId]);
        ns = await this.reads.namespace(this.owner, nsId);
      }
      const expiry = (await this.reads.chainTime()) + BigInt(opts.expiresInSec);
      const receipt = await this.relay("grant", [nsId, agentId, opts.scope === "read" ? 1 : 3, expiry, epochs, wraps.map((w) => toHex(w))]);
      return { txHash: receipt.transactionHash, epochs };
    });
  }

  async revoke(label: string, agentIds: bigint[]) {
    return traced(this.log, "owner", "revoke", { label, agentIds }, async () => {
      this.touch();
      if (agentIds.length === 0) fail("INPUT_INVALID", "agentIds must not be empty (use rotate)");
      return this.rotateWith(label, agentIds);
    });
  }

  async rotate(label: string) {
    return traced(this.log, "owner", "rotate", { label }, async () => {
      this.touch();
      return this.rotateWith(label, []);
    });
  }

  /** Keep set mirrors the contract's prune: grantees minus revoked minus expired minus not-current keys. */
  private async rotateWith(label: string, revokeIds: bigint[]) {
    const nsId = this.nsIdOf(label);
    for (let attempt = 0; ; attempt++) {
      const ns = await this.reads.namespace(this.owner, nsId);
      if (!ns.exists) fail("INPUT_INVALID", `no namespace "${label}" yet`);
      const newEpoch = ns.epoch + 1n;
      const now = await this.reads.chainTime();
      const keep: bigint[] = [];
      for (const id of await this.reads.grantees(this.owner, nsId)) {
        if (revokeIds.includes(id)) continue;
        const g = await this.reads.grant(this.owner, nsId, id);
        if (g.expiry > now && (await this.reads.hasCurrentKeys(id))) keep.push(id);
      }
      const wraps = await Promise.all(
        keep.map(async (id) =>
          toHex(await wrapNamespaceKey({
            ctx: this.ctx, nsId: hexToBytes(nsId), epoch: newEpoch, agentId: id, nsKey: this.nsKey(label, newEpoch), label,
            agentX25519Public: hexToBytes((await this.reads.agentKeys(id)).x25519Pub),
          })),
        ),
      );
      try {
        const receipt = revokeIds.length
          ? await this.relay("revoke", [nsId, revokeIds, keep, wraps])
          : await this.relay("rotate", [nsId, keep, wraps]);
        return { txHash: receipt.transactionHash, newEpoch };
      } catch (e) {
        if (!(e instanceof EngramError && e.detail === "KeepSetMismatch") || attempt >= 1) throw e;
      }
    }
  }

  async grants(): Promise<GrantView[]> {
    return traced(this.log, "owner", "grants", {}, async () => {
      this.touch();
      const rows = await this.config.source.grantsForOwner(this.owner);
      const out: GrantView[] = [];
      for (const g of rows) {
        const [onchain, active, keysCurrent, agentURI] = await Promise.all([
          this.reads.grant(this.owner, g.nsId, g.agentId),
          this.reads.isActive(this.owner, g.nsId, g.agentId),
          this.reads.hasCurrentKeys(g.agentId),
          this.reads.tokenURI(g.agentId),
        ]);
        out.push({
          nsId: g.nsId, label: this.labels.get(g.nsId.toLowerCase()), agentId: g.agentId, agentURI,
          scope: onchain.scope === 3 ? "readwrite" : "read", expiry: onchain.expiry, active, keysCurrent,
        });
      }
      return out;
    });
  }

  /** Invalidates any signed-but-unsubmitted relay call. */
  async cancelPending() {
    return traced(this.log, "owner", "cancelPending", {}, async () => {
      this.touch();
      const receipt = await this.relay("useNonce", []);
      return { txHash: receipt.transactionHash };
    });
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.prf.fill(0);
    this.signing.end();
  }

  private async freshCeremony() {
    if (!this.reauth || this.clock() - this.lastCeremony <= REAUTH_WINDOW_MS) return;
    const prf2 = await this.reauth();
    const owner2 = crypto(() => deriveAccount(prf2)).owner;
    prf2.fill(0);
    if (owner2.toLowerCase() !== this.owner.toLowerCase()) fail("REAUTH_MISMATCH", "a different passkey answered; approve with the passkey you signed in with");
    this.lastCeremony = this.clock();
  }
}

// ------------------------------------------------------------------------------------------ helpers

function seqFrom(logs: readonly { data: Hex; topics: readonly Hex[] }[]): bigint {
  for (const l of logs) {
    try {
      const ev = decodeEventLog({ abi: memoryRegistryAbi, data: l.data, topics: l.topics as never });
      if (ev.eventName === "EntryAppended") return (ev.args as { seq: bigint }).seq;
    } catch {
      /* other contract's log */
    }
  }
  throw new EngramError("TX_REVERTED", "append transaction emitted no EntryAppended event");
}

export function dedupe<T extends { seq: bigint }>(entries: T[], nextSeq: bigint): T[] {
  const bySeq = new Map<bigint, T>();
  for (const e of entries) if (e.seq < nextSeq && !bySeq.has(e.seq)) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => (a.seq < b.seq ? -1 : 1));
}

export function missing(entries: { seq: bigint }[], nextSeq: bigint): bigint[] {
  const have = new Set(entries.map((e) => e.seq));
  const out: bigint[] = [];
  for (let s = 0n; s < nextSeq; s++) if (!have.has(s)) out.push(s);
  return out;
}
