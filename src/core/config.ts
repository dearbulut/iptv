/** Configuration loading and path resolution. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { exists, readText } from './fs.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root — works from both `src/` (tsx) and `dist/` (compiled). */
export const ROOT = path.resolve(here, '..', '..');

export const PATHS = {
  root: ROOT,
  config: path.join(ROOT, 'config'),
  /** Working state that survives between runs and is committed to the repo. */
  data: path.join(ROOT, '.data'),
  cache: path.join(ROOT, '.data', 'cache'),
  /** Generated static site + API, the deploy artifact. */
  public: path.join(ROOT, 'public'),
  api: path.join(ROOT, 'public', 'api', 'v1'),
  playlists: path.join(ROOT, 'public', 'playlists'),
  epg: path.join(ROOT, 'public', 'epg'),
  site: path.join(ROOT, 'site'),
  /** Persisted health history — the memory that makes scoring meaningful. */
  healthDb: path.join(ROOT, '.data', 'health.json'),
  channelsDb: path.join(ROOT, '.data', 'channels.json'),
  streamsDb: path.join(ROOT, '.data', 'streams.json'),
  epgDb: path.join(ROOT, '.data', 'epg'),
  discoveryDb: path.join(ROOT, '.data', 'discovery.json'),
} as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export interface StreamSource {
  id: string;
  name: string;
  /** `m3u` = playlist URL, `iptv-org` = the upstream JSON API. */
  type: 'm3u' | 'iptv-org' | 'json';
  url: string;
  enabled: boolean;
  /** 0-1 multiplier applied to stream ranking. Curated lists score higher. */
  trust: number;
  /** Only keep entries whose title matches. */
  include?: string;
  /** Drop entries whose title matches. */
  exclude?: string;
  /** Attach these categories to every channel discovered here. */
  categories?: string[];
  /** Force a country code on entries that have none. */
  country?: string;
  license?: string;
  homepage?: string;
}

export interface EpgSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  /** ISO 639-1 language of the guide. */
  lang: string;
  /** Countries this guide covers, used for sharding output. */
  countries: string[];
  /** 0-1 trust used to break ties when two guides describe the same channel. */
  trust: number;
  license?: string;
}

/**
 * A hand-made correction to EPG matching, from `config/epg-overrides.yml`.
 * Either pins a guide channel to a Nexus channel, or marks it as one we
 * deliberately do not carry. `site` may be `*` to match any guide.
 */
export interface EpgOverride {
  site: string;
  site_id: string;
  channel?: string;
  skip?: boolean;
  note?: string;
}

export interface DiscoverySource {
  id: string;
  name: string;
  /** Page or raw file to scan for playlist URLs. */
  url: string;
  enabled: boolean;
  /** `index` scrapes the page for `.m3u`/`.m3u8` links; `playlist` reads it directly. */
  mode: 'index' | 'playlist';
  /** Cap on how many playlists to follow from an index page. */
  max_playlists?: number;
  trust: number;
}

