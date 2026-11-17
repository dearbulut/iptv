/**
 * Static API builder.
 *
 * Everything a client could want is pre-rendered into files so the whole thing
 * can be served by GitHub Pages / any CDN with no server and no rate limits.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig, PATHS, publicUrl, type Settings } from '../core/config.js';
import {
  copyDir,
  ensureDir,
  exists,
  formatBytes,
  readJsonOr,
  remove,
  writeJson,
  writeText,
} from '../core/fs.js';
import { Logger } from '../core/logger.js';
import { slugify } from '../core/text.js';
import type {
  ApiManifest,
  EnrichedChannel,
  EnrichedStream,
  HealthRecord,
} from '../core/types.js';
import { loadDataset, type Dataset } from '../aggregate/index.js';
import { loadHealthDb } from '../aggregate/index.js';
import { attachHealth } from '../health/index.js';
import { summarise, uptimeRatio } from '../health/scoring.js';
import { buildPlaylists } from './playlists.js';
import { buildSearchIndex } from './search-index.js';
import { buildOpenApi } from './openapi.js';
import { buildPlaylistCatalogue, buildReadmePlaylistBlock } from './catalogue.js';
import {
  browserBlocker,
  channelAvailability,
  historyString,
  isBrowserPlayable,
  type Availability,
} from './compat.js';
import { assignChannelNumbers, normaliseRegistry } from './channel-numbers.js';
import { buildStremioAddon } from './stremio.js';
import { buildXtreamIndex } from './xtream.js';
import { changesAtom, computeChanges, normaliseHistory, normaliseSnapshot } from './changes.js';
import { fetchRegional, regionalByChannel, type Regional } from './regional.js';
import { loadVodBlocklist, loadVodCatalog, withoutBlocked } from '../vod/index.js';
import { stremioVod, vodApi, vodPlaylists, xtreamVod } from './vod.js';
import type { EpgLink } from '../epg/index.js';

const log = new Logger('api');

/** Public shape of a stream in the API — health flattened for easy consumption. */
interface PublicStream {
  channel: string | null;
  feed: string | null;
  title: string;
  url: string;
  referrer: string | null;
  user_agent: string | null;
  quality: string | null;
  rank: number;
  sources: string[];
  /** Playable in a browser on an HTTPS page (no mixed content, no custom headers). */
  browser_playable: boolean;
  /** Why not, when it is not: `insecure` (http://), `headers`, or `format`. */
  browser_blocker: 'insecure' | 'headers' | 'format' | null;
  health: {
    status: string;
    score: number;
    uptime: number;
    /** One character per recorded check, oldest first: `1` up, `0` down. */
    history: string;
    checked_at: string;
    last_online: string | null;
    latency_ms: number | null;
    media: HealthRecord['media'];
  } | null;
}

interface PublicChannel {
  id: string;
  name: string;
  alt_names: string[];
  network: string | null;
  owners: string[];
  country: string;
  subdivision: string | null;
  categories: string[];
  languages: string[];
  broadcast_area: string[];
  timezones: string[];
  is_nsfw: boolean;
  launched: string | null;
  closed: string | null;
  replaced_by: string | null;
  website: string | null;
  logo: string | null;
  score: number;
  online: boolean;
  /** online · regional (geo-blocked from our scanner) · offline · unchecked · none */
  availability: Availability;
  /** Stable channel number (`tvg-chno`); never reused. Null when unplayable. */
  number: number | null;
  stream_count: number;
  /** At least one stream plays in a browser. */
  browser_playable: boolean;
  /** Where it works, by viewer country, from the Worker's checks. Empty when unknown. */
  regional: Regional;
  best_quality: string | null;
  streams: PublicStream[];
  guides: EnrichedChannel['guides'];
}

/** Country codes with a gzipped guide shard in public/epg (`tr.xml.gz`, …). */
async function listGuideShards(): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(PATHS.epg);
    return new Set(
      entries
        .map((name) => /^([a-z]{2,3})\.xml\.gz$/.exec(name)?.[1])
        .filter((code): code is string => Boolean(code)),
    );
  } catch {
    return new Set();
  }
}

