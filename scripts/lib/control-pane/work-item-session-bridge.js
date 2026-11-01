'use strict';

/**
 * Public bridge from the native session producer to Work Items claim binding.
 *
 * The native (ECC2) session manager owns the session registry. It mints a
 * session id, registers the session, spawns the harness, and returns the
 * registered id only after the spawn succeeded. This module carries that id,
 * the canonical repo root and an explicit work-item id across the boundary
 * and binds them through the public Work Items claim API.
 *
 * The rules are deliberately strict; every ambiguity fails closed:
 *
 *  - The work-item id is always explicit. A card is never inferred from a
 *    title, a task description or any other prose.
 *  - The session id must exist in the native registry and is matched exactly.
 *    A row in the local session table is never accepted as proof of identity,
 *    and a local row without a native counterpart is never bound.
 *  - The session must belong to the canonical repo root and must not already
 *    be bound to a different open work item.
 *  - A reused idle delegate is only bound when the caller declares it.
 *  - A failed spawn never binds.
 *  - A card that already has an owner is only handed over when the caller
 *    explicitly asks this exact native session to take it. A generic claim
 *    still refuses to replace an owner.
 *
 * The binding itself is written by the shared claim helper
 * (`claimWorkItem`), or by the explicit owner-to-session handoff
 * (`handoffWorkItemToSession`) when the card is already owned, so the CLI
 * and the control-pane API cannot diverge.
 */

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('node:util');
const { execFileSync } = require('child_process');

const { claimWorkItem, handoffWorkItemToSession, rebindWorkItemToSession, HANDOFF_ELIGIBLE_STATUSES, isOpenStatus } = require('./work-item-mutations');
const { readNativeSession } = require('./state');

// Adapter id used for the session mirror row written for a verified native
// session. The row mirrors a native registry row; it never invents one.
const NATIVE_SESSION_ADAPTER_ID = 'ecc2-native';

// Marker written into the mirror snapshot so a mirrored row is recognisable
// as a mirror of a native session rather than a locally created session.
const NATIVE_SESSION_MIRROR_MARKER = 'ecc2-native-session';

const BINDING_SOURCE = 'native-session';
const GIT_TIMEOUT_MS = 5000;

// Dispatch actions reported by the native session manager.
const DISPATCH_ACTIONS = Object.freeze({
  SPAWNED: 'spawned',
  REUSED_IDLE: 'reused_idle',
  REUSED_ACTIVE: 'reused_active',
  DEFERRED_SATURATED: 'deferred_saturated'
});

// A session that is registered and starting (or running) can take a card.
// A fresh spawn is still `pending` until the runner flips it to `running`.
const BINDABLE_SESSION_STATES = new Set(['pending', 'running']);
const IDLE_SESSION_STATES = new Set(['idle']);
const FAILED_SESSION_STATES = new Set(['failed']);
const TERMINAL_SESSION_STATES = new Set(['completed', 'failed', 'stopped']);

const SESSION_BINDING_ERROR_CODES = Object.freeze({
  STORE_REQUIRED: 'STORE_REQUIRED',
  WORK_ITEM_ID_REQUIRED: 'WORK_ITEM_ID_REQUIRED',
  WORK_ITEM_NOT_FOUND: 'WORK_ITEM_NOT_FOUND',
  WORK_ITEM_REPO_MISSING: 'WORK_ITEM_REPO_MISSING',
  WORK_ITEM_ALREADY_BOUND: 'WORK_ITEM_ALREADY_BOUND',
  WORK_ITEM_OWNER_CONFLICT: 'WORK_ITEM_OWNER_CONFLICT',
  WORK_ITEM_STATUS_INVALID: 'WORK_ITEM_STATUS_INVALID',
  REPO_ROOT_REQUIRED: 'REPO_ROOT_REQUIRED',
  REPO_ROOT_MISMATCH: 'REPO_ROOT_MISMATCH',
  SESSION_ID_REQUIRED: 'SESSION_ID_REQUIRED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_AMBIGUOUS: 'SESSION_AMBIGUOUS',
  SESSION_UNRELATED: 'SESSION_UNRELATED',
  SESSION_BUSY: 'SESSION_BUSY',
  SESSION_FAILED: 'SESSION_FAILED',
  SESSION_REUSED_IDLE: 'SESSION_REUSED_IDLE',
  SESSION_STATE_MISMATCH: 'SESSION_STATE_MISMATCH',
  SESSION_ALREADY_BOUND: 'SESSION_ALREADY_BOUND',
  SESSION_REGISTRY_UNAVAILABLE: 'SESSION_REGISTRY_UNAVAILABLE',
  DISPATCH_DEFERRED: 'DISPATCH_DEFERRED',
  DISPATCH_ACTION_UNSUPPORTED: 'DISPATCH_ACTION_UNSUPPORTED'
});

