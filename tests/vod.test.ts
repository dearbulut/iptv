import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isFamilySafe,
  openLicense,
  parseDuration,
  pickVideos,
  plainText,
  yearOf,
  type ArchiveDoc,
  type ArchiveFile,
} from '../src/vod/archive.js';
import {
  archiveIdentifier,
  buildVodCatalog,
  Numbering,
  toEntry,
  withoutBlocked,
  type VodCatalog,
  type VodSource,
} from '../src/vod/index.js';
import { extractTargets } from '../src/database/community.js';
import { stremioVod, VOD_PREFIX, vodApi, vodPlaylists, xtreamVod } from '../src/api/vod.js';

const films: VodSource = {
  id: 'films',
  name: 'Films',
  kind: 'movies',
  category: 'Feature Films',
  query: 'collection:feature_films',
  max: 10,
};
const noir: VodSource = {
  id: 'noir',
  name: 'Noir',
  kind: 'movies',
  category: 'Film Noir',
  query: 'collection:Film_Noir',
  max: 10,
};
const tv: VodSource = {
  id: 'tv',
  name: 'TV',
  kind: 'series',
  category: 'Classic TV',
  query: 'collection:classic_tv',
  max: 10,
};

const PD = 'http://creativecommons.org/publicdomain/mark/1.0/';

const doc = (identifier: string, over: Partial<ArchiveDoc> = {}): ArchiveDoc => ({
  identifier,
  title: identifier.replace(/_/g, ' '),
  year: '1950',
  description: '<p>A <b>classic</b>&nbsp;film.</p>',
  licenseurl: PD,
  subject: ['drama'],
  ...over,
});

const film: ArchiveFile[] = [
  { name: 'Movie.avi', format: 'Cinepack', size: '900000000' },
  { name: 'Movie.mp4', format: 'h.264', size: '500000000', length: '5400.4' },
  {
    name: 'Movie_512kb.mp4',
    format: '512Kb MPEG4',
    size: '300000000',
    length: '5400.4',
  },
  { name: 'Movie.ogv', format: 'Ogg Video', size: '200000000' },
  { name: 'Movie.jpg', format: 'JPEG' },
];

const episodes: ArchiveFile[] = [
  {
    name: 'Show_Ep10.mp4',
    format: 'h.264',
    size: '100',
    length: '25:00',
    title: 'The Finale',
  },
  { name: 'Show_Ep2.mp4', format: 'h.264', size: '100', length: '25:00' },
  { name: 'Show_Ep1.mp4', format: 'h.264', size: '100', length: '25:00' },
];

describe('VOD: archive.org parsing', () => {
  it('accepts only public-domain and Creative Commons licences', () => {
    assert.deepEqual(openLicense(PD), {
      label: 'Public Domain',
      url: 'https://creativecommons.org/publicdomain/mark/1.0/',
    });
    assert.equal(openLicense('https://creativecommons.org/publicdomain/zero/1.0/')?.label, 'CC0');
    assert.equal(openLicense('https://creativecommons.org/licenses/by-sa/4.0/')?.label, 'CC BY-SA');
    assert.equal(openLicense('http://creativecommons.org/licenses/publicdomain/')?.label, 'Public Domain');
    assert.equal(openLicense('https://creativecommons.org/licenses/by-nd-nc/1.0/')?.label, 'CC BY-NC-ND');
    assert.equal(openLicense('https://creativecommons.org/licenses/nd-nc/1.0/')?.label, 'CC NC-ND');
    assert.equal(openLicense('https://creativecommons.org/licenses/whatever/'), null);
    assert.equal(openLicense(undefined), null);
    assert.equal(openLicense(''), null);
    assert.equal(openLicense('https://example.com/all-rights-reserved'), null);
  });

  it('keeps adult material out', () => {
    assert.equal(isFamilySafe(doc('a')), true);
    assert.equal(isFamilySafe(doc('b', { subject: ['stag film'] })), false);
    assert.equal(isFamilySafe(doc('c', { title: 'Erotica 1920' })), false);
  });

  it('picks the most playable derivative of each original', () => {
    const videos = pickVideos('Movie_1950', film);
    assert.equal(videos.length, 1);
    assert.equal(videos[0]!.format, 'h.264');
    assert.equal(videos[0]!.url, 'https://archive.org/download/Movie_1950/Movie.mp4');
    assert.equal(videos[0]!.duration, 5400);
  });

  it('orders episodes naturally', () => {
    const videos = pickVideos('Show', episodes);
    assert.deepEqual(
      videos.map((v) => v.name),
      ['Show_Ep1.mp4', 'Show_Ep2.mp4', 'Show_Ep10.mp4'],
    );
    assert.equal(videos[2]!.title, 'The Finale');
    assert.equal(videos[0]!.title, 'Show Ep1');
  });

  it('parses durations, years and descriptions', () => {
    assert.equal(parseDuration('1:30:00'), 5400);
    assert.equal(parseDuration('90:00'), 5400);
    assert.equal(parseDuration('x'), null);
    assert.equal(yearOf({ identifier: 'x', date: '1946-05-01' }), 1946);
    assert.equal(yearOf({ identifier: 'x' }), null);
    assert.equal(plainText('<p>A <b>classic</b>&nbsp;film.</p>'), 'A classic film.');
  });
});

