"use client";
import type { AgentCard } from "@engram/sdk";
import { useEffect, useState } from "react";

const cache = new Map<string, Promise<AgentCard | null>>();

export function agentCard(agentId: string): Promise<AgentCard | null> {
  let p = cache.get(agentId);
  if (!p) {
    p = fetch(`/api/agent-card?agentId=${agentId}`)
      .then(async (r) => (r.ok ? ((await r.json()) as { card: AgentCard }).card : null))
      .catch(() => null);
    cache.set(agentId, p);
  }
  return p;
}

/** Agent display names from ERC-8004 cards, fetched through the vault's hardened proxy. */
export function useAgentCards(ids: string[]): Record<string, AgentCard | null> {
  const [cards, setCards] = useState<Record<string, AgentCard | null>>({});
  const key = [...new Set(ids)].sort().join(",");
  useEffect(() => {
    let live = true;
    for (const id of key ? key.split(",") : []) {
      void agentCard(id).then((c) => live && setCards((prev) => ({ ...prev, [id]: c })));
    }
    return () => {
      live = false;
    };
  }, [key]);
  return cards;
}
