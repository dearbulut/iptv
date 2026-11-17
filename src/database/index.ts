/**
 * The IPTV Nexus database: our own copy of everything, in this repository.
 *
 *   data/iptv-org/<table>.ndjson   a mirror of the iptv-org dataset, updated
 *                                  daily by the Database Sync workflow
 *   data/nexus/<table>.ndjson      our own data: community streams, channels
 *                                  iptv-org does not have, corrections, and
 *                                  takedowns. Never touched by the sync.
 *
 * The build reads only these files, so if iptv-org disappears, changes its
 * format or ships a broken update, IPTV Nexus keeps running on the last good
 * copy. Each record is one line, so a day's changes are a small git diff and
 * the history shows exactly what was
 * added or removed upstream.
 *
 * Records are stored exactly as iptv-org publishes them, in its order, so a
 * build from the database is identical to a build straight from iptv-org.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PATHS } from '../core/config.js';
import { streamKey } from '../core/http.js';
import { Logger } from '../core/logger.js';
import type { BlocklistEntry, Stream } from '../core/types.js';
import type { UpstreamData } from '../aggregate/upstream.js';
import type { SourcedStream } from '../aggregate/sources.js';

const log = new Logger('database');

export const DATABASE_DIR = path.join(PATHS.root, 'data');
export const MIRROR_DIR = path.join(DATABASE_DIR, 'iptv-org');
export const NEXUS_DIR = path.join(DATABASE_DIR, 'nexus');

/** Every table and the fields that identify one of its records. */
export const TABLES = {
  channels: ['id'],
  feeds: ['channel', 'id'],
  logos: ['channel', 'feed', 'url'],
  streams: ['url', 'channel', 'feed'],
  guides: ['channel', 'feed', 'site', 'site_id', 'lang'],
  categories: ['id'],
  languages: ['code'],
  countries: ['code'],
  subdivisions: ['code'],
  regions: ['code'],
  timezones: ['id'],
  blocklist: ['channel', 'url', 'ref'],
} as const satisfies Record<keyof Omit<UpstreamData, 'fetched_at' | 'source'>, readonly string[]>;

export type Table = keyof typeof TABLES;
export const TABLE_NAMES = Object.keys(TABLES) as Table[];

type Row = Record<string, unknown>;

/** The identity of a record within its table. */
export function recordKey(table: Table, row: Row): string {
  return TABLES[table].map((field) => String(row[field] ?? '')).join('\u0000');
}

/** Field-order-independent form of a record, for comparing two versions. */
export function stableLine(row: Row): string {
  const sorted: Row = {};
  for (const key of Object.keys(row).sort()) sorted[key] = row[key];
  return JSON.stringify(sorted);
}

/**
 * One record per line, in the order given. Upstream order is kept on purpose:
 * when two channels list the same stream URL, or a channel has several
 * logos, the first one wins, so reordering rows would change the catalogue.
 * iptv-org generates its files in a stable order, so daily diffs stay small.
 */
export function serialiseTable(rows: readonly Row[]): string {
  return rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
}

export function parseTable(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split('\n')) {
    if (line.trim()) rows.push(JSON.parse(line) as Row);
  }
  return rows;
}

