"use client";
import { Seal } from "./Seal";
import { LedgerSpecimen } from "./LedgerSpecimen";
import { useSession } from "./SessionProvider";
import { Words } from "./Words";

const REGISTRY = "0x733d1Bf4DC13B721a2Ce3DDCFb444795eFF59d31";
const REPO = "https://github.com/Aral-549/hippo";

const steps = [
  ["One passkey", "Face ID, Touch ID or your phone. There's no seed phrase to write down and no extension to install, and the same passkey opens your vault on any of your devices."],
  ["Apps ask before they read", "An app you approve never holds your memory. When you message it, it asks your vault, and the vault replies with the few memories that fit, from the folders you picked. Each read goes into a log only you can open."],
  ["You review what they save", "When an app wants to remember something, your vault keeps it as that app's suggestion. Other apps can't see it until you confirm it, so one bad app can't slip made-up details to the rest."],
  ["Take it back", "Revoke an app with one tap and your vault stops answering it, starting with the next message."],
] as const;

const snippet = [
  ["c", "// in your app: ask the user to approve one folder"],
  ["k", "const { sessionProof } = await connectEngram({"],
  ["v", '  vaultUrl, agentId, labels: ["preferences"], scope: "read",'],
  ["k", "});"],
  ["c", "// for each message: the vault shares what fits"],
  ["k", "const vault = openVaultBridge({ vaultUrl, agentId, mount });"],
  ["k", "const { entries } = await vault.disclose(userMessage);"],
] as const;

