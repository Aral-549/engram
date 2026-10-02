// Vault bridge for Disclosure mode (contracts/sdk.md "Vault bridge", contracts/disclosure.md D5, D9, D10).
// The vault page /bridge runs startBridge; the agent app runs openVaultBridge. postMessage only, origin-bound both
// ways, no data before the vault is unlocked and the requesting origin matches the approval.
import { EngramError, fail } from "./errors.js";
import type { OwnerSession } from "./owner.js";
import type { DisclosedEntry, DisclosureMode } from "./select.js";
import type { Hex } from "viem";

const REQ = "engram:bridge:req";
const RES = "engram:bridge:res";
const STATUS = "engram:bridge:status";
const OPS = ["disclose", "propose", "status"];

type Target = { postMessage(message: unknown, targetOrigin: string): void };
type Listener = (e: MessageEvent) => void;
type Host = { addEventListener(type: "message", f: Listener): void; removeEventListener(type: "message", f: Listener): void };
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// ------------------------------------------------------------------------------------------ vault side

/** What the vault's own bridge UI shows live (never sent to the app). */
export type BridgeEvent =
  | { op: "disclose"; ok: true; query: string; mode: DisclosureMode; entries: DisclosedEntry[] }
  | { op: "propose"; ok: true; text: string; seq: bigint }
  | { op: "disclose" | "propose"; ok: false; code: string };

export function startBridge(opts: {
  session: () => OwnerSession | undefined;
  agentId: bigint;
  window: Host & { parent: Target };
  onEvent?: (e: BridgeEvent) => void;
}) {
  const emit = (e: BridgeEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* UI errors never break the protocol */
    }
  };
  const w = opts.window;
  const onMessage: Listener = (e) => {
    if (e.source !== w.parent) return; // only the page that embeds us (D10)
    const d = e.data;
    if (!isObj(d) || d.type !== REQ || d.v !== 1 || typeof d.id !== "string" || d.id.length < 1 || d.id.length > 64 || !OPS.includes(d.op as string)) return;
    const origin = e.origin;
    const id = d.id;
    const reply = (body: Record<string, unknown>) => w.parent.postMessage({ type: RES, v: 1, id, ...body }, origin);
    void (async () => {
      const s = opts.session();
      if (!s) return reply({ ok: false, code: "VAULT_LOCKED" }); // no data, no policy lookup
      try {
        const policy = await s.approvalFor(opts.agentId);
        if (!policy || policy.origin !== origin) return; // not the approved site: say nothing (D9)
        const a = isObj(d.args) ? d.args : {};
        if (d.op === "status") return reply({ ok: true, state: "ready" });
        if (d.op === "disclose") {
          const r = await s.disclose({ agentId: opts.agentId, origin, query: a.query as string, mode: a.mode as DisclosureMode, round: a.round as number });
          emit({ op: "disclose", ok: true, query: String(a.query), mode: r.mode, entries: r.entries });
          return reply({ ok: true, entries: r.entries, mode: r.mode });
        }
        const r = await s.propose(opts.agentId, origin, { kind: a.kind as never, text: a.text as string, label: a.label as string | undefined });
        emit({ op: "propose", ok: true, text: String(a.text), seq: r.seq });
        return reply({ ok: true, seq: r.seq.toString(), txHash: r.txHash });
      } catch (err) {
        const code = err instanceof EngramError ? (err.code === "SESSION_EXPIRED" || err.code === "SESSION_ENDED" ? "VAULT_LOCKED" : err.code) : "BAD_REQUEST";
        if (d.op !== "status") emit({ op: d.op as "disclose" | "propose", ok: false, code });
        reply({ ok: false, code });
      }
    })();
  };
  w.addEventListener("message", onMessage);

  /** Tells the approved site that the vault is ready (call after unlock). Never sent while locked. */
  async function refresh() {
    const s = opts.session();
    if (!s) return;
    const policy = await s.approvalFor(opts.agentId).catch(() => undefined);
    if (policy?.active) w.parent.postMessage({ type: STATUS, v: 1, state: "ready" }, policy.origin);
  }
  void refresh();
  return { stop: () => w.removeEventListener("message", onMessage), refresh };
}

// ------------------------------------------------------------------------------------------ app side

