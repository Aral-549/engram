"use client";
import { Seal } from "./Seal";
import { useSession } from "./SessionProvider";

const steps = [
  ["One passkey", "Face ID, Touch ID, or your phone. No seed phrase, no extension, no email code."],
  ["AI apps ask first", "An assistant or planner requests one folder of your memory, for a set time. You approve it here."],
  ["Take it back", "Revoke any app in one tap. It can no longer read anything you add afterwards."],
] as const;

export function Onboarding({ locked = false }: { locked?: boolean }) {
  const { signUp, signIn, status, error } = useSession();
  const busy = status === "working";
  return (
    <main className="mx-auto grid min-h-dvh max-w-6xl grid-cols-1 gap-12 px-6 py-10 md:grid-cols-[1.25fr_1fr] md:gap-16 md:px-10 md:py-16">
      <section className="flex flex-col justify-between gap-10">
        <header className="flex items-center gap-3">
          <Seal size={30} />
          <span className="font-display text-2xl tracking-tight">Engram</span>
          <span className="ml-2 rounded-sm border border-rule px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-ink-soft">Monad testnet</span>
        </header>
        <div className="settle">
          <p className="mb-5 font-mono text-xs uppercase tracking-[0.2em] text-seal">{locked ? "Vault locked" : "Your AI memory, owned by you"}</p>
          <h1 className="font-display text-[clamp(2.8rem,6vw,5.2rem)] leading-[0.95] tracking-tight">
            {locked ? (
              <>Unlock with the passkey you <em className="text-seal">sealed it</em> with.</>
            ) : (
              <>One memory for every AI you use, <em className="text-seal">sealed</em> with your passkey.</>
            )}
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-soft">
            Your assistant learns you once. Other AI apps can read the parts you allow, and nothing else. Every memory is encrypted on your
            device before it is stored on Monad, so no company, including us, can read it.
          </p>
        </div>
        <p className="font-mono text-xs text-ink-soft">Keys come from your passkey on every sign-in. Nothing is stored in this browser.</p>
      </section>

      <section className="flex flex-col justify-center">
        <div className="paper-card settle p-7 md:p-9" style={{ animationDelay: "120ms" }}>
          <ol className="space-y-6">
            {steps.map(([title, body], i) => (
              <li key={title} className="grid grid-cols-[1.5rem_1fr] gap-3">
                <span className="font-display text-2xl leading-none text-rust">{i + 1}</span>
                <div>
                  <p className="font-medium">{title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-ink-soft">{body}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-9 flex flex-col gap-3">
            {locked ? null : (
              <button className="btn btn-primary justify-center px-5 py-3.5 text-base" onClick={() => void signUp()} disabled={busy}>
                <Seal size={18} /> {busy ? "Waiting for your passkey…" : "Create my memory vault"}
              </button>
            )}
            <button className={`btn justify-center px-5 py-3 ${locked ? "btn-primary text-base" : "btn-ghost"}`} onClick={() => void signIn()} disabled={busy}>
              {locked ? (busy ? "Waiting for your passkey…" : "Unlock vault") : "I already have one, unlock it"}
            </button>
          </div>
          {error ? (
            <p role="alert" className="mt-5 rounded-sm border border-rust/40 bg-rust-soft px-3 py-2.5 text-sm text-rust">
              {error}
            </p>
          ) : null}
        </div>
      </section>
    </main>
  );
}
