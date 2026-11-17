/**
 * The VOD catalogue: openly licensed films and series (config/vod.yml).
 *
 * Built weekly by the VOD workflow into `.data/vod.json` and kept on the
 * state branch; Sync turns it into the API, Xtream VOD and series, Stremio
 * movie and series catalogues and M3U playlists.
 *
 * Every film, series and episode has a permanent number — Xtream apps address
 * VOD by integer id and keep favourites and "continue watching" by it — so
 * numbers are carried over from the previous catalogue and never reused.
 */

import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { promises as fs } from 'node:fs';
import { PATHS } from '../core/config.js';
import { NEXUS_DIR, readTable } from '../database/index.js';
import { Logger } from '../core/logger.js';
import {
  type ArchiveDoc,
  type ArchiveFile,
  type VodLicense,
  type VideoFile,
  fetchFiles,
  isFamilySafe,
  languageOf,
  openLicense,
  pickVideos,
  plainText,
  POSTER,
  searchArchive,
  subjectsOf,
  titleOf,
  yearOf,
} from './archive.js';

const log = new Logger('vod');

export const VOD_PATH = path.join(PATHS.data, 'vod.json');

export interface VodSource {
  id: string;
  name: string;
  kind: 'movies' | 'series';
  category: string;
  query: string;
  max: number;
}

interface VodBase {
  id: string;
  number: number;
  title: string;
  year: number | null;
  description: string;
  categories: string[];
  tags: string[];
  language: string | null;
  poster: string;
  license: VodLicense;
  source_url: string;
  source: string;
}

export interface VodMovie extends VodBase {
  url: string;
  runtime: number | null;
}

export interface VodEpisode {
  id: string;
  number: number;
  episode: number;
  title: string;
  url: string;
  runtime: number | null;
}

export interface VodSeries extends VodBase {
  episodes: VodEpisode[];
}

export interface VodCatalog {
  version: 1;
  generated_at: string;
  /** Highest number ever assigned; numbers are never reused. */
  last: number;
  sources: Record<string, number>;
  movies: VodMovie[];
  series: VodSeries[];
}

/** Shorter videos are trailers, clips or fragments, not something to watch. */
export const MIN_SECONDS = 180;

/** The licence clause every query gets, so a config entry cannot forget it. */
const LICENSED = 'licenseurl:(*publicdomain* OR *creativecommons*)';

export async function loadVodSources(): Promise<VodSource[]> {
  const raw = parseYaml(await fs.readFile(path.join(PATHS.config, 'vod.yml'), 'utf8')) as { sources?: VodSource[] };
  return (raw.sources ?? []).filter((source) => source.id && source.query);
}

export async function loadVodCatalog(): Promise<VodCatalog | null> {
  try {
    const catalog = JSON.parse(await fs.readFile(VOD_PATH, 'utf8')) as VodCatalog;
    return Array.isArray(catalog.movies) ? catalog : null;
  } catch {
    return null;
  }
}