export type BridgeState = "unknown" | "locked" | "ready";
export type VaultBridge = {
  status(): BridgeState;
  disclose(query: string, opts?: { mode?: DisclosureMode; round?: number }): Promise<{ entries: DisclosedEntry[]; mode: DisclosureMode }>;
  propose(entry: { kind: "fact" | "preference" | "note"; text: string; label?: string }): Promise<{ seq: bigint; txHash: Hex }>;
  onStatus(cb: (s: BridgeState) => void): () => void;
  close(): void;
};

export function openVaultBridge(opts: {
  vaultUrl: string;
  agentId: bigint;
  mount?: { appendChild(n: unknown): unknown };
  frame?: { contentWindow: Target | null };
  window?: Host;
  timeoutMs?: number;
}): VaultBridge {
  let vaultOrigin: string;
  try {
    const u = new URL(opts.vaultUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    vaultOrigin = u.origin;
  } catch {
    return fail("INPUT_INVALID", "vaultUrl must be an http(s) URL");
  }
  const host: Host = opts.window ?? (globalThis as unknown as Host);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let frame = opts.frame;
  let iframe: HTMLIFrameElement | undefined;
  let loaded: Promise<void> = Promise.resolve();
  if (!frame) {
    if (!opts.mount || typeof document === "undefined") return fail("INPUT_INVALID", "mount is required in the browser");
    iframe = document.createElement("iframe");
    iframe.src = `${vaultOrigin}/bridge?agentId=${opts.agentId.toString()}`;
    iframe.allow = "publickey-credentials-get *; publickey-credentials-create *";
    iframe.title = "Engram vault";
    iframe.className = "engram-bridge";
    loaded = new Promise((r) => iframe!.addEventListener("load", () => r(), { once: true }));
    opts.mount.appendChild(iframe);
    frame = iframe;
  }
  let state: BridgeState = "unknown";
  const watchers = new Set<(s: BridgeState) => void>();
  const pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  const setState = (s: BridgeState) => {
    if (s === state) return;
    state = s;
    watchers.forEach((f) => f(s));
  };

  const onMessage: Listener = (e) => {
    if (e.origin !== vaultOrigin || !frame || e.source !== frame.contentWindow) return;
    const d = e.data;
    if (!isObj(d) || d.v !== 1) return;
    if (d.type === STATUS && d.state === "ready") return setState("ready");
    if (d.type !== RES || typeof d.id !== "string") return;
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    clearTimeout(p.timer);
    if (d.ok === true) {
      setState("ready");
      p.resolve(d);
    } else {
      const code = typeof d.code === "string" ? d.code : "BAD_REQUEST";
      if (code === "VAULT_LOCKED") setState("locked");
      p.reject(new EngramError(code as never, `the vault answered ${code}`));
    }
  };
  host.addEventListener("message", onMessage);

  async function call(op: string, args: unknown): Promise<Record<string, unknown>> {
    await loaded;
    const id = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new EngramError("BRIDGE_TIMEOUT", "the vault did not answer in time"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      frame!.contentWindow?.postMessage({ type: REQ, v: 1, id, op, args }, vaultOrigin);
    });
  }

  const asEntries = (v: unknown): DisclosedEntry[] =>
    (Array.isArray(v) ? v : [])
      .filter((x): x is DisclosedEntry => isObj(x) && typeof x.kind === "string" && typeof x.text === "string" && (x.by === "owner" || x.by === "self"))
      .slice(0, 20)
      .map((x) => ({ kind: x.kind, text: x.text.slice(0, 4000), by: x.by }));

  return {
    status: () => state,
    async disclose(query, o = {}) {
      const r = await call("disclose", { query, mode: o.mode ?? "relevant", round: o.round ?? 0 });
      return { entries: asEntries(r.entries), mode: r.mode === "full" ? "full" : "relevant" };
    },
    async propose(entry) {
      const r = await call("propose", entry);
      if (typeof r.seq !== "string" || !/^(0|[1-9][0-9]*)$/.test(r.seq) || typeof r.txHash !== "string") throw new EngramError("BAD_REQUEST", "malformed vault reply");
      return { seq: BigInt(r.seq), txHash: r.txHash as Hex };
    },
    onStatus(cb) {
      watchers.add(cb);
      return () => watchers.delete(cb);
    },
    close() {
      host.removeEventListener("message", onMessage);
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new EngramError("BRIDGE_TIMEOUT", "the bridge was closed"));
      }
      pending.clear();
      iframe?.remove();
    },
  };
}
