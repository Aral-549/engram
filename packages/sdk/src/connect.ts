// App <-> vault popup protocol. Spec: contracts/sdk.md "App client", cases 12-14.
import type { Hex } from "viem";
import { EngramError, fail } from "./errors.js";
import type { GrantScope } from "./owner.js";
import type { AppSessionProof } from "./appsession.js";

const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT256_MAX = 2n ** 256n - 1n;
const MAX_EXPIRY_SEC = 365 * 86400;
export const CONNECT_MESSAGE_TYPE = "engram:connect:result";

export type ConnectRequest = {
  agentId: bigint;
  labels: string[];
  scope: GrantScope;
  expiresInSec: number;
  /** Origin of the requesting app, as claimed in the URL. Results are only ever posted to exactly this origin. */
  origin: string;
  /** True when the agent's ERC-8004 card lists an endpoint on `origin`. Show a warning when false. */
  originVerified: boolean;
  /** "disclosure": the agent asks, the vault answers (no key). "offline": a key grant (contracts/disclosure.md). */
  mode: ConnectMode;
};
export type ConnectMode = "disclosure" | "offline";
/** `txHash` is absent in disclosure mode: it would name the real owner onchain (disclosure.md D33). */
export type ConnectResult = { owner: Hex; granted: string[]; txHash?: Hex; sessionProof?: AppSessionProof; mode?: ConnectMode };
export type ConnectMessage = ({ ok: true } & ConnectResult) | { ok: false; code: string };
/** ERC-8004 agent card (subset). */
export type AgentCard = { name?: string; description?: string; image?: string; endpoints?: { name?: string; endpoint: string }[] };

type WindowLike = {
  open(url: string, target?: string, features?: string): { closed: boolean; close?: () => void } | null;
  addEventListener(type: "message", f: (e: MessageEvent) => void): void;
  removeEventListener(type: "message", f: (e: MessageEvent) => void): void;
  location?: { origin: string };
};

function validate(labels: string[], scope: string, expiresInSec: number) {
  if (!labels.length || labels.some((l) => !LABEL_RE.test(l))) fail("INPUT_INVALID", "labels must match ^[a-z0-9][a-z0-9-]{0,31}$");
  if (scope !== "read" && scope !== "readwrite") fail("INPUT_INVALID", "scope must be read or readwrite");
  if (!Number.isSafeInteger(expiresInSec) || expiresInSec <= 0 || expiresInSec > MAX_EXPIRY_SEC) fail("INPUT_INVALID", "expiresInSec must be 1..31536000");
}

const originOf = (u: string): string | undefined => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
};