/** The archive.org identifier in a details, download or Films page link. */
export function archiveIdentifier(url: string): string | null {
  const match =
    url.match(/archive\.org\/(?:details|download|embed)\/([^/?#\s]+)/i) ?? url.match(/films\.html#(?:movies|series)\/([^/?#\s]+)/i);
  return match ? decodeURIComponent(match[1]!) : null;
}

/** Identifiers removed by takedown requests (data/nexus/blocklist.ndjson). */
export async function loadVodBlocklist(): Promise<Set<string>> {
  const rows = (await readTable(NEXUS_DIR, 'blocklist')) as Array<{
    url?: string;
  }>;
  return new Set(rows.map((row) => (row.url ? archiveIdentifier(row.url) : null)).filter((id): id is string => Boolean(id)));
}

/** The catalogue without titles removed by takedown requests. */
export function withoutBlocked(catalog: VodCatalog, blocked: ReadonlySet<string>): VodCatalog {
  if (blocked.size === 0) return catalog;
  return {
    ...catalog,
    movies: catalog.movies.filter((movie) => !blocked.has(movie.id)),
    series: catalog.series.filter((series) => !blocked.has(series.id)),
  };
}

/** Assigns numbers, keeping every number an id ever had. */
export class Numbering {
  private readonly known = new Map<string, number>();
  constructor(
    public last: number,
    previous: VodCatalog | null,
  ) {
    for (const movie of previous?.movies ?? []) this.known.set(movie.id, movie.number);
    for (const series of previous?.series ?? []) {
      this.known.set(series.id, series.number);
      for (const episode of series.episodes) this.known.set(episode.id, episode.number);
    }
  }
  get(id: string): number {
    let number = this.known.get(id);
    if (number === undefined) {
      number = ++this.last;
      this.known.set(id, number);
    }
    return number;
  }
}

/** Turns one archive item into a film or a series, or null when unusable. */
export function toEntry(
  doc: ArchiveDoc,
  files: readonly ArchiveFile[],
  source: VodSource,
  numbering: Numbering,
): { movie?: VodMovie; series?: VodSeries } | null {
  const license = openLicense(doc.licenseurl);
  if (!license || !isFamilySafe(doc)) return null;
  const videos = pickVideos(doc.identifier, files);
  if (videos.length === 0) return null;

  const base: VodBase = {
    id: doc.identifier,
    number: numbering.get(doc.identifier),
    title: titleOf(doc),
    year: yearOf(doc),
    description: plainText(doc.description),
    categories: [source.category],
    tags: subjectsOf(doc).slice(0, 8),
    language: languageOf(doc),
    poster: `${POSTER}/${encodeURIComponent(doc.identifier)}`,
    license,
    source_url: `https://archive.org/details/${encodeURIComponent(doc.identifier)}`,
    source: source.id,
  };

  // A film whose main file dwarfs the rest (trailers, extras) is one film.
  const main = [...videos].sort((a, b) => b.size - a.size)[0]!;
  const total = videos.reduce((sum, video) => sum + video.size, 0);
  const single = videos.length === 1 || (total > 0 && main.size / total >= 0.7);

  // A single episode or special is offered as a title of its own, not as a
  // one-episode series; trailers and clips are left out.
  if ((source.kind === 'movies' && single) || videos.length === 1) {
    if (main.duration !== null && main.duration < MIN_SECONDS) return null;
    return { movie: { ...base, url: main.url, runtime: main.duration } };
  }
  const episodes = videos.map((video: VideoFile, index) => {
    const id = `${doc.identifier}-e${index + 1}`;
    return {
      id,
      number: numbering.get(id),
      episode: index + 1,
      title: source.kind === 'movies' ? `Part ${index + 1}` : video.title,
      url: video.url,
      runtime: video.duration,
    };
  });
  return { series: { ...base, episodes } };
}

export interface BuildVodOptions {
  sources: readonly VodSource[];
  previous: VodCatalog | null;
  search?: (query: string, max: number) => Promise<ArchiveDoc[]>;
  files?: (identifiers: readonly string[]) => Promise<Map<string, ArchiveFile[]>>;
  /** archive.org identifiers removed by takedown requests. */
  blocked?: ReadonlySet<string>;
}

export async function buildVodCatalog(options: BuildVodOptions): Promise<VodCatalog> {
  const search = options.search ?? searchArchive;
  const files = options.files ?? ((ids) => fetchFiles(ids));
  const numbering = new Numbering(options.previous?.last ?? 0, options.previous);
  const counts: Record<string, number> = {};
  const movies = new Map<string, VodMovie>();
  const series = new Map<string, VodSeries>();

  for (const source of options.sources) {
    let docs = await search(`(${source.query}) AND ${LICENSED}`, source.max);
    if (docs.length === 0) {
      // Some indexes do not support wildcards on licenseurl; filter here instead.
      docs = (await search(source.query, source.max)).filter((doc) => openLicense(doc.licenseurl));
    }
    docs = docs.filter((doc) => openLicense(doc.licenseurl) && isFamilySafe(doc) && !options.blocked?.has(doc.identifier));
    const fresh = docs.filter((doc) => !movies.has(doc.identifier) && !series.has(doc.identifier));
    // Already seen through another source: just add this shelf.
    for (const doc of docs) {
      const existing = movies.get(doc.identifier) ?? series.get(doc.identifier);
      if (existing && !existing.categories.includes(source.category)) existing.categories.push(source.category);
    }
    const fileMap = await files(fresh.map((doc) => doc.identifier));
    let added = 0;
    for (const doc of fresh) {
      const entry = toEntry(doc, fileMap.get(doc.identifier) ?? [], source, numbering);
      if (entry?.movie) movies.set(doc.identifier, entry.movie);
      if (entry?.series) series.set(doc.identifier, entry.series);
      if (entry) added++;
    }
    counts[source.id] = added;
    log.info(`${source.name}: ${added} of ${docs.length} licensed item(s) playable`);
  }

  const catalog: VodCatalog = {
    version: 1,
    generated_at: new Date().toISOString(),
    last: numbering.last,
    sources: counts,
    movies: [...movies.values()].sort((a, b) => a.number - b.number),
    series: [...series.values()].sort((a, b) => a.number - b.number),
  };
  log.success(`VOD: ${catalog.movies.length} film(s), ${catalog.series.length} series`);
  return catalog;
}
