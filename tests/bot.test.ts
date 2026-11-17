import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { activeReports, processBrokenReport } from '../src/database/community.js';
import { evaluateSource, lineChanges, reviewPullRequest, type ReviewContext } from '../src/database/review.js';
import { regionalByChannel } from '../src/api/regional.js';
import { insertTable } from '../src/database/dump.js';
import { streamKey } from '../src/core/http.js';
import type { Channel, HealthCheck } from '../src/core/types.js';

const channel = (id: string, name: string, country: string): Channel => ({
  id, name, alt_names: [], network: null, owners: [], country, categories: ['general'],
  is_nsfw: false, launched: null, closed: null, replaced_by: null, website: null,
});
const check = (status: HealthCheck['status'], http: number | null = 200): HealthCheck => ({
  checked_at: 'now', status, latency_ms: 50, http_status: http, error: null, media: null,
});
const CHANNELS = [channel('TRT1.tr', 'TRT 1', 'TR'), channel('ShowTV.tr', 'Show TV', 'TR')];
const ctx = (over: Partial<ReviewContext> = {}): ReviewContext => ({
  channels: CHANNELS,
  knownStreams: new Set([streamKey('https://known/trt1.m3u8')]),
  countries: new Set(['TR', 'DE']),
  probe: async () => check('online'),
  ...over,
});

describe('pull request review', () => {
  it('treats lines as a multiset', () => {
    assert.deepEqual(lineChanges('a\nb\n', 'b\na\nc\n'), { added: ['c'], removed: [] });
    assert.deepEqual(lineChanges('a\na\n', 'a\n'), { added: [], removed: ['a'] });
    assert.deepEqual(lineChanges(null, 'x\n'), { added: ['x'], removed: [] });
  });

  it('merges valid additions, including a stream for a channel added in the same PR', async () => {
    const result = await reviewPullRequest(
      [
        { path: 'data/nexus/streams.ndjson', before: '', after: '{"channel":"NewTV.de","url":"https://cdn/new.m3u8"}\n' },
        { path: 'data/nexus/channels.ndjson', before: null, after: '{"id":"NewTV.de","name":"New TV","country":"DE"}\n' },
      ],
      ctx(),
    );
    assert.equal(result.verdict, 'merge');
    assert.match(result.message, /new channel `NewTV.de`/);
  });

  it('asks for changes when a line breaks a rule or does not play', async () => {
    const bad = await reviewPullRequest(
      [{ path: 'data/nexus/streams.ndjson', before: '', after: '{"channel":"TRT1.tr","url":"http://p/live/u/p/1.ts"}\n{"channel":"Nope.tr","url":"https://cdn/x.m3u8"}\nnot json\n{"channel":"TRT1.tr","url":"https://known/trt1.m3u8"}\n' }],
      ctx(),
    );
    assert.equal(bad.verdict, 'changes');
    for (const pattern of [/reseller/, /does not exist/, /not valid JSON/, /already listed/]) assert.match(bad.message, pattern);
    const dead = await reviewPullRequest(
      [{ path: 'data/nexus/streams.ndjson', before: '', after: '{"channel":"TRT1.tr","url":"https://cdn/dead.m3u8"}\n' }],
      ctx({ probe: async () => check('offline', 404) }),
    );
    assert.equal(dead.verdict, 'changes');
    assert.match(dead.message, /did not play.*404/);
  });

  it('leaves removals, protected data, code and workflows to a person', async () => {
    const removal = await reviewPullRequest([{ path: 'data/nexus/streams.ndjson', before: 'a\n', after: '' }], ctx());
    assert.equal(removal.verdict, 'manual');
    const blocklist = await reviewPullRequest([{ path: 'data/nexus/blocklist.ndjson', before: '', after: '{}\n' }], ctx());
    assert.equal(blocklist.verdict, 'manual');
    const code = await reviewPullRequest([{ path: '.github/workflows/x.yml', before: '', after: 'x' }, { path: 'src/a.ts', before: '', after: 'x' }], ctx());
    assert.equal(code.verdict, 'manual');
    assert.match(code.message, /workflows/);
  });

  it('never probes when another file needs a person', async () => {
    let probed = false;
    await reviewPullRequest(
      [{ path: 'src/a.ts', before: '', after: 'x' }, { path: 'data/nexus/streams.ndjson', before: '', after: '{"channel":"TRT1.tr","url":"https://cdn/n.m3u8"}\n' }],
      ctx({ probe: async () => { probed = true; return check('online'); } }),
    );
    assert.equal(probed, false);
  });
});

