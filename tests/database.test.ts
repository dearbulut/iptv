import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blockedUrls, parseTable, recordKey, serialiseTable } from '../src/database/index.js';
import { diffTable, guard, reportMarkdown } from '../src/database/sync.js';
import {
  allChecked,
  checkStreamUrl,
  DAILY_LIMIT,
  extractTargets,
  makeChannelId,
  parseIssueForm,
  processStreamSubmission,
  processTakedown,
  type SubmissionContext,
} from '../src/database/community.js';
import type { Channel, HealthCheck } from '../src/core/types.js';

const channel = (id: string, name: string, country: string): Channel => ({
  id,
  name,
  alt_names: [],
  network: null,
  owners: [],
  country,
  categories: ['general'],
  is_nsfw: false,
  launched: null,
  closed: null,
  replaced_by: null,
  website: null,
});

describe('database files', () => {
  it('round-trips records and keeps their order', () => {
    const rows = [{ id: 'B.tr', name: 'B' }, { id: 'A.tr', name: 'A' }];
    assert.deepEqual(parseTable(serialiseTable(rows)), rows);
    assert.equal(serialiseTable([]), '');
  });

  it('keys records by their identifying fields', () => {
    assert.equal(recordKey('channels', { id: 'X.tr', name: 'x' }), 'X.tr');
    assert.notEqual(
      recordKey('feeds', { channel: 'X.tr', id: 'SD' }),
      recordKey('feeds', { channel: 'X.tr', id: 'HD' }),
    );
  });
});

describe('database sync', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `C${i}.tr`, name: `C${i}` }));

  it('counts additions, removals and real changes, ignoring field order', () => {
    const before = [{ id: 'A.tr', name: 'A' }, { id: 'B.tr', name: 'B' }, { id: 'C.tr', name: 'C' }];
    const after = [{ name: 'A', id: 'A.tr' }, { id: 'B.tr', name: 'B2' }, { id: 'D.tr', name: 'D' }];
    const diff = diffTable('channels', before, after);
    assert.deepEqual([diff.added, diff.removed, diff.changed], [1, 1, 1]);
    assert.deepEqual(diff.samples.removed, ['C.tr (C)']);
  });

  it('applies normal churn but refuses a mass removal or an empty table', () => {
    const big = rows(2000);
    assert.deepEqual(guard([diffTable('channels', big, big.slice(0, 1960))]), [], '40 removals is under the floor');
    assert.equal(guard([diffTable('channels', big, big.slice(0, 1800))]).length, 1, '10% of channels trips the 5% limit');
    assert.equal(guard([diffTable('streams', big, big.slice(0, 1800))]).length, 0, 'streams allow 15%');
    assert.equal(guard([diffTable('categories', rows(30), [])]).length, 1, 'an emptied table always trips');
    assert.deepEqual(guard([diffTable('channels', [], big)]), [], 'the first sync is never blocked');
  });

  it('writes a readable report', () => {
    const markdown = reportMarkdown({
      synced_at: 'now',
      source: 'x',
      applied: false,
      blocked_by: ['channels: 200 of 2000 rows would be removed (limit 5%)'],
      tables: [diffTable('channels', rows(3), rows(2))],
    });
    assert.match(markdown, /refused/);
    assert.match(markdown, /channels removed \(1\)/);
  });
});

describe('stream-level blocklist', () => {
  it('normalises URLs and ignores channel-only entries', () => {
    const set = blockedUrls([
      { channel: '', url: 'HTTPS://Example.com:443/a.m3u8', reason: 'dmca', ref: 'x' },
      { channel: 'TRT1.tr', reason: 'dmca', ref: 'y' },
    ]);
    assert.equal(set.size, 1);
  });
});

const FORM = (overrides: Record<string, string> = {}) => {
  const fields: Record<string, string> = {
    Channel: 'TRT1.tr',
    'Stream URL': 'https://cdn.example/trt1.m3u8',
    Country: 'TR',
    Referrer: '_No response_',
    'User-Agent': '_No response_',
    'New channel': '- [ ] This is a new channel, not yet in IPTV Nexus',
    Categories: '_No response_',
    Languages: '_No response_',
    Website: '_No response_',
    'Logo URL': '_No response_',
    Confirmation: '- [X] This stream is free to watch and publicly available.',
    ...overrides,
  };
  return Object.entries(fields).map(([label, value]) => `### ${label}\n\n${value}`).join('\n\n');
};

