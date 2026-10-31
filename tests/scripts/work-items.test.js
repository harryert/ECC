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
const { syncGithubWorkItems } = require('../../scripts/work-items');

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
    await test('GitHub sync from an unrelated cwd preserves the existing repo root and assessment', async () => {
      const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-items-sync-'));
      const unrelatedCwd = path.join(syncDir, 'unrelated');
      const shimPath = path.join(syncDir, 'gh-shim.js');
      const previousCwd = process.cwd();
      const previousShim = process.env.ECC_GH_SHIM;
      const store = await createStateStore({ dbPath: ':memory:' });
      const repoRoot = fs.realpathSync(path.join(__dirname, '..', '..'));
      const assessment = { verdict: 'ready', assessedAt: '2026-10-31T12:00:00.000Z' };
      fs.mkdirSync(unrelatedCwd);
      fs.writeFileSync(shimPath, [
        "const prs = [{ number: 14, title: 'Native bridge', author: { login: 'maintainer' }, url: 'https://example.invalid/pull/14', updatedAt: '2026-11-01T00:00:00Z', mergeStateStatus: 'CLEAN', isDraft: false, headRefName: 'feature' }];",
        "process.stdout.write(JSON.stringify(process.argv[2] === 'pr' ? prs : []));"
      ].join('\n'));
      store.upsertWorkItem({
        id: 'github-example-repo-pr-14',
        source: 'github-pr',
        sourceId: '14',
        title: 'Old title',
        status: 'needs-review',
        priority: 'normal',
        owner: 'old-owner',
        repoRoot,
        sessionId: null,
        metadata: { currentAssessment: assessment, localNote: 'keep me' }
      });

      try {
        process.env.ECC_GH_SHIM = shimPath;
        process.chdir(unrelatedCwd);
        const result = syncGithubWorkItems(store, { githubRepo: 'example/repo', limit: 10 });
        assert.strictEqual(result.items.length, 1);
        assert.strictEqual(result.items[0].repoRoot, repoRoot);
        assert.strictEqual(result.items[0].title, 'PR #14: Native bridge');
        assert.deepStrictEqual(result.items[0].metadata.currentAssessment, assessment);
        assert.strictEqual(result.items[0].metadata.localNote, 'keep me');
        assert.strictEqual(result.items[0].metadata.mergeStateStatus, 'CLEAN');

        const newStore = await createStateStore({ dbPath: ':memory:' });
        try {
          assert.throws(
            () => syncGithubWorkItems(newStore, { githubRepo: 'example/repo', limit: 10 }),
            /requires --repo-root/
          );
        } finally {
          newStore.close();
        }
      } finally {
        process.chdir(previousCwd);
        if (previousShim === undefined) delete process.env.ECC_GH_SHIM;
        else process.env.ECC_GH_SHIM = previousShim;
        store.close();
        fs.rmSync(syncDir, { recursive: true, force: true });
      }
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
