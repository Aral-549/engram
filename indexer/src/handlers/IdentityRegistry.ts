// ERC-8004 IdentityRegistry event handlers (spec: contracts/indexer.md, cases 7, 10-12).
import { indexer } from "envio";
import { lc, loadAgent, logStage, withKeysCurrent } from "../shared.js";

indexer.onEvent({ contract: "IdentityRegistry", event: "Registered", fields: { block: ["timestamp"] } }, async ({ event, context }) => {
  // Not a source of tokenOwner (BUGLOG I1): Registered is emitted after _safeMint's receiver callback, so
  // `owner` can already be stale. Ownership comes only from Transfer.
  const agent = await loadAgent(context, event.params.agentId);
  context.Agent.set({ ...agent, agentURI: event.params.agentURI, registeredAt: BigInt(event.block.timestamp) });
  logStage(context, event, { agentId: event.params.agentId.toString(), owner: lc(event.params.owner) });
});

indexer.onEvent({ contract: "IdentityRegistry", event: "URIUpdated" }, async ({ event, context }) => {
  const agent = await loadAgent(context, event.params.agentId);
  context.Agent.set({ ...agent, agentURI: event.params.newURI });
  logStage(context, event, { agentId: event.params.agentId.toString() });
});

// Mint (from 0), transfer, and burn (to 0) all move token ownership, which decides key currency.
indexer.onEvent({ contract: "IdentityRegistry", event: "Transfer" }, async ({ event, context }) => {
  const agent = await loadAgent(context, event.params.tokenId);
  context.Agent.set(withKeysCurrent({ ...agent, tokenOwner: lc(event.params.to) }));
  logStage(context, event, { agentId: event.params.tokenId.toString(), from: lc(event.params.from), to: lc(event.params.to) });
});