export function Onboarding({ locked = false }: { locked?: boolean }) {
  const { signUp, signIn, status, error } = useSession();
  const busy = status === "working";

  const actions = (
    <div className="flex flex-col gap-3 sm:flex-row">
      {locked ? null : (
        <button className="btn btn-primary lift justify-center px-6 py-3.5 text-base" onClick={() => void signUp()} disabled={busy}>
          <Seal size={18} /> {busy ? "Waiting for your passkey…" : "Create my memory vault"}
        </button>
      )}
      <button className={`btn lift justify-center px-6 py-3.5 ${locked ? "btn-primary text-base" : "btn-ghost"}`} onClick={() => void signIn()} disabled={busy}>
        {locked ? (busy ? "Waiting for your passkey…" : "Unlock vault") : "I already have one, unlock it"}
      </button>
    </div>
  );

  return (
    <main className="mx-auto max-w-6xl px-6 md:px-10">
      <header className="flex items-center gap-3 py-7 md:py-8">
        <Seal size={30} />
        <span className="font-display text-2xl tracking-tight">Engram</span>
        <span className="ml-2 rounded-sm border border-rule px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-ink-soft">Monad testnet</span>
        {locked ? null : (
          <nav className="ml-auto hidden gap-6 font-mono text-xs text-ink-soft sm:flex">
            <a href="#how" className="hover:text-ink">How it works</a>
            <a href="#builders" className="hover:text-ink">For builders</a>
            <a href={REPO} target="_blank" rel="noreferrer" className="hover:text-ink">GitHub</a>
          </nav>
        )}
      </header>

      {/* Hero: headline and specimen share a top line; the specimen sits on a small stack of paper. */}
      <section className="grid grid-cols-1 items-start gap-12 pb-16 pt-6 md:grid-cols-[1.15fr_1fr] md:gap-14 md:pb-20 md:pt-12">
        <div>
          <p className="settle mb-5 font-mono text-xs uppercase tracking-[0.2em] text-seal">{locked ? "Vault locked" : "Your AI memory, kept by you"}</p>
          <h1 className="font-display text-[clamp(2.6rem,5.6vw,5rem)] leading-[0.95] tracking-tight">
            {locked ? (
              <>
                <Words>Unlock with the passkey you</Words>{" "}
                <em className="ink-mark text-seal">
                  <Words start={5}>sealed it</Words>
                </em>{" "}
                <Words start={7}>with.</Words>
              </>
            ) : (
              <>
                <Words>One memory for every AI you use,</Words>{" "}
                <em className="ink-mark text-seal">
                  <Words start={7}>sealed</Words>
                </em>{" "}
                <Words start={8}>with your passkey.</Words>
              </>
            )}
          </h1>
          <p className="settle mt-7 max-w-xl text-lg leading-relaxed text-ink-soft" style={{ animationDelay: "650ms" }}>
            Tell one assistant what you like and your other apps can use it too. Each app asks your vault when it needs something, and
            the vault hands over only the memories that fit the question. The app never gets a key, and you can see every read.
          </p>
          <div className="settle mt-9" style={{ animationDelay: "800ms" }}>
            {actions}
          </div>
          {error ? (
            <p role="alert" className="mt-5 max-w-xl rounded-sm border border-rust/40 bg-rust-soft px-3 py-2.5 text-sm text-rust">
              {error}
            </p>
          ) : null}
          <p className="settle mt-6 max-w-md font-mono text-xs leading-relaxed text-ink-soft" style={{ animationDelay: "950ms" }}>
            Everything is encrypted on your device before it goes to Monad, so no company can read it, us included. This browser stores
            nothing; your keys are rebuilt from your passkey each time you sign in.
          </p>
        </div>
        <div className="settle relative md:mt-10" style={{ animationDelay: "300ms" }}>
          <span aria-hidden className="paper-card absolute inset-0 translate-x-3 translate-y-3 rotate-[1.4deg] opacity-70" />
          <span aria-hidden className="paper-card absolute inset-0 translate-x-1.5 translate-y-1.5 rotate-[0.6deg] opacity-85" />
          <div className="relative">
            <LedgerSpecimen />
          </div>
        </div>
      </section>

      {locked ? null : (
        <>
          {/* One plain statement between the hero and the steps. */}
          <section className="border-t border-rule py-14 md:py-20">
            <p className="max-w-4xl font-display text-[clamp(1.8rem,3.4vw,2.9rem)] leading-[1.12] tracking-tight">
              An app that wants to know you has to ask your vault first. <span className="text-ink-soft">The vault decides what it gets,
              and you can read the whole history later.</span>
            </p>
          </section>

          <section id="how" className="border-t border-rule py-16 md:py-24">
            <div className="flex items-baseline justify-between gap-6">
              <h2 className="font-display text-4xl leading-none tracking-tight md:text-5xl">How it works</h2>
              <p className="hidden font-mono text-xs text-ink-soft md:block">four steps, one passkey</p>
            </div>
            <ol className="stagger mt-10 grid gap-x-14 gap-y-12 md:grid-cols-2">
              {steps.map(([title, body], i) => (
                <li key={title} className={`grid grid-cols-[3rem_1fr] gap-4 border-t border-rule pt-6 md:grid-cols-[4rem_1fr] ${i % 2 ? "md:mt-16" : ""}`} style={{ ["--i" as string]: i }}>
                  <span className="font-display text-5xl leading-none text-rust md:text-6xl">{i + 1}</span>
                  <div>
                    <p className="font-display text-2xl leading-tight md:text-3xl">{title}</p>
                    <p className="mt-3 leading-relaxed text-ink-soft">{body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section id="builders" className="grid gap-10 border-t border-rule py-16 md:grid-cols-[1fr_1.2fr] md:items-center md:py-24">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-seal">For builders</p>
              <h2 className="mt-4 font-display text-4xl leading-[1.02] tracking-tight md:text-5xl">
                Add memory to your agent without holding <em className="text-seal">anyone&apos;s</em> data.
              </h2>
              <p className="mt-5 max-w-md leading-relaxed text-ink-soft">
                Your agent gets an ERC-8004 identity on Monad. Users approve it for a folder, and it asks their vault for what it needs.
                You never store keys or user records, and your server never talks to the chain.
              </p>
              <a href={`${REPO}/blob/main/docs/INTEGRATE.md`} target="_blank" rel="noreferrer" className="btn btn-ghost lift mt-7 px-5 py-3">
                Read the integration guide
              </a>
            </div>
            <pre className="lift overflow-x-auto rounded-sm bg-ink p-6 font-mono text-[13px] leading-7 text-[#e9e3d6] shadow-[0_18px_40px_-24px_rgba(27,25,22,0.8)]">
              <code className="stagger block">
                {snippet.map(([t, line], i) => (
                  <span key={i} className={`block ${t === "c" ? "text-[#9c958a]" : t === "v" ? "text-[#c9e0d4]" : ""}`} style={{ ["--i" as string]: i, ["--d" as string]: "200ms" }}>
                    {line}
                  </span>
                ))}
              </code>
            </pre>
          </section>

          <footer className="flex flex-col gap-3 border-t border-rule py-8 font-mono text-[11px] text-ink-soft sm:flex-row sm:items-center sm:justify-between">
            <span>Built on Monad, with ERC-8004 agent identities, Mera passkeys and Envio</span>
            <a href={`https://testnet.monadvision.com/address/${REGISTRY}`} target="_blank" rel="noreferrer" className="underline decoration-rule underline-offset-4 hover:text-ink">
              MemoryRegistry {REGISTRY.slice(0, 6)}…{REGISTRY.slice(-4)}
            </a>
          </footer>
        </>
      )}
    </main>
  );
}
