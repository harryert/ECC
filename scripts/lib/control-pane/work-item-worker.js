'use strict';

const { parentPort, workerData } = require('worker_threads');
const { createStateStore } = require('../state-store');
const { recordCleanupError } = require('../state-store/file-lock');
const { claimWorkItem, moveWorkItem } = require('./work-item-mutations');
const { bindWorkItemToNativeSession } = require('./work-item-session-bridge');

/** Complete one board mutation away from the HTTP event loop, then close. */
async function mutate() {
  const { dbPath, action, args, sessionDbPath } = workerData;
  const mutation = action === 'claim' ? claimWorkItem : action === 'move' ? moveWorkItem : null;
  if (!mutation) throw new Error('Unknown work-item mutation');
  const store = await createStateStore({ dbPath });
  let result;
  let failed = false;
  let primary;
  try {
    if (action === 'claim' && args && args.sessionId) {
      // A claim that carries a native session id binds that session through
      // the public bridge, which resolves the session in the native registry
      // and fails closed on anything ambiguous.
      result = await bindWorkItemToNativeSession({
        store,
        workItemId: args.id,
        repoRoot: args.repoRoot,
        sessionId: args.sessionId,
        owner: args.owner,
        assigneeKind: args.assigneeKind,
        status: args.status,
        dispatchAction: args.dispatchAction,
        allowReusedIdle: args.allowReusedIdle === true,
        sessionDbPath
      });
    } else {
      result = store._database.transaction(() => mutation(store, args))();
    }
  } catch (error) { failed = true; primary = error; }
  try { store.close(); }
  catch (error) {
    if (failed) recordCleanupError(primary, 'closeError', error);
    else { failed = true; primary = error; }
  }
  if (failed) throw primary;
  return result;
}

function serializeError(error) {
  let message = 'Work-item mutation failed';
  let code;
  try {
    if (error && typeof error.message === 'string') message = error.message.slice(0, 1024);
    else if (error === null || typeof error !== 'object') message = String(error).slice(0, 1024);
  } catch (_error) { /* A throwing conversion must not prevent the failure response. */ }
  try {
    if (error && typeof error.code === 'string') code = error.code.slice(0, 128);
  } catch (_error) { /* Optional diagnostic. */ }
  return { message, code };
}

mutate().then(
  result => parentPort.postMessage({ ok: true, result }),
  error => parentPort.postMessage({ ok: false, error: serializeError(error) })
);
