// Stateless namespace discovery (contracts/apps.md, case V1). Namespace ids are opaque onchain, so the vault
// checks well-known labels plus custom labels recorded in a reserved encrypted namespace.
import { EngramError, type OwnerSession, type RecalledAnyEntry } from "@engram/sdk";

export const INDEX_LABEL = "engram-index";
export const KNOWN_LABELS = ["preferences", "work", "health", "travel", "notes"] as const;
const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PREFIX = "label:";

// recallAll (when present) also returns agent proposals written in Disclosure mode, with their source.
type Session = Pick<OwnerSession, "recall" | "remember"> & Partial<Pick<OwnerSession, "recallAll">>;
export type DiscoveredNamespace = { label: string; entries: RecalledAnyEntry[]; complete: boolean; skipped: number; custom: boolean };

export function isValidLabel(label: string): boolean {
  return LABEL_RE.test(label) && label !== INDEX_LABEL;
}

async function customLabels(session: Session): Promise<string[]> {
  const idx = await session.recall(INDEX_LABEL);
  const out: string[] = [];
  for (const e of idx.entries) {
    const name = e.text.startsWith(PREFIX) ? e.text.slice(PREFIX.length) : "";
    if (isValidLabel(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Records a custom label in the encrypted index (idempotent). */
export async function addLabel(session: Session, label: string): Promise<void> {
  if (!isValidLabel(label)) throw new EngramError("INPUT_INVALID", "labels are 1-32 characters: lowercase letters, digits, and hyphens");
  if ((await customLabels(session)).includes(label)) return;
  await session.remember(INDEX_LABEL, { kind: "note", text: `${PREFIX}${label}` });
}

/** Every namespace the owner has used, rediscovered from the passkey alone. */
export async function discoverLabels(session: Session): Promise<DiscoveredNamespace[]> {
  const custom = await customLabels(session);
  const labels = [...new Set<string>([...KNOWN_LABELS, ...custom])];
  const read = (label: string) => (session.recallAll ? session.recallAll(label) : session.recall(label));
  const results = await Promise.all(labels.map(async (label) => ({ label, custom: custom.includes(label), r: await read(label) })));
  return results
    // Incomplete means chain has entries the source has not served yet: the namespace exists, keep it.
    .filter(({ custom: c, r }) => c || r.entries.length > 0 || r.skipped > 0 || !r.complete)
    .map(({ label, custom: c, r }) => ({ label, entries: r.entries, complete: r.complete, skipped: r.skipped, custom: c }));
}