export interface Settings {
  project: {
    name: string;
    short_name: string;
    description: string;
    /** Public base URL of the deployed API, e.g. `https://user.github.io/repo`. */
    base_url: string | null;
    repository: string | null;
    /**
     * Deployed URL of workers/xtream (playlist builder, smart links, Xtream,
     * MCP), e.g. `https://iptv-nexus-xtream.you.workers.dev`. Null when none.
     */
    worker_url: string | null;
  };
  aggregate: {
    /** Upstream iptv-org API base. */
    upstream_api: string;
    /** Mirror used when the primary host is unreachable. */
    upstream_mirror: string;
    /** Cache upstream responses for this long. */
    cache_ttl_minutes: number;
    /** Drop channels flagged in the upstream blocklist. */
    respect_blocklist: boolean;
    /** Exclude NSFW channels from the default outputs. */
    exclude_nsfw: boolean;
    /** Max streams kept per channel after ranking. */
    max_streams_per_channel: number;
    http_concurrency: number;
  };
  health: {
    enabled: boolean;
    concurrency: number;
    timeout_seconds: number;
    /** Weight of the newest check in the rolling score (0-1). */
    score_alpha: number;
    /** Retire a stream after this many consecutive failures. */
    retire_after_failures: number;
    /** Keep at most this many history samples per stream. */
    history_size: number;
    /** Streams above this score are considered healthy. */
    healthy_threshold: number;
    /** Use ffprobe for media metadata. Falls back to HTTP-only when absent. */
    use_ffprobe: boolean;
    /** Seconds of stream to analyse with ffprobe. */
    probe_duration: number;
  };
  epg: {
    enabled: boolean;
    /** Days of guide data to keep, counted from now. */
    days: number;
    /** Drop programmes that ended more than this many hours ago. */
    retain_past_hours: number;
    concurrency: number;
    /** Minimum fuzzy score to auto-link an EPG channel to a Nexus channel. */
    match_threshold: number;
    gzip: boolean;
  };
  discovery: {
    enabled: boolean;
    concurrency: number;
    /** Only accept candidates that pass a live health check. */
    require_online: boolean;
    /** Reject candidates that cannot be matched to a known channel. */
    require_channel_match: boolean;
    match_threshold: number;
    /** Maximum new streams accepted per run, to keep diffs reviewable. */
    max_accepted_per_run: number;
  };
  api: {
    /** Emit `.gz` siblings for every JSON file. */
    gzip: boolean;
    pretty: boolean;
    /** Generate per-country / per-category / per-language shards. */
    shards: boolean;
    /**
     * Generate one JSON file per channel.
     *
     * `playable` (default) only emits documents for channels that have at
     * least one stream — a channel with no stream has nothing in its detail
     * document that `channels.json` does not already carry, and emitting all
     * ~40k of them roughly quadruples the size of the published site.
     * `all` emits every channel; `false` disables detail documents entirely.
     */
    channel_details: 'playable' | 'all' | false;
    /** Include streams that are currently offline. */
    include_offline: boolean;
  };
  playlists: {
    /** Group-title strategy for generated playlists. */
    group_by: 'category' | 'country' | 'language';
    /** Only include streams at or above this health score. */
    min_score: number;
    /** Point `x-tvg-url` at the generated EPG. */
    link_epg: boolean;
  };
}

