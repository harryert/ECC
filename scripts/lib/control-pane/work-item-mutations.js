'use strict';

/**
 * Shared work-item mutation helpers for the agent+human JIT board.
 *
 * Used by both the `work-items.js` CLI (`claim`) and the control-pane local
 * server (interactive claim / move), so the two surfaces never diverge.
 */

const DONE_STATUSES = new Set(['done', 'closed', 'resolved', 'merged', 'cancelled']);
const CLAIMABLE_STATUSES = new Set(['open', 'ready']);
const ACTIVE_CLAIM_STATUSES = new Set(['running', 'claimed', 'in-progress']);
const PRIORITY_RANK = { critical: 0, high: 1, urgent: 1, medium: 2, normal: 2, low: 3 };

// Statuses a card may hold while it is handed over to a session. A terminal
// card is finished and anything else (for example `blocked`) is parked, so
// neither may be taken over.
const HANDOFF_ELIGIBLE_STATUSES = new Set([...CLAIMABLE_STATUSES, ...ACTIVE_CLAIM_STATUSES]);

// Kanban lanes the board renders, and the canonical status each maps to on a move.
const LANE_TO_STATUS = {
  ready: 'open',
  running: 'running',
  blocked: 'blocked',
  done: 'done'
};
const VALID_LANES = new Set(Object.keys(LANE_TO_STATUS));
const VALID_ASSIGNEE_KINDS = new Set(['agent', 'human']);

function isOpenStatus(status) {
  return !DONE_STATUSES.has(
    String(status || '')
      .trim()
      .toLowerCase()
  );
}

function isClaimableStatus(status) {
  return CLAIMABLE_STATUSES.has(String(status || '').trim().toLowerCase());
}

function priorityRank(priority) {
  return PRIORITY_RANK[String(priority || '').toLowerCase()] ?? 2;
}

/**
 * Resolve which work item a claim targets: an explicit id, otherwise the
 * highest-priority unassigned open item (the JIT pickup queue).
 */
function selectClaimTarget(store, { id } = {}) {
  if (id) {
    const item = store.getWorkItemById(id);
    if (!item) {
      throw new Error(`Work item not found: ${id}`);
    }
    return item;
  }
  const { items } = store.listWorkItems({ limit: 100 });
  return items.filter(item => !item.owner && isClaimableStatus(item.status)).sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))[0] || null;
}

/** Merge the claim metadata into the item metadata without dropping fields. */
function mergeClaimMetadata(target, extraMetadata, kind) {
  const metadata = { ...(target.metadata || {}) };
  if (extraMetadata && typeof extraMetadata === 'object' && !Array.isArray(extraMetadata)) {
    Object.assign(metadata, extraMetadata);
  }
  if (kind) {
    metadata.assigneeKind = kind;
  }
  return metadata;
}

/**
 * Claim an unassigned work item for an agent or human. Sets the owner (and
 * optional assigneeKind) and moves the card to running unless an explicit
 * status is supplied. Optional `metadata` is merged into the item metadata.
 * Returns { claimed, item } or { claimed: false, reason }.
 */
function claimWorkItem(store, { id, owner, assigneeKind, sessionId, status, metadata: extraMetadata } = {}) {
  if (!owner) {
    throw new Error('claim requires an owner.');
  }
  const kind = assigneeKind ? String(assigneeKind).toLowerCase() : null;
  if (kind && !VALID_ASSIGNEE_KINDS.has(kind)) {
    throw new Error("assigneeKind must be 'agent' or 'human'.");
  }
  const target = selectClaimTarget(store, { id });
  if (!target) {
    return { claimed: false, reason: 'no-unassigned-open-items' };
  }
  const targetStatus = String(target.status || '').trim().toLowerCase();
  const metadata = mergeClaimMetadata(target, extraMetadata, kind);
  if (target.owner) {
    if (target.owner !== owner) {
      throw new Error(`Work item ${target.id} is already owned by ${target.owner}; cannot claim.`);
    }
    if (ACTIVE_CLAIM_STATUSES.has(targetStatus)) {
      if (!sessionId || sessionId === target.sessionId) {
        return { claimed: true, item: target };
      }
      const bound = store.upsertWorkItem({
        ...target,
        sessionId,
        metadata,
        updatedAt: new Date().toISOString()
      });
      return { claimed: true, item: bound };
    }
    if (!isClaimableStatus(targetStatus)) {
      throw new Error(`Work item ${target.id} is not ready; cannot claim.`);
    }
  } else if (!isClaimableStatus(targetStatus)) {
    throw new Error(`Work item ${target.id} is not ready; cannot claim.`);
  }
  const item = store.upsertWorkItem({
    ...target,
    owner,
    sessionId: sessionId ?? target.sessionId ?? null,
    status: status ?? 'running',
    metadata,
    updatedAt: new Date().toISOString()
  });
  return { claimed: true, item };
}

