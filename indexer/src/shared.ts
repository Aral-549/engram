// Shared helpers for Engram handlers (spec: contracts/indexer.md). Handlers only read and write via
// `context`, because Envio preload runs every handler twice.
import type { Agent, DailyStat } from "envio";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** All ids and address fields are stored lowercase (Envio hands us EIP-55 checksummed addresses). */
export const lc = (hex: string): string => hex.toLowerCase();

/** UTC day of a block timestamp, or undefined when it cannot form a date (handlers must never throw). */
export const dayOf = (unixSeconds: number): string | undefined => {
  const d = new Date(unixSeconds * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
};

export const namespaceId = (owner: string, nsId: string) => `${lc(owner)}-${lc(nsId)}`;
export const grantId = (owner: string, nsId: string, agentId: bigint) => `${namespaceId(owner, nsId)}-${agentId}`;

type Ctx = {
  isPreload: boolean;
  log: { debug: (m: string, p?: Record<string, unknown>) => void; warn: (m: string, p?: Record<string, unknown>) => void };
  Agent: { get: (id: string) => Promise<Agent | undefined>; set: (a: Agent) => void };
  DailyStat: { get: (id: string) => Promise<DailyStat | undefined>; set: (d: DailyStat) => void };
  OwnerDay: { get: (id: string) => Promise<{ id: string } | undefined>; set: (d: { id: string }) => void };
  IndexerError: { set: (e: { id: string; kind: string; detail: string; blockNumber: bigint }) => void };
};

type Meta = { block: { number: number }; logIndex: number; eventName: string };

/** Stage-boundary log (AGENTS.md rule 5). Skipped on the preload pass so each event logs once. */
export function logStage(context: Ctx, event: Meta, fields: Record<string, unknown>): void {
  if (context.isPreload) return;
  context.log.debug("indexer", { stage: "indexer", event: event.eventName, block: event.block.number, logIndex: event.logIndex, ...fields });
}

/** Records an event that violates a registry invariant (should never happen). Never throws. */
export function recordError(context: Ctx, event: Meta, kind: string, detail: string): void {
  context.IndexerError.set({ id: `${event.block.number}-${event.logIndex}`, kind, detail, blockNumber: BigInt(event.block.number) });
  if (!context.isPreload) context.log.warn("indexer invariant violated", { stage: "indexer", kind, detail, block: event.block.number });
}

export async function loadAgent(context: Ctx, agentId: bigint): Promise<Agent> {
  return (
    (await context.Agent.get(agentId.toString())) ?? {
      id: agentId.toString(),
      tokenOwner: ZERO_ADDRESS,
      agentURI: undefined,
      x25519Pub: undefined,
      operator: undefined,
      keysSetBy: undefined,
      keysCurrent: false,
      activeGrantCount: 0,
      entriesWritten: 0,
      registeredAt: undefined,
    }
  );
}

/** Mirrors MemoryRegistry._keysCurrent (BUGLOG R2/R3): keys set by the current, non-burned holder. */
export function withKeysCurrent(agent: Agent): Agent {
  const keysCurrent = agent.x25519Pub !== undefined && agent.tokenOwner !== ZERO_ADDRESS && agent.keysSetBy === agent.tokenOwner;
  return { ...agent, keysCurrent };
}

type DayDelta = Partial<Pick<DailyStat, "entries" | "grantsSet" | "revokes">>;

/** Adds to the UTC day's counters and counts `owner` as active once per day. */
export async function touchDay(context: Ctx, event: Meta, owner: string, unixSeconds: number, delta: DayDelta): Promise<void> {
  const day = dayOf(unixSeconds);
  if (day === undefined) {
    recordError(context, event, "BadTimestamp", String(unixSeconds));
    return;
  }
  const stat = (await context.DailyStat.get(day)) ?? { id: day, entries: 0, grantsSet: 0, revokes: 0, activeOwners: 0 };
  const ownerDayId = `${lc(owner)}-${day}`;
  const seen = await context.OwnerDay.get(ownerDayId);
  if (!seen) context.OwnerDay.set({ id: ownerDayId });
  context.DailyStat.set({
    ...stat,
    entries: stat.entries + (delta.entries ?? 0),
    grantsSet: stat.grantsSet + (delta.grantsSet ?? 0),
    revokes: stat.revokes + (delta.revokes ?? 0),
    activeOwners: stat.activeOwners + (seen ? 0 : 1),
  });
}
