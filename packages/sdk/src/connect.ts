// App <-> vault popup protocol. Spec: contracts/sdk.md "App client", cases 12-14.
import type { Hex } from "viem";
import { EngramError, fail } from "./errors.js";
import type { GrantScope } from "./owner.js";

const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
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
};
export type ConnectResult = { owner: Hex; granted: string[]; txHash: Hex };
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
  window?: WindowLike;
  pollMs?: number;
}): Promise<ConnectResult> {
  validate(opts.labels, opts.scope, opts.expiresInSec);
  const w = opts.window ?? (globalThis as unknown as { window: WindowLike }).window;
  const vaultOrigin = originOf(opts.vaultUrl) ?? fail("INPUT_INVALID", "vaultUrl must be an http(s) URL");
  const params = new URLSearchParams({
    v: "1", agentId: opts.agentId.toString(), labels: opts.labels.join(","), scope: opts.scope, expiresInSec: String(opts.expiresInSec),
  });
  if (w.location?.origin) params.set("origin", w.location.origin);
  const popup = w.open(`${vaultOrigin}/connect?${params}`, "engram-connect", "popup,width=460,height=720");
  if (!popup) return Promise.reject(new EngramError("POPUP_BLOCKED", "the browser blocked the Engram popup; call connectEngram from a click handler"));

  return new Promise<ConnectResult>((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== vaultOrigin || e.source !== popup) return;
      const d = e.data as Partial<ConnectMessage> & { type?: string; v?: number };
      if (!d || d.type !== CONNECT_MESSAGE_TYPE || d.v !== 1 || typeof d.ok !== "boolean") return;
      cleanup();
      if (d.ok && typeof d.owner === "string" && Array.isArray(d.granted) && typeof d.txHash === "string") {
        resolve({ owner: d.owner as Hex, granted: d.granted, txHash: d.txHash as Hex });
      } else {
        reject(new EngramError(d.ok === false && d.code === "USER_CANCELLED" ? "USER_CANCELLED" : "RELAY_REJECTED", "the vault did not grant access", { detail: d.ok === false ? d.code : undefined }));
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
  if (!/^\d{1,78}$/.test(agentIdRaw)) fail("INPUT_INVALID", "agentId must be a decimal integer");
  const labels = (p.get("labels") ?? "").split(",").filter(Boolean);
  const scope = p.get("scope") as GrantScope;
  const expiresInSec = Number(p.get("expiresInSec"));
  validate(labels, scope, expiresInSec);
  const claimed = p.get("origin") ?? "";
  const origin = originOf(claimed);
  if (!origin || origin !== claimed) fail("INPUT_INVALID", "origin must be an exact http(s) origin");
  const originVerified = (opts.agentCard?.endpoints ?? []).some((e) => originOf(e.endpoint) === origin);
  return { agentId: BigInt(agentIdRaw), labels, scope, expiresInSec, origin: origin!, originVerified };
}

/** Vault side: post the result to the opener, only if the opener really is `requestOrigin`. */
export function replyToOpener(opener: { postMessage(msg: unknown, targetOrigin: string): void } | null, requestOrigin: string, result: ConnectMessage) {
  opener?.postMessage({ type: CONNECT_MESSAGE_TYPE, v: 1, ...result }, requestOrigin);
}