const online: HealthCheck = {
  checked_at: 'now',
  status: 'online',
  latency_ms: 120,
  http_status: 200,
  error: null,
  media: { width: 1920, height: 1080, resolution: '1080p', frame_rate: 25, bitrate: null, video_codec: 'h264', audio_codec: 'aac', variants: 1 } as HealthCheck['media'],
};

const context = (over: Partial<SubmissionContext> = {}): SubmissionContext => ({
  channels: [channel('TRT1.tr', 'TRT 1', 'TR'), channel('ShowTV.tr', 'Show TV', 'TR')],
  knownStreams: new Set(),
  blocklist: [],
  recentByAuthor: 0,
  countries: new Set(['TR', 'IQ']),
  categories: new Set(['general', 'religious', 'news']),
  probe: async () => online,
  now: '2026-11-17T00:00:00.000Z',
  ...over,
});

describe('issue forms', () => {
  it('parses GitHub issue-form Markdown', () => {
    const fields = parseIssueForm(FORM());
    assert.equal(fields.get('channel'), 'TRT1.tr');
    assert.equal(fields.get('referrer'), '');
    assert.ok(allChecked(fields.get('confirmation')));
    assert.ok(!allChecked(fields.get('new channel')));
  });

  it('rejects subscription panels, credentials and non-HTTP streams', () => {
    assert.match(checkStreamUrl('http://p.example:8080/live/user/pass/123.ts')!, /reseller/);
    assert.match(checkStreamUrl('http://p.example/get.php?username=a&password=b')!, /reseller/);
    assert.match(checkStreamUrl('https://u:p@cdn.example/x.m3u8')!, /credentials/);
    assert.match(checkStreamUrl('rtmp://cdn.example/live')!, /http/);
    assert.equal(checkStreamUrl('https://cdn.example/live/index.m3u8'), null);
  });

  it('builds iptv-org style ids', () => {
    assert.equal(makeChannelId('Alabbassia TV', 'IQ'), 'AlabbassiaTV.iq');
    assert.equal(makeChannelId('Canal+ Sport', 'FR'), 'CanalPlusSport.fr');
    assert.equal(makeChannelId('Çocuk Kanalı', 'TR'), 'CocukKanali.tr');
  });
});

