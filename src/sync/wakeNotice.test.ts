import assert from 'node:assert/strict';
import test from 'node:test';

import { wakeNoticeFrom } from '../model';
import { wakeNoticeBody } from './wakeNotice';

test('a saved download is named on its own', () => {
  assert.equal(wakeNoticeBody('download', { downloaded: true, sent: 2 }), 'Downloaded the ring record.');
  assert.equal(wakeNoticeBody('either', { downloaded: true, sent: 0 }), 'Downloaded the ring record.');
});

test('a successful send names how many readings were posted', () => {
  assert.equal(wakeNoticeBody('sent', { downloaded: true, sent: 1 }), 'Sent 1 waiting reading.');
  assert.equal(wakeNoticeBody('either', { downloaded: false, sent: 3 }), 'Sent 3 waiting readings.');
});

test('either covers a download and a send in one notice', () => {
  assert.equal(
    wakeNoticeBody('either', { downloaded: true, sent: 2 }),
    'Downloaded the ring record and sent 2 waiting readings.',
  );
});

test('a failed download or a failed send stays quiet', () => {
  assert.equal(wakeNoticeBody('either', { downloaded: false, sent: 0 }), null);
  assert.equal(wakeNoticeBody('download', { downloaded: false, sent: 4 }), null);
  assert.equal(wakeNoticeBody('sent', { downloaded: true, sent: 0 }), null);
});

test('a missing notice choice stays either', () => {
  assert.equal(wakeNoticeFrom(undefined), 'either');
  assert.equal(wakeNoticeFrom('later'), 'either');
  assert.equal(wakeNoticeFrom('download'), 'download');
  assert.equal(wakeNoticeFrom('sent'), 'sent');
});
