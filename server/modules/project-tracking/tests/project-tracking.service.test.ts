import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { projectTrackingService } from '@/modules/project-tracking/index.js';

async function withTrackedSession(run: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'project-tracking-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'tracking.db');
  await initializeDatabase();
  sessionsDb.createAppSession('tracked-session', 'claude', directory, 'Fix checkout');

  try {
    await run();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
}

test('tracks run lifecycle across running, done and error states', async () => {
  await withTrackedSession(() => {
    projectTrackingService.add('tracked-session', true);
    assert.equal((projectTrackingService.list()[0] as { status: string }).status, 'running');

    projectTrackingService.updateStatus('tracked-session', 'done');
    assert.equal((projectTrackingService.list()[0] as { status: string }).status, 'done');

    projectTrackingService.updateStatus('tracked-session', 'error', 'Run exited with code 1');
    const failed = projectTrackingService.list()[0] as { status: string; errorMessage: string };
    assert.equal(failed.status, 'error');
    assert.equal(failed.errorMessage, 'Run exited with code 1');
  });
});

test('removing a tracked session leaves it off the board', async () => {
  await withTrackedSession(() => {
    projectTrackingService.add('tracked-session', false);
    projectTrackingService.remove('tracked-session');
    assert.deepEqual(projectTrackingService.list(), []);
  });
});
