"use client";
import type { GrantView, LogView, PolicyView, Proposal, RecalledAnyEntry } from "@engram/sdk";
import { useCallback, useEffect, useMemo, useState } from "react";
import { addLabel, discoverLabels, isValidLabel, type DiscoveredNamespace } from "@/lib/discover";
import { addressUrl, expiresIn, relativeTime, shortAddr, txUrl, untilSettled } from "@/lib/engram";
import { Seal } from "./Seal";
import { Words } from "./Words";
import { useSession } from "./SessionProvider";
import { useAgentCards } from "./useAgentCards";

type Tab = "memory" | "review" | "access" | "reads";
const KINDS = ["preference", "fact", "note"] as const;

export function Dashboard() {
  const { session, lock, error, clearError, run } = useSession();
  const [tab, setTab] = useState<Tab>("memory");
  const [pendingCount, setPendingCount] = useState(0);
  // Keep the Review badge current: agents can propose while you look at another tab.
  useEffect(() => {
    let stop = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const labels = (await run((s) => discoverLabels(s)))?.map((n) => n.label) ?? [];
      const p = await run((s) => s.proposals(labels));
      if (p && !stop) setPendingCount(p.length);
      if (!stop) t = setTimeout(() => void tick(), 6000);
    };
    void tick();
    return () => {
      stop = true;
      if (t) clearTimeout(t);
    };
  }, [run]);
  if (!session) return null;
  return (
    <main className="mx-auto grid min-h-dvh max-w-7xl grid-cols-1 md:grid-cols-[17rem_1fr]">
      <aside className="flex flex-col gap-8 border-b border-rule px-6 py-6 md:border-b-0 md:border-r md:py-10">
        <div className="flex items-center gap-3">
          <Seal size={28} />
          <span className="font-display text-2xl">Engram</span>
        </div>
        <div>
          <p className="font-mono text-[11px] uppercase tracking-wider text-ink-soft">Your vault</p>
          <a href={addressUrl(session.owner)} target="_blank" rel="noreferrer" className="mt-1 block font-mono text-sm underline decoration-rule underline-offset-4 hover:decoration-seal">
            {shortAddr(session.owner)}
          </a>
          <p className="mt-1 text-xs text-ink-soft">Monad testnet. Unlocked with your passkey.</p>
        </div>
        <nav className="flex gap-2 md:flex-col">
          {(["memory", "review", "access", "reads"] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`btn px-3 py-2 text-left ${tab === t ? "bg-card border border-rule" : "border border-transparent hover:bg-card"}`}>
              {t === "memory" ? "Memory" : t === "review" ? "Review" : t === "access" ? "Who can read it" : "Reads"}
              {t === "review" && pendingCount > 0 ? (
                <span className="ml-auto rounded-full bg-rust px-1.5 py-0.5 font-mono text-[10px] leading-none text-[#f7f3ea]" aria-label={`${pendingCount} waiting`}>
                  {pendingCount}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
        <button className="btn btn-ghost mt-auto justify-center px-3 py-2 text-sm" onClick={lock}>
          Lock vault
        </button>
      </aside>
      <section className="px-6 py-8 md:px-12 md:py-12">
        {error ? (
          <div role="alert" className="mb-6 flex items-start justify-between gap-4 rounded-sm border border-rust/40 bg-rust-soft px-4 py-3 text-sm text-rust">
            <span>{error}</span>
            <button onClick={clearError} className="font-mono text-xs underline">dismiss</button>
          </div>
        ) : null}
        {tab === "memory" ? <MemoryView /> : tab === "review" ? <ReviewView onCount={setPendingCount} /> : tab === "access" ? <AccessView /> : <ReadsView />}
      </section>
    </main>
  );
}

function MemoryView() {
  const { run } = useSession();
  const [spaces, setSpaces] = useState<DiscoveredNamespace[] | null>(null);
  const [active, setActive] = useState("preferences");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("preference");
  const [saving, setSaving] = useState(false);
  const [sealedAt, setSealedAt] = useState<number | null>(null);
  const [newLabel, setNewLabel] = useState("");

  const load = useCallback(async () => {
    // Wait out indexer lag: every namespace must be complete against chain nextSeq.
    const found = await run((s) => untilSettled(() => discoverLabels(s), (all) => all.every((n) => n.complete)));
    if (!found) return;
    setSpaces(found);
    if (found.length && !found.some((f) => f.label === active)) setActive(found[0]!.label);
  }, [run, active]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = spaces?.find((s) => s.label === active);
  const entries = useMemo(() => [...(current?.entries ?? [])].reverse(), [current]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setSaving(true);
    const ok = await run((s) => s.remember(active, { kind, text: text.trim() }));
    setSaving(false);
    if (ok) {
      setText("");
      setSealedAt(Date.now());
      await load();
    }
  }

  async function createFolder(e: React.FormEvent) {
    e.preventDefault();
    const label = newLabel.trim();
    if (!isValidLabel(label)) return;
    await run((s) => addLabel(s, label));
    setNewLabel("");
    setActive(label);
    await load();
  }

  const tabs = [...new Set(["preferences", ...(spaces ?? []).map((s) => s.label)])];

  return (
    <div className="max-w-3xl">
      <h2 className="font-display text-4xl tracking-tight md:text-5xl" aria-label="What your AI knows about you"><Words>What your AI knows about you</Words></h2>
      <p className="mt-2 text-ink-soft">Encrypted before it leaves this device. Only you, and apps you approve per folder, can read it.</p>

      <div className="mt-8 flex flex-wrap items-end gap-1 border-b border-rule">
        {tabs.map((label) => (
          <button key={label} data-active={label === active} onClick={() => setActive(label)} className="folder-tab px-4 py-2 font-mono text-sm">
            {label}
            <span className="ml-2 text-ink-soft">{spaces?.find((s) => s.label === label)?.entries.length ?? 0}</span>
          </button>
        ))}
        <form onSubmit={createFolder} className="ml-auto flex items-center gap-2 pb-1.5">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value.toLowerCase())}
            placeholder="new folder"
            aria-label="New folder name"
            className="w-32 rounded-sm border border-rule bg-card px-2 py-1 font-mono text-sm"
          />
          <button className="btn btn-ghost px-2 py-1 text-sm" disabled={!isValidLabel(newLabel)}>Add</button>
        </form>
      </div>

      <form onSubmit={save} className="index-card mt-6 p-5 pl-12">
        <label htmlFor="memory" className="font-mono text-[11px] uppercase tracking-wider text-ink-soft">Add to {active}</label>
        <textarea
          id="memory"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          maxLength={1500}
          placeholder="I am vegetarian and allergic to peanuts."
          className="mt-2 w-full resize-none bg-transparent text-lg leading-[1.8rem] outline-none placeholder:text-ink-soft/60"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="flex gap-1" role="radiogroup" aria-label="Kind">
            {KINDS.map((k) => (
              <button type="button" role="radio" aria-checked={kind === k} key={k} onClick={() => setKind(k)}
                className={`rounded-sm border px-2.5 py-1 font-mono text-xs ${kind === k ? "border-seal bg-seal-soft text-seal" : "border-rule text-ink-soft"}`}>
                {k}
              </button>
            ))}
          </div>
          <button className="btn btn-primary ml-auto px-4 py-2" disabled={saving || !text.trim()}>
            {saving ? "Sealing…" : "Remember"}
          </button>
          {sealedAt && !saving ? <Seal key={sealedAt} size={26} className="seal-stamp" title="Sealed and stored on Monad" /> : null}
        </div>
      </form>

      <ul className="mt-8 space-y-4">
        {spaces === null ? <li className="text-ink-soft">Opening your memory…</li> : null}
        {spaces && entries.length === 0 ? <li className="text-ink-soft">Nothing in {active} yet.</li> : null}
        {/* Reviewed proposals are hidden: a confirmed one lives on as your copy, a rejected one is gone. */}
        {entries.filter((e) => e.review !== "confirmed" && e.review !== "rejected").map((e, i) => (
          <MemoryCard key={`${e.seq}`} entry={e} delay={i * 45} />
        ))}
      </ul>
      {current && !current.complete ? (
        <p className="mt-4 font-mono text-xs text-rust">Some entries could not be loaded from the indexer yet. They are safe onchain; refresh in a moment.</p>
      ) : null}
    </div>
  );
}

function MemoryCard({ entry, delay }: { entry: RecalledAnyEntry; delay: number }) {
  // Disclosure-mode proposals are written by the vault (byOwner) on an agent's behalf: credit the agent (src).
  const writer = entry.src ? entry.src.agent : entry.byOwner ? null : entry.agentId.toString();
  const cards = useAgentCards([writer, entry.confirmedFrom].filter((x): x is string => !!x));
  const author = writer ? (cards[writer]?.name ?? `Agent #${writer}`) : "You";
  const confirmedName = entry.confirmedFrom ? (cards[entry.confirmedFrom]?.name ?? `Agent #${entry.confirmedFrom}`) : "";
  return (
    <li className="index-card settle lift px-5 py-4 pl-12" style={{ animationDelay: `${delay}ms` }}>
      <p className="text-lg leading-[1.8rem]">{entry.text}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-ink-soft">
        <span className={writer ? "text-seal" : ""}>
          {!writer ? (entry.confirmedFrom ? `Confirmed from ${confirmedName}` : "Written by you") : `Proposed by ${author}, waiting for your review`}
        </span>
        <span>{entry.kind}</span>
        <span>{relativeTime(entry.t)}</span>
        <a href={txUrl(entry.txHash)} target="_blank" rel="noreferrer" className="underline decoration-rule underline-offset-2 hover:text-ink">
          sealed #{entry.seq.toString()} on Monad
        </a>
      </div>
    </li>
  );
}

function AccessView() {
  const { run } = useSession();
  const [grants, setGrants] = useState<GrantView[] | null>(null);
  const [policies, setPolicies] = useState<PolicyView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (expect?: (g: GrantView[]) => boolean) => {
    // Discovery first so every namespace id maps back to its label in this session.
    await run((s) => discoverLabels(s));
    const g = await run((s) => untilSettled(() => s.grants(), expect ?? (() => true)));
    if (g) setGrants(g);
    const p = await run((s) => s.policies());
    if (p) setPolicies(p);
  }, [run]);

  useEffect(() => {
    void load();
  }, [load]);

  const approved = (policies ?? []).filter((p) => p.active && p.exp > Date.now());
  const cards = useAgentCards([...(grants ?? []).map((g) => g.agentId.toString()), ...approved.map((p) => p.agentId.toString())]);
  const active = (grants ?? []).filter((g) => g.active);

  async function disapprove(p: PolicyView) {
    const id = `policy-${p.agentId}`;
    setBusy(id);
    // Also revoke any offline key grant this agent holds (contracts/apps.md "Disclosure mode in the apps").
    await run((s) => s.disapprove(p.agentId));
    for (const g of active.filter((x) => x.agentId === p.agentId && x.label)) await run((s) => s.revoke(g.label!, [g.agentId]));
    setBusy(null);
    await load();
  }
  const past = (grants ?? []).filter((g) => !g.active);

  async function revoke(g: GrantView) {
    if (!g.label) return;
    const id = `${g.nsId}-${g.agentId}`;
    setBusy(id);
    await run((s) => s.revoke(g.label!, [g.agentId]));
    setBusy(null);
    await load((all) => !all.some((x) => x.nsId === g.nsId && x.agentId === g.agentId && x.active));
  }

  return (
    <div className="max-w-3xl">
      <h2 className="font-display text-4xl tracking-tight md:text-5xl" aria-label="Who can read your memory"><Words>Who can read your memory</Words></h2>
      <p className="mt-2 text-ink-soft">
        Revoking changes the folder&apos;s key. The app keeps nothing new; what it already read cannot be un-shared, by anyone.
      </p>
      <ul className="mt-8 space-y-4">
        {grants === null ? <li className="text-ink-soft">Checking access…</li> : null}
        {grants && policies && active.length === 0 && approved.length === 0 ? <li className="text-ink-soft">No app can read your memory right now.</li> : null}
        {approved.map((p) => {
          const card = cards[p.agentId.toString()];
          const id = `policy-${p.agentId}`;
          return (
            <li key={id} className="paper-card settle lift grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-4">
              <div>
                <p className="font-medium">{card?.name ?? `Agent #${p.agentId}`}</p>
                <p className="mt-0.5 text-sm text-ink-soft">Asks your vault while you chat. It never holds a key.</p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-ink-soft">
                  <span>folders: {p.labels.join(", ")}</span>
                  <span className={p.scope === "readwrite" ? "text-rust" : "text-seal"}>{p.scope === "readwrite" ? "can ask and propose" : "can ask"}</span>
                  <span>{p.origin}</span>
                  <span>{expiresIn(BigInt(Math.floor(p.exp / 1000)))}</span>
                </div>
              </div>
              <button className="btn btn-danger px-3 py-2 text-sm" disabled={busy === id} onClick={() => void disapprove(p)}>
                {busy === id ? "Revoking…" : "Revoke"}
              </button>
            </li>
          );
        })}
        {active.map((g) => {
          const card = cards[g.agentId.toString()];
          const id = `${g.nsId}-${g.agentId}`;
          return (
            <li key={id} className="paper-card settle lift grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-4">
              <div>
                <p className="font-medium">{card?.name ?? `Agent #${g.agentId}`}</p>
                <p className="mt-0.5 text-sm text-ink-soft">{card?.description ?? "ERC-8004 registered agent"}</p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-ink-soft">
                  <span>folder: {g.label ?? "unknown"}</span>
                  <span className={g.scope === "readwrite" ? "text-rust" : "text-seal"}>{g.scope === "readwrite" ? "can read and add" : "can read"}</span>
                  <span>{expiresIn(g.expiry)}</span>
                  {!g.keysCurrent ? <span className="text-rust">agent identity changed hands</span> : null}
                </div>
              </div>
              <button className="btn btn-danger px-3 py-2 text-sm" disabled={busy === id || !g.label} onClick={() => void revoke(g)}>
                {busy === id ? "Revoking…" : "Revoke"}
              </button>
            </li>
          );
        })}
      </ul>
      {past.length ? (
        <details className="mt-10">
          <summary className="cursor-pointer font-mono text-xs uppercase tracking-wider text-ink-soft">History ({past.length})</summary>
          <ul className="mt-3 space-y-2">
            {past.map((g) => (
              <li key={`${g.nsId}-${g.agentId}`} className="flex justify-between border-b border-rule py-2 text-sm text-ink-soft">
                <span>{cards[g.agentId.toString()]?.name ?? `Agent #${g.agentId}`} · {g.label ?? "folder"}</span>
                <span className="font-mono text-xs">revoked or expired</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ReadsView() {
  const { run } = useSession();
  const [logs, setLogs] = useState<LogView[] | null>(null);
  const [texts, setTexts] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    // Live: agents' reads are logged by the bridge in the background, so keep refreshing while this tab is open.
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await load();
      if (!stop) timer = setTimeout(() => void tick(), 4000);
    };
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  async function load() {
    {
      const l = await run((s) => s.disclosures({}));
      if (!l) return;
      setLogs(l);
      // Resolve each referenced entry to its text, from this device only (logs store references, not text).
      const labels = [...new Set(l.flatMap((x) => x.refs.map((r) => r.label)))];
      const m = new Map<string, string>();
      for (const label of labels) {
        const r = await run((s) => s.recallAll(label));
        for (const e of r?.entries ?? []) m.set(`${label}:${e.seq}`, e.text);
      }
      setTexts(m);
    }
  }

  const cards = useAgentCards([...new Set((logs ?? []).map((l) => l.agentId.toString()))]);
  return (
    <div className="max-w-3xl">
      <h2 className="font-display text-4xl tracking-tight md:text-5xl" aria-label="Every read, by every agent"><Words>Every read, by every agent</Words></h2>
      <p className="mt-2 text-ink-soft">Agents in Disclosure mode never hold your memory. Each time one asks, your vault answers with only what is relevant, and writes it here.</p>
      <ol className="mt-8 space-y-3" aria-live="polite">
        {logs === null ? <li className="text-ink-soft">Opening the log…</li> : null}
        {logs && logs.length === 0 ? <li className="text-ink-soft">No agent has asked your vault yet.</li> : null}
        {(logs ?? []).slice(0, 100).map((l, i) => {
          const name = cards[l.agentId.toString()]?.name ?? `Agent #${l.agentId}`;
          const shared = l.refs.map((r) => texts.get(`${r.label}:${r.seq}`) ?? `${r.label} #${r.seq}`);
          return (
            <li key={l.seq.toString()} className="paper-card settle px-5 py-3.5" style={{ animationDelay: `${Math.min(i, 12) * 35}ms` }}>
              <p className="font-mono text-[11px] text-ink-soft">
                <span className="text-seal">{name}</span>
                <span className="mx-1.5 text-rule">/</span>
                {l.mode === "write" ? "proposed a memory" : l.mode === "full" ? "asked for everything" : `asked "${l.q || "(empty)"}"`}
                <span className="mx-1.5 text-rule">/</span>
                {relativeTime(l.t)}
              </p>
              <p className={`mt-1 leading-snug ${l.n === 0 ? "text-ink-soft" : ""}`}>
                {l.n === 0 ? "Nothing relevant, nothing shared." : `${l.mode === "write" ? "Saved" : `Shared ${l.n}`}: ${shared.join("; ")}`}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ReviewView({ onCount }: { onCount: (n: number) => void }) {
  const { run } = useSession();
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    const ls = (await run((s) => discoverLabels(s)))?.map((n) => n.label) ?? [];
    setLabels(ls);
    const p = await run((s) => s.proposals(ls));
    if (p) {
      setItems(p);
      onCount(p.length);
    }
  }, [run, onCount]);
  useEffect(() => {
    void load();
  }, [load]);

  const cards = useAgentCards([...new Set((items ?? []).map((p) => p.agentId.toString()))]);
  const byAgent = new Map<string, Proposal[]>();
  for (const p of items ?? []) byAgent.set(p.agentId.toString(), [...(byAgent.get(p.agentId.toString()) ?? []), p]);
  const key = (p: Proposal) => `${p.label}:${p.seq}`;

  async function act(p: Proposal, action: "confirm" | "reject", text?: string) {
    setBusy(key(p));
    await run((s) => s.review({ label: p.label, seq: p.seq, action, ...(text !== undefined ? { text } : {}) }));
    setBusy(null);
    setEditing(null);
    await load();
  }
  async function rejectAll(agentId: string) {
    setBusy(`all:${agentId}`);
    await run((s) => s.rejectAllFrom(BigInt(agentId), labels));
    setBusy(null);
    await load();
  }

  return (
    <div className="max-w-3xl">
      <h2 className="font-display text-4xl tracking-tight md:text-5xl" aria-label="Review what agents proposed"><Words>Review what agents proposed</Words></h2>
      <p className="mt-2 text-ink-soft">
        An agent&apos;s proposals stay with that agent until you confirm them. Only what you confirm becomes your memory and reaches your
        other agents. This is what keeps one bad agent from poisoning the rest.
      </p>
      {items === null ? <p className="mt-8 text-ink-soft">Looking for proposals…</p> : null}
      {items && items.length === 0 ? <p className="mt-8 text-ink-soft">Nothing waiting. Agents&apos; proposals appear here.</p> : null}
      {[...byAgent.entries()].map(([agentId, list]) => {
        const name = cards[agentId]?.name ?? `Agent #${agentId}`;
        return (
          <section key={agentId} className="mt-8">
            <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule pb-2">
              <p className="font-mono text-xs uppercase tracking-wider text-ink-soft">
                <span className="text-seal">{name}</span> proposed {list.length}
              </p>
              <button className="btn btn-danger px-2.5 py-1 text-xs" disabled={busy !== null} onClick={() => void rejectAll(agentId)}>
                {busy === `all:${agentId}` ? "Rejecting…" : `Reject all from ${name} and revoke`}
              </button>
            </div>
            <ul className="mt-4 space-y-3">
              {list.map((p, i) => (
                <li key={key(p)} className={`paper-card settle px-5 py-4 ${p.flagged ? "border-rust/60" : ""}`} style={{ animationDelay: `${i * 40}ms` }}>
                  {editing === key(p) ? (
                    <textarea
                      aria-label="Edit before confirming"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={2}
                      maxLength={1500}
                      className="w-full resize-none rounded-sm border border-rule bg-paper px-2 py-1.5 text-lg leading-relaxed outline-none focus:border-seal"
                    />
                  ) : (
                    <p className="text-lg leading-relaxed">{p.text}</p>
                  )}
                  {p.flagged ? (
                    <p className="mt-2 rounded-sm bg-rust-soft px-2 py-1 text-xs text-rust">
                      This looks like an instruction to an AI, not a fact about you. Confirm only if you really meant it.
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="mr-auto font-mono text-xs text-ink-soft">
                      {p.kind} · {p.label} · {relativeTime(p.t)}
                    </span>
                    {editing === key(p) ? (
                      <>
                        <button className="btn btn-primary px-3 py-1.5 text-sm" disabled={busy !== null || !draft.trim()} onClick={() => void act(p, "confirm", draft)}>
                          Save and confirm
                        </button>
                        <button className="btn btn-ghost px-3 py-1.5 text-sm" onClick={() => setEditing(null)}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <button className="btn btn-primary px-3 py-1.5 text-sm" disabled={busy !== null} onClick={() => void act(p, "confirm")}>
                          {busy === key(p) ? "Sealing…" : "Confirm"}
                        </button>
                        <button className="btn btn-ghost px-3 py-1.5 text-sm" disabled={busy !== null} onClick={() => { setEditing(key(p)); setDraft(p.text); }}>
                          Edit
                        </button>
                        <button className="btn btn-danger px-3 py-1.5 text-sm" disabled={busy !== null} onClick={() => void act(p, "reject")}>
                          Reject
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
