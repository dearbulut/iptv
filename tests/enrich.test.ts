import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// The enricher runs in the browser; it is plain ES modules with no DOM use.
// @ts-expect-error -- untyped JS module
import * as core from '../site/enrich-core.js';
import { changesAtom, computeChanges, HISTORY_LIMIT, normaliseHistory } from '../src/api/changes.js';

const { parseM3u, writeM3u, normaliseName, splitPrefix, buildMatcher, matchEntry, enrichPlaylist } = core;

const INDEX = {
  fields: ['id', 'name', 'alt', 'country', 'logo', 'number', 'state', 'guide'],
  channels: [
    ['TRT1.tr', 'TRT 1', '', 'TR', 'https://logo/trt1.png', 12, 2, 1],
    ['KanalD.tr', 'Kanal D', '', 'TR', '', 13, 2, 1],
    ['ShowTV.tr', 'Show TV', '', 'TR', '', 14, 1, 0],
    ['ARTTV.gr', 'ART TV', '', 'GR', '', 20, 1, 0],
    ['ART.gr', 'ART', '', 'GR', '', 21, 1, 0],
    ['UTV.cz', 'UTV', '', 'CZ', '', 30, 1, 0],
    ['UTVHD.in', 'UTV HD', '', 'IN', '', 31, 2, 0],
    ['DasErste.de', 'Das Erste', 'ARD', 'DE', '', 40, 2, 1],
    ['CanalPlus.fr', 'Canal+', '', 'FR', '', 50, 1, 0],
    ['Canal.fr', 'Canal', '', 'FR', '', 51, 1, 0],
  ],
};
const COUNTRIES = [
  { code: 'TR', name: 'Turkiye' },
  { code: 'DE', name: 'Germany' },
  { code: 'GR', name: 'Greece' },
  { code: 'CZ', name: 'Czech Republic' },
  { code: 'IN', name: 'India' },
  { code: 'FR', name: 'France' },
];
const matcher = buildMatcher(INDEX, COUNTRIES);
const entry = (title: string, attrs: Record<string, string> = {}, url = 'http://p/1') => ({
  duration: '-1',
  attrs,
  title,
  url,
  extra: [],
});
const idOf = (e: ReturnType<typeof entry>) => matchEntry(e, matcher)?.channel.id ?? null;

describe('M3U parsing', () => {
  it('round-trips attributes, titles with commas and option lines', () => {
    const text = [
      '#EXTM3U x-tvg-url="http://g"',
      '#EXTINF:-1 tvg-id="" group-title="News, Live",Name, with comma',
      '#EXTVLCOPT:http-referrer=https://r/',
      'http://s/1.m3u8',
      '#EXTINF:0,Plain',
      'http://s/2.ts',
    ].join('\n');
    const parsed = parseM3u(text);
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.entries[0].title, 'Name, with comma');
    assert.equal(parsed.entries[0].attrs['group-title'], 'News, Live');
    assert.deepEqual(parsed.entries[0].extra, ['#EXTVLCOPT:http-referrer=https://r/']);
    assert.deepEqual(parseM3u(writeM3u(parsed.header, parsed.entries)), parsed);
  });
});

describe('name normalisation', () => {
  it('drops feed words and accents but keeps words that are part of a name', () => {
    assert.equal(normaliseName('TRT 1 FHD'), 'trt1');
    assert.equal(normaliseName('Kanal D HD'), 'kanald');
    assert.equal(normaliseName('Canal+'), 'canalplus');
    assert.equal(normaliseName('Çocuk Kanalı'), 'cocukkanali');
  });

  it('only treats real tags as prefixes', () => {
    assert.deepEqual(splitPrefix('TR: TRT 1'), { tag: 'TR', rest: 'TRT 1' });
    assert.deepEqual(splitPrefix('|DE| Das Erste'), { tag: 'DE', rest: 'Das Erste' });
    assert.deepEqual(splitPrefix('[FR] Canal+'), { tag: 'FR', rest: 'Canal+' });
    assert.equal(splitPrefix('ATV-Avrupa').tag, null);
  });
});