describe('VOD: catalogue', () => {
  it('turns a single-video item into a film and a multi-video item into a series', () => {
    const numbering = new Numbering(0, null);
    const movie = toEntry(doc('Movie_1950'), film, films, numbering);
    assert.equal(movie?.movie?.title, 'Movie 1950');
    assert.equal(movie?.movie?.license.label, 'Public Domain');
    assert.equal(movie?.movie?.poster, 'https://archive.org/services/img/Movie_1950');

    const show = toEntry(doc('Show'), episodes, tv, numbering);
    assert.equal(show?.series?.episodes.length, 3);
    assert.deepEqual(
      show?.series?.episodes.map((e) => e.id),
      ['Show-e1', 'Show-e2', 'Show-e3'],
    );

    // A "film" split into equal reels is offered as parts.
    const reels = toEntry(doc('Reels'), episodes, films, numbering);
    assert.equal(reels?.series?.episodes[0]?.title, 'Part 1');
  });

  it('offers a lone episode as a title and drops clips', () => {
    const numbering = new Numbering(0, null);
    const lone = toEntry(doc('Special'), [{ name: 'Special.mp4', format: 'h.264', size: '1', length: '1500' }], tv, numbering);
    assert.equal(lone?.movie?.categories[0], 'Classic TV');
    assert.equal(lone?.series, undefined);
    assert.equal(toEntry(doc('Trailer'), [{ name: 't.mp4', format: 'h.264', size: '1', length: '95' }], films, numbering), null);
  });

  it('rejects unlicensed or unplayable items', () => {
    const numbering = new Numbering(0, null);
    assert.equal(toEntry(doc('x', { licenseurl: undefined }), film, films, numbering), null);
    assert.equal(toEntry(doc('y'), [{ name: 'a.jpg', format: 'JPEG' }], films, numbering), null);
  });

  const search = async (query: string) => {
    assert.match(query, /licenseurl/);
    if (query.includes('feature_films')) return [doc('Movie_1950'), doc('Unlicensed', { licenseurl: 'https://example.com' })];
    if (query.includes('Film_Noir')) return [doc('Movie_1950'), doc('Noir_1947')];
    return [doc('Show')];
  };
  const files = async (ids: readonly string[]) => new Map(ids.map((id) => [id, id === 'Show' ? episodes : film] as const));

  it('builds, shares items across shelves and keeps numbers stable', async () => {
    const first = await buildVodCatalog({
      sources: [films, noir, tv],
      previous: null,
      search,
      files,
    });
    assert.deepEqual(
      first.movies.map((m) => m.id),
      ['Movie_1950', 'Noir_1947'],
    );
    assert.deepEqual(first.movies[0]!.categories, ['Feature Films', 'Film Noir']);
    assert.equal(first.series.length, 1);
    assert.deepEqual(first.sources, { films: 1, noir: 1, tv: 1 });

    // Next week Movie_1950 is gone and a new film arrives: no number is reused.
    const later = async (query: string) =>
      query.includes('feature_films') ? [doc('New_1931')] : query.includes('Film_Noir') ? [doc('Noir_1947')] : [doc('Show')];
    const second = await buildVodCatalog({
      sources: [films, noir, tv],
      previous: first,
      search: later,
      files,
    });
    const number = (c: VodCatalog, id: string) => [...c.movies, ...c.series].find((t) => t.id === id)?.number;
    assert.equal(number(second, 'Noir_1947'), number(first, 'Noir_1947'));
    assert.equal(number(second, 'Show'), number(first, 'Show'));
    assert.equal(second.series[0]!.episodes[1]!.number, first.series[0]!.episodes[1]!.number);
    assert.equal(number(second, 'New_1931'), first.last + 1);
  });

  it('publishes Xtream, Stremio, M3U and API views', async () => {
    const catalog = await buildVodCatalog({
      sources: [films, noir, tv],
      previous: null,
      search,
      files,
    });

    const x = xtreamVod(catalog);
    assert.deepEqual(x.categories.movies, [
      [1, 'Feature Films'],
      [2, 'Film Noir'],
    ]);
    assert.equal(x.movies.length, 2);
    assert.equal(x.movies[0]!.length, 9);
    assert.deepEqual(x.movies[0]![4], [1, 2]);
    assert.equal(x.series[0]!.episodes.length, 3);

    const { files: stremioFiles, catalogs } = stremioVod(catalog);
    assert.deepEqual(
      catalogs.map((c) => c.id),
      ['nexus-movies', 'nexus-series'],
    );
    const paths = stremioFiles.map((f) => f.path);
    assert.ok(paths.includes(`stream/movie/${VOD_PREFIX}Movie_1950.json`));
    assert.ok(paths.includes(`meta/series/${VOD_PREFIX}Show.json`));
    assert.ok(paths.includes(`stream/series/${VOD_PREFIX}Show-e3.json`));
    assert.ok(paths.includes('catalog/movie/nexus-movies/genre=Film Noir.json'));

    const m3u = vodPlaylists(catalog);
    assert.equal(m3u.movies.split('\n').filter((l) => l.startsWith('#EXTINF')).length, 2);
    assert.equal(m3u.series.split('\n').filter((l) => l.startsWith('#EXTINF')).length, 3);

    assert.deepEqual(vodApi(catalog).counts, {
      movies: 2,
      series: 1,
      episodes: 3,
    });
  });
});