describe('source evaluation', () => {
  it('measures what a playlist adds', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="TRT1.tr",TRT 1', 'https://known/trt1.m3u8',
      '#EXTINF:-1 tvg-id="ShowTV.tr",Show TV', 'https://cdn/show.m3u8',
      '#EXTINF:-1,Panel', 'http://p.example/live/user/pass/1.ts',
    ].join('\n');
    const result = await evaluateSource(playlist, { ...ctx(), playable: new Set(['TRT1.tr']) });
    assert.deepEqual(
      { entries: result.entries, matched: result.matched, newStreams: result.newStreams, first: result.newForUnplayable, panel: result.panelLike },
      { entries: 3, matched: 2, newStreams: 1, first: 1, panel: 1 },
    );
    assert.deepEqual(result.sample, [{ url: 'https://cdn/show.m3u8', status: 'online' }]);
  });
});

describe('broken stream reports', () => {
  const form = (fields: Record<string, string>) =>
    Object.entries({ Channel: 'TRT1.tr', 'Stream URL': '_No response_', Problem: 'It does not play', 'Your country': 'TR', ...fields })
      .map(([label, value]) => `### ${label}\n\n${value}`)
      .join('\n\n');
  const streams = new Map([['TRT1.tr', [
    { url: 'https://a/dead.m3u8', referrer: null, user_agent: null },
    { url: 'https://a/live.m3u8', referrer: null, user_agent: null },
  ]]]);
  const probe = async (url: string) => check(url.includes('dead') ? 'offline' : 'online', url.includes('dead') ? 404 : 200);
  const now = '2026-11-17T00:00:00.000Z';

  it('hides the dead streams for a week and keeps the working ones', async () => {
    const result = await processBrokenReport(form({}), 12, { channels: CHANNELS, streamsByChannel: streams, probe, now });
    assert.equal(result.status, 'hidden');
    assert.deepEqual(result.reports.map((r) => [r['url'], r['expires_at']]), [['https://a/dead.m3u8', '2026-11-24T00:00:00.000Z']]);
    assert.match(result.message, /works from our checker/);
  });

  it('says so when everything works, and sends other problems to a person', async () => {
    const working = await processBrokenReport(form({ 'Stream URL': 'https://a/live.m3u8' }), 1, { channels: CHANNELS, streamsByChannel: streams, probe, now });
    assert.equal(working.status, 'working');
    assert.equal(working.reports.length, 0);
    const other = await processBrokenReport(form({ Problem: 'It plays the wrong channel' }), 1, { channels: CHANNELS, streamsByChannel: streams, probe, now });
    assert.equal(other.status, 'manual');
    const unknownUrl = await processBrokenReport(form({ 'Stream URL': 'https://elsewhere/x.m3u8' }), 1, { channels: CHANNELS, streamsByChannel: streams, probe, now });
    assert.equal(unknownUrl.status, 'rejected');
  });

  it('expires reports', () => {
    const reports = [{ expires_at: '2026-11-20T00:00:00Z' }, { expires_at: '2026-11-01T00:00:00Z' }];
    assert.equal(activeReports(reports, '2026-11-17T00:00:00Z').length, 1);
  });
});

describe('regional availability', () => {
  it('maps channel numbers to ids and drops thin data', () => {
    const map = regionalByChannel(
      { generated_at: 'x', days: 14, channels: { '12': { TR: [9, 1], DE: [0, 4], FR: [1, 0] }, '99': { TR: [5, 0] } } },
      { 'TRT1.tr': 12 },
    );
    assert.deepEqual(map.get('TRT1.tr'), { TR: { ok: 9, fail: 1, ratio: 0.9 }, DE: { ok: 0, fail: 4, ratio: 0 } });
    assert.equal(map.size, 1);
    assert.equal(regionalByChannel(null, {}).size, 0);
  });
});

describe('database dump', () => {
  it('builds tables from mixed rows, with JSON for arrays and 0/1 for booleans', () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string) => { exec(s: string): void; prepare(s: string): { run(...v: unknown[]): unknown; all(): unknown[] }; close(): void };
    };
    const db = new DatabaseSync(':memory:');
    insertTable(db, 'channels', [{ id: 'A.tr', tags: ['x'], nsfw: false }, { id: 'B.tr', extra: 1 }], 'id');
    assert.deepEqual(
      db.prepare('SELECT id, tags, nsfw, extra FROM channels ORDER BY id').all().map((row) => ({ ...(row as object) })),
      [{ id: 'A.tr', tags: '["x"]', nsfw: 0, extra: null }, { id: 'B.tr', tags: null, nsfw: null, extra: 1 }],
    );
    db.close();
  });
});
