import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { patchDelegate, patchScheduler } = require('../../plugins/withBackgroundWake.js');

const root = path.join(import.meta.dirname, '../..');

test('the background wake patch keeps Expo processing and adds one refresh task', () => {
  const scheduler = fs.readFileSync(
    path.join(root, 'node_modules/expo-background-task/ios/BackgroundTaskScheduler.swift'),
    'utf8',
  );
  const delegate = fs.readFileSync(
    path.join(root, 'node_modules/expo-background-task/ios/BackgroundTaskAppDelegate.swift'),
    'utf8',
  );
  const scheduled = patchScheduler(scheduler);
  const patched = patchDelegate(delegate);

  assert.equal(scheduled.includes('blescraper.backgroundTaskRegistered'), true);
  assert.equal(scheduled.includes('RefreshWake.scheduleIfIdle()'), true);
  assert.equal(scheduled.includes('RefreshWake.identifier'), true);
  assert.equal(patched.includes('com.sameer.blescraper.refresh'), true);
  assert.equal(patched.includes('RefreshWake.submitNext()'), true);
  assert.equal(patched.includes('historyDays: 2'), true);
  assert.equal(patched.includes('historyDays: 7'), true);
  assert.equal(patched.split('BGTaskScheduler.shared.register').length - 1, 2);
  assert.equal(patched.includes('com.expo.modules.backgroundtask.processing'), false);
  assert.equal(patched.includes('BackgroundTaskConstants.BackgroundWorkerIdentifier'), true);

  const refresh = patched.slice(patched.indexOf('BLEScraper refresh started'));
  const submitAt = refresh.indexOf('RefreshWake.submitNext()');
  const workAt = refresh.indexOf('runBackgroundWork');
  assert.equal(submitAt >= 0 && submitAt < workAt, true);

  assert.equal(patchScheduler(scheduled), scheduled);
  assert.equal(patchDelegate(patched), patched);
});
