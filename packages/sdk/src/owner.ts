// Owner side (vault origin only). Spec: contracts/sdk.md "Owner", "Session scoping", "Trust boundaries".
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
  EngramCryptoError,
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
import { decodeEventLog, decodeFunctionData, encodeFunctionData, hexToBytes, toHex, type Hex, type LocalAccount, type TransactionReceipt } from "viem";
import { memoryRegistryAbi } from "./abi.js";
import { chainReads } from "./chain.js";
import { clientsFor, loggerOf, type EngramConfig } from "./config.js";
import { EngramError, crypto, cryptoAsync, fail } from "./errors.js";
import { traced } from "./log.js";
import { signOwnerCall, type RelayRequest } from "./relay.js";
import { APP_SESSION_MAX_TTL_SEC, APP_SESSION_TYPES, appSessionDomain, exactOrigin, type AppSessionProof } from "./appsession.js";

export const SESSION_IDLE_MS = 15 * 60 * 1000;
export const REAUTH_WINDOW_MS = 60 * 1000;
/** Grants expiring within this margin of chain time are revoked explicitly on rotation (sdk.md case 34). */
export const EXPIRY_MARGIN_SEC = 60n;
export const MAX_GRANTEES = 16;
const MAX_EXPIRY_SEC = 365 * 86400;
const UINT256_MAX = 2n ** 256n - 1n;

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

