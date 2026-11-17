/**
 * A single-file SQLite copy of the database, published weekly as a release
 * asset (see .github/workflows/dump.yml) so developers can query everything
 * with any SQLite client instead of downloading dozens of JSON files.
 *
 * Tables mirror data/ — iptv-org copy with our own data layered on, exactly
 * as the build sees it — plus, when the live API is supplied, the health and
 * status the build computed (channel numbers, availability, per-stream
 * uptime). Array and object fields are stored as JSON text.
 */

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { Logger } from '../core/logger.js';
import { loadDatabase, NEXUS_DIR, readTable } from './index.js';

const log = new Logger('dump');
// node:sqlite is built into Node 22; loaded lazily so nothing else depends on it.
const require = createRequire(import.meta.url);

type Row = Record<string, unknown>;

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...values: unknown[]): unknown };
  close(): void;
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

function toSql(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Creates a table from the union of the rows' fields, then inserts them. */
export function insertTable(db: SqliteDatabase, name: string, rows: readonly Row[], primaryKey?: string): number {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  if (columns.length === 0) columns.push('id');
  const definitions = columns.map((column) =>
    column === primaryKey ? `${quoteIdent(column)} PRIMARY KEY` : quoteIdent(column),
  );
  db.exec(`CREATE TABLE ${quoteIdent(name)} (${definitions.join(', ')})`);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO ${quoteIdent(name)} (${columns.map(quoteIdent).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  );
  db.exec('BEGIN');
  for (const row of rows) insert.run(...columns.map((column) => toSql(row[column])));
  db.exec('COMMIT');
  return rows.length;
}

export interface DumpOptions {
  out: string;
  /** Path to a built api/v1/channels.json, for status and health tables. */
  channelsJson?: string;
}

export async function buildDump(options: DumpOptions): Promise<Record<string, number>> {
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDatabase };
  await fs.rm(options.out, { force: true });
  const db = new DatabaseSync(options.out);
  const counts: Record<string, number> = {};
  const { data, communityStreams } = await loadDatabase();

  const add = (name: string, rows: readonly Row[], primaryKey?: string) => {
    counts[name] = insertTable(db, name, rows, primaryKey);
  };

  add('channels', data.channels as unknown as Row[], 'id');
  add('feeds', data.feeds as unknown as Row[]);
  add('logos', data.logos as unknown as Row[]);
  add('streams', [
    ...(data.streams as unknown as Row[]).map((stream) => ({ ...stream, source: 'iptv-org' })),
    ...communityStreams.map((stream) => ({
      channel: stream.channel,
      feed: stream.feed,
      title: stream.title,
      url: stream.url,
      referrer: stream.referrer,
      user_agent: stream.user_agent,
      quality: stream.quality,
      source: 'community',
    })),
  ]);
  add('guides', data.guides as unknown as Row[]);
  add('categories', data.categories as unknown as Row[], 'id');
  add('languages', data.languages as unknown as Row[], 'code');
  add('countries', data.countries as unknown as Row[], 'code');
  add('subdivisions', data.subdivisions as unknown as Row[], 'code');
  add('regions', data.regions as unknown as Row[], 'code');
  add('timezones', data.timezones as unknown as Row[], 'id');
  add('blocklist', data.blocklist as unknown as Row[]);
  add('reports', await readTable(NEXUS_DIR, 'reports' as never).catch(() => []));

  if (options.channelsJson) {
    const built = JSON.parse(await fs.readFile(options.channelsJson, 'utf8')) as Row[];
    add(
      'channel_status',
      built.map((channel) => ({
        id: channel['id'],
        number: channel['number'],
        availability: channel['availability'],
        online: channel['online'],
        score: channel['score'],
        browser_playable: channel['browser_playable'],
        best_quality: channel['best_quality'],
        stream_count: channel['stream_count'],
      })),
      'id',
    );
    add(
      'stream_health',
      built.flatMap((channel) =>
        ((channel['streams'] as Row[] | undefined) ?? []).map((stream) => {
          const health = (stream['health'] ?? {}) as Row;
          return {
            url: stream['url'],
            channel: channel['id'],
            status: health['status'] ?? 'unchecked',
            score: health['score'] ?? null,
            uptime: health['uptime'] ?? null,
            history: health['history'] ?? null,
            latency_ms: health['latency_ms'] ?? null,
            resolution: (health['media'] as Row | undefined)?.['resolution'] ?? stream['quality'] ?? null,
            checked_at: health['checked_at'] ?? null,
            last_online: health['last_online'] ?? null,
            browser_playable: stream['browser_playable'] ?? null,
          };
        }),
      ),
    );
  }

  db.exec(`
    CREATE INDEX idx_feeds_channel ON feeds(channel);
    CREATE INDEX idx_logos_channel ON logos(channel);
    CREATE INDEX idx_streams_channel ON streams(channel);
    CREATE INDEX idx_guides_channel ON guides(channel);
    CREATE INDEX idx_channels_country ON channels(country);
  `);
  if (counts['stream_health'] !== undefined) {
    db.exec(`
      CREATE INDEX idx_health_channel ON stream_health(channel);
      CREATE VIEW working_channels AS
        SELECT c.id, c.name, c.country, s.number, s.best_quality
        FROM channels c JOIN channel_status s ON s.id = c.id
        WHERE s.availability = 'online';
      CREATE VIEW channel_streams AS
        SELECT c.id AS channel, c.name, c.country, h.url, h.status, h.uptime, h.resolution
        FROM channels c JOIN stream_health h ON h.channel = c.id;
    `);
  }
  db.exec(`CREATE TABLE meta (key PRIMARY KEY, value)`);
  const meta = db.prepare('INSERT INTO meta VALUES (?, ?)');
  meta.run('generated_at', new Date().toISOString());
  meta.run('source', data.source);
  meta.run('license', 'Unlicense');
  meta.run('homepage', 'https://github.com/dearbulut/iptv');
  db.exec('VACUUM');
  db.close();
  log.success(Object.entries(counts).map(([table, n]) => `${table} ${n}`).join(', '));
  return counts;
}