export interface NexusConfig {
  settings: Settings;
  sources: StreamSource[];
  epgSources: EpgSource[];
  discoverySources: DiscoverySource[];
  epgOverrides: EpgOverride[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: Settings = {
  project: {
    name: 'IPTV Nexus',
    short_name: 'Nexus',
    description: 'Self-updating IPTV channel, stream and EPG index with a free static API.',
    base_url: null,
    repository: null,
    worker_url: null,
  },
  aggregate: {
    upstream_api: 'https://iptv-org.github.io/api',
    upstream_mirror: 'https://raw.githubusercontent.com/iptv-org/api/gh-pages',
    cache_ttl_minutes: 60,
    respect_blocklist: true,
    exclude_nsfw: true,
    max_streams_per_channel: 8,
    http_concurrency: 12,
  },
  health: {
    enabled: true,
    concurrency: 40,
    timeout_seconds: 12,
    score_alpha: 0.3,
    retire_after_failures: 10,
    history_size: 30,
    healthy_threshold: 40,
    use_ffprobe: true,
    probe_duration: 4,
  },
  epg: {
    enabled: true,
    days: 3,
    retain_past_hours: 6,
    concurrency: 6,
    match_threshold: 0.86,
    gzip: true,
  },
  discovery: {
    enabled: true,
    concurrency: 20,
    require_online: true,
    require_channel_match: true,
    match_threshold: 0.9,
    max_accepted_per_run: 250,
  },
  api: {
    gzip: true,
    pretty: false,
    shards: true,
    channel_details: 'playable',
    include_offline: true,
  },
  playlists: {
    group_by: 'category',
    min_score: 0,
    link_epg: true,
  },
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep merge where `override` wins; arrays are replaced, not concatenated. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isRecord(base) || !isRecord(override)) {
    return (override === undefined ? base : (override as T));
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    result[key] = key in base ? deepMerge((base as Record<string, unknown>)[key], value) : value;
  }
  return result as T;
}

async function loadYaml<T>(file: string, fallback: T): Promise<T> {
  if (!(await exists(file))) return fallback;
  const parsed = parseYaml(await readText(file)) as unknown;
  return (parsed ?? fallback) as T;
}

/** Applies `NEXUS_*` environment overrides for the values CI needs to set. */
function applyEnvOverrides(settings: Settings): Settings {
  const baseUrl = process.env['NEXUS_BASE_URL'];
  const repository = process.env['NEXUS_REPOSITORY'];
  const name = process.env['NEXUS_NAME'];
  if (baseUrl) settings.project.base_url = baseUrl.replace(/\/+$/, '');
  if (repository) settings.project.repository = repository;
  if (name) settings.project.name = name;
  const workerUrl = process.env['NEXUS_WORKER_URL'];
  if (workerUrl) settings.project.worker_url = workerUrl.replace(/\/+$/, '');
  if (process.env['NEXUS_DISABLE_HEALTH'] === '1') settings.health.enabled = false;
  if (process.env['NEXUS_DISABLE_EPG'] === '1') settings.epg.enabled = false;
  return settings;
}

let cached: NexusConfig | null = null;

/** Loads and validates every config file. Result is memoised per process. */
export async function loadConfig(reload = false): Promise<NexusConfig> {
  if (cached && !reload) return cached;

  const settingsRaw = await loadYaml<Partial<Settings>>(
    path.join(PATHS.config, 'settings.yml'),
    {},
  );
  const settings = applyEnvOverrides(deepMerge(DEFAULT_SETTINGS, settingsRaw));

  const sourcesFile = await loadYaml<{ sources?: StreamSource[] }>(
    path.join(PATHS.config, 'sources.yml'),
    {},
  );
  const epgFile = await loadYaml<{ sources?: EpgSource[] }>(
    path.join(PATHS.config, 'epg-sources.yml'),
    {},
  );
  const discoveryFile = await loadYaml<{ sources?: DiscoverySource[] }>(
    path.join(PATHS.config, 'discovery.yml'),
    {},
  );

  const overridesFile = await loadYaml<{ overrides?: EpgOverride[] | null }>(
    path.join(PATHS.config, 'epg-overrides.yml'),
    {},
  );

  /** Fills in per-entry defaults without clobbering explicit `false`/`0`. */
  const withDefaults = <T extends object>(entry: T, defaults: Partial<T>): T => {
    const result = { ...entry } as Record<string, unknown>;
    for (const [key, value] of Object.entries(defaults)) {
      if (result[key] === undefined || result[key] === null) result[key] = value;
    }
    return result as T;
  };

  const sources = (sourcesFile.sources ?? []).map((source) =>
    withDefaults(source, { trust: 0.5, enabled: true, type: 'm3u' }),
  );

  const errors: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source.id) errors.push('a stream source is missing `id`');
    else if (seen.has(source.id)) errors.push(`duplicate stream source id: ${source.id}`);
    seen.add(source.id);
    if (!source.url) errors.push(`stream source ${source.id} is missing \`url\``);
    if (source.trust < 0 || source.trust > 1) {
      errors.push(`stream source ${source.id} has trust outside 0-1`);
    }
  }
  const epgOverrides = overridesFile.overrides ?? [];
  const seenOverrides = new Set<string>();
  for (const [i, entry] of epgOverrides.entries()) {
    const where = `epg-overrides.yml entry ${i + 1}`;
    if (!entry || !entry.site || !entry.site_id) {
      errors.push(`${where} needs \`site\` and \`site_id\``);
      continue;
    }
    entry.site_id = String(entry.site_id);
    if (Boolean(entry.channel) === Boolean(entry.skip)) {
      errors.push(`${where} (${entry.site}/${entry.site_id}) needs exactly one of \`channel\` or \`skip: true\``);
    }
    const key = `${entry.site}::${entry.site_id}`;
    if (seenOverrides.has(key)) errors.push(`${where} duplicates ${entry.site}/${entry.site_id}`);
    seenOverrides.add(key);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }

  cached = {
    settings,
    sources,
    epgSources: (epgFile.sources ?? []).map((source) =>
      withDefaults(source, { enabled: true, trust: 0.5, countries: [], lang: 'en' }),
    ),
    discoverySources: (discoveryFile.sources ?? []).map((source) =>
      withDefaults(source, { enabled: true, trust: 0.3, mode: 'index' }),
    ),
    epgOverrides,
  };
  return cached;
}

/** Resolves a public URL for a generated path, when a base URL is configured. */
export function publicUrl(settings: Settings, relativePath: string): string {
  const base = settings.project.base_url;
  const clean = relativePath.replace(/^\/+/, '');
  return base ? `${base}/${clean}` : `/${clean}`;
}
