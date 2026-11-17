import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractPlaylistUrls } from '../src/discovery/index.js';
import { buildSearchIndex, SEARCH_FIELDS } from '../src/api/search-index.js';
import { buildOverrideIndex, linkEpgChannels } from '../src/epg/index.js';
import { buildChannelIndex } from '../src/aggregate/match.js';
import { DEFAULT_SETTINGS } from '../src/core/config.js';
import { mapConcurrent, createLimiter, shard, retry } from '../src/core/concurrency.js';
import { buildLogoIndex } from '../src/aggregate/upstream.js';
import type { Channel, EpgBundle, Feed, Logo } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

describe('extractPlaylistUrls', () => {
  it('finds absolute playlist links in HTML and plain text', () => {
    const urls = extractPlaylistUrls(
      `<a href="https://a.example/list.m3u">one</a>
       see also https://b.example/live.m3u8?token=1
       <img src="https://c.example/not-a-playlist.png">`,
      'https://index.example/page',
    );
    assert.ok(urls.includes('https://a.example/list.m3u'));
    assert.ok(urls.includes('https://b.example/live.m3u8?token=1'));
    assert.equal(urls.length, 2);
  });

  it('resolves relative links against the page URL', () => {
    const urls = extractPlaylistUrls('<a href="lists/uk.m3u">uk</a>', 'https://index.example/dir/');
    assert.deepEqual(urls, ['https://index.example/dir/lists/uk.m3u']);
  });

  it('deduplicates repeats', () => {
    const urls = extractPlaylistUrls(
      'https://a.example/x.m3u8 https://a.example/x.m3u8',
      'https://index.example/',
    );
    assert.equal(urls.length, 1);
  });

  it('returns nothing for a page with no playlists', () => {
    assert.deepEqual(extractPlaylistUrls('<p>hello</p>', 'https://x.example/'), []);
  });
});

// ---------------------------------------------------------------------------
// search index
// ---------------------------------------------------------------------------

describe('buildSearchIndex', () => {
  const channels = [
    {
      id: 'Offline.us',
      name: 'Offline Channel',
      alt_names: [],
      network: null,
      country: 'US',
      categories: ['general'],
      languages: ['eng'],
      logo: null,
      score: 10,
      online: false,
      stream_count: 1,
      best_quality: '480p',
    },
    {
      id: 'BBCNews.uk',
      name: 'BBC News',
      alt_names: ['BBC News Channel'],
      network: 'BBC',
      country: 'GB',
      categories: ['news'],
      languages: ['eng'],
      logo: 'https://l.example/bbc.png',
      score: 92,
      online: true,
      stream_count: 3,
      best_quality: '1080p',
    },
  ];

  const index = buildSearchIndex(channels);

  it('emits one row per channel with the declared arity', () => {
    assert.equal(index.count, 2);
    for (const row of index.channels) assert.equal(row.length, SEARCH_FIELDS.length);
  });

  it('sorts online and high-scoring channels first', () => {
    assert.equal(index.channels[0]![0], 'BBCNews.uk');
  });

  it('builds a searchable blob covering names, network and id', () => {
    const blob = index.channels[0]![2];
    assert.ok(blob.includes('bbcnews'));
    assert.ok(blob.includes('bbc'));
  });

  it('never emits null in a row', () => {
    for (const row of index.channels) {
      for (const value of row) assert.notEqual(value, null);
    }
  });
});

// ---------------------------------------------------------------------------
// EPG matching
// ---------------------------------------------------------------------------