/** Opens the vault's consent popup and resolves with the grant result. Call from a user gesture. */
export function connectEngram(opts: {
  vaultUrl: string;
  agentId: bigint;
  labels: string[];
  scope: GrantScope;
  expiresInSec: number;
  /** Default "disclosure". */
  mode?: ConnectMode;
  window?: WindowLike;
  pollMs?: number;
}): Promise<ConnectResult> {
  // Invalid input rejects the returned promise; callers never need a sync try/catch (BUGLOG S7).
  let vaultOrigin: string;
  try {
    validate(opts.labels, opts.scope, opts.expiresInSec);
    if (opts.mode !== undefined && opts.mode !== "disclosure" && opts.mode !== "offline") fail("INPUT_INVALID", "mode must be disclosure or offline");
    if (typeof opts.agentId !== "bigint" || opts.agentId < 0n || opts.agentId > UINT256_MAX) fail("INPUT_INVALID", "agentId must be in 0..2^256-1");
    vaultOrigin = originOf(opts.vaultUrl) ?? fail("INPUT_INVALID", "vaultUrl must be an http(s) URL");
  } catch (e) {
    return Promise.reject(e);
  }
  const w = opts.window ?? (globalThis as unknown as { window: WindowLike }).window;
  const params = new URLSearchParams({
    v: "1", agentId: opts.agentId.toString(), labels: opts.labels.join(","), scope: opts.scope, expiresInSec: String(opts.expiresInSec),
    mode: opts.mode ?? "disclosure",
  });
  if (w.location?.origin) params.set("origin", w.location.origin);
  const popup = w.open(`${vaultOrigin}/connect?${params}`, "engram-connect", "popup,width=460,height=720");
  if (!popup) return Promise.reject(new EngramError("POPUP_BLOCKED", "the browser blocked the Engram popup; call connectEngram from a click handler"));

  return new Promise<ConnectResult>((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== vaultOrigin || e.source !== popup) return;
      const d = e.data as Record<string, unknown> | null;
      if (!d || typeof d !== "object" || d.type !== CONNECT_MESSAGE_TYPE || d.v !== 1) return;
      // Malformed replies are ignored exactly like foreign ones (BUGLOG S7).
      const okShape =
        d.ok === true && typeof d.owner === "string" && ADDRESS_RE.test(d.owner) &&
        (typeof d.txHash === "string" ? TX_RE.test(d.txHash) : d.mode === "disclosure") &&
        Array.isArray(d.granted) && d.granted.every((l) => typeof l === "string" && LABEL_RE.test(l));
      const failShape = d.ok === false && typeof d.code === "string" && d.code.length <= 64;
      if (!okShape && !failShape) return;
      cleanup();
      if (okShape) {
        // The proof is passed through untouched: the app server verifies it (verifyAppSession), not the browser.
        const proof = d.sessionProof && typeof d.sessionProof === "object" ? (d.sessionProof as AppSessionProof) : undefined;
        const mode = d.mode === "disclosure" || d.mode === "offline" ? d.mode : undefined;
        resolve({ owner: d.owner as Hex, granted: d.granted as string[], ...(typeof d.txHash === "string" ? { txHash: d.txHash as Hex } : {}), ...(proof ? { sessionProof: proof } : {}), ...(mode ? { mode } : {}) });
      } else {
        reject(new EngramError(d.code === "USER_CANCELLED" ? "USER_CANCELLED" : "RELAY_REJECTED", "the vault did not grant access", { detail: d.code as string }));
      }
    };
    const timer = setInterval(() => {
      if (popup.closed) {
        cleanup();
        reject(new EngramError("USER_CANCELLED", "the Engram popup was closed before access was granted"));
      }
    }, opts.pollMs ?? 500);
    const cleanup = () => {
      clearInterval(timer);
      w.removeEventListener("message", onMessage);
    };
    w.addEventListener("message", onMessage);
  });
}

/** Vault side: parse and validate a connect request URL; checks the claimed origin against the agent card. */
export function parseConnectRequest(url: string, opts: { agentCard?: AgentCard } = {}): ConnectRequest {
  const u = new URL(url);
  const p = u.searchParams;
  if (p.get("v") !== "1") fail("INPUT_INVALID", "unsupported connect request version");
  const agentIdRaw = p.get("agentId") ?? "";
  // Canonical decimal only: no leading zeros, exponents, hex, or signs (the consent screen shows these numbers).
  const CANON = /^(0|[1-9]\d{0,77})$/;
  if (!CANON.test(agentIdRaw) || BigInt(agentIdRaw) > UINT256_MAX) fail("INPUT_INVALID", "agentId must be a canonical decimal integer in 0..2^256-1");
  const labels = (p.get("labels") ?? "").split(",");
  if (new Set(labels).size !== labels.length) fail("INPUT_INVALID", "labels must not repeat");
  const scope = p.get("scope") as GrantScope;
  const expRaw = p.get("expiresInSec") ?? "";
  if (!CANON.test(expRaw)) fail("INPUT_INVALID", "expiresInSec must be a canonical decimal integer");
  const expiresInSec = Number(expRaw);
  validate(labels, scope, expiresInSec);
  const claimed = p.get("origin") ?? "";
  const origin = originOf(claimed);
  if (!origin || origin !== claimed) fail("INPUT_INVALID", "origin must be an exact http(s) origin");
  const endpoints: unknown = opts.agentCard?.endpoints;
  const originVerified = Array.isArray(endpoints) && endpoints.some((e) => !!e && typeof e === "object" && typeof (e as { endpoint?: unknown }).endpoint === "string" && originOf((e as { endpoint: string }).endpoint) === origin);
  const modeRaw = p.get("mode");
  if (modeRaw !== null && modeRaw !== "disclosure" && modeRaw !== "offline") fail("INPUT_INVALID", "mode must be disclosure or offline");
  return { agentId: BigInt(agentIdRaw), labels, scope, expiresInSec, origin: origin!, originVerified, mode: (modeRaw ?? "offline") as ConnectMode };
}

/** Vault side: post the result to the opener, only if the opener really is `requestOrigin`. */
export function replyToOpener(opener: { postMessage(msg: unknown, targetOrigin: string): void } | null, requestOrigin: string, result: ConnectMessage) {
  opener?.postMessage({ type: CONNECT_MESSAGE_TYPE, v: 1, ...result }, requestOrigin);
}