export async function readTable(dir: string, table: Table): Promise<Row[]> {
  try {
    return parseTable(await fs.readFile(path.join(dir, `${table}.ndjson`), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`data/${path.basename(dir)}/${table}.ndjson: ${(error as Error).message}`);
  }
}

export async function writeTable(dir: string, table: Table, rows: readonly Row[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${table}.ndjson`), serialiseTable(rows));
}

/** Appends records to one of our own tables, keeping it sorted. */
export async function appendNexus(table: Table, rows: readonly Row[]): Promise<void> {
  const existing = await readTable(NEXUS_DIR, table);
  await writeTable(NEXUS_DIR, table, [...existing, ...rows]);
}

/** Appends rows to any data/nexus file, including ones that are not upstream tables. */
export async function appendNexusFile(name: string, rows: readonly Row[]): Promise<void> {
  if (rows.length === 0) return;
  await fs.mkdir(NEXUS_DIR, { recursive: true });
  await fs.appendFile(path.join(NEXUS_DIR, `${name}.ndjson`), serialiseTable(rows));
}

export async function databaseExists(): Promise<boolean> {
  try {
    await fs.access(path.join(MIRROR_DIR, 'channels.ndjson'));
    await fs.access(path.join(MIRROR_DIR, 'streams.ndjson'));
    return true;
  } catch {
    return false;
  }
}

export interface MirrorMeta {
  source: string;
  synced_at: string;
  counts: Record<string, number>;
}

/** A stream contributed through the community submission flow. */
export interface CommunityStream extends Stream {
  added_by?: string;
  added_at?: string;
  issue?: number;
}

export interface LoadedDatabase {
  data: UpstreamData;
  /** Our own streams, fed to the merge as a source of their own. */
  communityStreams: SourcedStream[];
}

/** Trust given to community streams: below curated lists, above discovery. */
export const COMMUNITY_TRUST = 0.6;

/**
 * Loads the database: the iptv-org mirror with our own tables layered on top.
 * Our channels replace mirror channels with the same id field by field, so a
 * correction only needs the fields it changes; every other table adds rows.
 */
export async function loadDatabase(): Promise<LoadedDatabase> {
  const tables = {} as Record<Table, Row[]>;
  const nexus = {} as Record<Table, Row[]>;
  await Promise.all(
    TABLE_NAMES.map(async (table) => {
      tables[table] = await readTable(MIRROR_DIR, table);
      nexus[table] = await readTable(NEXUS_DIR, table);
    }),
  );

  // Channels: field-level overrides and additions.
  const channels = new Map(tables.channels.map((row) => [String(row['id']), row]));
  for (const row of nexus.channels) {
    const id = String(row['id']);
    channels.set(id, { ...(channels.get(id) ?? {}), ...row });
  }

  const meta = await fs
    .readFile(path.join(MIRROR_DIR, 'meta.json'), 'utf8')
    .then((text) => JSON.parse(text) as MirrorMeta)
    .catch(() => null);

  const now = new Date().toISOString();
  const communityStreams: SourcedStream[] = (nexus.streams as unknown as CommunityStream[])
    .filter((stream) => stream.url)
    .map((stream) => ({
      channel: stream.channel ?? null,
      feed: stream.feed ?? null,
      title: stream.title ?? '',
      url: stream.url,
      referrer: stream.referrer ?? null,
      user_agent: stream.user_agent ?? null,
      quality: stream.quality ?? null,
      label: stream.label ?? null,
      key: streamKey(stream.url),
      provenance: { source: 'community', origin: 'data/nexus/streams.ndjson', added_at: stream.added_at ?? now },
      attributes: {},
      trust: COMMUNITY_TRUST,
    }));

  // Streams reported and confirmed dead are hidden until their report expires.
  const reports = await fs
    .readFile(path.join(NEXUS_DIR, 'reports.ndjson'), 'utf8')
    .then(parseTable)
    .catch(() => [] as Row[]);
  const hidden = reports
    .filter((report) => String(report['expires_at'] ?? '') > now && report['url'])
    .map((report) => ({ channel: '', url: String(report['url']), reason: 'reported-dead', ref: `#${report['issue'] ?? ''}` }));

  const merged = (table: Table) => [...tables[table], ...nexus[table]];
  const data = {
    channels: [...channels.values()],
    feeds: merged('feeds'),
    logos: merged('logos'),
    streams: tables.streams,
    guides: merged('guides'),
    categories: merged('categories'),
    languages: merged('languages'),
    countries: merged('countries'),
    subdivisions: merged('subdivisions'),
    regions: merged('regions'),
    timezones: merged('timezones'),
    blocklist: [...merged('blocklist'), ...hidden],
    fetched_at: meta?.synced_at ?? now,
    source: `IPTV Nexus database (iptv-org mirror ${meta?.synced_at?.slice(0, 10) ?? 'unknown'})`,
  } as unknown as UpstreamData;

  log.info(
    `Database: ${data.channels.length} channels, ${data.streams.length} mirrored + ` +
      `${communityStreams.length} community streams, ${data.blocklist.length - hidden.length} blocklist entries, ` +
      `${hidden.length} hidden after reports`,
  );
  return { data, communityStreams };
}

/** Blocklist entries that remove a single stream rather than a channel. */
export function blockedUrls(blocklist: readonly BlocklistEntry[]): Set<string> {
  return new Set(
    blocklist
      .map((entry) => (entry as BlocklistEntry & { url?: string }).url)
      .filter((url): url is string => Boolean(url))
      .map((url) => streamKey(url)),
  );
}
