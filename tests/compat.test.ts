import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  browserBlocker,
  channelAvailability,
  historyString,
  isBrowserPlayable,
} from '../src/api/compat.js';
import {
  assignChannelNumbers,
  emptyRegistry,
  normaliseRegistry,
} from '../src/api/channel-numbers.js';
import type { HealthRecord } from '../src/core/types.js';

const stream = (url: string, extra: Partial<{ referrer: string; user_agent: string }> = {}) => ({
  url,
  referrer: extra.referrer ?? null,
  user_agent: extra.user_agent ?? null,
});

describe('isBrowserPlayable', () => {
  it('accepts HTTPS HLS, including extension-less manifests', () => {
    assert.equal(isBrowserPlayable(stream('https://cdn.example/live/index.m3u8')), true);
    assert.equal(isBrowserPlayable(stream('https://cdn.example/live/master?token=1')), true);
    assert.equal(isBrowserPlayable(stream('https://cdn.example/vod/clip.mp4')), true);
  });

  it('rejects plain http, which an HTTPS page blocks as mixed content', () => {
    assert.equal(isBrowserPlayable(stream('http://cdn.example/index.m3u8')), false);
    assert.equal(browserBlocker(stream('http://cdn.example/index.m3u8')), 'insecure');
  });

  it('rejects streams that need headers a browser cannot send', () => {
    const guarded = stream('https://cdn.example/index.m3u8', { referrer: 'https://site.example/' });
    assert.equal(isBrowserPlayable(guarded), false);
    assert.equal(browserBlocker(guarded), 'headers');
  });

  it('rejects raw transport streams, DASH and RTMP', () => {
    assert.equal(browserBlocker(stream('https://cdn.example/live.ts')), 'format');
    assert.equal(isBrowserPlayable(stream('https://cdn.example/manifest.mpd')), false);
    assert.equal(isBrowserPlayable(stream('rtmp://cdn.example/live')), false);
  });

  it('returns no blocker for a playable stream', () => {
    assert.equal(browserBlocker(stream('https://cdn.example/index.m3u8')), null);
  });
});

describe('channelAvailability', () => {
  const s = (status: string) => ({ health: { status } });

  it('distinguishes every state a viewer cares about', () => {
    assert.equal(channelAvailability([]), 'none');
    assert.equal(channelAvailability([{ health: null }]), 'unchecked');
    assert.equal(channelAvailability([s('offline'), s('online')]), 'online');
    assert.equal(channelAvailability([s('offline'), s('blocked')]), 'regional');
    assert.equal(channelAvailability([s('timeout'), s('error')]), 'offline');
  });

  it('prefers regional over offline: a geo-block is not a failure', () => {
    assert.equal(channelAvailability([s('blocked'), s('offline'), s('offline')]), 'regional');
  });
});

describe('historyString', () => {
  it('encodes history oldest first', () => {
    assert.equal(historyString({ history: [1, 0, 1, 1] } as HealthRecord), '1011');
    assert.equal(historyString(null), '');
  });
});

describe('channel numbers', () => {
  const ch = (id: string, country: string, name = id) => ({ id, country, name });

  it('numbers the first line-up grouped by country, then name', () => {
    const { registry } = assignChannelNumbers(emptyRegistry(), [
      ch('Z.tr', 'TR', 'Zeta'),
      ch('A.us', 'US', 'Alpha'),
      ch('B.tr', 'TR', 'Beta'),
    ]);
    assert.deepEqual(registry.numbers, { 'B.tr': 1, 'Z.tr': 2, 'A.us': 3 });
  });

  it('never renumbers an existing channel when others are added', () => {
    const first = assignChannelNumbers(emptyRegistry(), [ch('M.tr', 'TR'), ch('N.tr', 'TR')]).registry;
    const before = { ...first.numbers };
    const { registry, assigned } = assignChannelNumbers(first, [
      ch('A.tr', 'TR'), // sorts before both, but must not displace them
      ch('M.tr', 'TR'),
      ch('N.tr', 'TR'),
    ]);
    assert.equal(assigned, 1);
    assert.equal(registry.numbers['M.tr'], before['M.tr']);
    assert.equal(registry.numbers['N.tr'], before['N.tr']);
    assert.equal(registry.numbers['A.tr'], 3);
  });

  it('keeps a number for a channel that disappears and comes back', () => {
    const first = assignChannelNumbers(emptyRegistry(), [ch('X.de', 'DE'), ch('Y.de', 'DE')]).registry;
    const gone = assignChannelNumbers(first, [ch('Y.de', 'DE')]).registry;
    const back = assignChannelNumbers(gone, [ch('X.de', 'DE'), ch('Y.de', 'DE')]);
    assert.equal(back.assigned, 0);
    assert.equal(back.registry.numbers['X.de'], 1);
  });

  it('never reuses a retired number', () => {
    const registry = normaliseRegistry({ version: 1, last: 50, numbers: { 'A.us': 3 } });
    const { registry: next } = assignChannelNumbers(registry, [ch('New.us', 'US')]);
    assert.equal(next.numbers['New.us'], 51);
  });

  it('repairs a damaged or missing registry instead of failing', () => {
    assert.deepEqual(normaliseRegistry(null), emptyRegistry());
    const repaired = normaliseRegistry({ numbers: { 'A.us': 7, 'B.us': -1, 'C.us': 'x' } });
    assert.deepEqual(repaired.numbers, { 'A.us': 7 });
    assert.equal(repaired.last, 7);
  });
});
