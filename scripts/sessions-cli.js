#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');
const { createStateStore } = require('./lib/state-store');
const { readNativeSession, resolveControlPaneConfig } = require('./lib/control-pane/state');
const { NATIVE_SESSION_MIRROR_MARKER } = require('./lib/control-pane/work-item-session-bridge');

const TERMINAL_NATIVE_SESSION_STATES = new Set(['completed', 'failed', 'stopped']);
const NATIVE_SESSION_STATES = new Set([
  'pending',
  'running',
  'idle',
  'stale',
  ...TERMINAL_NATIVE_SESSION_STATES,
]);

function formatSessionEnd(session) {
  if (session.nativeSessionVerified === false) {
    return '(unknown)';
  }
  return session.endedAt || '(active)';
}

function showHelp(exitCode = 0) {
  console.log(`
Usage: node scripts/sessions-cli.js [<session-id>] [--db <path>] [--json] [--limit <n>]

List recent ECC sessions from the SQLite state store or inspect a single session
with worker, skill-run, and decision detail.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    dbPath: null,
    help: false,
    json: false,
    limit: 10,
    sessionId: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--db') {
      if (!args[index + 1] || args[index + 1].startsWith('--') || args[index + 1] === '-h') {
        throw new Error(`Missing value for ${arg}`);
      }
      parsed.dbPath = args[index + 1] || null;
      index += 1;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--limit') {
      if (!args[index + 1] || args[index + 1].startsWith('--') || args[index + 1] === '-h') {
        throw new Error(`Missing value for ${arg}`);
      }
      parsed.limit = args[index + 1] || null;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (!arg.startsWith('--') && !parsed.sessionId) {
      parsed.sessionId = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function printSessionList(payload) {
  console.log('Recent sessions:\n');

  if (payload.sessions.length === 0) {
    console.log('No sessions found.');
    return;
  }

  for (const session of payload.sessions) {
    console.log(`- ${session.id} [${session.harness}/${session.adapterId}] ${session.state}`);
    console.log(`  Repo: ${session.repoRoot || '(unknown)'}`);
    console.log(`  Started: ${session.startedAt || '(unknown)'}`);
    console.log(`  Ended: ${formatSessionEnd(session)}`);
    console.log(`  Workers: ${session.workerCount}`);
  }

  console.log(`\nTotal sessions: ${payload.totalCount}`);
}

function printWorkers(workers) {
  console.log(`Workers: ${workers.length}`);
  if (workers.length === 0) {
    console.log('  - none');
    return;
  }

  for (const worker of workers) {
    console.log(`  - ${worker.id || worker.label || '(unknown)'} ${worker.state || 'unknown'}`);
    console.log(`    Branch: ${worker.branch || '(unknown)'}`);
    console.log(`    Worktree: ${worker.worktree || '(unknown)'}`);
  }
}

function printSkillRuns(skillRuns) {
  console.log(`Skill runs: ${skillRuns.length}`);
  if (skillRuns.length === 0) {
    console.log('  - none');
    return;
  }

  for (const skillRun of skillRuns) {
    console.log(`  - ${skillRun.id} ${skillRun.outcome} ${skillRun.skillId}@${skillRun.skillVersion}`);
    console.log(`    Task: ${skillRun.taskDescription}`);
    console.log(`    Duration: ${skillRun.durationMs ?? '(unknown)'} ms`);
  }
}

function printDecisions(decisions) {
  console.log(`Decisions: ${decisions.length}`);
  if (decisions.length === 0) {
    console.log('  - none');
    return;
  }

  for (const decision of decisions) {
    console.log(`  - ${decision.id} ${decision.status}`);
    console.log(`    Title: ${decision.title}`);
    console.log(`    Alternatives: ${decision.alternatives.join(', ') || '(none)'}`);
  }
}

function printSessionDetail(payload) {
  console.log(`Session: ${payload.session.id}`);
  console.log(`Harness: ${payload.session.harness}`);
  console.log(`Adapter: ${payload.session.adapterId}`);
  console.log(`State: ${payload.session.state}`);
  console.log(`Repo: ${payload.session.repoRoot || '(unknown)'}`);
  console.log(`Started: ${payload.session.startedAt || '(unknown)'}`);
  console.log(`Ended: ${formatSessionEnd(payload.session)}`);
  console.log();
  printWorkers(payload.workers);
  console.log();
  printSkillRuns(payload.skillRuns);
  console.log();
  printDecisions(payload.decisions);
}

function isNativeSessionMirror(session) {
  return Boolean(
    session
    && session.snapshot
    && session.snapshot.mirroredFrom === NATIVE_SESSION_MIRROR_MARKER
  );
}

function unverifiedNativeSession(store, session) {
  const cleared = session.endedAt === null || session.endedAt === undefined
    ? session
    : store.upsertSession({ ...session, endedAt: null });
  return { ...cleared, state: 'unknown', endedAt: null, nativeSessionVerified: false };
}

async function refreshNativeSession(store, session, configOptions) {
  const nativeSessionId = session.snapshot.nativeSessionId;
  const nativeWorkingDir = session.snapshot.workingDir;
  if (
    typeof nativeSessionId !== 'string'
    || nativeSessionId !== session.id
    || typeof nativeWorkingDir !== 'string'
    || nativeWorkingDir.trim() === ''
    || !path.isAbsolute(nativeWorkingDir)
  ) {
    return unverifiedNativeSession(store, session);
  }

  let nativeDbPath;
  let result;
  try {
    const homeDir = configOptions.homeDir || os.homedir();
    const resolvedConfig = resolveControlPaneConfig({
      env: { HOME: homeDir, USERPROFILE: homeDir },
      cwd: nativeWorkingDir,
    });
    nativeDbPath = path.isAbsolute(resolvedConfig.dbPath)
      ? resolvedConfig.dbPath
      : path.resolve(nativeWorkingDir, resolvedConfig.dbPath);
    result = await readNativeSession(nativeDbPath, nativeSessionId);
  } catch {
    return unverifiedNativeSession(store, session);
  }

  const nativeSession = result && result.session;
  if (
    !nativeSession
    || !Array.isArray(result.matches)
    || result.matches.length !== 1
    || nativeSession.id !== nativeSessionId
    || typeof session.snapshot.createdAt !== 'string'
    || nativeSession.createdAt !== session.snapshot.createdAt
    || nativeSession.harness !== session.harness
    || nativeSession.agentType !== session.snapshot.agentType
    || nativeSession.workingDir !== session.snapshot.workingDir
    || !NATIVE_SESSION_STATES.has(nativeSession.state)
  ) {
    return unverifiedNativeSession(store, session);
  }

  const updated = store.upsertSession({
    ...session,
    state: nativeSession.state,
    endedAt: TERMINAL_NATIVE_SESSION_STATES.has(nativeSession.state)
      ? nativeSession.updatedAt || null
      : null,
  });
  return { ...updated, nativeSessionVerified: true };
}

async function refreshNativeSessionViews(store, sessions, configOptions) {
  if (!sessions.some(isNativeSessionMirror)) {
    return sessions;
  }

  const refreshed = [];
  for (const session of sessions) {
    refreshed.push(
      isNativeSessionMirror(session)
        ? await refreshNativeSession(store, session, configOptions)
        : session,
    );
  }
  return refreshed;
}

async function loadSessionPayload(store, options, configOptions = {}) {
  if (!options.sessionId) {
    const payload = store.listRecentSessions({ limit: options.limit });
    return {
      type: 'list',
      payload: {
        ...payload,
        sessions: await refreshNativeSessionViews(store, payload.sessions, configOptions),
      },
    };
  }

  const payload = store.getSessionDetail(options.sessionId);
  if (!payload) {
    throw new Error(`Session not found: ${options.sessionId}`);
  }
  const [session] = await refreshNativeSessionViews(store, [payload.session], configOptions);
  return { type: 'detail', payload: { ...payload, session } };
}

async function main() {
  let store = null;

  try {
    const options = parseArgs(process.argv);
    if (options.help) {
      showHelp(0);
    }

    store = await createStateStore({
      dbPath: options.dbPath,
      homeDir: process.env.HOME || os.homedir(),
    });

    const { type, payload } = await loadSessionPayload(store, options, {
      homeDir: process.env.HOME || process.env.USERPROFILE || os.homedir(),
      cwd: process.cwd(),
    });
    if (type === 'list') {
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printSessionList(payload);
      }
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      printSessionDetail(payload);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  } finally {
    if (store) {
      store.close();
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  parseArgs,
};
