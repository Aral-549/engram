// MemoryRegistry event handlers (spec: contracts/indexer.md, cases 1-9, 13-15).
import { indexer } from "envio";
import { grantId, lc, loadAgent, logStage, namespaceId, recordError, touchDay, withKeysCurrent } from "../shared.js";

const TS = { block: ["timestamp"] } as const;

indexer.onEvent({ contract: "MemoryRegistry", event: "NamespaceCreated", fields: TS }, async ({ event, context }) => {
  const owner = lc(event.params.owner);
  const id = namespaceId(owner, event.params.nsId);
  const ts = BigInt(event.block.timestamp);
  if (await context.Namespace.get(id)) {
    recordError(context, event, "NamespaceExists", id);
    return;
  }
  context.Namespace.set({ id, owner_id: owner, nsId: lc(event.params.nsId), epoch: 0n, nextSeq: 0n, granteeCount: 0, createdAt: ts });
  const prev = await context.Owner.get(owner);
  context.Owner.set({
    id: owner,
    namespaceCount: (prev?.namespaceCount ?? 0) + 1,
    entryCount: prev?.entryCount ?? 0,
    firstSeenAt: prev?.firstSeenAt ?? ts,
  });
  await touchDay(context, owner, event.block.timestamp, {});
  logStage(context, event, { owner, nsId: event.params.nsId });
});

indexer.onEvent(
  { contract: "MemoryRegistry", event: "EntryAppended", fields: { block: ["timestamp"], transaction: ["hash"] } },
  async ({ event, context }) => {
    const { owner: rawOwner, nsId, seq, epoch, byOwner, agentId, ciphertext } = event.params;
    const owner = lc(rawOwner);
    const nsKey = namespaceId(owner, nsId);
    const ns = await context.Namespace.get(nsKey);
    if (!ns) {
      recordError(context, event, "UnknownNamespace", `${nsKey} seq ${seq}`);
      return;
    }
    context.Entry.set({
      id: `${nsKey}-${seq}`,
      namespace_id: nsKey,
      seq,
      epoch,
      byOwner,
      agentId,
      ciphertext: lc(ciphertext),
      txHash: lc(event.transaction.hash),
      blockNumber: BigInt(event.block.number),
      blockTime: BigInt(event.block.timestamp),
    });
    context.Namespace.set({ ...ns, nextSeq: seq + 1n > ns.nextSeq ? seq + 1n : ns.nextSeq });
    const ownerRow = await context.Owner.get(owner);
    if (ownerRow) context.Owner.set({ ...ownerRow, entryCount: ownerRow.entryCount + 1 });
    if (!byOwner) {
      const agent = await loadAgent(context, agentId);
      context.Agent.set({ ...agent, entriesWritten: agent.entriesWritten + 1 });
    }
    await touchDay(context, owner, event.block.timestamp, { entries: 1 });
    logStage(context, event, { owner, nsId, seq: seq.toString(), byOwner, agentId: agentId.toString(), bytes: (ciphertext.length - 2) / 2 });
  },
);

indexer.onEvent({ contract: "MemoryRegistry", event: "GrantSet", fields: TS }, async ({ event, context }) => {
  const { owner: rawOwner, nsId, agentId, scope, expiry } = event.params;
  const owner = lc(rawOwner);
  const nsKey = namespaceId(owner, nsId);
  const ns = await context.Namespace.get(nsKey);
  if (!ns) {
    recordError(context, event, "UnknownNamespace", `${nsKey} grant ${agentId}`);
    return;
  }
  const id = grantId(owner, nsId, agentId);
  const prev = await context.Grant.get(id);
  const wasActive = prev?.active === true;
  context.Grant.set({
    id,
    namespace_id: nsKey,
    agent_id: agentId.toString(),
    scope: Number(scope),
    expiry,
    active: true,
    grantedAt: BigInt(event.block.timestamp),
    revokedAt: undefined,
  });
  if (!wasActive) {
    context.Namespace.set({ ...ns, granteeCount: ns.granteeCount + 1 });
    const agent = await loadAgent(context, agentId);
    context.Agent.set({ ...agent, activeGrantCount: agent.activeGrantCount + 1 });
  }
  await touchDay(context, owner, event.block.timestamp, { grantsSet: 1 });
  logStage(context, event, { owner, nsId, agentId: agentId.toString(), scope: Number(scope), expiry: expiry.toString(), regrant: wasActive });
});

indexer.onEvent({ contract: "MemoryRegistry", event: "KeyWrapped" }, async ({ event, context }) => {
  const { owner, nsId, agentId, epoch, wrap } = event.params;
  const gid = grantId(owner, nsId, agentId);
  if (!(await context.Grant.get(gid))) recordError(context, event, "WrapWithoutGrant", `${gid} epoch ${epoch}`);
  context.WrappedKey.set({ id: `${gid}-${epoch}`, grant_id: gid, epoch, wrap: lc(wrap) });
  logStage(context, event, { owner: lc(owner), nsId, agentId: agentId.toString(), epoch: epoch.toString() });
});

indexer.onEvent({ contract: "MemoryRegistry", event: "GrantRevoked", fields: TS }, async ({ event, context }) => {
  const { owner: rawOwner, nsId, agentId } = event.params;
  const owner = lc(rawOwner);
  const id = grantId(owner, nsId, agentId);
  const grant = await context.Grant.get(id);
  if (!grant || !grant.active) {
    recordError(context, event, "RevokeInactiveGrant", id);
    return;
  }
  context.Grant.set({ ...grant, active: false, revokedAt: BigInt(event.block.timestamp) });
  const ns = await context.Namespace.get(namespaceId(owner, nsId));
  if (ns) context.Namespace.set({ ...ns, granteeCount: Math.max(0, ns.granteeCount - 1) });
  const agent = await loadAgent(context, agentId);
  context.Agent.set({ ...agent, activeGrantCount: Math.max(0, agent.activeGrantCount - 1) });
  await touchDay(context, owner, event.block.timestamp, { revokes: 1 });
  logStage(context, event, { owner, nsId, agentId: agentId.toString() });
});

indexer.onEvent({ contract: "MemoryRegistry", event: "EpochRotated" }, async ({ event, context }) => {
  const nsKey = namespaceId(event.params.owner, event.params.nsId);
  const ns = await context.Namespace.get(nsKey);
  if (!ns) {
    recordError(context, event, "UnknownNamespace", `${nsKey} rotate`);
    return;
  }
  context.Namespace.set({ ...ns, epoch: event.params.newEpoch });
  logStage(context, event, { owner: lc(event.params.owner), nsId: event.params.nsId, newEpoch: event.params.newEpoch.toString() });
});

indexer.onEvent({ contract: "MemoryRegistry", event: "AgentKeysSet" }, async ({ event, context }) => {
  const agent = await loadAgent(context, event.params.agentId);
  // The contract only accepts setAgentKeys from the current token holder, so the setter is the holder now.
  context.Agent.set(
    withKeysCurrent({ ...agent, x25519Pub: lc(event.params.x25519Pub), operator: lc(event.params.operator), keysSetBy: agent.tokenOwner }),
  );
  logStage(context, event, { agentId: event.params.agentId.toString(), operator: lc(event.params.operator) });
});
