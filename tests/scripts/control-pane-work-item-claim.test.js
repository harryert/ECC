/**
 * Public API test for the native session -> Work Items claim binding.
 *
 * The control-pane HTTP API is the supported public surface for the JIT
 * board. This test drives `POST /api/work-items/:id/claim` with a native
 * session id and checks that the binding lands in the work-item mirror, and
 * that an unknown or unrelated session is rejected instead of guessed.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const initSqlJs = require('sql.js');

const { createStateStore } = require('../../scripts/lib/state-store');
const { createControlPaneServer } = require('../../scripts/lib/control-pane/server');

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

async function writeNativeRegistry(dbPath, sessions) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
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
  `);
  for (const session of sessions) {
    db.run(
      `INSERT INTO sessions (
        id, task, project, task_group, agent_type, harness, detected_harnesses_json,
        working_dir, state, created_at, updated_at, last_heartbeat_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        'dispatch a delegate',
        '',
        '',
        'claude',
        'claude',
        '["claude"]',
        session.workingDir || REPO_ROOT,
        session.state || 'running',
        '2026-11-01T00:00:00Z',
        '2026-11-01T00:00:01Z',
        '2026-11-01T00:00:01Z'
      ]
    );
  }
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

async function writeStateStore(stateDbPath, workItems) {
  const store = await createStateStore({ dbPath: stateDbPath });
  try {
    for (const item of workItems) {
      if (item.sessionId) {
        store.upsertSession({
          id: item.sessionId,
          adapterId: 'ecc2-native',
          harness: 'claude',
          state: item.sessionState || 'completed',
          repoRoot: item.repoRoot || REPO_ROOT,
          startedAt: '2026-11-01T00:00:00Z',
          endedAt: '2026-11-01T00:00:01Z',
          snapshot: { mirroredFrom: 'ecc2-native-session', nativeSessionId: item.sessionId }
        });
      }
      store.upsertWorkItem({
        id: item.id,
        source: 'manual',
        sourceId: null,
        title: item.title || 'Public API work item',
        status: item.status || 'open',
        priority: 'normal',
        url: null,
        owner: item.owner || null,
        repoRoot: item.repoRoot || REPO_ROOT,
        sessionId: item.sessionId || null,
        metadata: item.metadata || {},
        updatedAt: '2026-11-01T00:00:00.000Z'
      });
    }
  } finally {
    store.close();
  }
}

async function postClaim(url, id, body) {
  const response = await fetch(`${url}/api/work-items/${encodeURIComponent(id)}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, payload: await response.json() };
}

async function runTests() {
  console.log('\n=== Testing control-pane session claim API ===\n');

  let passed = 0;
  let failed = 0;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-claim-api-'));
  const dbPath = path.join(tempDir, 'ecc2.db');
  const stateDbPath = path.join(tempDir, 'state.db');
  let app = null;

  try {
    await writeNativeRegistry(dbPath, [{ id: 'session-a', state: 'running' }]);
    await writeStateStore(stateDbPath, [{ id: 'wi-api' }]);

    app = await createControlPaneServer({
      repoRoot: REPO_ROOT,
      dbPath,
      stateDbPath,
      host: '127.0.0.1',
      port: 0,
      allowActions: true
    }).listen();
    const url = app.url;

    if (
      await test('claims a work item with a registered native session', async () => {
        const { status, payload } = await postClaim(url, 'wi-api', {
          owner: 'agent-1',
          as: 'agent',
          sessionId: 'session-a',
          repoRoot: REPO_ROOT,
          dispatchAction: 'spawned'
        });

        assert.strictEqual(status, 200);
        assert.strictEqual(payload.ok, true);
        assert.strictEqual(payload.item.sessionId, 'session-a');
        assert.strictEqual(payload.item.owner, 'agent-1');
        assert.strictEqual(payload.item.metadata.sessionBinding.sessionId, 'session-a');
        assert.strictEqual(payload.item.metadata.sessionBinding.bindingSource, 'spawned');
      })
    )
      passed++;
    else failed++;

    if (
      await test('shows the bound session in the work-item mirror', async () => {
        const response = await fetch(`${url}/api/snapshot`);
        const snapshot = await response.json();
        const item = snapshot.workItems.items.find(entry => entry.id === 'wi-api');

        assert.ok(item, 'the work item is part of the snapshot');
        assert.strictEqual(item.sessionId, 'session-a');
        assert.strictEqual(item.assigneeKind, 'agent');
        assert.strictEqual(item.repoRoot, fs.realpathSync(REPO_ROOT));
      })
    )
      passed++;
    else failed++;

    if (
      await test('rejects a session id that is not registered', async () => {
        const { status, payload } = await postClaim(url, 'wi-api', {
          owner: 'agent-1',
          sessionId: 'session-missing',
          repoRoot: REPO_ROOT
        });

        assert.strictEqual(status, 404);
        assert.strictEqual(payload.ok, false);
        assert.strictEqual(payload.code, 'SESSION_NOT_FOUND');
      })
    )
      passed++;
    else failed++;

    if (
      await test('rejects a work item registered under another repo root', async () => {
        const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-other-repo-'));
        try {
          await writeStateStore(stateDbPath, [{ id: 'wi-other-repo', repoRoot: otherRepo }]);
          const { status, payload } = await postClaim(url, 'wi-other-repo', {
            owner: 'agent-1',
            sessionId: 'session-a',
            repoRoot: REPO_ROOT
          });

          assert.strictEqual(status, 409);
          assert.strictEqual(payload.ok, false);
          assert.strictEqual(payload.code, 'REPO_ROOT_MISMATCH');
        } finally {
          fs.rmSync(otherRepo, { recursive: true, force: true });
        }
      })
    )
      passed++;
    else failed++;

    if (
      await test('rejects a session that belongs to another repository', async () => {
        const { status, payload } = await postClaim(url, 'wi-api', {
          owner: 'agent-1',
          sessionId: 'session-a',
          repoRoot: os.tmpdir()
        });

        assert.strictEqual(status, 409);
        assert.strictEqual(payload.ok, false);
        assert.strictEqual(payload.code, 'SESSION_UNRELATED');
      })
    )
      passed++;
    else failed++;

    if (
      await test('claims a work item without a session as before', async () => {
        await writeStateStore(stateDbPath, [{ id: 'wi-plain' }]);
        const { status, payload } = await postClaim(url, 'wi-plain', {
          owner: 'operator',
          as: 'human'
        });

        assert.strictEqual(status, 200);
        assert.strictEqual(payload.ok, true);
        assert.strictEqual(payload.item.owner, 'operator');
        assert.strictEqual(payload.item.sessionId, null);
      })
    )
      passed++;
    else failed++;

    if (
      await test('rebinds an existing item through the claim API after its native session completes', async () => {
        await writeNativeRegistry(dbPath, [
          { id: 'session-old', state: 'completed' },
          { id: 'session-new', state: 'running' }
        ]);
        await writeStateStore(stateDbPath, [{
          id: 'wi-rebind', status: 'running', owner: 'agent-1', sessionId: 'session-old',
          metadata: { retained: true }
        }]);

        const { status, payload } = await postClaim(url, 'wi-rebind', {
          owner: 'agent-1',
          sessionId: 'session-new',
          repoRoot: REPO_ROOT
        });

        assert.strictEqual(status, 200);
        assert.strictEqual(payload.ok, true);
        assert.strictEqual(payload.item.id, 'wi-rebind');
        assert.strictEqual(payload.item.sessionId, 'session-new');
        assert.strictEqual(payload.item.metadata.retained, true);
        assert.strictEqual(payload.item.metadata.sessionBinding.previousSessionId, 'session-old');
      })
    )
      passed++;
    else failed++;
  } finally {
    if (app) {
      await app.close();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