describe('linkEpgChannels', () => {
  const channels: Channel[] = [
    {
      id: 'TRT1.tr',
      name: 'TRT 1',
      alt_names: [],
      network: 'TRT',
      owners: [],
      country: 'TR',
      categories: ['general'],
      is_nsfw: false,
      launched: null,
      closed: null,
      replaced_by: null,
      website: null,
    },
    {
      id: 'BBCNews.uk',
      name: 'BBC News',
      alt_names: ['BBC News Channel'],
      network: 'BBC',
      owners: [],
      country: 'GB',
      categories: ['news'],
      is_nsfw: false,
      launched: null,
      closed: null,
      replaced_by: null,
      website: null,
    },
  ];

  const index = buildChannelIndex(channels, [] as Feed[]);

  function bundle(ids: Array<[string, string[]]>): EpgBundle {
    return {
      site: 'example.com',
      generated_at: new Date().toISOString(),
      channels: ids.map(([id, names]) => ({
        id,
        display_names: names,
        icon: null,
        site: 'example.com',
        lang: null,
      })),
      programmes: [],
    };
  }

  it('prefers an authoritative upstream guide mapping', () => {
    const upstream = new Map([['example.com::weird-id-42', 'TRT1.tr']]);
    const { links } = linkEpgChannels(
      bundle([['weird-id-42', ['Completely Different']]]),
      index,
      upstream,
      DEFAULT_SETTINGS,
    );
    assert.equal(links.get('weird-id-42')?.channel, 'TRT1.tr');
    assert.equal(links.get('weird-id-42')?.method, 'upstream');
  });

  it('matches when the EPG id is already a channel id', () => {
    const { links } = linkEpgChannels(
      bundle([['BBCNews.uk', ['Whatever']]]),
      index,
      new Map(),
      DEFAULT_SETTINGS,
    );
    assert.equal(links.get('BBCNews.uk')?.method, 'exact');
  });

  it('strips the iptv-org feed suffix from EPG ids', () => {
    const { links } = linkEpgChannels(
      bundle([['BBCNews.uk@NorthAmerica', ['Whatever']]]),
      index,
      new Map(),
      DEFAULT_SETTINGS,
    );
    assert.equal(links.get('BBCNews.uk@NorthAmerica')?.channel, 'BBCNews.uk');
  });

  it('applies manual overrides before anything else, including to fix a fuzzy match', () => {
    const overrides = buildOverrideIndex([
      { site: 'example.com', site_id: 'site-99', channel: 'BBCNews.uk' },
      { site: '*', site_id: 'site-7', channel: 'TRT1.tr' },
    ]);
    const { links } = linkEpgChannels(
      bundle([
        ['site-99', ['TRT 1 HD']], // would fuzzy-match TRT 1
        ['site-7', ['Unrecognisable']],
      ]),
      index,
      new Map(),
      DEFAULT_SETTINGS,
      ['TR'],
      overrides,
    );
    assert.equal(links.get('site-99')?.channel, 'BBCNews.uk');
    assert.equal(links.get('site-99')?.method, 'manual');
    assert.equal(links.get('site-7')?.channel, 'TRT1.tr');
  });

  it('drops skipped channels from both links and the unmatched report', () => {
    const { links, unmatched, skipped } = linkEpgChannels(
      bundle([['site-1', ['Some Regional Station Nobody Knows']]]),
      index,
      new Map(),
      DEFAULT_SETTINGS,
      [],
      buildOverrideIndex([{ site: 'example.com', site_id: 'site-1', skip: true }]),
    );
    assert.equal(links.size, 0);
    assert.equal(unmatched.length, 0);
    assert.equal(skipped, 1);
  });

  it('ignores an override that points at an unknown channel', () => {
    const { links } = linkEpgChannels(
      bundle([['BBCNews.uk', ['BBC News']]]),
      index,
      new Map(),
      DEFAULT_SETTINGS,
      [],
      buildOverrideIndex([{ site: '*', site_id: 'BBCNews.uk', channel: 'Nope.xx' }]),
    );
    assert.equal(links.get('BBCNews.uk')?.channel, 'BBCNews.uk');
  });

  it('falls back to fuzzy matching on display names', () => {
    const { links } = linkEpgChannels(
      bundle([['site-99', ['TRT 1 HD']]]),
      index,
      new Map(),
      DEFAULT_SETTINGS,
      ['TR'],
    );
    assert.equal(links.get('site-99')?.channel, 'TRT1.tr');
  });

  it('reports channels it cannot match instead of guessing', () => {
    const { links, unmatched } = linkEpgChannels(
      bundle([['site-1', ['Some Regional Station Nobody Knows']]]),
      index,
      new Map(),
      DEFAULT_SETTINGS,
    );
    assert.equal(links.size, 0);
    assert.equal(unmatched.length, 1);
  });
});