describe('stream submissions', () => {
  it('accepts a working stream for an existing channel', async () => {
    const result = await processStreamSubmission(FORM(), 'alice', 7, context());
    assert.equal(result.status, 'accepted');
    assert.equal(result.stream?.['channel'], 'TRT1.tr');
    assert.equal(result.stream?.['quality'], '1080p');
    assert.equal(result.stream?.['added_by'], 'alice');
    assert.equal(result.channel, undefined);
  });

  it('finds the channel from a page link or its name', async () => {
    const byLink = await processStreamSubmission(FORM({ Channel: 'https://dearbulut.github.io/iptv/?channel=ShowTV.tr' }), 'a', 1, context());
    assert.equal(byLink.stream?.['channel'], 'ShowTV.tr');
    const byName = await processStreamSubmission(FORM({ Channel: 'Show TV' }), 'a', 1, context());
    assert.equal(byName.stream?.['channel'], 'ShowTV.tr');
  });

  it('creates a new channel, with its languages on a feed', async () => {
    const result = await processStreamSubmission(
      FORM({
        Channel: 'Alabbassia TV',
        Country: 'IQ',
        'New channel': '- [X] This is a new channel, not yet in IPTV Nexus',
        Categories: 'religious, nonsense',
        Languages: 'ara',
        'Logo URL': 'https://example.com/logo.png',
      }),
      'alabbassia',
      16,
      context(),
    );
    assert.equal(result.status, 'accepted');
    assert.equal(result.channel?.['id'], 'AlabbassiaTV.iq');
    assert.deepEqual(result.channel?.['categories'], ['religious']);
    assert.equal(result.channel?.['logo'], 'https://example.com/logo.png');
    assert.deepEqual(result.feed?.['languages'], ['ara']);
    assert.equal(result.stream?.['channel'], 'AlabbassiaTV.iq');
  });

  it('explains every way a submission can fail', async () => {
    const cases: Array<[string, Promise<{ status: string; message: string }>, RegExp]> = [
      ['unconfirmed', processStreamSubmission(FORM({ Confirmation: '- [ ] free' }), 'a', 1, context()), /confirmation/],
      ['panel', processStreamSubmission(FORM({ 'Stream URL': 'http://p.example/live/a/b/1.ts' }), 'a', 1, context()), /reseller/],
      ['unknown channel', processStreamSubmission(FORM({ Channel: 'Nope TV' }), 'a', 1, context()), /No channel matches/],
      ['offline', processStreamSubmission(FORM(), 'a', 1, context({ probe: async () => ({ ...online, status: 'offline', media: null, http_status: 404 }) })), /did not play.*404/],
      ['daily limit', processStreamSubmission(FORM(), 'a', 1, context({ recentByAuthor: DAILY_LIMIT })), /daily limit/],
      ['taken down', processStreamSubmission(FORM(), 'a', 1, context({ blocklist: [{ channel: 'TRT1.tr', reason: 'dmca', ref: 'x' }] })), /rights-holder/],
    ];
    for (const [name, promise, pattern] of cases) {
      const result = await promise;
      assert.equal(result.status, 'rejected', name);
      assert.match(result.message, pattern, name);
    }
    const duplicate = await processStreamSubmission(
      FORM(),
      'a',
      1,
      context({ knownStreams: new Set([(await import('../src/core/http.js')).streamKey('https://cdn.example/trt1.m3u8')]) }),
    );
    assert.equal(duplicate.status, 'duplicate');
  });

  it('never probes a stream that fails the cheap checks', async () => {
    let probed = false;
    await processStreamSubmission(FORM({ 'Stream URL': 'http://p.example/live/a/b/1.ts' }), 'a', 1, context({ probe: async () => { probed = true; return online; } }));
    assert.equal(probed, false);
  });
});

describe('takedown requests', () => {
  const TAKEDOWN = (targets: string, ticked = true) =>
    [
      '### Your name\n\nJane Doe',
      '### Organisation\n\nRights Ltd',
      '### Contact email\n\nlegal@example.com',
      '### Copyrighted work\n\nThe live broadcast',
      `### What to remove\n\n${targets}`,
      `### Statements\n\n- [${ticked ? 'X' : ' '}] good faith\n- [X] accurate\n- [X] public`,
      '### Signature\n\nJane Doe',
    ].join('\n\n');
  const channels = [channel('TRT1.tr', 'TRT 1', 'TR')];

  it('reads ids, page links and stream URLs', () => {
    const targets = extractTargets('trt1.tr\nhttps://dearbulut.github.io/iptv/?channel=TRT1.tr, https://cdn/x.m3u8\nNope.xx', channels);
    assert.deepEqual(targets, { channels: ['TRT1.tr'], urls: ['https://cdn/x.m3u8'], unknown: ['Nope.xx'] });
  });

  it('removes at once when the notice is complete', () => {
    const result = processTakedown(TAKEDOWN('TRT1.tr\nhttps://cdn/x.m3u8'), 'https://github.com/o/r/issues/5', channels, 'now');
    assert.equal(result.status, 'removed');
    assert.deepEqual(
      result.entries.map((entry) => [entry.channel, entry.url ?? null, entry.reason, entry.ref]),
      [
        ['TRT1.tr', null, 'dmca', 'https://github.com/o/r/issues/5'],
        ['', 'https://cdn/x.m3u8', 'dmca', 'https://github.com/o/r/issues/5'],
      ],
    );
  });

  it('removes nothing from an incomplete notice', () => {
    const unticked = processTakedown(TAKEDOWN('TRT1.tr', false), 'u', channels, 'now');
    assert.equal(unticked.status, 'incomplete');
    assert.equal(unticked.entries.length, 0);
    assert.match(unticked.message, /statements/);
    const nothing = processTakedown(TAKEDOWN('Nope.xx'), 'u', channels, 'now');
    assert.equal(nothing.status, 'incomplete');
    assert.match(nothing.message, /Not recognised: `Nope.xx`/);
  });
});