/**
 * Hand an already-owned work item over to a native session.
 *
 * This is the explicit owner-to-session handoff and it is deliberately kept
 * apart from `claimWorkItem`: a generic claim never replaces an existing
 * owner, so the two surfaces cannot drift into silently stealing a card.
 *
 * The handoff is only valid when the caller names the exact session that
 * takes the card, the card is not bound to another session yet, and the card
 * is still in a status that may be worked on.
 */
function handoffWorkItemToSession(store, { id, owner, sessionId, assigneeKind, status, metadata: extraMetadata } = {}) {
  if (!owner) {
    throw new Error('handoff requires an owner.');
  }
  if (!sessionId) {
    throw new Error('handoff requires a session id.');
  }
  const kind = assigneeKind ? String(assigneeKind).toLowerCase() : null;
  if (kind && !VALID_ASSIGNEE_KINDS.has(kind)) {
    throw new Error("assigneeKind must be 'agent' or 'human'.");
  }
  const target = store.getWorkItemById(id);
  if (!target) {
    return { claimed: false, reason: 'work-item-not-found' };
  }
  if (target.sessionId) {
    throw new Error(`Work item ${target.id} is already bound to session ${target.sessionId}; cannot hand off.`);
  }
  const targetStatus = String(target.status || '').trim().toLowerCase();
  if (!HANDOFF_ELIGIBLE_STATUSES.has(targetStatus)) {
    throw new Error(`Work item ${target.id} is ${targetStatus || 'unknown'} and cannot be handed off.`);
  }
  const metadata = mergeClaimMetadata(target, extraMetadata, kind);
  // A card that was already running keeps its status; a merely ready card
  // becomes running now that a session owns it.
  const nextStatus = status
    ?? (ACTIVE_CLAIM_STATUSES.has(targetStatus) ? target.status : 'running');
  const item = store.upsertWorkItem({
    ...target,
    owner,
    sessionId,
    status: nextStatus,
    metadata,
    updatedAt: new Date().toISOString()
  });
  return { claimed: true, item };
}

/**
 * Move a work item to a kanban lane (ready | running | blocked | done).
 */
function moveWorkItem(store, { id, lane } = {}) {
  if (!id) {
    throw new Error('move requires a work item id.');
  }
  const laneKey = String(lane || '')
    .trim()
    .toLowerCase();
  if (!VALID_LANES.has(laneKey)) {
    throw new Error(`Invalid lane '${lane}'. Expected one of ${[...VALID_LANES].join(', ')}.`);
  }
  const target = store.getWorkItemById(id);
  if (!target) {
    throw new Error(`Work item not found: ${id}`);
  }
  const item = store.upsertWorkItem({
    ...target,
    status: LANE_TO_STATUS[laneKey],
    updatedAt: new Date().toISOString()
  });
  return { moved: true, item };
}

module.exports = {
  DONE_STATUSES,
  HANDOFF_ELIGIBLE_STATUSES,
  LANE_TO_STATUS,
  VALID_LANES,
  VALID_ASSIGNEE_KINDS,
  isOpenStatus,
  priorityRank,
  selectClaimTarget,
  claimWorkItem,
  handoffWorkItemToSession,
  moveWorkItem
};
