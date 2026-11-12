import assert from 'node:assert/strict';
import test from 'node:test';

import { wakeNoticeBody } from './wakeNotice';

test('a download with nothing waiting names the ring read and the later send', () => {
  assert.equal(
    wakeNoticeBody({ downloadDays: 2, waiting: 0, sendsAfter: true }),
    'Downloading the last 2 days of heart rate, steps, and sleep from the ring, then sending anything new.',
  );
});

test('waiting readings are named before the ring download', () => {
  assert.equal(
    wakeNoticeBody({ downloadDays: 7, waiting: 3, sendsAfter: true }),
    'Uploading 3 waiting readings, then downloading the last 7 days of heart rate, steps, and sleep from the ring. Anything new is sent after the download.',
  );
});

test('one waiting reading stays singular', () => {
  assert.equal(wakeNoticeBody({ downloadDays: null, waiting: 1, sendsAfter: false }), 'Uploading 1 waiting reading.');
});

test('a download with nowhere to send does not mention an upload', () => {
  assert.equal(
    wakeNoticeBody({ downloadDays: 1, waiting: 0, sendsAfter: false }),
    'Downloading the last day of heart rate, steps, and sleep from the ring.',
  );
});

test('a wake with nothing to do stays quiet', () => {
  assert.equal(wakeNoticeBody({ downloadDays: null, waiting: 0, sendsAfter: false }), null);
});
