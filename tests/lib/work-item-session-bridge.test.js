/**
 * Dispatch-boundary regression for the native session -> Work Items binding.
 *
 * The native session manager returns a registered session id after a
 * successful spawn. These tests pin the boundary behaviour: the binding only
 * happens for an explicit work item, an exact native session id and the
 * canonical repo root, and every other case fails closed.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const initSqlJs = require('sql.js');

const { createStateStore } = require('../../scripts/lib/state-store');
const {
  SESSION_BINDING_ERROR_CODES,
  bindWorkItemToNativeSession,
  rollbackNativeSessionWorkItemBinding
} = require('../../scripts/lib/control-pane/work-item-session-bridge');
const { claimWorkItem } = require('../../scripts/lib/control-pane/work-item-mutations');

const REPO_ROOT = path.join(__dirname, '..', '..');

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

const SESSIONS_TABLE_SQL = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    task_group TEXT NOT NULL DEFAULT '',
    agent_type TEXT NOT NULL,
    harness TEXT NOT NULL DEFAULT 'unknown',
    detected_harnesses_json TEXT NOT NULL DEFAULT '[]',
    working_dir TEXT NOT NULL DEFAULT '.',
    state TEXT NOT NULL DEFAULT 'pending',
    pid INTEGER,
    worktree_path TEXT,
    worktree_branch TEXT,
    worktree_base TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    tokens_used INTEGER DEFAULT 0,
    tool_calls INTEGER DEFAULT 0,
    files_changed INTEGER DEFAULT 0,
    duration_secs INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0.0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL
  );
`;

/** Write a native session registry that mirrors the ECC2 sessions table. */
async function writeNativeRegistry(dbPath, sessions) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(SESSIONS_TABLE_SQL);
  for (const session of sessions) {
    db.run(
      `INSERT INTO sessions (
        id, task, project, task_group, agent_type, harness, detected_harnesses_json,
        working_dir, state, pid, worktree_path, worktree_branch, worktree_base,
        created_at, updated_at, last_heartbeat_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.task || 'dispatch a delegate',
        session.project || '',
        session.taskGroup || '',
        session.agentType || 'claude',
        session.harness || 'claude',
        '["claude"]',
        session.workingDir || REPO_ROOT,
        session.state || 'pending',
        session.pid === undefined ? null : session.pid,
        session.worktreePath || null,
        session.worktreeBranch || null,
        session.worktreeBase || null,
        '2026-11-01T00:00:00Z',
        '2026-11-01T00:00:01Z',
        '2026-11-01T00:00:01Z'
      ]
    );
  }
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

async function createStore() {
  return createStateStore({ dbPath: ':memory:' });
}

function seedWorkItem(store, overrides = {}) {
  return store.upsertWorkItem({
    id: 'wi-bridge',
    source: 'manual',
    sourceId: null,
    title: 'Bind the dispatched session',
    status: 'open',
    priority: 'normal',
    url: null,
    owner: null,
    repoRoot: REPO_ROOT,
    sessionId: null,
    metadata: {},
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides
  });
}

function createOtherRepository() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-other-repo-'));
  execFileSync('git', ['init', '--quiet', dir], { stdio: 'ignore' });
  return dir;
}

async function expectBindingError(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.strictEqual(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`expected the binding to fail with ${code}`);
}

async function runTests() {
  console.log('\n=== Testing native session -> Work Items binding ===\n');

  let passed = 0;
  let failed = 0;
  const tempDirs = [];

  if (
    await test('remote dispatch preserves explicit Work Item IDs and claims before runner start', () => {
      const manager = fs.readFileSync(path.join(REPO_ROOT, 'ecc2/src/session/manager.rs'), 'utf8');
      const main = fs.readFileSync(path.join(REPO_ROOT, 'ecc2/src/main.rs'), 'utf8');
      const store = fs.readFileSync(path.join(REPO_ROOT, 'ecc2/src/session/store.rs'), 'utf8');
      const queueStart = manager.indexOf('async fn queue_session_with_resolved_profile_and_runner_program(');
      const queueEnd = manager.indexOf('async fn create_session_in_dir(', queueStart);
      const queue = manager.slice(queueStart, queueEnd);
      const repositoryCheckStart = manager.indexOf('async fn belongs_to_same_repository(');
      const repositoryCheckEnd = manager.indexOf('\n}', repositoryCheckStart) + 2;
      const repositoryCheck = manager.slice(repositoryCheckStart, repositoryCheckEnd);

      assert.match(main, /work_item_id: Option<String>/);
      assert.match(main, /RemoteCommands::Add\s*\{[\s\S]*?work_item_id,/);
      assert.match(main, /payload\.work_item_id\.as_deref\(\)/);
      assert.match(store, /work_item_id TEXT/);
      assert.match(store, /work_item_id, source/);
      assert.match(manager, /request\.work_item_id\.as_deref\(\)/);
      assert.match(manager, /insert_remote_dispatch_request_with_work_item/);
      assert.match(repositoryCheck, /canonical_git_common_dir\(session_root\)\.await\?\s*==\s*canonical_git_common_dir\(intake_root\)\.await\?/);
      assert.match(queue, /belongs_to_same_repository\(&registered_root,\s*&intake_root\)\.await\?/);
      assert.match(queue, /bind_work_item_to_native_session\([\s\S]*?&registered_session\.id,\s*&intake_root,\s*&cfg\.db_path,/);
      assert.ok(queue.indexOf('bind_work_item_to_native_session(') < queue.indexOf('spawn_session_runner_for_program('));
      assert.match(queue, /registered_session\.id/);
      assert.match(queue, /repo_root/);
      assert.match(queue, /let cleanup_error = db\.update_state\(&session\.id, &SessionState::Failed\)\.err\(\);/);
      assert.match(queue, /Additionally failed to mark session \{\} as failed: \{cleanup_error\}/);
      assert.match(queue, /SessionState::Failed/);
      assert.match(queue, /rollback_work_item_native_session_binding\([\s\S]*?&session\.id,[\s\S]*?previous_item/);
    })
  )
    passed++;
  else failed++;

  if (
    await test('native binding resolves the supported ECC CLI outside the target repo', () => {
      const manager = fs.readFileSync(path.join(REPO_ROOT, 'ecc2/src/session/manager.rs'), 'utf8');
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-pace-target-'));
      tempDirs.push(targetRoot);
      const targetCli = path.join(targetRoot, 'scripts', 'work-items.js');
      const supportedCli = path.join(REPO_ROOT, 'scripts', 'work-items.js');
      const bindingStart = manager.indexOf('pub async fn bind_work_item_to_native_session(');
      const bindingEnd = manager.indexOf('\nfn work_item_binding_args(', bindingStart);
      const binding = manager.slice(bindingStart, bindingEnd);
      const argsStart = manager.indexOf('fn work_item_binding_args(');
      const argsEnd = manager.indexOf('\n}', argsStart) + 2;
      const argsBuilder = manager.slice(argsStart, argsEnd);

      assert.ok(fs.existsSync(supportedCli), 'the ECC installation provides the Work Item CLI');
      assert.ok(!fs.existsSync(targetCli), 'the Pace target has no scripts/work-items.js');
      assert.match(binding, /resolve_ecc_plugin_root\(\)/);
      assert.match(binding, /ecc_root\.join\("scripts\/work-items\.js"\)/);
      assert.doesNotMatch(binding, /repo_root\.join\("scripts\/work-items\.js"\)/);
      assert.match(binding, /&repo_root,\s*session_db_path/);
      assert.match(argsBuilder, /work_item_id: &str/);
      assert.match(argsBuilder, /"claim"\.to_string\(\),\s*work_item_id\.to_string\(\)/);
      assert.match(argsBuilder, /"--repo-root"\.to_string\(\),\s*repo_root\.display\(\)/);
      assert.match(argsBuilder, /"--session-id"\.to_string\(\),\s*session_id\.to_string\(\)/);
      assert.doesNotMatch(argsBuilder, /list|prompt|infer/i);
    })
  )
    passed++;
  else failed++;

  if (
    await test('binds a spawned native session to an explicit work item', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [{ id: 'session-a', state: 'pending' }]);
      const store = await createStore();
      try {
        seedWorkItem(store);
        const result = await bindWorkItemToNativeSession({
          store,
          workItemId: 'wi-bridge',
          repoRoot: REPO_ROOT,
          sessionId: 'session-a',
          sessionDbPath: registryPath,
          dispatchAction: 'spawned'
        });

        assert.strictEqual(result.claimed, true);
        assert.strictEqual(result.item.sessionId, 'session-a');
        assert.strictEqual(result.binding.sessionId, 'session-a');
        assert.strictEqual(result.binding.bindingSource, 'spawned');
        assert.strictEqual(result.binding.repoRoot, fs.realpathSync(REPO_ROOT));
        assert.strictEqual(result.item.metadata.sessionBinding.sessionId, 'session-a');
        assert.strictEqual(result.item.metadata.assigneeKind, 'agent');

        const mirrored = store.getSessionById('session-a');
        assert.ok(mirrored, 'the verified native session is mirrored into the session registry');
        assert.strictEqual(mirrored.adapterId, 'ecc2-native');
        assert.strictEqual(mirrored.snapshot.nativeSessionId, 'session-a');
      } finally {
        store.close();
      }
    })
  )
    passed++;
  else failed++;

  if (
    await test('requires an explicit work item id', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [{ id: 'session-a', state: 'running' }]);
      const store = await createStore();
      try {
        seedWorkItem(store);
        await expectBindingError(
          bindWorkItemToNativeSession({
            store,
            repoRoot: REPO_ROOT,
            sessionId: 'session-a',
            sessionDbPath: registryPath
          }),
          SESSION_BINDING_ERROR_CODES.WORK_ITEM_ID_REQUIRED
        );
      } finally {
        store.close();
      }
    })
  )
    passed++;
  else failed++;

  if (
    await test('fails closed when no native session matches', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [{ id: 'session-a', state: 'running' }]);
      const store = await createStore();
      try {
        seedWorkItem(store);
        await expectBindingError(
          bindWorkItemToNativeSession({
            store,
            workItemId: 'wi-bridge',
            repoRoot: REPO_ROOT,
            sessionId: 'session-z',
            sessionDbPath: registryPath
          }),
          SESSION_BINDING_ERROR_CODES.SESSION_NOT_FOUND
        );
      } finally {
        store.close();
      }
    })
  )
    passed++;
  else failed++;

  if (
    await test('never binds a session that only exists in the local session table', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [{ id: 'session-a', state: 'running' }]);
      const store = await createStore();
      try {
        seedWorkItem(store);
        store.upsertSession({
          id: 'ghost-session',
          adapterId: 'ecc2-native',
          harness: 'claude',
          state: 'running',
          repoRoot: REPO_ROOT,
          startedAt: '2026-11-01T00:00:00Z',
          endedAt: null,
          snapshot: { mirroredFrom: 'ecc2-native-session', nativeSessionId: 'ghost-session' }
        });
        await expectBindingError(
          bindWorkItemToNativeSession({
            store,
            workItemId: 'wi-bridge',
            repoRoot: REPO_ROOT,
            sessionId: 'ghost-session',
            sessionDbPath: registryPath
          }),
          SESSION_BINDING_ERROR_CODES.SESSION_NOT_FOUND
        );
        assert.strictEqual(store.getWorkItemById('wi-bridge').sessionId, null);
      } finally {
        store.close();
      }
    })
  )
    passed++;
  else failed++;

  if (
    await test('fails closed on an ambiguous native session id', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [{ id: 'session-a', state: 'running' }]);
      const store = await createStore();
      try {
        seedWorkItem(store);
        const error = await expectBindingError(
          bindWorkItemToNativeSession(
            {
              store,
              workItemId: 'wi-bridge',
              repoRoot: REPO_ROOT,
              sessionId: 'session-a',
              sessionDbPath: registryPath
            },
            {
              resolveNativeSession: async () => ({
                session: { id: 'session-a', state: 'running', workingDir: REPO_ROOT },
                matches: [{ id: 'session-a' }, { id: 'session-a' }]
              })
            }
          ),
          SESSION_BINDING_ERROR_CODES.SESSION_AMBIGUOUS
        );
        assert.match(error.message, /matches 2 registered sessions/);
      } finally {
        store.close();
      }
    })
  )
    passed++;
  else failed++;

  if (
    await test('fails closed when the session belongs to another repository', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const otherRepo = createOtherRepository();
      tempDirs.push(otherRepo);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [
        { id: 'session-a', state: 'running', workingDir: otherRepo }
      ]);
      const store = await createStore();
      try {
        seedWorkItem(store);
        await expectBindingError(
          bindWorkItemToNativeSession({
            store,
            workItemId: 'wi-bridge',
            repoRoot: REPO_ROOT,
            sessionId: 'session-a',
            sessionDbPath: registryPath
          }),
          SESSION_BINDING_ERROR_CODES.SESSION_UNRELATED
        );
      } finally {
        store.close();
      }
    })
  )
    passed++;
  else failed++;

  if (
    await test('fails closed when the work item is registered under another repo root', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const otherRepo = createOtherRepository();
      tempDirs.push(otherRepo);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [{ id: 'session-a', state: 'running' }]);
      const store = await createStore();
      try {
        seedWorkItem(store, { repoRoot: otherRepo });
        await expectBindingError(
          bindWorkItemToNativeSession({
            store,
            workItemId: 'wi-bridge',
            repoRoot: REPO_ROOT,
            sessionId: 'session-a',
            sessionDbPath: registryPath
          }),
          SESSION_BINDING_ERROR_CODES.REPO_ROOT_MISMATCH
        );
      } finally {
        store.close();
      }
    })
  )
    passed++;
  else failed++;

  if (
    await test('fails closed on a failed spawn', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [{ id: 'session-a', state: 'failed' }]);
      const store = await createStore();
      try {
        seedWorkItem(store);
        await expectBindingError(
          bindWorkItemToNativeSession({
            store,
            workItemId: 'wi-bridge',
            repoRoot: REPO_ROOT,
            sessionId: 'session-a',
            sessionDbPath: registryPath
          }),
          SESSION_BINDING_ERROR_CODES.SESSION_FAILED
        );
        assert.strictEqual(store.getWorkItemById('wi-bridge').sessionId, null);
      } finally {
        store.close();
      }
    })
  )
    passed++;
  else failed++;

  if (
    await test('fails closed on a busy session', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [{ id: 'session-a', state: 'completed' }]);
      const store = await createStore();
      try {
        seedWorkItem(store);
        await expectBindingError(
          bindWorkItemToNativeSession({
            store,
            workItemId: 'wi-bridge',
            repoRoot: REPO_ROOT,
            sessionId: 'session-a',
            sessionDbPath: registryPath
          }),
          SESSION_BINDING_ERROR_CODES.SESSION_BUSY
        );
      } finally {
        store.close();
      }
    })
  )
    passed++;
  else failed++;

  if (
    await test('fails closed on a deferred dispatch', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [{ id: 'session-a', state: 'running' }]);
      const store = await createStore();
      try {
        seedWorkItem(store);
        await expectBindingError(
          bindWorkItemToNativeSession({
            store,
            workItemId: 'wi-bridge',
            repoRoot: REPO_ROOT,
            sessionId: 'session-a',
            sessionDbPath: registryPath,
            dispatchAction: 'deferred_saturated'
          }),
          SESSION_BINDING_ERROR_CODES.DISPATCH_DEFERRED
        );
      } finally {
        store.close();
      }
    })
  )
    passed++;
  else failed++;

  if (
    await test('binds a reused idle delegate only when it is declared', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [{ id: 'session-a', state: 'idle' }]);
      const store = await createStore();
      try {
        seedWorkItem(store);
        await expectBindingError(
          bindWorkItemToNativeSession({
            store,
            workItemId: 'wi-bridge',
            repoRoot: REPO_ROOT,
            sessionId: 'session-a',
            sessionDbPath: registryPath
          }),
          SESSION_BINDING_ERROR_CODES.SESSION_REUSED_IDLE
        );
        await expectBindingError(
          bindWorkItemToNativeSession({
            store,
            workItemId: 'wi-bridge',
            repoRoot: REPO_ROOT,
            sessionId: 'session-a',
            sessionDbPath: registryPath,
            dispatchAction: 'reused_idle'
          }),
          SESSION_BINDING_ERROR_CODES.SESSION_REUSED_IDLE
        );
        const result = await bindWorkItemToNativeSession({
          store,
          workItemId: 'wi-bridge',
          repoRoot: REPO_ROOT,
          sessionId: 'session-a',
          sessionDbPath: registryPath,
          dispatchAction: 'reused_idle',
          allowReusedIdle: true
        });
        assert.strictEqual(result.binding.bindingSource, 'reused_idle');
        assert.strictEqual(result.item.sessionId, 'session-a');
      } finally {
        store.close();
      }
    })
  )
    passed++;
  else failed++;

  if (
    await test('fails closed when the session already serves another open work item', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [{ id: 'session-a', state: 'running' }]);
      const store = await createStore();
      try {
        seedWorkItem(store);
        seedWorkItem(store, { id: 'wi-other' });
        store.upsertSession({
          id: 'session-a',
          adapterId: 'ecc2-native',
          harness: 'claude',
          state: 'running',
          repoRoot: REPO_ROOT,
          startedAt: '2026-11-01T00:00:00Z',
          endedAt: null,
          snapshot: { mirroredFrom: 'ecc2-native-session', nativeSessionId: 'session-a' }
        });
        store.upsertWorkItem({
          ...store.getWorkItemById('wi-other'),
          owner: 'agent-1',
          sessionId: 'session-a',
          status: 'running',
          updatedAt: '2026-11-01T00:00:00.000Z'
        });
        await expectBindingError(
          bindWorkItemToNativeSession({
            store,
            workItemId: 'wi-bridge',
            repoRoot: REPO_ROOT,
            sessionId: 'session-a',
            sessionDbPath: registryPath
          }),
          SESSION_BINDING_ERROR_CODES.SESSION_ALREADY_BOUND
        );
      } finally {
        store.close();
      }
    })
  )
    passed++;
  else failed++;

  if (
    await test('fails closed when the work item is already bound to another session', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [
        { id: 'session-a', state: 'running' },
        { id: 'session-b', state: 'running' }
      ]);
      const store = await createStore();
      try {
        seedWorkItem(store);
        store.upsertSession({
          id: 'session-b',
          adapterId: 'ecc2-native',
          harness: 'claude',
          state: 'running',
          repoRoot: REPO_ROOT,
          startedAt: '2026-11-01T00:00:00Z',
          endedAt: null,
          snapshot: { mirroredFrom: 'ecc2-native-session', nativeSessionId: 'session-b' }
        });
        store.upsertWorkItem({
          ...store.getWorkItemById('wi-bridge'),
          owner: 'agent-1',
          sessionId: 'session-b',
          status: 'running',
          updatedAt: '2026-11-01T00:00:00.000Z'
        });
        await expectBindingError(
          bindWorkItemToNativeSession({
            store,
            workItemId: 'wi-bridge',
            repoRoot: REPO_ROOT,
            sessionId: 'session-a',
            sessionDbPath: registryPath
          }),
          SESSION_BINDING_ERROR_CODES.SESSION_BUSY
        );
      } finally {
        store.close();
      }
    })
  )
    passed++;
  else failed++;

  if (
    await test('rolls back a successful binding after spawn failure and preserves later writer state', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [{ id: 'session-a', state: 'pending' }]);
      const store = await createStore();
      try {
        const original = seedWorkItem(store, { owner: 'previous-owner', status: 'open' });
        const result = await bindWorkItemToNativeSession({
          store,
          workItemId: original.id,
          repoRoot: REPO_ROOT,
          sessionId: 'session-a',
          sessionDbPath: registryPath
        });
        const rolledBack = rollbackNativeSessionWorkItemBinding(store, {
          workItemId: original.id,
          sessionId: 'session-a',
          expectedItem: result.item,
          previousItem: result.previousItem
        });
        assert.strictEqual(rolledBack.rolledBack, true);
        assert.strictEqual(rolledBack.item.owner, 'previous-owner');
        assert.strictEqual(rolledBack.item.status, 'open');
        assert.strictEqual(rolledBack.item.sessionId, null);
        assert.deepStrictEqual(rolledBack.item.metadata, {});

        const bound = await bindWorkItemToNativeSession({
          store,
          workItemId: original.id,
          repoRoot: REPO_ROOT,
          sessionId: 'session-a',
          sessionDbPath: registryPath
        });
        const changed = store.upsertWorkItem({
          ...store.getWorkItemById(original.id),
          owner: 'other-writer',
          status: 'blocked',
          updatedAt: '2099-01-01T00:00:00.000Z'
        });
        const skipped = rollbackNativeSessionWorkItemBinding(store, {
          workItemId: original.id,
          sessionId: 'session-a',
          expectedItem: bound.item,
          previousItem: bound.previousItem
        });
        assert.strictEqual(skipped.rolledBack, false);
        assert.deepStrictEqual(skipped.item, changed);
      } finally {
        store.close();
      }
    })
  ) passed++;
  else failed++;

  if (
    await test('hands an owned work item over to the explicitly requested native session', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [{ id: 'session-a', state: 'running' }]);
      const store = await createStore();
      try {
        const original = seedWorkItem(store, {
          owner: 'pace-g0-supervisor',
          status: 'in-progress',
          metadata: { source: 'pace' }
        });
        const result = await bindWorkItemToNativeSession({
          store,
          workItemId: original.id,
          repoRoot: REPO_ROOT,
          sessionId: 'session-a',
          owner: 'session-a',
          sessionDbPath: registryPath
        });

        assert.strictEqual(result.claimed, true);
        assert.strictEqual(result.item.owner, 'session-a');
        assert.strictEqual(result.item.sessionId, 'session-a');
        assert.strictEqual(result.item.status, 'in-progress');
        assert.strictEqual(result.binding.handoff, true);
        assert.strictEqual(result.binding.previousOwner, 'pace-g0-supervisor');
        assert.strictEqual(result.item.metadata.sessionBinding.previousOwner, 'pace-g0-supervisor');
        assert.strictEqual(result.item.metadata.assigneeKind, 'agent');

        assert.strictEqual(result.previousItem.owner, 'pace-g0-supervisor');
        assert.strictEqual(result.previousItem.status, 'in-progress');
        assert.strictEqual(result.previousItem.sessionId, null);
        assert.deepStrictEqual(result.previousItem.metadata, { source: 'pace' });
      } finally {
        store.close();
      }
    })
  )
    passed++;
  else failed++;

  if (
    await test('refuses a generic owner replacement for an owned work item', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [{ id: 'session-a', state: 'running' }]);
      const store = await createStore();
      try {
        const original = seedWorkItem(store, {
          owner: 'pace-g0-supervisor',
          status: 'in-progress'
        });

        assert.throws(
          () => claimWorkItem(store, { id: original.id, owner: 'agent-2', sessionId: 'session-a' }),
          /already owned by pace-g0-supervisor/
        );
        await expectBindingError(
          bindWorkItemToNativeSession({
            store,
            workItemId: original.id,
            repoRoot: REPO_ROOT,
            sessionId: 'session-a',
            owner: 'agent-2',
            sessionDbPath: registryPath
          }),
          SESSION_BINDING_ERROR_CODES.WORK_ITEM_OWNER_CONFLICT
        );

        const item = store.getWorkItemById(original.id);
        assert.strictEqual(item.owner, 'pace-g0-supervisor');
        assert.strictEqual(item.sessionId, null);
      } finally {
        store.close();
      }
    })
  )
    passed++;
  else failed++;

  if (
    await test('refuses a handoff for a terminal card or a card bound to a session', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [{ id: 'session-a', state: 'running' }]);
      const store = await createStore();
      try {
        for (const sessionId of ['session-a', 'session-b']) {
          store.upsertSession({
            id: sessionId,
            adapterId: 'ecc2-native',
            harness: 'claude',
            state: 'running',
            repoRoot: REPO_ROOT,
            startedAt: '2026-11-01T00:00:00Z',
            endedAt: null,
            snapshot: { mirroredFrom: 'ecc2-native-session', nativeSessionId: sessionId }
          });
        }
        seedWorkItem(store, {
          id: 'wi-terminal',
          owner: 'pace-g0-supervisor',
          status: 'done'
        });
        seedWorkItem(store, {
          id: 'wi-blocked',
          owner: 'pace-g0-supervisor',
          status: 'blocked'
        });
        seedWorkItem(store, {
          id: 'wi-bound-elsewhere',
          owner: 'pace-g0-supervisor',
          status: 'in-progress',
          sessionId: 'session-b'
        });
        seedWorkItem(store, {
          id: 'wi-bound-here',
          owner: 'pace-g0-supervisor',
          status: 'in-progress',
          sessionId: 'session-a'
        });

        for (const id of ['wi-terminal', 'wi-blocked']) {
          await expectBindingError(
            bindWorkItemToNativeSession({
              store,
              workItemId: id,
              repoRoot: REPO_ROOT,
              sessionId: 'session-a',
              owner: 'session-a',
              sessionDbPath: registryPath
            }),
            SESSION_BINDING_ERROR_CODES.WORK_ITEM_STATUS_INVALID
          );
        }
        for (const id of ['wi-bound-elsewhere', 'wi-bound-here']) {
          await expectBindingError(
            bindWorkItemToNativeSession({
              store,
              workItemId: id,
              repoRoot: REPO_ROOT,
              sessionId: 'session-a',
              owner: 'session-a',
              sessionDbPath: registryPath
            }),
            id === 'wi-bound-elsewhere'
              ? SESSION_BINDING_ERROR_CODES.SESSION_NOT_FOUND
              : SESSION_BINDING_ERROR_CODES.WORK_ITEM_ALREADY_BOUND
          );
        }

        assert.strictEqual(store.getWorkItemById('wi-terminal').sessionId, null);
        assert.strictEqual(store.getWorkItemById('wi-blocked').sessionId, null);
        assert.strictEqual(store.getWorkItemById('wi-bound-elsewhere').owner, 'pace-g0-supervisor');
        assert.strictEqual(store.getWorkItemById('wi-bound-here').owner, 'pace-g0-supervisor');
      } finally {
        store.close();
      }
    })
  )
    passed++;
  else failed++;

  if (
    await test('rolls a handoff back to the previous owner and keeps a later writer', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [{ id: 'session-a', state: 'pending' }]);
      const store = await createStore();
      try {
        const original = seedWorkItem(store, {
          owner: 'pace-g0-supervisor',
          status: 'in-progress',
          metadata: { source: 'pace' }
        });
        const result = await bindWorkItemToNativeSession({
          store,
          workItemId: original.id,
          repoRoot: REPO_ROOT,
          sessionId: 'session-a',
          owner: 'session-a',
          sessionDbPath: registryPath
        });
        const rolledBack = rollbackNativeSessionWorkItemBinding(store, {
          workItemId: original.id,
          sessionId: 'session-a',
          expectedItem: result.item,
          previousItem: result.previousItem
        });
        assert.strictEqual(rolledBack.rolledBack, true);
        assert.strictEqual(rolledBack.item.owner, 'pace-g0-supervisor');
        assert.strictEqual(rolledBack.item.status, 'in-progress');
        assert.strictEqual(rolledBack.item.sessionId, null);
        assert.deepStrictEqual(rolledBack.item.metadata, { source: 'pace' });

        const rebound = await bindWorkItemToNativeSession({
          store,
          workItemId: original.id,
          repoRoot: REPO_ROOT,
          sessionId: 'session-a',
          owner: 'session-a',
          sessionDbPath: registryPath
        });
        const changed = store.upsertWorkItem({
          ...store.getWorkItemById(original.id),
          owner: 'other-writer',
          status: 'blocked',
          metadata: { source: 'pace', note: 'later writer' },
          updatedAt: '2099-01-01T00:00:00.000Z'
        });
        const skipped = rollbackNativeSessionWorkItemBinding(store, {
          workItemId: original.id,
          sessionId: 'session-a',
          expectedItem: rebound.item,
          previousItem: rebound.previousItem
        });
        assert.strictEqual(skipped.rolledBack, false);
        assert.deepStrictEqual(skipped.item, changed);
      } finally {
        store.close();
      }
    })
  )
    passed++;
  else failed++;

  if (
    await test('finds a session conflict beyond the newest 1000 work items', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [{ id: 'session-a', state: 'running' }]);
      const store = await createStore();
      try {
        seedWorkItem(store);
        store.upsertSession({
          id: 'session-a',
          adapterId: 'ecc2-native',
          harness: 'claude',
          state: 'running',
          repoRoot: REPO_ROOT,
          startedAt: '2026-11-01T00:00:00Z',
          endedAt: null,
          snapshot: { mirroredFrom: 'ecc2-native-session', nativeSessionId: 'session-a' }
        });
        store.upsertWorkItem({
          id: 'wi-old-session-conflict',
          source: 'manual',
          title: 'Older session conflict',
          status: 'running',
          owner: 'agent-1',
          sessionId: 'session-a',
          updatedAt: '2000-01-01T00:00:00.000Z'
        });
        for (let index = 0; index < 1001; index += 1) {
          store.upsertWorkItem({
            id: `wi-newer-${index}`,
            source: 'manual',
            title: `Unrelated item ${index}`,
            status: 'open',
            owner: null,
            sessionId: null,
            updatedAt: '2099-01-01T00:00:00.000Z'
          });
        }
        await expectBindingError(
          bindWorkItemToNativeSession({
            store,
            workItemId: 'wi-bridge',
            repoRoot: REPO_ROOT,
            sessionId: 'session-a',
            sessionDbPath: registryPath
          }),
          SESSION_BINDING_ERROR_CODES.SESSION_ALREADY_BOUND
        );
      } finally {
        store.close();
      }
    })
  ) passed++;
  else failed++;

  if (
    await test('rebinds only after the exact prior native session is terminal and preserves its record', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      await writeNativeRegistry(registryPath, [
        { id: 'session-old', state: 'completed' },
        { id: 'session-new', state: 'running' }
      ]);
      const store = await createStore();
      try {
        store.upsertSession({
          id: 'session-old', adapterId: 'ecc2-native', harness: 'claude', state: 'completed',
          repoRoot: REPO_ROOT, startedAt: '2026-11-01T00:00:00Z', endedAt: '2026-11-01T00:00:01Z',
          snapshot: { mirroredFrom: 'ecc2-native-session', nativeSessionId: 'session-old' }
        });
        const original = seedWorkItem(store, {
          owner: 'agent-1',
          status: 'running',
          sessionId: 'session-old',
          metadata: { source: 'pace', retained: true }
        });
        const result = await bindWorkItemToNativeSession({
          store, workItemId: original.id, repoRoot: REPO_ROOT,
          sessionId: 'session-new', owner: 'session-new', sessionDbPath: registryPath
        });

        assert.strictEqual(result.item.id, original.id);
        assert.strictEqual(result.item.sessionId, 'session-new');
        assert.strictEqual(result.item.owner, 'session-new');
        assert.strictEqual(result.binding.handoff, false);
        assert.deepStrictEqual(result.item.metadata.source, 'pace');
        assert.strictEqual(result.binding.previousSessionId, 'session-old');
        assert.strictEqual(store.getSessionById('session-old').state, 'completed');
        assert.strictEqual(store.getSessionById('session-new').state, 'running');

        const rolledBack = rollbackNativeSessionWorkItemBinding(store, {
          workItemId: original.id,
          sessionId: 'session-new',
          expectedItem: result.item,
          previousItem: result.previousItem
        });
        assert.strictEqual(rolledBack.rolledBack, true);
        assert.strictEqual(rolledBack.item.sessionId, 'session-old');
        assert.deepStrictEqual(rolledBack.item.metadata, original.metadata);
      } finally {
        store.close();
      }
    })
  ) passed++;
  else failed++;

  if (
    await test('rejects rebinds unless the exact prior session is authoritatively terminal', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const store = await createStore();
      try {
        for (const [name, registrySessions, expected] of [
          ['active', [{ id: 'session-old', state: 'running' }, { id: 'session-new', state: 'running' }], SESSION_BINDING_ERROR_CODES.SESSION_BUSY],
          ['unknown', [{ id: 'session-old', state: 'mystery' }, { id: 'session-new', state: 'running' }], SESSION_BINDING_ERROR_CODES.SESSION_BUSY],
          ['missing', [{ id: 'session-new', state: 'running' }], SESSION_BINDING_ERROR_CODES.SESSION_NOT_FOUND]
        ]) {
          const registryPath = path.join(tempDir, `${name}.db`);
          await writeNativeRegistry(registryPath, registrySessions);
          store.upsertSession({
            id: 'session-old', adapterId: 'ecc2-native', harness: 'claude', state: 'completed',
            repoRoot: REPO_ROOT, startedAt: '2026-11-01T00:00:00Z', endedAt: '2026-11-01T00:00:01Z',
            snapshot: { mirroredFrom: 'ecc2-native-session', nativeSessionId: 'session-old' }
          });
          seedWorkItem(store, {
            id: `wi-${name}`, owner: 'agent-1', status: 'running',
            sessionId: 'session-old', metadata: { preserve: name }
          });
          await expectBindingError(bindWorkItemToNativeSession({
            store, workItemId: `wi-${name}`, repoRoot: REPO_ROOT,
            sessionId: 'session-new', sessionDbPath: registryPath
          }), expected);
          assert.strictEqual(store.getWorkItemById(`wi-${name}`).sessionId, 'session-old');
        }
      } finally {
        store.close();
      }
    })
  ) passed++;
  else failed++;

  if (
    await test('rejects a predecessor from another repository or an ambiguous predecessor id', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-bridge-'));
      tempDirs.push(tempDir);
      const registryPath = path.join(tempDir, 'ecc2.db');
      const otherRepo = createOtherRepository();
      tempDirs.push(otherRepo);
      await writeNativeRegistry(registryPath, [
        { id: 'session-old', state: 'completed', workingDir: otherRepo },
        { id: 'session-new', state: 'running' }
      ]);
      const store = await createStore();
      try {
        store.upsertSession({
          id: 'session-old', adapterId: 'ecc2-native', harness: 'claude', state: 'completed',
          repoRoot: otherRepo, startedAt: '2026-11-01T00:00:00Z', endedAt: '2026-11-01T00:00:01Z',
          snapshot: { mirroredFrom: 'ecc2-native-session', nativeSessionId: 'session-old' }
        });
        for (const id of ['wi-mismatched-predecessor', 'wi-ambiguous-predecessor']) {
          seedWorkItem(store, {
            id, owner: 'agent-1', status: 'running', sessionId: 'session-old', metadata: { keep: true }
          });
        }
        await expectBindingError(bindWorkItemToNativeSession({
          store, workItemId: 'wi-mismatched-predecessor', repoRoot: REPO_ROOT,
          sessionId: 'session-new', sessionDbPath: registryPath
        }), SESSION_BINDING_ERROR_CODES.SESSION_UNRELATED);

        await expectBindingError(bindWorkItemToNativeSession({
          store, workItemId: 'wi-ambiguous-predecessor', repoRoot: REPO_ROOT,
          sessionId: 'session-new', sessionDbPath: registryPath
        }, {
          resolveNativeSession: async (_dbPath, sessionId) => sessionId === 'session-old'
            ? { matches: [{ id: sessionId }, { id: sessionId }] }
            : { session: { id: sessionId, state: 'running', workingDir: REPO_ROOT }, matches: [{ id: sessionId }] }
        }), SESSION_BINDING_ERROR_CODES.SESSION_AMBIGUOUS);

        assert.strictEqual(store.getWorkItemById('wi-mismatched-predecessor').sessionId, 'session-old');
        assert.strictEqual(store.getWorkItemById('wi-ambiguous-predecessor').sessionId, 'session-old');
      } finally {
        store.close();
      }
    })
  ) passed++;
  else failed++;

  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
