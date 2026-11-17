/**
 * Daily sync of the iptv-org mirror (data/iptv-org) with upstream.
 *
 * Additions, corrections and removals upstream are applied automatically —
 * including blocklist entries, which is how takedowns filed with iptv-org
 * reach us. What is never applied automatically is a *mass* removal: if a
 * table would lose more than a set share of its rows in one day, the sync
 * refuses and keeps the last good copy, because that is what a broken export,
 * a format change or the project disappearing looks like. A human can then
 * look at the report and rerun with `--force`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../core/config.js';
import { Logger } from '../core/logger.js';
import { fetchUpstream, type UpstreamData } from '../aggregate/upstream.js';
import {
  MIRROR_DIR,
  TABLE_NAMES,
  readTable,
  recordKey,
  stableLine,
  writeTable,
  type MirrorMeta,
  type Table,
} from './index.js';

const log = new Logger('db-sync');

/** Removal share that blocks the sync, per table (default 10%). */
export const REMOVAL_LIMITS: Partial<Record<Table, number>> = {
  channels: 0.05,
  streams: 0.15,
  feeds: 0.1,
  guides: 0.2,
};
const DEFAULT_REMOVAL_LIMIT = 0.1;
/** Below this many removals a table never trips the guard. */
const REMOVAL_FLOOR = 50;

type Row = Record<string, unknown>;

export interface TableDiff {
  table: Table;
  before: number;
  after: number;
  added: number;
  removed: number;
  changed: number;
  /** A few examples of each, for the report. */
  samples: { added: string[]; removed: string[]; changed: string[] };
}

export interface SyncReport {
  synced_at: string;
  source: string;
  applied: boolean;
  blocked_by: string[];
  tables: TableDiff[];
}

const label = (table: Table, row: Row): string => {
  switch (table) {
    case 'channels':
      return `${row['id']} (${row['name']})`;
    case 'streams':
      return `${row['channel'] ?? '?'} ${row['url']}`;
    case 'blocklist':
      return `${row['channel']} — ${row['reason']} ${row['ref'] ?? ''}`.trim();
    default:
      return recordKey(table, row).replace(/\u0000/g, ' / ');
  }
};

export function diffTable(table: Table, before: readonly Row[], after: readonly Row[]): TableDiff {
  const old = new Map(before.map((row) => [recordKey(table, row), row]));
  const next = new Map(after.map((row) => [recordKey(table, row), row]));
  const diff: TableDiff = {
    table,
    before: old.size,
    after: next.size,
    added: 0,
    removed: 0,
    changed: 0,
    samples: { added: [], removed: [], changed: [] },
  };
  const sample = (kind: keyof TableDiff['samples'], row: Row) => {
    if (diff.samples[kind].length < 25) diff.samples[kind].push(label(table, row));
  };
  for (const [key, row] of next) {
    const previous = old.get(key);
    if (!previous) {
      diff.added++;
      sample('added', row);
    } else if (stableLine(previous) !== stableLine(row)) {
      diff.changed++;
      sample('changed', row);
    }
  }
  for (const [key, row] of old) {
    if (!next.has(key)) {
      diff.removed++;
      sample('removed', row);
    }
  }
  return diff;
}

/** Tables whose removals exceed their limit. An empty mirror never blocks. */
export function guard(diffs: readonly TableDiff[]): string[] {
  return diffs
    .filter((diff) => {
      if (diff.before === 0) return false;
      if (diff.after === 0) return true;
      const limit = REMOVAL_LIMITS[diff.table] ?? DEFAULT_REMOVAL_LIMIT;
      return diff.removed > REMOVAL_FLOOR && diff.removed / diff.before > limit;
    })
    .map(
      (diff) =>
        `${diff.table}: ${diff.removed} of ${diff.before} rows would be removed ` +
        `(limit ${Math.round((REMOVAL_LIMITS[diff.table] ?? DEFAULT_REMOVAL_LIMIT) * 100)}%)`,
    );
}

export async function syncDatabase(
  settings: Settings,
  options: { force?: boolean; upstream?: UpstreamData } = {},
): Promise<SyncReport> {
  const upstream = options.upstream ?? (await fetchUpstream({ ...settings, aggregate: { ...settings.aggregate, cache_ttl_minutes: 0 } }));
  const diffs: TableDiff[] = [];
  for (const table of TABLE_NAMES) {
    const before = await readTable(MIRROR_DIR, table);
    const after = (upstream[table] ?? []) as unknown as Row[];
    diffs.push(diffTable(table, before, after));
  }

  const blockedBy = guard(diffs);
  const report: SyncReport = {
    synced_at: new Date().toISOString(),
    source: upstream.source,
    applied: false,
    blocked_by: blockedBy,
    tables: diffs,
  };

  if (blockedBy.length > 0 && !options.force) {
    log.warn(`Refusing to sync: ${blockedBy.join('; ')}`);
    return report;
  }

  const changed = diffs.some((diff) => diff.added + diff.removed + diff.changed > 0);
  if (!changed) {
    log.info('Mirror already matches upstream');
    report.applied = true;
    return report;
  }

  for (const table of TABLE_NAMES) {
    await writeTable(MIRROR_DIR, table, (upstream[table] ?? []) as unknown as Row[]);
  }
  const meta: MirrorMeta = {
    source: upstream.source,
    synced_at: report.synced_at,
    counts: Object.fromEntries(diffs.map((diff) => [diff.table, diff.after])),
  };
  await fs.writeFile(path.join(MIRROR_DIR, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  report.applied = true;
  log.success(
    diffs
      .filter((diff) => diff.added + diff.removed + diff.changed > 0)
      .map((diff) => `${diff.table} +${diff.added} -${diff.removed} ~${diff.changed}`)
      .join(', '),
  );
  return report;
}

/** Markdown summary for the commit message, step summary and alert issue. */
export function reportMarkdown(report: SyncReport): string {
  const rows = report.tables
    .filter((diff) => diff.added + diff.removed + diff.changed > 0)
    .map((diff) => `| ${diff.table} | ${diff.after.toLocaleString('en')} | +${diff.added} | −${diff.removed} | ~${diff.changed} |`);
  const lines = [
    report.applied ? '## Database synced with iptv-org' : '## Database sync refused',
    '',
    ...(report.blocked_by.length > 0
      ? ['**Mass removal detected — the last good copy was kept:**', '', ...report.blocked_by.map((b) => `- ${b}`), '']
      : []),
    rows.length > 0 ? '| Table | Rows | Added | Removed | Changed |\n| --- | ---: | ---: | ---: | ---: |' : 'No changes.',
    ...rows,
  ];
  for (const table of ['channels', 'streams', 'blocklist'] as const) {
    const diff = report.tables.find((d) => d.table === table);
    if (!diff) continue;
    for (const kind of ['added', 'removed'] as const) {
      if (diff.samples[kind].length === 0) continue;
      lines.push('', `<details><summary>${table} ${kind} (${diff[kind]})</summary>`, '');
      lines.push(...diff.samples[kind].map((item) => `- \`${item}\``));
      if (diff[kind] > diff.samples[kind].length) lines.push(`- …and ${diff[kind] - diff.samples[kind].length} more`);
      lines.push('', '</details>');
    }
  }
  return `${lines.join('\n')}\n`;
}