describe('VOD: takedowns', () => {
  it('recognises archive.org and Films page links', () => {
    assert.equal(archiveIdentifier('https://archive.org/details/Movie_1950'), 'Movie_1950');
    assert.equal(archiveIdentifier('https://archive.org/download/Movie_1950/Movie.mp4'), 'Movie_1950');
    assert.equal(archiveIdentifier('https://dearbulut.github.io/iptv/films.html#series/Show'), 'Show');
    assert.equal(archiveIdentifier('https://example.com/live.m3u8'), null);
  });

  it('turns a Films page link in a takedown into the archive.org item', () => {
    const targets = extractTargets('https://dearbulut.github.io/iptv/films.html#movies/Movie_1950', []);
    assert.deepEqual(targets.urls, ['https://archive.org/details/Movie_1950']);
    assert.deepEqual(targets.unknown, []);
  });

  it('drops blocked titles from a build and from a stored catalogue', async () => {
    const search = async () => [doc('Movie_1950'), doc('Noir_1947')];
    const files = async (ids: readonly string[]) => new Map(ids.map((id) => [id, film] as const));
    const built = await buildVodCatalog({
      sources: [films],
      previous: null,
      search,
      files,
      blocked: new Set(['Noir_1947']),
    });
    assert.deepEqual(
      built.movies.map((m) => m.id),
      ['Movie_1950'],
    );
    assert.deepEqual(withoutBlocked(built, new Set(['Movie_1950'])).movies, []);
    assert.equal(withoutBlocked(built, new Set()), built);
  });
});
