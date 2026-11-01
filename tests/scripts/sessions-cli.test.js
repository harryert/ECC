'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const initSqlJs = require('sql.js');
const { main, parseArgs } = require('../../scripts/sessions-cli');
const { createStateStore } = require('../../scripts/lib/state-store');
const { bindWorkItemToNativeSession } = require('../../scripts/lib/control-pane/work-item-session-bridge');

const SCRIPT = path.resolve(__dirname, '../../scripts/sessions-cli.js');
const NATIVE_SESSION_MIRROR_MARKER = 'ecc2-native-session';
const CREATED_AT = '2026-11-01T00:00:00.000Z';
const NATIVE_SESSIONS_SCHEMA = `
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

async function withTempHome(fn) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-sessions-cli-'));
  try {
    await fn(homeDir);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

async function runCli(homeDir, args, { cwd = homeDir, env = {} } = {}) {
  const originalArgv = process.argv;
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const stdout = [];
  const stderr = [];
  const exitSentinel = Symbol('expected process.exit');
  let status = 0;
  const cliEnv = { ...originalEnv, HOME: homeDir, USERPROFILE: homeDir };
  delete cliEnv.ECC2_DB_PATH;
  delete cliEnv.ECC_STATE_DB_PATH;
  delete cliEnv.NODE_TEST_CONTEXT;
  Object.assign(cliEnv, env);

  try {
    process.argv = [process.execPath, SCRIPT, ...args];
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, cliEnv);
    console.log = (...values) => stdout.push(values.map(String).join(' '));
    console.error = (...values) => stderr.push(values.map(String).join(' '));
    process.exit = code => {
      const exit = new Error('captured process.exit');
      exit.sentinel = exitSentinel;
      exit.code = code;
      throw exit;
    };

    try {
      await main();
    } catch (error) {
      if (error.sentinel !== exitSentinel) throw error;
      status = error.code;
    }
  } finally {
    process.argv = originalArgv;
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  }

  return {
    status,
    stdout: stdout.length ? `${stdout.join('\n')}\n` : '',
    stderr: stderr.length ? `${stderr.join('\n')}\n` : '',
  };
}

async function writeNativeRegistry(dbPath, sessions) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(NATIVE_SESSIONS_SCHEMA);
  for (const session of sessions) {
    const updatedAt = session.updatedAt || CREATED_AT;
    db.run(
      `INSERT INTO sessions (
        id, task, agent_type, harness, working_dir, state, created_at, updated_at, last_heartbeat_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        'session lifecycle projection',
        session.agentType || 'claude',
        session.harness || 'claude',
        session.workingDir || '/repo',
        session.state,
        session.createdAt || CREATED_AT,
        updatedAt,
        updatedAt,
      ],
    );
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