function toPublicStream(stream: EnrichedStream): PublicStream {
  return {
    channel: stream.channel,
    feed: stream.feed,
    title: stream.title,
    url: stream.url,
    referrer: stream.referrer,
    user_agent: stream.user_agent,
    quality: stream.health?.media?.resolution ?? stream.quality,
    rank: stream.rank,
    sources: [...new Set(stream.provenance.map((entry) => entry.source))],
    browser_playable: isBrowserPlayable(stream),
    browser_blocker: browserBlocker(stream),
    health: stream.health
      ? {
          status: stream.health.status,
          score: stream.health.score,
          uptime: uptimeRatio(stream.health),
          history: historyString(stream.health),
          checked_at: stream.health.checked_at,
          last_online: stream.health.last_online,
          latency_ms: stream.health.latency_ms,
          media: stream.health.media,
        }
      : null,
  };
}

function bestQuality(streams: readonly EnrichedStream[]): string | null {
  let best: string | null = null;
  let bestValue = 0;
  for (const stream of streams) {
    const quality = stream.health?.media?.resolution ?? stream.quality;
    const value = quality ? Number.parseInt(quality, 10) || 0 : 0;
    if (value > bestValue) {
      bestValue = value;
      best = quality;
    }
  }
  return best;
}

function toPublicChannel(
  channel: EnrichedChannel,
  includeOffline: boolean,
  number: number | null = null,
  regional: Regional = {},
): PublicChannel {
  const streams = includeOffline
    ? channel.streams
    : channel.streams.filter((stream) => stream.health?.status !== 'offline');

  return {
    id: channel.id,
    name: channel.name,
    alt_names: channel.alt_names,
    network: channel.network,
    owners: channel.owners,
    country: channel.country,
    subdivision: channel.subdivision ?? null,
    categories: channel.categories,
    languages: channel.languages,
    broadcast_area: channel.broadcast_area,
    timezones: channel.timezones,
    is_nsfw: channel.is_nsfw,
    launched: channel.launched,
    closed: channel.closed,
    replaced_by: channel.replaced_by,
    website: channel.website,
    logo: channel.logo,
    score: channel.score,
    online: channel.online,
    availability: channelAvailability(streams),
    number,
    stream_count: streams.length,
    browser_playable: streams.some((stream) => isBrowserPlayable(stream)),
    regional,
    best_quality: bestQuality(streams),
    streams: streams.map(toPublicStream),
    guides: channel.guides,
  };
}

/**
 * Directories under `public/` written by other pipeline stages, which a clean
 * API build must leave alone.
 *
 * `epg/` is produced by `cli epg`, which runs *before* `cli api` in both the
 * Sync workflow and `cli pipeline`. A clean build used to `rm -rf public/`
 * wholesale, so the guide was generated and then deleted moments later: the
 * manifest still reported 111k programmes (that count comes from
 * `.data/epg/report.json`), every playlist's `x-tvg-url` pointed at the guide,
 * and the guide itself 404'd. See issue #14.
 */
const PRESERVED_ON_CLEAN = new Set(['epg']);

/** Empties `public/` except for directories owned by other stages. */
async function cleanPublic(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(PATHS.public);
  } catch {
    return; // nothing to clean
  }
  for (const entry of entries) {
    if (PRESERVED_ON_CLEAN.has(entry)) continue;
    await remove(path.join(PATHS.public, entry));
  }
}

export interface ApiBuildResult {
  generated_at: string;
  files: number;
  bytes: number;
  manifest: ApiManifest;
}

