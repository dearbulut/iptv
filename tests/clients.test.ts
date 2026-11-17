import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildStremioAddon, STREMIO_PAGE_SIZE, type StremioChannel } from '../src/api/stremio.js';
import { buildXtreamIndex, pickXtreamStream } from '../src/api/xtream.js';

const stream = (url: string, status: string | null, extra: Partial<StremioChannel['streams'][number]> = {}) => ({
  url,
  title: 'Feed',
  referrer: null,
  user_agent: null,
  quality: '720p',
  browser_playable: url.startsWith('https://'),
  health: status ? { status, uptime: 90 } : null,
  ...extra,
});

const channel = (id: string, over: Partial<StremioChannel> = {}): StremioChannel => ({
  id,
  name: id,
  alt_names: [],
  country: 'TR',
  categories: ['news'],
  languages: ['tur'],
  is_nsfw: false,
  website: null,
  logo: null,
  number: 1,
  availability: 'online',
  score: 50,
  streams: [stream(`https://cdn.example/${id}.m3u8`, 'online')],
  ...over,
});

const ctx = {
  name: 'Nexus',
  description: 'Test.',
  version: '1.0.0',
  homepage: 'https://example.github.io/iptv',
  countries: new Map([['TR', 'Turkiye'], ['US', 'United States']]),
  categories: new Map([['news', 'News'], ['kids', 'Kids']]),
};

describe('Stremio addon', () => {
  it('lists only channels worth opening', () => {
    const files = buildStremioAddon(
      [
        channel('Live.tr'),
        channel('Geo.tr', { availability: 'regional' }),
        channel('Dead.tr', { availability: 'offline' }),
        channel('Adult.tr', { is_nsfw: true }),
      ],
      ctx,
    );
    const metas = (files.find((f) => f.path === 'catalog/tv/nexus-live.json')!.data as { metas: Array<{ id: string }> }).metas;
    assert.deepEqual(metas.map((m) => m.id), ['nexus-Live.tr', 'nexus-Geo.tr']);
    assert.ok(!files.some((f) => f.path.includes('Dead.tr')));
  });

  it('paginates with the skip extra and filters by genre and country', () => {
    const many = Array.from({ length: STREMIO_PAGE_SIZE + 5 }, (_, i) =>
      channel(`C${String(i).padStart(3, '0')}.us`, { country: 'US' }),
    );
    const paths = new Set(buildStremioAddon(many, ctx).map((f) => f.path));
    assert.ok(paths.has('catalog/tv/nexus-live/skip=100.json'));
    assert.ok(paths.has('catalog/tv/nexus-live/genre=News&skip=100.json'));
    assert.ok(paths.has('catalog/tv/nexus-country/genre=United States.json'));
    assert.ok(!paths.has('catalog/tv/nexus-live/skip=200.json'));
  });

  it('passes required headers through the streaming server', () => {
    const files = buildStremioAddon(
      [channel('Hdr.tr', { streams: [stream('https://cdn.example/x.m3u8', 'online', { referrer: 'https://site/', browser_playable: false })] })],
      ctx,
    );
    const data = files.find((f) => f.path === 'stream/tv/nexus-Hdr.tr.json')!.data as {
      streams: Array<{ behaviorHints: { notWebReady?: boolean; proxyHeaders?: { request: Record<string, string> } } }>;
    };
    assert.equal(data.streams[0]!.behaviorHints.notWebReady, true);
    assert.deepEqual(data.streams[0]!.behaviorHints.proxyHeaders, { request: { Referer: 'https://site/' } });
  });
});

describe('Xtream index', () => {
  it('uses the stable channel number as stream_id', () => {
    const index = buildXtreamIndex([channel('B.tr', { number: 42 }), channel('A.tr', { number: 7 })], {
      generatedAt: 'now',
      countries: ctx.countries,
      categories: ctx.categories,
    });
    assert.deepEqual(index.streams.map((row) => row[0]), [7, 42]);
    assert.deepEqual(index.categories.category[0], [1, 'News']);
    assert.deepEqual(index.categories.country, [[1, 'Turkiye']]);
  });

  it('prefers a stream a redirect can play: online and header-free', () => {
    const picked = pickXtreamStream(
      channel('X.tr', {
        streams: [
          stream('https://a/hdr.m3u8', 'online', { referrer: 'https://site/' }),
          stream('https://a/down.m3u8', 'offline'),
          stream('https://a/good.m3u8', 'online'),
        ],
      }),
    );
    assert.equal(picked?.url, 'https://a/good.m3u8');
  });

  it('never hands a redirect-only client a non-HTTP stream', () => {
    assert.equal(pickXtreamStream(channel('R.tr', { streams: [stream('rtmp://a/live', 'online')] })), null);
    const picked = pickXtreamStream(
      channel('M.tr', { streams: [stream('rtmp://a/live', 'online'), stream('http://a/x.m3u8', null)] }),
    );
    assert.equal(picked?.url, 'http://a/x.m3u8');
  });
});
