'use strict';
/**
 * Tests for scripts/work-items.js — focused on the `claim` JIT pickup command.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const { createStateStore } = require('../../scripts/lib/state-store');

const CLI = path.join(__dirname, '..', '..', 'scripts', 'work-items.js');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`    Error: ${error.message}`);
    failed += 1;
  }
}

function runClaim(dbPath, args) {
  const result = spawnSync('node', [CLI, 'claim', '--db', dbPath, '--json', ...args], {
    encoding: 'utf8'
  });
  return result;
}

async function seed(dbPath) {
  const store = await createStateStore({ dbPath });
  try {
    // High-priority, unassigned, open — the JIT pickup target.
    store.upsertWorkItem({
      id: 'wi-unassigned-high',
      source: 'github-issue',
      title: 'Fix the gate bypass',
      status: 'open',
      priority: 'high',
      owner: null,
      metadata: {}
    });
    // Low-priority, unassigned, open — should be picked only after the high one.
    store.upsertWorkItem({
      id: 'wi-unassigned-low',
      source: 'manual',
      title: 'Tidy docs',
      status: 'open',
      priority: 'low',
      owner: null,
      metadata: {}
    });
    // Already owned — must never be auto-claimed.
    store.upsertWorkItem({
      id: 'wi-owned',
      source: 'manual',
      title: 'In progress',
      status: 'running',
      priority: 'high',
      owner: 'codex',
      metadata: {}
    });
    // Done — must never be claimed.
    store.upsertWorkItem({
      id: 'wi-done',
      source: 'manual',
      title: 'Shipped',
      status: 'done',
      priority: 'high',
      owner: null,
      metadata: {}
    });
  } finally {
    store.close();
  }
}

async function run() {
  console.log('\n=== Testing work-items.js claim ===\n');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-items-claim-'));
  const dbPath = path.join(dir, 'state.db');

  try {
    await seed(dbPath);

    await test('claim picks the highest-priority unassigned open item and sets owner + kind', async () => {
      const result = runClaim(dbPath, ['--owner', 'alice', '--as', 'human']);
      assert.strictEqual(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.strictEqual(payload.claimed, true);
      assert.strictEqual(payload.item.id, 'wi-unassigned-high', 'high-priority item claimed first');
      assert.strictEqual(payload.item.owner, 'alice');
      assert.strictEqual(payload.item.status, 'running', 'claim moves the card to running');
      assert.strictEqual(payload.item.metadata.assigneeKind, 'human');
    });

    await test('a second claim takes the next unassigned item, not an owned or done one', async () => {
      const result = runClaim(dbPath, ['--owner', 'bot-7', '--as', 'agent']);
      assert.strictEqual(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.strictEqual(payload.claimed, true);
      assert.strictEqual(payload.item.id, 'wi-unassigned-low');
      assert.strictEqual(payload.item.metadata.assigneeKind, 'agent');
    });

    await test('claim reports nothing to do once the queue is drained', async () => {
      const result = runClaim(dbPath, ['--owner', 'alice']);
      assert.strictEqual(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.strictEqual(payload.claimed, false);
      assert.strictEqual(payload.reason, 'no-unassigned-open-items');
    });

    await test('claim of a specific id works and rejects a missing id', async () => {
      const owned = runClaim(dbPath, ['wi-owned', '--owner', 'carol']);
      assert.notStrictEqual(owned.status, 0, 'an explicit id must not replace another owner');
      assert.match(owned.stderr, /already owned/i);
      const store = await createStateStore({ dbPath });
      try { assert.strictEqual(store.getWorkItemById('wi-owned').owner, 'codex'); } finally { store.close(); }

      const missing = runClaim(dbPath, ['nope-404', '--owner', 'carol']);
      assert.notStrictEqual(missing.status, 0, 'missing id should fail');
      assert.ok(/not found/i.test(missing.stderr), 'reports not found');
    });

    await test('repo-root claim targets the exact item without changing its status', async () => {
      const store = await createStateStore({ dbPath });
      try {
        store.upsertWorkItem({ id: 'wi-root-exact', source: 'manual', title: 'Root task', status: 'open', repoRoot: '/repo/exact', owner: null });
      } finally { store.close(); }

      const result = runClaim(dbPath, ['wi-root-exact', '--owner', 'root-owner', '--repo-root', '/repo/exact']);
      assert.strictEqual(result.status, 0, result.stderr);
      const item = JSON.parse(result.stdout).item;
      assert.strictEqual(item.id, 'wi-root-exact');
      assert.strictEqual(item.owner, 'root-owner');
      assert.strictEqual(item.status, 'open');
    });

    await test('foreign repo-root claim fails without writing', async () => {
      const store = await createStateStore({ dbPath });
      try {
        store.upsertWorkItem({ id: 'wi-root-foreign', source: 'manual', title: 'Foreign task', status: 'open', repoRoot: '/repo/actual', owner: null });
      } finally { store.close(); }
      const before = fs.readFileSync(dbPath);

      const result = runClaim(dbPath, ['wi-root-foreign', '--owner', 'wrong-root', '--repo-root', '/repo/other']);
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /does not belong to repo root/i);
      assert.deepStrictEqual(fs.readFileSync(dbPath), before);
    });

    await test('repo-root claim requires an id and never falls back to global pickup', async () => {
      const store = await createStateStore({ dbPath });
      try {
        store.upsertWorkItem({ id: 'wi-global-fallback', source: 'manual', title: 'Global task', status: 'open', owner: null });
      } finally { store.close(); }
      const before = fs.readFileSync(dbPath);

      const result = runClaim(dbPath, ['--owner', 'no-fallback', '--repo-root', '/repo/expected']);
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /requires a work item id/i);
      assert.deepStrictEqual(fs.readFileSync(dbPath), before);
    });

    await test('repo-root claim safely binds an unbound session without changing status', async () => {
      const store = await createStateStore({ dbPath });
      try {
        store.upsertSession({ id: 'session-42', adapterId: 'manual', harness: 'codex', state: 'running' });
        store.upsertWorkItem({ id: 'wi-root-session', source: 'manual', title: 'Session task', status: 'open', repoRoot: '/repo/session', sessionId: null, owner: null });
      } finally { store.close(); }

      const result = runClaim(dbPath, ['wi-root-session', '--owner', 'session-owner', '--repo-root', '/repo/session', '--session-id', 'session-42']);
      assert.strictEqual(result.status, 0, result.stderr);
      const item = JSON.parse(result.stdout).item;
      assert.strictEqual(item.sessionId, 'session-42');
      assert.strictEqual(item.status, 'open');
    });

    await test('repeat claim by the same owner is idempotent', async () => {
      const before = await createStateStore({ dbPath });
      let original;
      try { original = before.getWorkItemById('wi-owned'); } finally { before.close(); }
      const repeated = runClaim(dbPath, ['wi-owned', '--owner', original.owner, '--as', 'human']);
      assert.strictEqual(repeated.status, 0, repeated.stderr);
      assert.deepStrictEqual(JSON.parse(repeated.stdout).item, original);
    });

    await test('concurrent explicit claims have one winner and preserve its owner', async () => {
      const setup = await createStateStore({ dbPath });
      try { setup.upsertWorkItem({ id: 'wi-race', source: 'manual', title: 'Race', status: 'open', owner: null }); } finally { setup.close(); }
      const results = await Promise.all(['left', 'right'].map(owner => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, 'claim', 'wi-race', '--owner', owner, '--db', dbPath, '--json']);
        let stdout = ''; let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', status => resolve({ owner, status, stdout, stderr }));
      })));
      const winners = results.filter(result => result.status === 0);
      assert.strictEqual(winners.length, 1, JSON.stringify(results));
      assert.match(results.find(result => result.status !== 0).stderr, /already owned/i);
      const store = await createStateStore({ dbPath });
      try { assert.strictEqual(store.getWorkItemById('wi-race').owner, winners[0].owner); } finally { store.close(); }
    });

    await test('claim requires --owner and validates --as', async () => {
      const noOwner = runClaim(dbPath, ['wi-done']);
      assert.notStrictEqual(noOwner.status, 0);
      assert.ok(/requires --owner/i.test(noOwner.stderr));

      const badKind = runClaim(dbPath, ['wi-owned', '--owner', 'x', '--as', 'robot']);
      assert.notStrictEqual(badKind.status, 0);
      assert.ok(/agent.*human/i.test(badKind.stderr));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

run();