// ---------------------------------------------------------------------------
// logos
// ---------------------------------------------------------------------------

describe('buildLogoIndex', () => {
  const logo = (channel: string, inUse: boolean, w: number, h: number, url: string): Logo => ({
    channel,
    feed: null,
    in_use: inUse,
    tags: [],
    width: w,
    height: h,
    format: 'PNG',
    url,
  });

  it('prefers the in-use logo even when a larger one exists', () => {
    const index = buildLogoIndex([
      logo('A.us', false, 2000, 2000, 'big.png'),
      logo('A.us', true, 200, 200, 'official.png'),
    ]);
    assert.equal(index.get('A.us'), 'official.png');
  });

  it('otherwise prefers the largest', () => {
    const index = buildLogoIndex([
      logo('B.us', false, 100, 100, 'small.png'),
      logo('B.us', false, 800, 800, 'large.png'),
    ]);
    assert.equal(index.get('B.us'), 'large.png');
  });

  it('ignores entries with no channel or url', () => {
    const index = buildLogoIndex([logo('', false, 10, 10, 'x.png')]);
    assert.equal(index.size, 0);
  });
});

// ---------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------

describe('mapConcurrent', () => {
  it('preserves input order regardless of completion order', async () => {
    const result = await mapConcurrent(
      [30, 5, 20, 1],
      async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return ms;
      },
      { concurrency: 4 },
    );
    assert.deepEqual(result, [30, 5, 20, 1]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await mapConcurrent(
      Array.from({ length: 30 }, (_, i) => i),
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
      },
      { concurrency: 4 },
    );
    assert.ok(peak <= 4, `peak concurrency was ${peak}`);
  });

  it('isolates failures when tolerant', async () => {
    const result = await mapConcurrent(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      },
      { concurrency: 2, tolerant: true },
    );
    assert.deepEqual(result, [1, undefined, 3]);
  });

  it('reports progress for every item', async () => {
    let last = 0;
    await mapConcurrent([1, 2, 3, 4], async (n) => n, {
      concurrency: 2,
      onProgress: (done) => {
        last = done;
      },
    });
    assert.equal(last, 4);
  });
});

describe('createLimiter', () => {
  it('rejects a nonsensical limit', () => {
    assert.throws(() => createLimiter(0), RangeError);
  });

  it('keeps running after a rejection', async () => {
    const limit = createLimiter(1);
    await assert.rejects(limit(async () => Promise.reject(new Error('x'))));
    assert.equal(await limit(async () => 'ok'), 'ok');
  });
});

describe('shard', () => {
  it('partitions without loss or overlap', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const parts = [0, 1, 2].map((i) => shard(items, 3, i));
    assert.deepEqual([...parts.flat()].sort((a, b) => a - b), items);
  });

  it('returns everything for a single shard', () => {
    assert.deepEqual(shard([1, 2, 3], 1, 0), [1, 2, 3]);
  });

  it('rejects an out-of-range index', () => {
    assert.throws(() => shard([1], 2, 5), RangeError);
  });
});

describe('retry', () => {
  it('succeeds after transient failures', async () => {
    let attempts = 0;
    const value = await retry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error('flaky');
        return 'done';
      },
      { attempts: 4, baseDelayMs: 1 },
    );
    assert.equal(value, 'done');
    assert.equal(attempts, 3);
  });

  it('stops early when shouldRetry says no', async () => {
    let attempts = 0;
    await assert.rejects(
      retry(
        async () => {
          attempts++;
          throw new Error('permanent');
        },
        { attempts: 5, baseDelayMs: 1, shouldRetry: () => false },
      ),
    );
    assert.equal(attempts, 1);
  });
});