function bindingError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeIdentifier(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Resolve a path to its canonical form. Symlinks are resolved so the same
 * repository reached through a worktree or a symlink compares equal.
 */
function canonicalizePath(target) {
  const raw = normalizeIdentifier(target);
  if (!raw) {
    return null;
  }
  const resolved = path.resolve(raw);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Resolve the common git directory of a checkout. Two paths belong to the
 * same repository when they share one, which is how a linked worktree is
 * recognized as belonging to its base checkout.
 */
function gitCommonDir(directory) {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) {
    delete env[key];
  }
  try {
    const output = execFileSync('git', ['-C', directory, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS
    }).trim();
    if (!output) {
      return null;
    }
    const absolute = path.isAbsolute(output) ? output : path.resolve(directory, output);
    return canonicalizePath(absolute);
  } catch {
    return null;
  }
}

function isSameRepository(left, right) {
  const leftPath = canonicalizePath(left);
  const rightPath = canonicalizePath(right);
  if (!leftPath || !rightPath) {
    return false;
  }
  if (leftPath === rightPath) {
    return true;
  }
  const leftCommon = gitCommonDir(leftPath);
  const rightCommon = gitCommonDir(rightPath);
  return Boolean(leftCommon && rightCommon && leftCommon === rightCommon);
}

/** Directories a native session was registered with. */
function sessionRepoCandidates(session) {
  const candidates = [];
  if (session && session.workingDir) {
    candidates.push(session.workingDir);
  }
  if (session && session.worktree && session.worktree.path) {
    candidates.push(session.worktree.path);
  }
  return candidates.filter(candidate => typeof candidate === 'string' && candidate.length > 0);
}

/**
 * Decide how a session may be bound, from its native state and the dispatch
 * action reported by the manager.
 */
function resolveBindingSource(session, dispatchAction, allowReusedIdle) {
  const state = String((session && session.state) || '').trim().toLowerCase();
  const action = dispatchAction ? String(dispatchAction).trim().toLowerCase() : null;
  const knownActions = Object.values(DISPATCH_ACTIONS);

  if (action && !knownActions.includes(action)) {
    throw bindingError(
      SESSION_BINDING_ERROR_CODES.DISPATCH_ACTION_UNSUPPORTED,
      `Unsupported dispatch action '${dispatchAction}'. Expected one of ${knownActions.join(', ')}.`
    );
  }
  if (action === DISPATCH_ACTIONS.DEFERRED_SATURATED) {
    throw bindingError(
      SESSION_BINDING_ERROR_CODES.DISPATCH_DEFERRED,
      'The dispatch was deferred; no session was assigned to the work item.'
    );
  }
  if (FAILED_SESSION_STATES.has(state)) {
    throw bindingError(
      SESSION_BINDING_ERROR_CODES.SESSION_FAILED,
      `Session ${session.id} failed to start; a failed spawn never takes a work item.`
    );
  }
  if (IDLE_SESSION_STATES.has(state)) {
    if (action !== DISPATCH_ACTIONS.REUSED_IDLE) {
      throw bindingError(
        SESSION_BINDING_ERROR_CODES.SESSION_REUSED_IDLE,
        `Session ${session.id} is an idle delegate; declare dispatch action '${DISPATCH_ACTIONS.REUSED_IDLE}' to bind it.`
      );
    }
    if (allowReusedIdle !== true) {
      throw bindingError(
        SESSION_BINDING_ERROR_CODES.SESSION_REUSED_IDLE,
        `Session ${session.id} is a reused idle delegate; allowReusedIdle must be true to bind it.`
      );
    }
    return DISPATCH_ACTIONS.REUSED_IDLE;
  }
  if (!BINDABLE_SESSION_STATES.has(state)) {
    throw bindingError(
      SESSION_BINDING_ERROR_CODES.SESSION_BUSY,
      `Session ${session.id} is ${state || 'unknown'} and cannot take a new work item.`
    );
  }
  if (action === DISPATCH_ACTIONS.REUSED_IDLE) {
    throw bindingError(
      SESSION_BINDING_ERROR_CODES.SESSION_STATE_MISMATCH,
      `Session ${session.id} was declared a reused idle delegate but is ${state}.`
    );
  }
  if (action === DISPATCH_ACTIONS.REUSED_ACTIVE) {
    throw bindingError(
      SESSION_BINDING_ERROR_CODES.SESSION_BUSY,
      `Session ${session.id} was reused while it was already active.`
    );
  }
  return DISPATCH_ACTIONS.SPAWNED;
}

/** The session must be registered under the canonical repo root. */
function assertSessionBelongsToRepo(session, repoRoot) {
  const candidates = sessionRepoCandidates(session);
  if (candidates.length === 0) {
    throw bindingError(
      SESSION_BINDING_ERROR_CODES.SESSION_UNRELATED,
      `Session ${session.id} does not record a working directory and cannot be tied to ${repoRoot}.`
    );
  }
  if (!candidates.some(candidate => isSameRepository(candidate, repoRoot))) {
    throw bindingError(
      SESSION_BINDING_ERROR_CODES.SESSION_UNRELATED,
      `Session ${session.id} is not registered under ${repoRoot}.`
    );
  }
}

/** Another open work item must not already claim this session. */
function findSessionConflict(store, sessionId, workItemId) {
  const conflict = store.findWorkItemsBySessionId(sessionId).find(item => (
    item.id !== workItemId
    && isOpenStatus(item.status)
  ));
  return conflict ? conflict.id : null;
}

/**
 * Decide whether an already-owned card may be handed over to a native
 * session.
 *
 * The handoff is narrow on purpose. The caller must ask for this exact
 * session to take the card, the card must not be bound to a session yet, and
 * the card must still be in a status that can be worked on. Anything else
 * fails closed, so a generic claim can never take a card away from its owner.
 */
function assertHandoffAllowed(item, { sessionId, requestedOwner }) {
  if (requestedOwner !== sessionId) {
    throw bindingError(
      SESSION_BINDING_ERROR_CODES.WORK_ITEM_OWNER_CONFLICT,
      `Work item ${item.id} is already owned by ${item.owner}; cannot claim.`
    );
  }
  if (item.sessionId) {
    throw bindingError(
      SESSION_BINDING_ERROR_CODES.WORK_ITEM_ALREADY_BOUND,
      `Work item ${item.id} is already bound to session ${item.sessionId}.`
    );
  }
  const itemStatus = String(item.status || '').trim().toLowerCase();
  if (!HANDOFF_ELIGIBLE_STATUSES.has(itemStatus)) {
    throw bindingError(
      SESSION_BINDING_ERROR_CODES.WORK_ITEM_STATUS_INVALID,
      `Work item ${item.id} is ${itemStatus || 'unknown'} and cannot be handed off.`
    );
  }
}

/**
 * Mirror a verified native session into the session registry.
 *
 * The work-item session link references the session registry by id, so the
 * verified native session needs a registry row for the reference to hold.
 * Every field is copied from the native row and the snapshot is tagged, so a
 * mirrored row is never mistaken for a locally created session.
 */
function mirrorNativeSession(store, session) {
  const candidates = sessionRepoCandidates(session);
  store.upsertSession({
    id: session.id,
    adapterId: NATIVE_SESSION_ADAPTER_ID,
    harness: String(session.harness || 'unknown'),
    state: String(session.state || 'pending'),
    repoRoot: candidates[0] || null,
    startedAt: session.createdAt || null,
    endedAt: null,
    snapshot: {
      mirroredFrom: NATIVE_SESSION_MIRROR_MARKER,
      nativeSessionId: session.id,
      agentType: session.agentType || null,
      taskGroup: session.taskGroup || null,
      project: session.project || null,
      workingDir: session.workingDir || null,
      worktree: session.worktree || null,
      pid: session.pid === undefined ? null : session.pid,
      createdAt: session.createdAt || null,
      updatedAt: session.updatedAt || null
    }
  });
}

/**
 * Bind a native session to an explicit work item.
 *
 * @param {object} options
 * @param {object} options.store State store (public query API).
 * @param {string} options.workItemId Explicit work-item id. Required.
 * @param {string} options.repoRoot Canonical repo root. Required.
 * @param {string} options.sessionId Exact native session id. Required.
 * @param {string} [options.owner] Owner recorded on the card. When the card
 *   already has an owner, this must be the native session id itself to hand
 *   the card over; any other owner is refused.
 * @param {string} [options.assigneeKind] 'agent' or 'human'.
 * @param {string} [options.status] Explicit status for the card.
 * @param {string} [options.dispatchAction] Dispatch action reported by the manager.
 * @param {boolean} [options.allowReusedIdle] Explicit opt-in for idle delegates.
 * @param {string} options.sessionDbPath Path to the native session registry.
 * @param {object} [deps] Test seam; `resolveNativeSession` replaces the mirror read.
 * @returns {Promise<{claimed: boolean, item: object, binding: object}>}
 */
async function bindWorkItemToNativeSession(options = {}, deps = {}) {
  const store = options.store;
  if (
    !store
    || typeof store.getWorkItemById !== 'function'
    || typeof store.upsertWorkItem !== 'function'
    || typeof store.findWorkItemsBySessionId !== 'function'
  ) {
    throw bindingError(
      SESSION_BINDING_ERROR_CODES.STORE_REQUIRED,
      'A work-item store is required to bind a session.'
    );
  }

  const workItemId = normalizeIdentifier(options.workItemId);
  if (!workItemId) {
    throw bindingError(
      SESSION_BINDING_ERROR_CODES.WORK_ITEM_ID_REQUIRED,
      'An explicit work item id is required; a card is never inferred from a title or task.'
    );
  }

  const sessionId = normalizeIdentifier(options.sessionId);
  if (!sessionId) {
    throw bindingError(
      SESSION_BINDING_ERROR_CODES.SESSION_ID_REQUIRED,
      'An explicit native session id is required to bind a session.'
    );
  }

  const repoRoot = canonicalizePath(options.repoRoot);
  if (!repoRoot) {
    throw bindingError(
      SESSION_BINDING_ERROR_CODES.REPO_ROOT_REQUIRED,
      'An exact canonical repo root is required to bind a session.'
    );
  }

  const resolveSession = deps.resolveNativeSession || readNativeSession;
  const resolved = await resolveSession(options.sessionDbPath, sessionId, options);
  const matches = (resolved && resolved.matches) || [];
  if (matches.length === 0) {
    throw bindingError(
      SESSION_BINDING_ERROR_CODES.SESSION_NOT_FOUND,
      `No registered native session matches '${sessionId}'.`
    );
  }
  if (matches.length > 1) {
    throw bindingError(
      SESSION_BINDING_ERROR_CODES.SESSION_AMBIGUOUS,
      `Native session id '${sessionId}' matches ${matches.length} registered sessions.`
    );
  }

  const session = resolved.session || matches[0];
  const source = resolveBindingSource(session, options.dispatchAction, options.allowReusedIdle);
  assertSessionBelongsToRepo(session, repoRoot);

  const initialItem = store.getWorkItemById(workItemId);
  const previousSessionId = initialItem && initialItem.sessionId && initialItem.sessionId !== sessionId
    ? initialItem.sessionId
    : null;
  if (previousSessionId) {
    const previousResolved = await resolveSession(options.sessionDbPath, previousSessionId, options);
    const previousMatches = (previousResolved && previousResolved.matches) || [];
    if (previousMatches.length === 0) {
      throw bindingError(
        SESSION_BINDING_ERROR_CODES.SESSION_NOT_FOUND,
        `No registered native session matches the previous session '${previousSessionId}'.`
      );
    }
    if (previousMatches.length > 1) {
      throw bindingError(
        SESSION_BINDING_ERROR_CODES.SESSION_AMBIGUOUS,
        `Previous native session id '${previousSessionId}' matches ${previousMatches.length} registered sessions.`
      );
    }
    const previousSession = previousResolved.session || previousMatches[0];
    if (!TERMINAL_SESSION_STATES.has(String(previousSession.state || '').trim().toLowerCase())) {
      throw bindingError(
        SESSION_BINDING_ERROR_CODES.SESSION_BUSY,
        `Previous session ${previousSessionId} is ${previousSession.state || 'unknown'} and cannot be rebound.`
      );
    }
    assertSessionBelongsToRepo(previousSession, repoRoot);
  }

  return store._database.transaction(() => {
    const item = store.getWorkItemById(workItemId);
    if (!item) {
      throw bindingError(
        SESSION_BINDING_ERROR_CODES.WORK_ITEM_NOT_FOUND,
        `Work item not found: ${workItemId}`
      );
    }
    const itemRepoRoot = canonicalizePath(item.repoRoot);
    if (!itemRepoRoot) {
      throw bindingError(
        SESSION_BINDING_ERROR_CODES.WORK_ITEM_REPO_MISSING,
        `Work item ${workItemId} does not record a repo root.`
      );
    }
    if (itemRepoRoot !== repoRoot) {
      throw bindingError(
        SESSION_BINDING_ERROR_CODES.REPO_ROOT_MISMATCH,
        `Work item ${workItemId} is registered under ${itemRepoRoot}, not ${repoRoot}.`
      );
    }
    if (item.sessionId && item.sessionId !== sessionId && item.sessionId !== previousSessionId) {
      throw bindingError(
        SESSION_BINDING_ERROR_CODES.WORK_ITEM_ALREADY_BOUND,
        `Work item ${workItemId} is already bound to session ${item.sessionId}.`
      );
    }
    if ((item.sessionId || null) !== (initialItem && initialItem.sessionId || null)) {
      throw bindingError(
        SESSION_BINDING_ERROR_CODES.WORK_ITEM_ALREADY_BOUND,
        `Work item ${workItemId} changed its session binding during claim.`
      );
    }
    const requestedOwner = normalizeIdentifier(options.owner);
    const currentOwner = item.owner ? normalizeIdentifier(item.owner) : '';
    // An explicit native dispatch asks for this exact session to own the
    // card. When the card still has a different owner that is an explicit
    // owner-to-session handoff; every other claim keeps the generic
    // behaviour and never replaces an owner.
    const requiresHandoff = !previousSessionId
      && Boolean(currentOwner)
      && Boolean(requestedOwner)
      && requestedOwner !== currentOwner;
    if (requiresHandoff) {
      assertHandoffAllowed(item, { sessionId, requestedOwner });
    }
    const conflict = findSessionConflict(store, sessionId, workItemId);
    if (conflict) {
      throw bindingError(
        SESSION_BINDING_ERROR_CODES.SESSION_ALREADY_BOUND,
        `Session ${sessionId} is already bound to work item ${conflict}.`
      );
    }

    mirrorNativeSession(store, session);

    const owner = requestedOwner || item.owner || sessionId;
    const binding = {
      source: BINDING_SOURCE,
      sessionId,
      repoRoot,
      dispatchAction: normalizeIdentifier(options.dispatchAction) || source,
      bindingSource: source,
      sessionState: String(session.state || ''),
      previousSessionId,
      handoff: requiresHandoff,
      previousOwner: requiresHandoff ? currentOwner : null,
      boundAt: new Date().toISOString()
    };

    let result;
    if (requiresHandoff) {
      result = handoffWorkItemToSession(store, {
        id: workItemId,
        owner: requestedOwner,
        assigneeKind: options.assigneeKind || 'agent',
        sessionId,
        status: options.status,
        metadata: { sessionBinding: binding }
      });
    } else if (previousSessionId) {
      result = rebindWorkItemToSession(store, {
        id: workItemId,
        previousSessionId,
        owner: requestedOwner,
        assigneeKind: options.assigneeKind || 'agent',
        sessionId,
        status: options.status,
        metadata: { sessionBinding: binding }
      });
    } else {
      result = claimWorkItem(store, {
        id: workItemId,
        owner,
        assigneeKind: options.assigneeKind || 'agent',
        sessionId,
        status: options.status,
        metadata: { sessionBinding: binding }
      });
    }
    if (!result.claimed) {
      throw bindingError(
        SESSION_BINDING_ERROR_CODES.WORK_ITEM_NOT_FOUND,
        `Work item ${workItemId} could not be claimed.`
      );
    }
    return { claimed: true, item: result.item, binding, previousItem: item };
  })();
}

function rollbackNativeSessionWorkItemBinding(store, { workItemId, sessionId, expectedItem, previousItem } = {}) {
  if (!store || typeof store.getWorkItemById !== 'function' || typeof store.upsertWorkItem !== 'function') {
    throw bindingError(SESSION_BINDING_ERROR_CODES.STORE_REQUIRED, 'A work-item store is required to roll back a session binding.');
  }
  if (!workItemId || !sessionId || !expectedItem || !previousItem) {
    throw new Error('Rollback requires workItemId, sessionId, expectedItem, and previousItem.');
  }

  return store._database.transaction(() => {
    const current = store.getWorkItemById(workItemId);
    const binding = current && current.metadata && current.metadata.sessionBinding;
    if (
      !current
      || current.sessionId !== sessionId
      || !binding
      || binding.sessionId !== sessionId
      || !isDeepStrictEqual(current, expectedItem)
    ) {
      return { rolledBack: false, item: current };
    }

    const item = store.upsertWorkItem({
      ...current,
      owner: previousItem.owner,
      status: previousItem.status,
      sessionId: previousItem.sessionId,
      metadata: previousItem.metadata,
      updatedAt: new Date().toISOString()
    });
    return { rolledBack: true, item };
  })();
}

module.exports = {
  DISPATCH_ACTIONS,
  NATIVE_SESSION_ADAPTER_ID,
  NATIVE_SESSION_MIRROR_MARKER,
  SESSION_BINDING_ERROR_CODES,
  bindWorkItemToNativeSession,
  rollbackNativeSessionWorkItemBinding,
  canonicalizePath,
  isSameRepository,
  resolveBindingSource
};
