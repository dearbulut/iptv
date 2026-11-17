/** Aggregation entry point: upstream + extra sources → the canonical dataset. */

import { PATHS, loadConfig } from '../core/config.js';
import { readJsonOr, writeJson, ensureDir } from '../core/fs.js';
import { Logger } from '../core/logger.js';
import type {
  Category,
  Country,
  EnrichedChannel,
  EnrichedStream,
  Guide,
  HealthRecord,
  Language,
  Region,
  Subdivision,
  Timezone,
} from '../core/types.js';
import { buildLogoIndex, fetchUpstream, type UpstreamData } from './upstream.js';
import { databaseExists, loadDatabase } from '../database/index.js';
import type { SourcedStream } from './sources.js';
import { loadExtraSources } from './sources.js';
import { mergeDataset, type MergeResult } from './merge.js';

const log = new Logger('aggregate');

export interface Dataset {
  generated_at: string;
  channels: EnrichedChannel[];
  orphans: EnrichedStream[];
  guides: Guide[];
  categories: Category[];
  languages: Language[];
  countries: Country[];
  subdivisions: Subdivision[];
  regions: Region[];
  timezones: Timezone[];
  upstream: { source: string; fetched_at: string };
  stats: MergeResult['stats'];
}

/** Loads the persisted health database keyed by stream key. */
export async function loadHealthDb(): Promise<Map<string, HealthRecord>> {
  const records = await readJsonOr<HealthRecord[]>(PATHS.healthDb, []);
  return new Map(records.map((record) => [record.key, record]));
}

export async function saveHealthDb(records: Map<string, HealthRecord>): Promise<void> {
  await ensureDir(PATHS.data);
  await writeJson(PATHS.healthDb, [...records.values()], { pretty: false });
}

/** Reads the dataset produced by a previous `aggregate` run. */
export async function loadDataset(): Promise<Dataset | null> {
  return readJsonOr<Dataset | null>(PATHS.channelsDb, null);
}

export async function saveDataset(dataset: Dataset): Promise<void> {
  await ensureDir(PATHS.data);
  await writeJson(PATHS.channelsDb, dataset);
}

export interface AggregateOptions {
  /** Skip third-party sources and use upstream only. */
  upstreamOnly?: boolean;
  /** Pre-fetched upstream data, to avoid a second download. */
  upstream?: UpstreamData;
}

/** Runs the full aggregation and persists the result to `.data/channels.json`. */
export async function aggregate(options: AggregateOptions = {}): Promise<Dataset> {
  const config = await loadConfig();
  const { settings } = config;

  // Our own database (data/) is the source of truth. Fetching iptv-org
  // directly is only a fallback for a fresh checkout that has none yet.
  let upstream = options.upstream;
  let communityStreams: SourcedStream[] = [];
  if (!upstream) {
    if (await databaseExists()) {
      const database = await loadDatabase();
      upstream = database.data;
      communityStreams = database.communityStreams;
    } else {
      log.warn('No database in data/ yet — reading iptv-org directly. Run `db-sync` to create it.');
      upstream = await fetchUpstream(settings);
    }
  }
  const extraStreams = options.upstreamOnly
    ? []
    : [...communityStreams, ...(await loadExtraSources(config.sources, settings))];

  const health = await loadHealthDb();
  log.info(`Loaded ${health.size} health record(s) from previous runs`);

  const merged = mergeDataset({
    channels: upstream.channels,
    feeds: upstream.feeds,
    guides: upstream.guides,
    blocklist: upstream.blocklist,
    logoIndex: buildLogoIndex(upstream.logos),
    upstreamStreams: upstream.streams,
    extraStreams,
    sources: config.sources,
    health,
    settings,
  });

  const dataset: Dataset = {
    generated_at: new Date().toISOString(),
    channels: merged.channels,
    orphans: merged.orphans,
    guides: upstream.guides,
    categories: upstream.categories,
    languages: upstream.languages,
    countries: upstream.countries,
    subdivisions: upstream.subdivisions,
    regions: upstream.regions,
    timezones: upstream.timezones,
    upstream: { source: upstream.source, fetched_at: upstream.fetched_at },
    stats: merged.stats,
  };

  await saveDataset(dataset);

  const withStreams = dataset.channels.filter((channel) => channel.streams.length > 0).length;
  log.success(
    `Dataset: ${dataset.channels.length} channels (${withStreams} playable), ` +
      `${merged.stats.merged_streams} streams`,
  );

  return dataset;
}

export * from './upstream.js';
export * from './sources.js';
export * from './merge.js';
export * from './match.js';