describe('matching', () => {
  it('uses an existing Nexus tvg-id first, even with a feed suffix', () => {
    assert.equal(idOf(entry('whatever', { 'tvg-id': 'TRT1.tr@HD' })), 'TRT1.tr');
  });

  it('matches provider-style names', () => {
    assert.equal(idOf(entry('TR: TRT 1 FHD')), 'TRT1.tr');
    assert.equal(idOf(entry('|TR| KANAL D HD')), 'KanalD.tr');
    assert.equal(idOf(entry('ARD', { 'group-title': 'DE | Vollprogramm' })), 'DasErste.de');
  });

  it('prefers the exact spelling over a shorter channel', () => {
    assert.equal(idOf(entry('ART TV')), 'ARTTV.gr');
    assert.equal(idOf(entry('Canal+ HD')), 'CanalPlus.fr');
  });

  it('lets the country hint beat a spelling match elsewhere', () => {
    assert.equal(idOf(entry('|CZ| UTV HD')), 'UTV.cz');
    assert.equal(idOf(entry('UTV HD', { 'group-title': 'Czech Republic' })), 'UTV.cz');
  });

  it('uses fuzzy matching only inside a hinted country', () => {
    const close = matchEntry(entry('TR: Show TVV'), matcher);
    assert.equal(close?.channel.id, 'ShowTV.tr');
    assert.equal(close?.method, 'fuzzy');
    assert.equal(matchEntry(entry('Show TVV'), matcher), null);
  });

  it('leaves VOD entries and unknown channels untouched', () => {
    const parsed = {
      header: { attrs: {}, raw: '#EXTM3U' },
      entries: [
        entry('TR: TRT 1', { 'tvg-logo': 'mine.png' }),
        entry('Some Movie', {}, 'http://p/movie/u/p/1.mkv'),
        entry('Nobody Knows This'),
      ],
    };
    const out = enrichPlaylist(parsed, matcher, { numbers: true, guideUrl: 'http://guide' });
    assert.equal(out.entries[0].attrs['tvg-id'], 'TRT1.tr');
    assert.equal(out.entries[0].attrs['tvg-logo'], 'mine.png', 'an existing logo is kept');
    assert.equal(out.entries[0].attrs['tvg-chno'], '12');
    assert.equal(out.entries[0].url, 'http://p/1', 'the stream is never changed');
    assert.equal(out.entries[1], parsed.entries[1]);
    assert.equal(out.entries[2], parsed.entries[2]);
    assert.equal(out.header.attrs['x-tvg-url'], 'http://guide');
    assert.deepEqual(
      { total: out.summary.total, vod: out.summary.vod, matched: out.summary.matched, withGuide: out.summary.withGuide },
      { total: 2, vod: 1, matched: 1, withGuide: 1 },
    );
  });
});

describe('catalogue changes', () => {
  const ch = (id: string, playable = true) => ({ id, name: id, country: 'TR', playable });

  it('records nothing on the first build', () => {
    const result = computeChanges(null, [ch('A.tr')], normaliseHistory(null), 't0');
    assert.equal(result.entry, null);
    assert.deepEqual(result.snapshot.playable, ['A.tr']);
  });

  it('reports channels that became and stopped being watchable', () => {
    const first = computeChanges(null, [ch('A.tr'), ch('B.tr')], normaliseHistory(null), 't0');
    const second = computeChanges(first.snapshot, [ch('A.tr'), ch('B.tr', false), ch('C.tr')], first.history, 't1');
    assert.deepEqual(second.entry?.added.map((c) => c.id), ['C.tr']);
    assert.deepEqual(second.entry?.removed.map((c) => c.id), ['B.tr']);
    assert.equal(second.history.entries.length, 1);
    const third = computeChanges(second.snapshot, [ch('A.tr'), ch('C.tr')], second.history, 't2');
    assert.equal(third.entry, null, 'no news is not an entry');
  });

  it('keeps a bounded history and writes valid, escaped Atom', () => {
    let history = normaliseHistory(null);
    let snapshot = computeChanges(null, [], history, 't').snapshot;
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      const next = computeChanges(snapshot, [ch(`C${i}.tr`)], history, `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`);
      snapshot = next.snapshot;
      history = next.history;
    }
    assert.equal(history.entries.length, HISTORY_LIMIT);
    const atom = changesAtom(
      { version: 1, entries: [{ at: '2026-01-01T00:00:00Z', added: [{ id: 'A&B.tr', name: 'A & <B>', country: 'TR' }], removed: [], playable: 1 }] },
      { title: 'Nexus', siteUrl: 'https://x', feedUrl: 'https://x/feed', updated: 'now' },
    );
    assert.ok(atom.includes('A &amp;amp; &amp;lt;B&amp;gt;'));
    assert.ok(!atom.includes('<B>'));
  });
});