function parseJsonOutput(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('requires a value for every db and limit option', () => {
  for (const flag of ['--db', '--limit']) {
    for (const args of [[flag], [flag, '--json'], [flag, '-h'], [flag, 'value', flag]]) {
      assert.throws(() => parseArgs(['node', SCRIPT, ...args]), { message: `Missing value for ${flag}` });
    }
  }
  const parsed = parseArgs(['node', SCRIPT, '--db', 'state.db', '--limit', '2', '--json', 'demo']);
  assert.equal(parsed.dbPath, 'state.db');
  assert.equal(parsed.limit, '2');
  assert.equal(parsed.json, true);
  assert.equal(parsed.sessionId, 'demo');
});

test('rejects incomplete options before a database can be created', async () => {
  await withTempHome(async homeDir => {
    for (const flag of ['--db', '--limit']) {
      for (const args of [[flag], [flag, '--json'], [flag, '-h']]) {
        assert.throws(() => parseArgs(['node', SCRIPT, ...args]), {
          message: `Missing value for ${flag}`,
        });
      }
    }
    assert.equal(parseArgs(['node', SCRIPT, '--help']).help, true);
    assert.deepEqual(fs.readdirSync(homeDir), []);
  });
});

test('inspects session details through the CLI entry point', async () => {
  await withTempHome(async homeDir => {
    const dbPath = path.join(homeDir, 'state.db');
    const store = await createStateStore({ dbPath });
    try {
      store.upsertSession({
        id: 'demo', adapterId: 'claude-history', harness: 'claude', state: 'recorded', repoRoot: homeDir,
        startedAt: '2026-03-15T08:00:00Z', endedAt: '2026-03-15T09:00:00Z',
        snapshot: { workers: [{ id: 'worker', state: 'active', branch: 'main', worktree: homeDir }, {}] },
      });
      store.upsertSession({ id: 'empty', adapterId: 'claude-history', harness: 'claude', state: 'recorded' });
      store.insertSkillRun({
        id: 'run', skillId: 'demo-skill', skillVersion: 'v1', sessionId: 'demo', taskDescription: 'A task', outcome: 'success',
      });
      store.insertDecision({ id: 'choice', sessionId: 'demo', title: 'A choice', rationale: 'A reason', status: 'active' });
    } finally {
      store.close();
    }

    const detail = await runCli(homeDir, ['demo', '--db', dbPath, '--json']);
    const payload = parseJsonOutput(detail);
    assert.equal(payload.workers.length, 2);
    assert.equal(payload.skillRuns[0].taskDescription, 'A task');
    assert.equal(payload.decisions[0].title, 'A choice');
  });
});

test('projects the bound native session lifecycle through the CLI and fails closed on a registry mismatch', async () => {
  await withTempHome(async homeDir => {
    const projectRoot = path.join(homeDir, 'bound-project');
    const launchDir = path.join(homeDir, 'unrelated-launch-directory');
    const nativeDbPath = path.join(homeDir, 'registries', 'bound-ecc2.db');
    const environmentDbPath = path.join(homeDir, 'registries', 'environment-ecc2.db');
    const stateDbPath = path.join(homeDir, 'state.db');
    const endedAt = '2026-11-01T02:00:00.000Z';
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(launchDir, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'ecc2.toml'), `db_path = "${nativeDbPath}"\n`);

    const nativeIdentity = {
      id: 'bound-session',
      agentType: 'claude',
      harness: 'claude',
      workingDir: projectRoot,
      createdAt: CREATED_AT,
    };
    await writeNativeRegistry(nativeDbPath, [{ ...nativeIdentity, state: 'running' }]);
    await writeNativeRegistry(environmentDbPath, [{
      ...nativeIdentity,
      state: 'failed',
      updatedAt: '2026-11-01T03:00:00.000Z',
    }]);

    const store = await createStateStore({ dbPath: stateDbPath });
    try {
      store.upsertWorkItem({
        id: 'wi-bound',
        source: 'manual',
        sourceId: null,
        title: 'Bound native session',
        status: 'open',
        priority: 'normal',
        url: null,
        owner: null,
        repoRoot: projectRoot,
        sessionId: null,
        metadata: {},
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      });
      const binding = await bindWorkItemToNativeSession({
        store,
        workItemId: 'wi-bound',
        repoRoot: projectRoot,
        sessionId: nativeIdentity.id,
        sessionDbPath: nativeDbPath,
      });
      assert.equal(binding.item.sessionId, nativeIdentity.id);

      store.upsertWorkItem({
        id: 'wi-duplicate',
        source: 'manual',
        sourceId: null,
        title: 'Duplicate session binding',
        status: 'open',
        priority: 'normal',
        url: null,
        owner: null,
        repoRoot: projectRoot,
        sessionId: null,
        metadata: {},
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      });
      await assert.rejects(
        bindWorkItemToNativeSession({
          store,
          workItemId: 'wi-duplicate',
          repoRoot: projectRoot,
          sessionId: nativeIdentity.id,
          sessionDbPath: nativeDbPath,
        }),
        error => error.code === 'SESSION_ALREADY_BOUND',
      );
      const mirror = store.getSessionById(nativeIdentity.id);
      assert.equal(mirror.adapterId, 'ecc2-native');
      assert.equal(mirror.snapshot.mirroredFrom, NATIVE_SESSION_MIRROR_MARKER);
      assert.equal(mirror.snapshot.nativeSessionId, nativeIdentity.id);
    } finally {
      store.close();
    }

    const active = await runCli(
      homeDir,
      [nativeIdentity.id, '--db', stateDbPath, '--json'],
      { cwd: launchDir, env: { ECC2_DB_PATH: environmentDbPath } },
    );
    const activeSession = parseJsonOutput(active).session;
    assert.equal(activeSession.state, 'running');
    assert.equal(activeSession.endedAt, null);
    assert.equal(activeSession.nativeSessionVerified, true);

    await writeNativeRegistry(nativeDbPath, [{
      ...nativeIdentity,
      state: 'completed',
      updatedAt: endedAt,
    }]);
    const terminal = await runCli(
      homeDir,
      ['--db', stateDbPath, '--json'],
      { cwd: launchDir, env: { ECC2_DB_PATH: environmentDbPath } },
    );
    const terminalSessions = parseJsonOutput(terminal).sessions;
    assert.equal(terminalSessions.length, 1);
    const terminalSession = terminalSessions.find(session => session.id === nativeIdentity.id);
    assert.ok(terminalSession);
    assert.equal(terminalSession.state, 'completed');
    assert.equal(terminalSession.endedAt, endedAt);
    assert.equal(terminalSession.nativeSessionVerified, true);

    await writeNativeRegistry(nativeDbPath, [{
      ...nativeIdentity,
      state: 'stopped',
      createdAt: '2026-11-01T01:00:00.000Z',
      updatedAt: '2026-11-01T04:00:00.000Z',
    }]);
    const unverified = await runCli(
      homeDir,
      [nativeIdentity.id, '--db', stateDbPath, '--json'],
      { cwd: launchDir, env: { ECC2_DB_PATH: environmentDbPath } },
    );
    const unverifiedSession = parseJsonOutput(unverified).session;
    assert.equal(unverifiedSession.state, 'unknown');
    assert.equal(unverifiedSession.endedAt, null);
    assert.equal(unverifiedSession.nativeSessionVerified, false);

    const human = await runCli(
      homeDir,
      [nativeIdentity.id, '--db', stateDbPath],
      { cwd: launchDir, env: { ECC2_DB_PATH: environmentDbPath } },
    );
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /State: unknown/);
    assert.match(human.stdout, /Ended: \(unknown\)/);

    const verifiedStore = await createStateStore({ dbPath: stateDbPath });
    try {
      const persisted = verifiedStore.getSessionById(nativeIdentity.id);
      assert.equal(persisted.state, 'completed');
      assert.equal(persisted.endedAt, null);
      assert.equal(persisted.snapshot.nativeSessionId, nativeIdentity.id);
      assert.equal(verifiedStore.getWorkItemById('wi-bound').sessionId, nativeIdentity.id);
    } finally {
      verifiedStore.close();
    }
  });
});