export function assertAgentId(agentId: bigint) {
  if (typeof agentId !== "bigint" || agentId < 0n || agentId > UINT256_MAX) fail("INPUT_INVALID", "agentId must be an integer in 0..2^256-1");
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

const ended = () => new EngramError("SESSION_ENDED", "this session has ended; sign in again");

export class OwnerSession {
  readonly owner: Hex;
  // Secrets live in ES private fields: invisible to JSON.stringify, util.inspect, and Object.keys (BUGLOG S5).
  readonly #prf: Uint8Array;
  readonly #signing: Secp256k1SigningSession;
  readonly #account: LocalAccount;
  readonly #config: EngramConfig;
  readonly #reauth: Reauth | undefined;
  readonly #clock: () => number;
  readonly #labels = new Map<string, string>(); // nsId -> label seen in this session
  #ended = false;
  #lastActivity: number;
  #lastCeremony: number;

  private constructor(config: EngramConfig, prf: Uint8Array, reauth: Reauth | undefined, clock: () => number) {
    this.#config = config;
    this.#reauth = reauth;
    this.#clock = clock;
    this.#prf = new Uint8Array(prf);
    const acc = crypto(() => deriveAccount(this.#prf));
    this.#signing = createSecp256k1SigningSession({ privateKey: acc.accountKey });
    acc.accountKey.fill(0);
    this.#account = toViemAccount(this.#signing) as LocalAccount;
    this.owner = acc.owner;
    this.#lastActivity = this.#lastCeremony = clock();
  }

  static async open(config: EngramConfig, prf: Uint8Array, reauth: Reauth | undefined, clock: () => number = Date.now) {
    return new OwnerSession(config, prf, reauth, clock);
  }

  toJSON() {
    return { owner: this.owner, ended: this.#ended };
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `OwnerSession { owner: '${this.owner}', ended: ${this.#ended} }`;
  }

  private get log() {
    return loggerOf(this.#config);
  }
  private get reads() {
    return chainReads(this.#config);
  }
  private get ctx(): BindingContext {
    return { chainId: BigInt(this.#config.chainId), registry: this.#config.registry, owner: this.owner };
  }

  /** Session guard at call entry: ended / idle-expired checks and activity bump. */
  private touch() {
    this.live();
    const now = this.#clock();
    if (now - this.#lastActivity > SESSION_IDLE_MS) {
      this.end();
      fail("SESSION_EXPIRED", "the session expired after 15 minutes of inactivity; unlock with your passkey");
    }
    this.#lastActivity = Math.max(this.#lastActivity, now);
  }

  /** Liveness check after every await: a call in flight when end() runs must not continue (BUGLOG S5). */
  private live() {
    if (this.#ended) throw ended();
  }

  private nsIdOf(label: string): Hex {
    const id = toHex(crypto(() => deriveNamespaceId(this.#prf, label)));
    this.#labels.set(id.toLowerCase(), label);
    return id;
  }

  private nsKey(label: string, epoch: bigint) {
    this.live();
    return deriveNamespaceKey(this.#prf, label, epoch);
  }

  /**
   * Signs and relays one owner call, then verifies the effect: the transaction must be a successful
   * `relay(...)` to the registry carrying exactly this signed request (BUGLOG S2). Re-signs once if another
   * tab consumed the nonce first.
   */
  private async relay(functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
    const data = encodeFunctionData({ abi: memoryRegistryAbi, functionName: functionName as never, args: args as never });
    const { publicClient } = clientsFor(this.#config);
    for (let attempt = 0; ; attempt++) {
      this.live();
      let req: RelayRequest;
      try {
        req = await signOwnerCall(this.#config, this.#account, data);
      } catch (e) {
        if (isMeraError(e) && e.code === "SESSION_ENDED") throw ended();
        throw e;
      }
      this.live();
      try {
        const { txHash } = await this.#config.relayer.submit(req);
        const [receipt, tx] = await Promise.all([
          publicClient.waitForTransactionReceipt({ hash: txHash }),
          publicClient.getTransaction({ hash: txHash }),
        ]);
        if (!isOurRelay(this.#config.registry, receipt, tx, req)) {
          throw new EngramError("RELAY_REJECTED", "the relayer did not execute this request", { detail: "EFFECT_NOT_FOUND" });
        }
        return receipt;
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
          return { seq: seqFrom(this.#config.registry, receipt, this.owner, nsId), txHash: receipt.transactionHash };
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
      this.live();
      if (!ns.exists) return { entries: [], skipped: 0, complete: true, missingSeqs: [] };
      const got = dedupe(await this.#config.source.entries({ owner: this.owner, nsId }), ns.nextSeq);
      const missingSeqs = missing(got, ns.nextSeq);
      const entries: RecalledEntry[] = [];
      let skipped = 0;
      for (const e of got) {
        const key = this.nsKey(label, e.epoch); // throws SESSION_ENDED if end() ran meanwhile
        try {
          const pt = await decryptEntry({ key, ctx: this.ctx, nsId: hexToBytes(nsId), epoch: e.epoch, envelope: hexToBytes(e.ciphertext) });
          entries.push({ ...parseEntry(pt), seq: e.seq, epoch: e.epoch, byOwner: e.byOwner, agentId: e.agentId, txHash: e.txHash });
        } catch {
          skipped++;
        }
      }
      this.live();
      Object.assign(extra, { count: entries.length, skipped, missingSeqs });
      return { entries, skipped, complete: missingSeqs.length === 0, missingSeqs };
    });
  }

  /** Shares a namespace with an ERC-8004 agent. Re-prompts the passkey unless a ceremony happened in the last 60 s. */
  async grant(label: string, agentId: bigint, opts: { scope: GrantScope; expiresInSec: number; includeHistory: boolean }) {
    return traced(this.log, "owner", "grant", { label, agentId, scope: opts.scope }, async () => {
      this.touch();
      const nsId = this.nsIdOf(label);
      assertAgentId(agentId);
      if (opts.scope !== "read" && opts.scope !== "readwrite") fail("INPUT_INVALID", "scope must be read or readwrite");
      if (!Number.isSafeInteger(opts.expiresInSec) || opts.expiresInSec <= 0 || opts.expiresInSec > MAX_EXPIRY_SEC) {
        fail("INPUT_INVALID", "expiresInSec must be 1..31536000 (365 days)");
      }
      // All checks that can fail happen before the passkey prompt.
      if (!(await this.reads.hasCurrentKeys(agentId))) {
        fail("AGENT_KEYS_NOT_CURRENT", `agent ${agentId} has no current keys (not published, or its ERC-8004 token changed hands)`);
      }
      const keys = await this.reads.agentKeys(agentId);
      const sourceKeys = await this.#config.source.agentKeys?.(agentId).catch(() => undefined);
      if (sourceKeys && sourceKeys.x25519Pub.toLowerCase() !== keys.x25519Pub.toLowerCase()) {
        this.log({ stage: "sdk", side: "owner", op: "grant", traceId: "-", ok: true, code: "SOURCE_KEYS_MISMATCH", agentId: agentId.toString() });
      }
      let ns = await this.reads.namespace(this.owner, nsId);
      // A 17th grantee: rotate first if any grantee is expired or stale (they get revoked), else refuse (case 35).
      if (ns.exists) {
        const grantees = await this.reads.grantees(this.owner, nsId);
        if (!grantees.includes(agentId) && grantees.length >= MAX_GRANTEES) {
          const plan = await this.keepPlan(label, nsId, ns.epoch + 1n, []);
          if (plan.revoke.length === 0) fail("INPUT_INVALID", `a folder can be shared with at most ${MAX_GRANTEES} agents; revoke one first`);
          await this.rotateWith(label, []);
          ns = await this.reads.namespace(this.owner, nsId);
        }
      }
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
      agentIds.forEach(assertAgentId);
      return this.rotateWith(label, agentIds);
    });
  }

  async rotate(label: string) {
    return traced(this.log, "owner", "rotate", { label }, async () => {
      this.touch();
      return this.rotateWith(label, []);
    });
  }

  /**
   * Splits the grantees for a rotation to `newEpoch` into what the contract will accept:
   * keep = live grantees whose key wraps; revoke = requested ids, near-expiry (< 60 s) or stale-key grantees,
   * and grantees whose key cannot be wrapped (BUGLOG S3, S6). Wrapped keys are returned for the keep set.
   */
  private async keepPlan(label: string, nsId: Hex, newEpoch: bigint, requested: bigint[]) {
    const now = await this.reads.chainTime();
    const revoke = [...requested];
    const keep: bigint[] = [];
    const wraps: Hex[] = [];
    for (const id of await this.reads.grantees(this.owner, nsId)) {
      if (revoke.includes(id)) continue;
      const g = await this.reads.grant(this.owner, nsId, id);
      if (g.expiry <= now + EXPIRY_MARGIN_SEC || !(await this.reads.hasCurrentKeys(id))) {
        revoke.push(id);
        continue;
      }
      try {
        const wrap = await wrapNamespaceKey({
          ctx: this.ctx, nsId: hexToBytes(nsId), epoch: newEpoch, agentId: id, nsKey: this.nsKey(label, newEpoch), label,
          agentX25519Public: hexToBytes((await this.reads.agentKeys(id)).x25519Pub),
        });
        keep.push(id);
        wraps.push(toHex(wrap));
      } catch (e) {
        if (!(e instanceof EngramCryptoError)) throw e;
        this.log({ stage: "sdk", side: "owner", op: "rotate", traceId: "-", ok: true, code: "UNWRAPPABLE_KEY_REVOKED", agentId: id.toString() });
        revoke.push(id);
      }
    }
    return { keep, wraps, revoke };
  }

  private async rotateWith(label: string, requested: bigint[]) {
    const nsId = this.nsIdOf(label);
    for (let attempt = 0; ; attempt++) {
      const ns = await this.reads.namespace(this.owner, nsId);
      if (!ns.exists) fail("INPUT_INVALID", `no namespace "${label}" yet`);
      const newEpoch = ns.epoch + 1n;
      const plan = await this.keepPlan(label, nsId, newEpoch, requested);
      try {
        const receipt = plan.revoke.length
          ? await this.relay("revoke", [nsId, plan.revoke, plan.keep, plan.wraps])
          : await this.relay("rotate", [nsId, plan.keep, plan.wraps]);
        return { txHash: receipt.transactionHash, newEpoch };
      } catch (e) {
        if (!(e instanceof EngramError && e.detail === "KeepSetMismatch") || attempt >= 1) throw e;
      }
    }
  }

  async grants(): Promise<GrantView[]> {
    return traced(this.log, "owner", "grants", {}, async () => {
      this.touch();
      const rows = await this.#config.source.grantsForOwner(this.owner);
      const out: GrantView[] = [];
      for (const g of rows) {
        const [onchain, active, keysCurrent, agentURI] = await Promise.all([
          this.reads.grant(this.owner, g.nsId, g.agentId),
          this.reads.isActive(this.owner, g.nsId, g.agentId),
          this.reads.hasCurrentKeys(g.agentId),
          this.reads.tokenURI(g.agentId),
        ]);
        out.push({
          nsId: g.nsId, label: this.#labels.get(g.nsId.toLowerCase()), agentId: g.agentId, agentURI,
          scope: onchain.scope === 3 ? "readwrite" : "read", expiry: onchain.expiry, active, keysCurrent,
        });
      }
      this.live();
      return out;
    });
  }

  /**
   * Signs an app session proof (identity for one app and agent), inside the session: no passkey prompt.
   * The app server checks it with `verifyAppSession`; it grants no access on its own.
   */
  async signAppSession(opts: { agentId: bigint; origin: string; ttlSec: number }): Promise<AppSessionProof> {
    return traced(this.log, "owner", "signAppSession", { agentId: opts.agentId }, async () => {
      this.touch();
      assertAgentId(opts.agentId);
      const origin = exactOrigin(opts.origin) ?? fail("INPUT_INVALID", "origin must be an exact http(s) origin");
      if (!Number.isSafeInteger(opts.ttlSec) || opts.ttlSec <= 0 || opts.ttlSec > APP_SESSION_MAX_TTL_SEC) {
        fail("INPUT_INVALID", `ttlSec must be 1..${APP_SESSION_MAX_TTL_SEC} (30 days)`);
      }
      const issuedAt = BigInt(Math.floor(Date.now() / 1000));
      const expiresAt = issuedAt + BigInt(opts.ttlSec);
      this.live();
      let signature: Hex;
      try {
        signature = await this.#account.signTypedData({
          domain: appSessionDomain(this.#config), types: APP_SESSION_TYPES, primaryType: "AppSession",
          message: { owner: this.owner, agentId: opts.agentId, origin, issuedAt, expiresAt },
        });
      } catch (e) {
        if (isMeraError(e) && e.code === "SESSION_ENDED") throw ended();
        throw e;
      }
      return { owner: this.owner, agentId: opts.agentId.toString(), origin, issuedAt: issuedAt.toString(), expiresAt: expiresAt.toString(), signature };
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
    if (this.#ended) return;
    this.#ended = true;
    this.#prf.fill(0);
    this.#signing.end();
  }

  /** A clock that went backwards never counts as "recent" (BUGLOG S5). */
  private async freshCeremony() {
    const elapsed = this.#clock() - this.#lastCeremony;
    if (!this.#reauth || (elapsed >= 0 && elapsed <= REAUTH_WINDOW_MS)) return;
    const prf2 = await this.#reauth();
    const owner2 = crypto(() => deriveAccount(prf2)).owner;
    prf2.fill(0);
    if (owner2.toLowerCase() !== this.owner.toLowerCase()) fail("REAUTH_MISMATCH", "a different passkey answered; approve with the passkey you signed in with");
    this.live();
    this.#lastCeremony = this.#clock();
  }
}

// ------------------------------------------------------------------------------------------ helpers

/** The tx must be a successful `relay(owner, data, deadline, signature)` call to the registry with exactly `req`. */
function isOurRelay(registry: Hex, receipt: TransactionReceipt, tx: { to: Hex | null; input: Hex }, req: RelayRequest): boolean {
  if (receipt.status !== "success" || !tx.to || tx.to.toLowerCase() !== registry.toLowerCase()) return false;
  try {
    const call = decodeFunctionData({ abi: memoryRegistryAbi, data: tx.input });
    if (call.functionName !== "relay") return false;
    const [owner, data, deadline, signature] = call.args as [Hex, Hex, bigint, Hex];
    return (
      owner.toLowerCase() === req.owner.toLowerCase() &&
      data.toLowerCase() === req.data.toLowerCase() &&
      deadline.toString() === req.deadline &&
      signature.toLowerCase() === req.signature.toLowerCase()
    );
  } catch {
    return false;
  }
}

/** seq of the EntryAppended this owner's append emitted (registry address, owner, and namespace must match). */
function seqFrom(registry: Hex, receipt: TransactionReceipt, owner: Hex, nsId: Hex): bigint {
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== registry.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: memoryRegistryAbi, data: l.data, topics: l.topics as never });
      const a = ev.args as { owner?: Hex; nsId?: Hex; seq?: bigint };
      if (ev.eventName === "EntryAppended" && a.owner?.toLowerCase() === owner.toLowerCase() && a.nsId?.toLowerCase() === nsId.toLowerCase()) {
        return a.seq!;
      }
    } catch {
      /* other log */
    }
  }
  throw new EngramError("RELAY_REJECTED", "the append emitted no matching EntryAppended event", { detail: "EFFECT_NOT_FOUND" });
}

/** In-range, deduplicated, seq-ordered entries (negative or >= nextSeq seqs from a source are dropped). */
export function dedupe<T extends { seq: bigint }>(entries: T[], nextSeq: bigint): T[] {
  const bySeq = new Map<bigint, T>();
  for (const e of entries) if (e.seq >= 0n && e.seq < nextSeq && !bySeq.has(e.seq)) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => (a.seq < b.seq ? -1 : 1));
}

export function missing(entries: { seq: bigint }[], nextSeq: bigint): bigint[] {
  const have = new Set(entries.map((e) => e.seq));
  const out: bigint[] = [];
  for (let s = 0n; s < nextSeq; s++) if (!have.has(s)) out.push(s);
  return out;
}
