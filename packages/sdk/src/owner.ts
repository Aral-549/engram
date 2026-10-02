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
  derivePairwise,
  encodeEntry,
  encodeEntryV2,
  encryptEntry,
  parseAnyEntry,
  parseEntry,
  wrapNamespaceKey,
  type AnyEntry,
  type BindingContext,
  type Entry,
  type EntryKind,
} from "@engram/crypto";
import { decodeEventLog, decodeFunctionData, encodeFunctionData, hexToBytes, toHex, type Hex, type LocalAccount, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { LogItem } from "@engram/crypto";
import { selectCandidates, type Candidate, type DisclosedEntry, type DisclosureMode } from "./select.js";
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

// Disclosure mode (contracts/disclosure.md). Reserved folders hold the owner's own encrypted bookkeeping.
export const POLICY_LABEL = "engram-policy";
export const LOG_LABEL = "engram-log";
export const POLICY_CACHE_MS = 3000;
const DISCLOSE_LIMIT = { max: 60, windowMs: 10 * 60 * 1000 };
const PROPOSE_LIMIT = { max: 20, windowMs: 24 * 60 * 60 * 1000 };
const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LOG_QUEUE_MAX = 500;
const LOG_ENTRY_MAX_BYTES = 2048;
const PROPOSE_KINDS = ["fact", "preference", "note"];

export type PolicyView = { agentId: bigint; origin: string; labels: string[]; scope: GrantScope; exp: number; active: boolean; seq: bigint };
export type LogView = {
  agentId: bigint; origin: string; q: string; mode: "relevant" | "full" | "write"; refs: { label: string; seq: bigint }[];
  n: number; round: number; t: number; seq: bigint;
};
export type RecalledAnyEntry = { kind: string; text: string; t: number; src?: { agent: string }; seq: bigint; epoch: bigint; byOwner: boolean; agentId: bigint; txHash: Hex };
type Doc = { doc: AnyEntry; seq: bigint; epoch: bigint; byOwner: boolean; agentId: bigint; txHash: Hex };
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
  #policyCache: { at: number; byAgent: Map<string, PolicyView> } | undefined;
  readonly #discloseHits = new Map<string, number[]>();
  readonly #proposeHits = new Map<string, number[]>();
  #relayTail: Promise<void> = Promise.resolve();
  #foreground = 0; // user actions waiting for or holding the relay; background log writes yield to them (D34)
  // Batched read log (D35): items wait here, at most LOG_QUEUE_MAX, and are written every 10-20 s.
  readonly #logItems: LogItem[] = [];
  #logDropped = 0;
  #logTimer: ReturnType<typeof setTimeout> | undefined;
  #logFlight: Promise<void> | undefined;
  // Policy changes apply in call order (D36); a revoke counts from the moment it is called (D34).
  #policyTail: Promise<unknown> = Promise.resolve();
  #policyTicket = 0;
  readonly #revokedAt = new Map<string, number>();
  readonly #pairwiseAddr = new Map<string, Hex>();
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
  private async relay(functionName: string, args: readonly unknown[], background = false): Promise<TransactionReceipt> {
    // One relay at a time per session: background log appends must not race user actions for the nonce, and they
    // wait while any user action is queued, so a flood of reads can never delay a revoke (D34).
    if (background) {
      while (this.#foreground > 0 && !this.#ended) await new Promise((r) => setTimeout(r, 100));
    } else {
      this.#foreground++;
    }
    try {
      return await this.relaySerial(functionName, args);
    } finally {
      if (!background) this.#foreground--;
    }
  }

  private async relaySerial(functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
    const prev = this.#relayTail;
    let release!: () => void;
    this.#relayTail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await this.relayNow(functionName, args);
    } finally {
      release();
    }
  }

  private async relayNow(functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
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
      const plaintext = crypto(() => encodeEntry({ v: 1, t: Date.now(), kind: entry.kind, text: entry.text }));
      return this.appendPlain(label, plaintext);
    });
  }

  /** Encrypts and appends one canonical entry document (v1 or v2) to a folder, creating the folder if needed. */
  private async appendPlain(label: string, plaintext: Uint8Array, background = false): Promise<{ seq: bigint; txHash: Hex }> {
    {
      const nsId = this.nsIdOf(label);
      for (let attempt = 0; ; attempt++) {
        const ns = await this.reads.namespace(this.owner, nsId);
        if (!ns.exists) await this.relay("createNamespace", [nsId], background).catch((e) => {
          if (!(e instanceof EngramError && e.detail === "NamespaceExists")) throw e;
        });
        const envelope = await encryptEntry({ key: this.nsKey(label, ns.epoch), ctx: this.ctx, nsId: hexToBytes(nsId), epoch: ns.epoch, plaintext });
        try {
          const receipt = await this.relay("appendAsOwner", [nsId, ns.epoch, toHex(envelope)], background);
          return { seq: seqFrom(this.#config.registry, receipt, this.owner, nsId), txHash: receipt.transactionHash };
        } catch (e) {
          if (!(e instanceof EngramError && e.detail === "WrongEpoch") || attempt >= 1) throw e; // rotated meanwhile
        }
      }
    }
  }

  /** Every decryptable document in a folder (v1 and v2), seq-ordered. Undecodable entries are counted, not returned. */
  private async readDocs(label: string): Promise<{ docs: Doc[]; skipped: number; missingSeqs: bigint[] }> {
    const nsId = this.nsIdOf(label);
    const ns = await this.reads.namespace(this.owner, nsId);
    this.live();
    if (!ns.exists) return { docs: [], skipped: 0, missingSeqs: [] };
    const got = dedupe(await this.#config.source.entries({ owner: this.owner, nsId }), ns.nextSeq);
    const missingSeqs = missing(got, ns.nextSeq);
    const docs: Doc[] = [];
    let skipped = 0;
    for (const e of got) {
      const key = this.nsKey(label, e.epoch);
      try {
        const pt = await decryptEntry({ key, ctx: this.ctx, nsId: hexToBytes(nsId), epoch: e.epoch, envelope: hexToBytes(e.ciphertext) });
        docs.push({ doc: parseAnyEntry(pt), seq: e.seq, epoch: e.epoch, byOwner: e.byOwner, agentId: e.agentId, txHash: e.txHash });
      } catch {
        skipped++;
      }
    }
    this.live();
    return { docs, skipped, missingSeqs };
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
      if (typeof label === "string" && label.startsWith("engram-")) fail("INPUT_INVALID", "engram-* folders are reserved and cannot be shared (D37)");
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
  async signAppSession(opts: { agentId: bigint; origin: string; ttlSec: number; pairwise?: boolean }): Promise<AppSessionProof> {
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
      // Disclosure mode: the agent only ever sees the pairwise identity for its own agentId (disclosure.md D2).
      const signer: LocalAccount = opts.pairwise ? this.pairwiseAccount(opts.agentId) : this.#account;
      const owner = signer.address;
      let signature: Hex;
      try {
        signature = await signer.signTypedData({
          domain: appSessionDomain(this.#config), types: APP_SESSION_TYPES, primaryType: "AppSession",
          message: { owner, agentId: opts.agentId, origin, issuedAt, expiresAt },
        });
      } catch (e) {
        if (isMeraError(e) && e.code === "SESSION_ENDED") throw ended();
        throw e;
      }
      this.live();
      return { owner, agentId: opts.agentId.toString(), origin, issuedAt: issuedAt.toString(), expiresAt: expiresAt.toString(), signature };
    });
  }

  // ---------------------------------------------------------------------------------------- Disclosure mode

  /** The pseudonymous address agent `agentId` sees for this owner (stable across devices, distinct per agent). */
  pairwise(agentId: bigint): Hex {
    this.live();
    assertAgentId(agentId);
    const k = agentId.toString();
    let a = this.#pairwiseAddr.get(k);
    if (!a) {
      const id = crypto(() => derivePairwise(this.#prf, agentId));
      id.key.fill(0);
      a = id.address as Hex;
      this.#pairwiseAddr.set(k, a);
    }
    return a;
  }

  private pairwiseAccount(agentId: bigint): LocalAccount {
    this.live();
    const id = crypto(() => derivePairwise(this.#prf, agentId));
    const account = privateKeyToAccount(toHex(id.key));
    id.key.fill(0);
    return account;
  }

  /** Approves an agent for Disclosure mode: an encrypted policy entry, no onchain grant, no key leaves the vault. */
  async approve(agentId: bigint, opts: { origin: string; labels: string[]; scope: GrantScope; expiresInSec: number }) {
    return traced(this.log, "owner", "approve", { agentId, scope: opts.scope }, async () => {
      this.touch();
      assertAgentId(agentId);
      const origin = exactOrigin(opts.origin) ?? fail("INPUT_INVALID", "origin must be an exact http(s) origin");
      const labels = Array.isArray(opts.labels) ? [...opts.labels] : [];
      if (!labels.length || labels.length > 8 || new Set(labels).size !== labels.length || !labels.every((l) => typeof l === "string" && LABEL_RE.test(l) && !l.startsWith("engram-"))) {
        fail("INPUT_INVALID", "labels must be 1..8 unique, non-reserved folder labels");
      }
      if (opts.scope !== "read" && opts.scope !== "readwrite") fail("INPUT_INVALID", "scope must be read or readwrite");
      if (!Number.isSafeInteger(opts.expiresInSec) || opts.expiresInSec <= 0 || opts.expiresInSec > MAX_EXPIRY_SEC) {
        fail("INPUT_INVALID", "expiresInSec must be 1..31536000 (365 days)");
      }
      const ticket = ++this.#policyTicket;
      return this.inPolicyOrder(async () => {
        await this.freshCeremony(); // approving shares data: same prompt rule as grant (sdk.md "Session scoping")
        const exp = this.#clock() + opts.expiresInSec * 1000;
        const r = await this.writePolicy({ agentId, origin, labels, scope: opts.scope, exp, active: true });
        // A later approval lifts an earlier revoke; an earlier one never lifts a later revoke (D36).
        if ((this.#revokedAt.get(agentId.toString()) ?? -1) < ticket) this.#revokedAt.delete(agentId.toString());
        return r;
      });
    });
  }

  /** Runs policy writes one at a time, in call order (D36). */
  private inPolicyOrder<T>(f: () => Promise<T>): Promise<T> {
    const run = this.#policyTail.then(f, f);
    this.#policyTail = run.catch(() => undefined);
    return run;
  }

  /** Withdraws an approval: the vault stops answering that agent. */
  async disapprove(agentId: bigint): Promise<{ txHash?: Hex; pending?: true }> {
    return traced(this.log, "owner", "disapprove", { agentId }, async () => {
      this.touch();
      assertAgentId(agentId);
      // Effective now, on this device, before any network call (D34): the vault stops answering this agent.
      const ticket = ++this.#policyTicket;
      this.#revokedAt.set(agentId.toString(), ticket);
      return this.inPolicyOrder(async () => {
        const p = (this.#policyCache?.byAgent.get(agentId.toString())) ?? (await this.loadPolicies(true)).get(agentId.toString());
        if (!p) fail("INPUT_INVALID", `agent ${agentId} has no approval`);
        const doc = { agentId, origin: p!.origin, labels: p!.labels, scope: p!.scope, exp: p!.exp, active: false };
        try {
          const r = await this.writePolicy(doc);
          return { txHash: r.txHash };
        } catch (e) {
          if (e instanceof EngramError && e.code === "SESSION_ENDED") throw e;
          this.log({ stage: "sdk", side: "owner", op: "disapprove", traceId: "-", ok: false, code: "REVOKE_PENDING", agentId: agentId.toString() });
          this.retryRevoke(doc, 1);
          return { pending: true as const };
        }
      });
    });
  }

  /** Keeps trying to record a revoke onchain (for other devices); this device already stopped answering. */
  private retryRevoke(doc: Omit<PolicyView, "seq">, attempt: number) {
    if (this.#ended || attempt > 10) return;
    const t = setTimeout(() => {
      void this.inPolicyOrder(async () => {
        if (this.#ended) return;
        try {
          await this.writePolicy(doc);
        } catch {
          this.retryRevoke(doc, attempt + 1);
        }
      });
    }, Math.min(60_000, 2000 * 2 ** (attempt - 1)));
    (t as { unref?: () => void }).unref?.();
  }

  private async writePolicy(p: Omit<PolicyView, "seq">) {
    const bytes = crypto(() =>
      encodeEntryV2({ v: 2, t: this.#clock(), kind: "policy", agent: p.agentId.toString(), origin: p.origin, labels: p.labels, scope: p.scope, exp: p.exp, active: p.active }),
    );
    const r = await this.appendPlain(POLICY_LABEL, bytes);
    const cache = this.#policyCache ?? { at: this.#clock(), byAgent: new Map() };
    const prev = cache.byAgent.get(p.agentId.toString());
    if (!prev || prev.seq < r.seq) cache.byAgent.set(p.agentId.toString(), { ...p, seq: r.seq });
    this.#policyCache = cache;
    return { txHash: r.txHash, pairwiseOwner: this.pairwise(p.agentId) };
  }

  /** Latest policy per agent, re-read from the chain when the cache is older than 3 s (or when forced). */
  private async loadPolicies(force = false): Promise<Map<string, PolicyView>> {
    const now = this.#clock();
    const c = this.#policyCache;
    if (!force && c && now - c.at >= 0 && now - c.at <= POLICY_CACHE_MS) return c.byAgent;
    let read = await this.readDocs(POLICY_LABEL);
    for (let i = 0; i < 6 && read.missingSeqs.length; i++) {
      await new Promise((r) => setTimeout(r, 500)); // the indexer can trail the chain (D29)
      read = await this.readDocs(POLICY_LABEL);
    }
    const { docs } = read;
    // Start from what this session already knows: a refresh never replaces a policy with an older one, so indexer
    // lag can never undo a revoke made here (BUGLOG D-3, disclosure.md D30).
    const byAgent = new Map<string, PolicyView>(c?.byAgent ?? []);
    for (const d of docs) {
      if (d.doc.v !== 2 || d.doc.kind !== "policy" || !d.byOwner) continue;
      const x = d.doc;
      const prev = byAgent.get(x.agent);
      if (!prev || prev.seq < d.seq) byAgent.set(x.agent, { agentId: BigInt(x.agent), origin: x.origin, labels: x.labels, scope: x.scope, exp: x.exp, active: x.active, seq: d.seq });
    }
    this.#policyCache = { at: now, byAgent };
    return byAgent;
  }

  private withLocalRevokes(p: PolicyView | undefined): PolicyView | undefined {
    return p && this.#revokedAt.has(p.agentId.toString()) ? { ...p, active: false } : p;
  }

  async policies(): Promise<PolicyView[]> {
    return traced(this.log, "owner", "policies", {}, async () => {
      this.touch();
      await this.#policyTail; // reflect policy writes already requested
      return [...(await this.loadPolicies(true)).values()].map((p) => this.withLocalRevokes(p)!);
    });
  }

  /** The current approval for one agent (cached up to 3 s), used by the bridge to check the requesting origin. */
  async approvalFor(agentId: bigint): Promise<PolicyView | undefined> {
    this.touch();
    assertAgentId(agentId);
    return this.withLocalRevokes((await this.loadPolicies()).get(agentId.toString()));
  }

  private async checkedPolicy(agentId: bigint, origin: string): Promise<PolicyView> {
    assertAgentId(agentId);
    if (this.#revokedAt.has(agentId.toString())) fail("NOT_APPROVED", "this agent is not approved for this site");
    const p = (await this.loadPolicies()).get(agentId.toString());
    if (!p || !p.active || p.origin !== origin) fail("NOT_APPROVED", "this agent is not approved for this site");
    if (p!.exp <= this.#clock()) fail("EXPIRED", "this approval has expired");
    return p!;
  }

  private hit(map: Map<string, number[]>, key: string, limit: { max: number; windowMs: number }): boolean {
    const now = this.#clock();
    const list = (map.get(key) ?? []).filter((t) => now - t >= 0 && now - t < limit.windowMs);
    if (list.length >= limit.max) {
      map.set(key, list);
      return false;
    }
    list.push(now);
    map.set(key, list);
    return true;
  }

  /** Answers one agent question from approved folders only, and logs the read (contracts/disclosure.md). */
  async disclose(req: { agentId: bigint; origin: string; query: string; mode: DisclosureMode; round: number }): Promise<{ entries: DisclosedEntry[]; mode: DisclosureMode }> {
    return traced(this.log, "owner", "disclose", { agentId: req.agentId, mode: req.mode }, async (extra) => {
      this.touch();
      if (typeof req.query !== "string" || [...req.query].length > 500) fail("BAD_REQUEST", "query must be a string of at most 500 characters");
      if (req.mode !== "relevant" && req.mode !== "full") fail("BAD_REQUEST", "mode must be relevant or full");
      if (!Number.isSafeInteger(req.round) || req.round < 0 || req.round > 3) fail("BAD_REQUEST", "round must be 0..3");
      const policy = await this.checkedPolicy(req.agentId, req.origin);
      if (!this.hit(this.#discloseHits, req.agentId.toString(), DISCLOSE_LIMIT)) fail("RATE_LIMITED", "too many reads by this agent; try again in a few minutes");
      const me = req.agentId.toString();
      const candidates: Candidate[] = [];
      let lagBudget = 6; // the indexer can trail the chain by ~1 s: re-read briefly, once per call (D29)
      for (const label of policy.labels) {
        let read = await this.readDocs(label);
        while (read.missingSeqs.length && lagBudget-- > 0) {
          await new Promise((r) => setTimeout(r, 500));
          read = await this.readDocs(label);
        }
        for (const d of read.docs) {
          const x = d.doc;
          if (x.v !== 1 && (x.kind === "policy" || x.kind === "log" || x.kind === "logs")) continue;
          // Who wrote it: only the owner's own appends count as the owner's, and `src` is trusted only on those
          // (D31, D32). Any agent's writes reach that agent alone (quarantine, D19).
          const writer = d.byOwner ? (x.v === 1 ? "owner" : x.src.agent) : d.agentId.toString();
          if (writer === "owner") candidates.push({ kind: x.kind, text: x.text, by: "owner", t: x.t, seq: d.seq, label });
          else if (writer === me) candidates.push({ kind: x.kind, text: x.text, by: "self", t: x.t, seq: d.seq, label });
        }
      }
      const picked = selectCandidates(req.query, candidates, req.mode);
      this.queueLog({
        agentId: req.agentId, origin: req.origin, q: [...req.query].slice(0, 200).join(""), mode: req.mode,
        refs: picked.map((c) => ({ label: c.label, seq: c.seq })), n: picked.length, round: req.round,
      });
      extra.count = picked.length;
      return { entries: picked.map(({ kind, text, by }) => ({ kind, text, by })), mode: req.mode };
    });
  }

  /** Writes an agent's proposal into an approved folder as the owner, tagged with its source (v2, D17). */
  async propose(agentId: bigint, origin: string, entry: { kind: EntryKind; text: string; label?: string }): Promise<{ seq: bigint; txHash: Hex }> {
    return traced(this.log, "owner", "propose", { agentId }, async () => {
      this.touch();
      const policy = await this.checkedPolicy(agentId, origin);
      if (policy.scope !== "readwrite") fail("READ_ONLY", "this agent may read but not write");
      const label = entry.label ?? policy.labels[0]!;
      if (!policy.labels.includes(label)) fail("BAD_REQUEST", "that folder is not approved for this agent");
      if (typeof entry.kind !== "string" || !PROPOSE_KINDS.includes(entry.kind)) fail("BAD_REQUEST", "kind must be fact, preference, or note");
      const text = typeof entry.text === "string" ? entry.text.trim() : "";
      if ([...text].length < 1 || [...text].length > 500) fail("BAD_REQUEST", "text must be 1..500 characters");
      if (!this.hit(this.#proposeHits, agentId.toString(), PROPOSE_LIMIT)) fail("QUOTA", "this agent reached its daily limit of proposals");
      const bytes = crypto(() => encodeEntryV2({ v: 2, t: this.#clock(), kind: entry.kind, text, src: { agent: agentId.toString() } }));
      const r = await this.appendPlain(label, bytes);
      this.queueLog({ agentId, origin, q: "", mode: "write", refs: [{ label, seq: r.seq }], n: 1, round: 0 });
      return r;
    });
  }

  /** Queues one read for the encrypted log. Written in batches every 10-20 s, never right after the read (D35). */
  private queueLog(l: Omit<LogView, "t" | "seq">) {
    this.#logItems.push({
      t: this.#clock(), agent: l.agentId.toString(), origin: l.origin, q: l.q, mode: l.mode,
      refs: l.refs.map((r) => ({ l: r.label, s: r.seq.toString() })), n: l.n, round: l.round,
    });
    while (this.#logItems.length > LOG_QUEUE_MAX) {
      this.#logItems.shift();
      this.#logDropped++;
    }
    this.scheduleLogs();
  }

  private scheduleLogs() {
    if (this.#logTimer || this.#ended || !this.#logItems.length) return;
    this.#logTimer = setTimeout(() => {
      this.#logTimer = undefined;
      void this.writeLogs();
    }, 10_000 + Math.floor(Math.random() * 10_000));
    (this.#logTimer as { unref?: () => void }).unref?.();
  }

  /** Packs queued items into as few `logs` entries as fit in 2048 bytes and appends them in the background. */
  private writeLogs(): Promise<void> {
    if (this.#logFlight) return this.#logFlight;
    this.#logFlight = (async () => {
      try {
        while (this.#logItems.length && !this.#ended) {
          let take = 0;
          let bytes: Uint8Array | undefined;
          for (let k = 1; k <= Math.min(20, this.#logItems.length); k++) {
            let b: Uint8Array;
            try {
              b = crypto(() => encodeEntryV2({ v: 2, t: this.#clock(), kind: "logs", items: this.#logItems.slice(0, k) }));
            } catch {
              break;
            }
            if (b.length > LOG_ENTRY_MAX_BYTES) break;
            take = k;
            bytes = b;
          }
          if (!bytes) {
            this.#logItems.shift(); // an unencodable item: drop it rather than block the log
            this.#logDropped++;
            continue;
          }
          try {
            await this.appendPlain(LOG_LABEL, bytes, true);
            this.#logItems.splice(0, take);
          } catch {
            this.log({ stage: "sdk", side: "owner", op: "log", traceId: "-", ok: false, code: "LOG_PENDING", pending: this.#logItems.length });
            break;
          }
        }
      } finally {
        this.#logFlight = undefined;
        this.scheduleLogs();
      }
    })();
    return this.#logFlight;
  }

  /** Writes queued log items now. Returns how many are still waiting and how many were dropped (queue cap). */
  async flushLogs(): Promise<{ pending: number; dropped: number }> {
    if (this.#logTimer) clearTimeout(this.#logTimer);
    this.#logTimer = undefined;
    await this.writeLogs();
    if (this.#logTimer) clearTimeout(this.#logTimer);
    this.#logTimer = undefined;
    return { pending: this.#logItems.length, dropped: this.#logDropped };
  }

  async disclosures(filter: { agentId?: bigint } = {}): Promise<LogView[]> {
    return traced(this.log, "owner", "disclosures", {}, async () => {
      this.touch();
      const out: LogView[] = [];
      for (const d of (await this.readDocs(LOG_LABEL)).docs) {
        const x = d.doc;
        if (x.v !== 2 || !d.byOwner) continue;
        const items: LogItem[] = x.kind === "log" ? [x] : x.kind === "logs" ? x.items : [];
        for (const it of items) {
          if (filter.agentId !== undefined && it.agent !== filter.agentId.toString()) continue;
          out.push({ agentId: BigInt(it.agent), origin: it.origin, q: it.q, mode: it.mode, refs: it.refs.map((r) => ({ label: r.l, seq: BigInt(r.s) })), n: it.n, round: it.round, t: it.t, seq: d.seq });
        }
      }
      return out.sort((a, b) => (b.seq > a.seq ? 1 : b.seq < a.seq ? -1 : b.t - a.t));
    });
  }

  /** Like recall, but includes v2 agent proposals with their source. */
  async recallAll(label: string): Promise<{ entries: RecalledAnyEntry[]; skipped: number; complete: boolean; missingSeqs: bigint[] }> {
    return traced(this.log, "owner", "recallAll", { label }, async () => {
      this.touch();
      const { docs, skipped, missingSeqs } = await this.readDocs(label);
      const entries: RecalledAnyEntry[] = [];
      for (const d of docs) {
        const x = d.doc;
        const meta = { seq: d.seq, epoch: d.epoch, byOwner: d.byOwner, agentId: d.agentId, txHash: d.txHash };
        if (x.v === 1) entries.push({ kind: x.kind, text: x.text, t: x.t, ...meta });
        // `src` is trusted only on the owner's own appends; an agent-appended entry is credited to its writer (D32).
        else if (x.kind !== "policy" && x.kind !== "log" && x.kind !== "logs") entries.push({ kind: x.kind, text: x.text, t: x.t, ...(d.byOwner ? { src: x.src } : {}), ...meta });
      }
      return { entries, skipped, complete: missingSeqs.length === 0, missingSeqs };
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
    if (this.#logTimer) clearTimeout(this.#logTimer);
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