/** Writes the whole static site + API into `public/`. */
export async function buildApi(options: { clean?: boolean } = {}): Promise<ApiBuildResult> {
  const config = await loadConfig();
  const { settings } = config;

  const dataset = await loadDataset();
  if (!dataset) throw new Error('No dataset found. Run `aggregate` before `api`.');

  // Re-attach the newest health data — the scan may have run after aggregation.
  const healthDb = await loadHealthDb();
  attachHealth(dataset.channels, healthDb);

  if (options.clean) await cleanPublic();
  await ensureDir(PATHS.api);

  let files = 0;
  let bytes = 0;

  /**
   * Writes one API document.
   *
   * A `.gz` sibling is only produced for documents large enough to benefit.
   * With ~40k per-channel files, gzipping every one of them would double the
   * file count for a few hundred bytes saved each — and GitHub Pages already
   * compresses small text responses on the fly.
   */
  const GZIP_THRESHOLD = 32 * 1024;
  const emit = async (
    relativePath: string,
    data: unknown,
    pretty = settings.api.pretty,
  ): Promise<void> => {
    const target = path.join(PATHS.api, relativePath);
    await ensureDir(path.dirname(target));
    const serialized = pretty ? `${JSON.stringify(data, null, 2)}\n` : JSON.stringify(data);
    const size = Buffer.byteLength(serialized);
    bytes += await writeJson(target, data, {
      pretty,
      gzip: settings.api.gzip && size >= GZIP_THRESHOLD,
    });
    files++;
  };

  // ---- attach EPG links --------------------------------------------------
  const epgLinks = await readJsonOr<EpgLink[]>(path.join(PATHS.epgDb, 'links.json'), []);
  const linksByChannel = new Map<string, EnrichedChannel['guides']>();
  for (const link of epgLinks) {
    const bucket = linksByChannel.get(link.channel) ?? [];
    bucket.push({
      site: link.site,
      site_id: link.site_id,
      lang: '',
      confidence: link.confidence,
      method: link.method,
    });
    linksByChannel.set(link.channel, bucket);
  }
  for (const channel of dataset.channels) {
    const generated = linksByChannel.get(channel.id);
    if (generated) {
      const seen = new Set(channel.guides.map((guide) => `${guide.site}::${guide.site_id}`));
      for (const link of generated) {
        const key = `${link.site}::${link.site_id}`;
        if (!seen.has(key)) {
          channel.guides.push(link);
          seen.add(key);
        }
      }
    }
  }

  // ---- EPG match report ---------------------------------------------------
  // Guide channels no rule could link. Published so anyone can spot an easy
  // fix and add it to config/epg-overrides.yml without running the pipeline.
  const unmatchedEpg = await readJsonOr<Array<{ site: string; id: string; name: string }>>(
    path.join(PATHS.epgDb, 'unmatched.json'),
    [],
  );
  const unmatchedBySite: Record<string, number> = {};
  for (const entry of unmatchedEpg) {
    unmatchedBySite[entry.site] = (unmatchedBySite[entry.site] ?? 0) + 1;
  }
  await emit(
    'epg-unmatched.json',
    {
      generated_at: dataset.generated_at,
      total: unmatchedEpg.length,
      by_site: unmatchedBySite,
      how_to_fix: 'Add { site, site_id, channel } or { site, site_id, skip: true } to config/epg-overrides.yml',
      channels: [...unmatchedEpg]
        .sort((a, b) => a.site.localeCompare(b.site) || a.name.localeCompare(b.name))
        .map((entry) => ({ site: entry.site, site_id: entry.id, name: entry.name })),
    },
    true,
  );

  // ---- stable channel numbers --------------------------------------------
  // Restored from (and published back to) the state branch by Sync, so a
  // channel keeps its number across every future run. Only channels with a
  // stream are numbered; a channel that gains one later gets the next number.
  const numbersPath = path.join(PATHS.data, 'channel-numbers.json');
  const { registry, assigned } = assignChannelNumbers(
    normaliseRegistry(await readJsonOr<unknown>(numbersPath, null)),
    dataset.channels.filter((channel) => channel.streams.length > 0),
  );
  await writeJson(numbersPath, registry);
  if (assigned > 0) log.info(`Assigned ${assigned} new channel number(s); highest is ${registry.last}`);

  // ---- regional availability ---------------------------------------------
  const regionalSummary = await fetchRegional(settings.project.worker_url);
  const regional = regionalByChannel(regionalSummary, registry.numbers);

  // ---- collections --------------------------------------------------------
  const publicChannels = dataset.channels.map((channel) =>
    toPublicChannel(
      channel,
      settings.api.include_offline,
      channel.streams.length > 0 ? (registry.numbers[channel.id] ?? null) : null,
      regional.get(channel.id),
    ),
  );
  await emit(
    'regional.json',
    {
      generated_at: regionalSummary?.generated_at ?? null,
      days: regionalSummary?.days ?? null,
      channels: Object.fromEntries(regional),
    },
    true,
  );
  const playable = publicChannels.filter((channel) => channel.stream_count > 0);

  await emit('channels.json', publicChannels);
  await emit('channels.online.json', playable.filter((channel) => channel.online));

  const allStreams = publicChannels.flatMap((channel) => channel.streams);
  await emit('streams.json', allStreams);
  await emit('orphans.json', dataset.orphans.map(toPublicStream));

  // Counts make these collections directly useful for building UI filters.
  /**
   * `channels` counts everything in the database, `playable` counts the ones
   * that actually have a stream. The gap is large — roughly a quarter of the
   * catalogue is watchable — so a UI that only shows `channels` promises far
   * more than it can deliver.
   */
  const countChannels = <T>(
    items: readonly T[],
    keyOf: (item: T) => string,
    matches: (channel: PublicChannel, key: string) => boolean,
  ): Array<T & { channels: number; playable: number; online: number }> =>
    items.map((item) => {
      const key = keyOf(item);
      const bucket = publicChannels.filter((channel) => matches(channel, key));
      return {
        ...item,
        channels: bucket.length,
        playable: bucket.filter((channel) => channel.stream_count > 0).length,
        online: bucket.filter((channel) => channel.online).length,
      };
    });

  const countries = countChannels(
    dataset.countries,
    (country) => country.code,
    (channel, code) => channel.country?.toUpperCase() === code.toUpperCase(),
  );
  const languages = countChannels(
    dataset.languages,
    (language) => language.code,
    (channel, code) => channel.languages.includes(code),
  );
  const categories = countChannels(
    dataset.categories,
    (category) => category.id,
    (channel, id) => channel.categories.includes(id),
  );

  await emit('countries.json', countries, true);
  await emit('languages.json', languages, true);
  await emit('categories.json', categories, true);
  await emit('regions.json', dataset.regions, true);
  await emit('subdivisions.json', dataset.subdivisions, true);
  await emit('timezones.json', dataset.timezones, true);
  await emit('guides.json', dataset.guides);

  // ---- match index ----------------------------------------------------------
  // Everything the browser-side M3U enricher (site/tools.html) needs to map a
  // provider's playlist onto Nexus ids, for every channel — not only those we
  // have streams for, since a provider's own streams still need a tvg-id for
  // the guide. Compact positional rows, like search.json.
  const guideChannels = new Set(epgLinks.map((link) => link.channel));
  const matchFields = ['id', 'name', 'alt', 'country', 'logo', 'number', 'state', 'guide'] as const;
  await emit('match.json', {
    fields: matchFields,
    count: publicChannels.length,
    channels: publicChannels.map((channel) => [
      channel.id,
      channel.name,
      channel.alt_names.join('|'),
      channel.country,
      channel.logo ?? '',
      channel.number,
      /** 2 working now, 1 has a stream, 0 none. */
      channel.online ? 2 : channel.stream_count > 0 ? 1 : 0,
      guideChannels.has(channel.id) ? 1 : 0,
    ]),
  });

  // ---- changes since the previous build --------------------------------------
  // Snapshot and history are restored from (and published back to) the state
  // branch by Sync, like the channel numbers.
  const snapshotPath = path.join(PATHS.data, 'catalogue-snapshot.json');
  const historyPath = path.join(PATHS.data, 'changes.json');
  const changes = computeChanges(
    normaliseSnapshot(await readJsonOr<unknown>(snapshotPath, null)),
    publicChannels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      country: channel.country,
      playable: channel.stream_count > 0,
    })),
    normaliseHistory(await readJsonOr<unknown>(historyPath, null)),
    new Date().toISOString(),
  );
  await writeJson(snapshotPath, changes.snapshot);
  await writeJson(historyPath, changes.history);
  if (changes.entry) {
    log.info(`Changes: ${changes.entry.added.length} new, ${changes.entry.removed.length} gone`);
  }
  await emit('changes.json', changes.history);
  const siteUrl = settings.project.base_url ?? '';
  await writeText(
    path.join(PATHS.api, 'changes.xml'),
    changesAtom(changes.history, {
      title: settings.project.name,
      siteUrl,
      feedUrl: publicUrl(settings, 'api/v1/changes.xml'),
      updated: dataset.generated_at,
    }),
  );
  files++;

  // ---- client integrations ------------------------------------------------
  const countryNames = new Map(dataset.countries.map((country) => [country.code, country.name]));
  const categoryNames = new Map(dataset.categories.map((category) => [category.id, category.name]));

  // Static Stremio addon under public/stremio/.
  const stremioFiles = buildStremioAddon(playable, {
    name: settings.project.name,
    description: settings.project.description,
    version: '1.0.0',
    homepage: settings.project.base_url,
    countries: countryNames,
    categories: categoryNames,
  });
  // Openly licensed films and series (built weekly by the VOD workflow).
  // Takedowns apply at the next sync, not only at the next weekly rebuild.
  const storedVod = await loadVodCatalog();
  const vodCatalog = storedVod ? withoutBlocked(storedVod, await loadVodBlocklist()) : null;
  if (vodCatalog && vodCatalog.movies.length + vodCatalog.series.length > 0) {
    const vod = stremioVod(vodCatalog);
    stremioFiles.push(...vod.files);
    const manifestFile = stremioFiles.find((file) => file.path === 'manifest.json');
    const manifestData = manifestFile?.data as
      | { types: string[]; idPrefixes: string[]; catalogs: unknown[]; description: string }
      | undefined;
    if (manifestData) {
      manifestData.types.push('movie', 'series');
      manifestData.idPrefixes.push('nexusvod-');
      manifestData.catalogs.push(...vod.catalogs);
      manifestData.description += ` Plus ${vodCatalog.movies.length.toLocaleString('en')} free films and ${vodCatalog.series.length.toLocaleString('en')} series in the public domain or under Creative Commons.`;
    }
    await emit('vod.json', vodApi(vodCatalog));
    await ensureDir(path.join(PATHS.public, 'xtream'));
    bytes += await writeJson(path.join(PATHS.public, 'xtream', 'vod.json'), xtreamVod(vodCatalog));
    const lists = vodPlaylists(vodCatalog);
    await ensureDir(path.join(PATHS.playlists, 'vod'));
    await writeText(path.join(PATHS.playlists, 'vod', 'movies.m3u'), lists.movies);
    await writeText(path.join(PATHS.playlists, 'vod', 'series.m3u'), lists.series);
    files += 3;
    log.info(`VOD: ${vodCatalog.movies.length} films, ${vodCatalog.series.length} series`);
  }

  const stremioRoot = path.join(PATHS.public, 'stremio');
  for (let i = 0; i < stremioFiles.length; i += 64) {
    await Promise.all(
      stremioFiles.slice(i, i + 64).map(async (file) => {
        const target = path.join(stremioRoot, file.path);
        await ensureDir(path.dirname(target));
        bytes += await writeJson(target, file.data);
        files++;
      }),
    );
  }
  log.info(`Stremio addon: ${stremioFiles.length} files`);

  // Precomputed data for the Xtream Codes Worker (workers/xtream).
  const xtream = buildXtreamIndex(playable, {
    generatedAt: dataset.generated_at,
    countries: countryNames,
    categories: categoryNames,
  });
  await ensureDir(path.join(PATHS.public, 'xtream'));
  bytes += await writeJson(path.join(PATHS.public, 'xtream', 'index.json'), xtream);
  files++;
  log.info(`Xtream index: ${xtream.streams.length} live streams`);

  // ---- health -------------------------------------------------------------
  const healthRecords = [...healthDb.values()];
  const summary = summarise(
    healthRecords,
    {
      alpha: settings.health.score_alpha,
      retireAfterFailures: settings.health.retire_after_failures,
      historySize: settings.health.history_size,
    },
    settings.health.healthy_threshold,
  );
  await emit(
    'health.json',
    {
      generated_at: dataset.generated_at,
      ...summary,
      by_country: Object.fromEntries(
        countries
          .filter((country) => country.channels > 0)
          .map((country) => [
            country.code,
            { channels: country.channels, playable: country.playable, online: country.online },
          ]),
      ),
    },
    true,
  );

  // ---- search index -------------------------------------------------------
  await emit('search.json', buildSearchIndex(publicChannels));

  // ---- shards -------------------------------------------------------------
  if (settings.api.shards) {
    const shardWrite = async (
      directory: string,
      buckets: Map<string, PublicChannel[]>,
    ): Promise<void> => {
      for (const [key, bucket] of buckets) {
        await emit(`by-${directory}/${slugify(key) || key}.json`, bucket);
      }
    };

    const group = (keyOf: (channel: PublicChannel) => string[]): Map<string, PublicChannel[]> => {
      const buckets = new Map<string, PublicChannel[]>();
      for (const channel of publicChannels) {
        for (const key of keyOf(channel)) {
          if (!key) continue;
          const bucket = buckets.get(key.toLowerCase()) ?? [];
          bucket.push(channel);
          buckets.set(key.toLowerCase(), bucket);
        }
      }
      return buckets;
    };

    await shardWrite('country', group((channel) => [channel.country ?? '']));
    await shardWrite('category', group((channel) => channel.categories));
    await shardWrite('language', group((channel) => channel.languages));
  }

  // ---- per-channel documents ---------------------------------------------
  if (settings.api.channel_details) {
    const detailed =
      settings.api.channel_details === 'all' ? publicChannels : playable;
    log.info(
      `Writing ${detailed.length} channel document(s) (mode: ${settings.api.channel_details})`,
    );
    for (const channel of detailed) {
      await emit(`channels/${encodeURIComponent(channel.id)}.json`, channel);
    }
  }

  // ---- playlists ----------------------------------------------------------
  // Point players at the guide only when one is actually being published;
  // otherwise every playlist header would send them to a 404.
  const guideAvailable =
    (await exists(path.join(PATHS.epg, 'guide.xml.gz'))) ||
    (await exists(path.join(PATHS.epg, 'guide.xml')));
  const playlistSettings: Settings = guideAvailable
    ? settings
    : { ...settings, playlists: { ...settings.playlists, link_epg: false } };
  if (!guideAvailable && settings.playlists.link_epg) {
    log.warn('No EPG guide in public/epg — playlists will omit x-tvg-url');
  }
  const playlistResult = await buildPlaylists(dataset.channels, playlistSettings, {
    countries: new Map(dataset.countries.map((country) => [country.code, country.name])),
    categories: new Map(dataset.categories.map((category) => [category.id, category.name])),
    languages: new Map(dataset.languages.map((language) => [language.code, language.name])),
    numbers: new Map(Object.entries(registry.numbers)),
    guideShards: guideAvailable && settings.epg.gzip ? await listGuideShards() : undefined,
  });
  await emit('playlists.json', playlistResult.files, true);

  // ---- manifest -----------------------------------------------------------
  const epgReport = await readJsonOr<{ programmes?: number }>(
    path.join(PATHS.epgDb, 'report.json'),
    {},
  );
  // Only advertise programmes that are actually being served. The report lives
  // in `.data/`, which CI restores from cache, so it can describe a guide from
  // an earlier run even when this run's guide is missing. Reporting that count
  // anyway is how the manifest claimed 111k programmes while the guide 404'd.
  const guideShipped = guideAvailable;
  if (!guideShipped && (epgReport.programmes ?? 0) > 0) {
    log.warn('EPG report exists but no guide is in public/epg — reporting 0 programmes');
  }
  const servedProgrammes = guideShipped ? (epgReport.programmes ?? 0) : 0;

  const manifest: ApiManifest = {
    name: settings.project.name,
    version: '1.0.0',
    generated_at: dataset.generated_at,
    base_url: settings.project.base_url,
    counts: {
      channels: publicChannels.length,
      /** Channels with at least one stream — what a viewer can actually open. */
      playable_channels: playable.length,
      online_channels: publicChannels.filter((channel) => channel.online).length,
      feeds: dataset.channels.reduce((sum, channel) => sum + channel.feeds.length, 0),
      streams: allStreams.length,
      online_streams: summary.online,
      guides: dataset.guides.length,
      epg_programmes: servedProgrammes,
      countries: countries.filter((country) => country.channels > 0).length,
      languages: languages.filter((language) => language.channels > 0).length,
      categories: categories.filter((category) => category.channels > 0).length,
    },
    endpoints: {
      manifest: publicUrl(settings, 'api/v1/index.json'),
      channels: publicUrl(settings, 'api/v1/channels.json'),
      channels_online: publicUrl(settings, 'api/v1/channels.online.json'),
      streams: publicUrl(settings, 'api/v1/streams.json'),
      countries: publicUrl(settings, 'api/v1/countries.json'),
      languages: publicUrl(settings, 'api/v1/languages.json'),
      categories: publicUrl(settings, 'api/v1/categories.json'),
      regions: publicUrl(settings, 'api/v1/regions.json'),
      guides: publicUrl(settings, 'api/v1/guides.json'),
      health: publicUrl(settings, 'api/v1/health.json'),
      search: publicUrl(settings, 'api/v1/search.json'),
      channel_detail: publicUrl(settings, 'api/v1/channels/{id}.json'),
      by_country: publicUrl(settings, 'api/v1/by-country/{code}.json'),
      by_category: publicUrl(settings, 'api/v1/by-category/{id}.json'),
      by_language: publicUrl(settings, 'api/v1/by-language/{code}.json'),
      playlist: publicUrl(settings, 'playlists/index.m3u'),
      playlist_best: publicUrl(settings, 'playlists/best.m3u'),
      epg: publicUrl(settings, 'epg/guide.xml.gz'),
      epg_unmatched: publicUrl(settings, 'api/v1/epg-unmatched.json'),
      match: publicUrl(settings, 'api/v1/match.json'),
      changes: publicUrl(settings, 'api/v1/changes.json'),
      regional: publicUrl(settings, 'api/v1/regional.json'),
      ...(vodCatalog
        ? {
            vod: publicUrl(settings, 'api/v1/vod.json'),
            vod_movies_m3u: publicUrl(settings, 'playlists/vod/movies.m3u'),
            vod_series_m3u: publicUrl(settings, 'playlists/vod/series.m3u'),
          }
        : {}),
      changes_feed: publicUrl(settings, 'api/v1/changes.xml'),
      channel_guide: publicUrl(settings, 'epg/channels/{id}.json'),
      stremio: publicUrl(settings, 'stremio/manifest.json'),
      xtream_data: publicUrl(settings, 'xtream/index.json'),
      ...(settings.project.worker_url
        ? {
            worker: settings.project.worker_url,
            playlist_builder: `${settings.project.worker_url}/m3u`,
            smart_link: `${settings.project.worker_url}/play/{number}`,
            xtream: settings.project.worker_url,
            mcp: `${settings.project.worker_url}/mcp`,
          }
        : {}),
      openapi: publicUrl(settings, 'api/v1/openapi.json'),
    },
    upstream: dataset.upstream,
  };

  await emit('index.json', manifest, true);
  await emit('openapi.json', buildOpenApi(settings, dataset.generated_at), true);

  // ---- repository-facing catalogue ---------------------------------------
  // PLAYLISTS.md lives at the repo root rather than in public/ so it renders
  // on GitHub, which is where people actually go looking for a playlist URL.
  const catalogue = buildPlaylistCatalogue({
    settings,
    generatedAt: dataset.generated_at,
    files: playlistResult.files,
    counts: {
      channels: manifest.counts.channels,
      playable_channels: manifest.counts.playable_channels,
      streams: manifest.counts.streams,
      online_streams: manifest.counts.online_streams,
      epg_programmes: manifest.counts.epg_programmes,
    },
    countryFlags: new Map(dataset.countries.map((country) => [country.name, country.flag])),
  });
  await writeText(path.join(PATHS.root, 'PLAYLISTS.md'), catalogue);

  // Keep the README table in step with the generated catalogue.
  const readmePath = path.join(PATHS.root, 'README.md');
  if (await exists(readmePath)) {
    const { readText } = await import('../core/fs.js');
    const readme = await readText(readmePath);
    const block = buildReadmePlaylistBlock(settings);
    const marked = /<!-- PLAYLISTS:START -->[\s\S]*?<!-- PLAYLISTS:END -->/;
    if (marked.test(readme)) {
      const updated = readme.replace(marked, block);
      if (updated !== readme) await writeText(readmePath, updated);
    }
  }
  log.info('Wrote PLAYLISTS.md');

  // ---- static site --------------------------------------------------------
  if (await exists(PATHS.site)) {
    await copyDir(PATHS.site, PATHS.public);
    // GitHub Pages would otherwise run Jekyll and drop `_`-prefixed paths.
    await writeText(path.join(PATHS.public, '.nojekyll'), '');
    log.info('Copied static site into public/');
  }

  log.success(
    `API built: ${files} JSON files (${formatBytes(bytes)}), ` +
      `${playlistResult.files.length} playlists, ${publicChannels.length} channels`,
  );

  return { generated_at: dataset.generated_at, files, bytes, manifest };
}

export type { Dataset };
export * from './playlists.js';
export * from './search-index.js';
export * from './openapi.js';
export * from './catalogue.js';
