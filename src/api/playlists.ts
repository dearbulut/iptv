/** Generates M3U playlists from the dataset. */

import path from 'node:path';
import { PATHS, publicUrl, type Settings } from '../core/config.js';
import { ensureDir, writeText } from '../core/fs.js';
import { writeM3u } from '../core/m3u.js';
import { slugify } from '../core/text.js';
import { Logger } from '../core/logger.js';
import type { EnrichedChannel, EnrichedStream, M3uEntry } from '../core/types.js';

const log = new Logger('playlists');

export interface PlaylistIndexEntry {
  path: string;
  name: string;
  group: string;
  channels: number;
  streams: number;
}

interface BuildContext {
  settings: Settings;
  epgUrl: string | null;
  /** Stable channel numbers, emitted as `tvg-chno`. */
  numbers: ReadonlyMap<string, number>;
}

function toEntry(
  channel: EnrichedChannel,
  stream: EnrichedStream,
  context: BuildContext,
  groupTitle: string,
): M3uEntry {
  const headers: Record<string, string> = {};
  if (stream.user_agent) headers['user-agent'] = stream.user_agent;
  if (stream.referrer) headers['referer'] = stream.referrer;

  const quality = stream.health?.media?.resolution ?? stream.quality ?? '';
  const title = quality ? `${channel.name} (${quality})` : channel.name;

  return {
    duration: -1,
    title,
    url: stream.url,
    attributes: {
      'tvg-id': channel.id,
      'tvg-chno': context.numbers.has(channel.id) ? String(context.numbers.get(channel.id)) : '',
      'tvg-name': channel.name,
      'tvg-logo': channel.logo ?? '',
      'tvg-country': channel.country ?? '',
      'tvg-language': channel.languages.join(';'),
      'group-title': groupTitle,
      // Non-standard but widely read by dashboards; harmless elsewhere.
      'nexus-score': String(Math.round(stream.health?.score ?? 0)),
    },
    headers,
    group: groupTitle,
  };
}

/** Picks the streams that belong in generated playlists. */
function playableStreams(
  channel: EnrichedChannel,
  settings: Settings,
  onePerChannel: boolean,
): EnrichedStream[] {
  const eligible = channel.streams
    .filter((stream) => {
      const score = stream.health?.score;
      if (score === undefined || score === null) return settings.playlists.min_score <= 50;
      return score >= settings.playlists.min_score;
    })
    .sort((a, b) => b.rank - a.rank);
  return onePerChannel ? eligible.slice(0, 1) : eligible;
}

export interface PlaylistBuildResult {
  files: PlaylistIndexEntry[];
  total_entries: number;
}

/** Writes the full playlist set: index, per-country, per-category, per-language. */
export async function buildPlaylists(
  channels: readonly EnrichedChannel[],
  settings: Settings,
  meta: {
    countries: Map<string, string>;
    categories: Map<string, string>;
    languages: Map<string, string>;
    /** Stable channel numbers (see channel-numbers.ts). */
    numbers?: ReadonlyMap<string, number>;
    /**
     * Countries (lower-case) that have their own guide shard in `epg/`.
     * Country playlists point at that shard instead of the full guide: a TV
     * app loading the Turkish playlist then downloads ~25 KB of guide rather
     * than 13 MB, most of it for channels it does not have.
     */
    guideShards?: ReadonlySet<string>;
  },
): Promise<PlaylistBuildResult> {
  await ensureDir(PATHS.playlists);

  const epgUrl = settings.playlists.link_epg ? publicUrl(settings, 'epg/guide.xml.gz') : null;
  const numbers = meta.numbers ?? new Map<string, number>();
  const context: BuildContext = { settings, epgUrl, numbers };
  const header: Record<string, string> = {};
  if (epgUrl) header['x-tvg-url'] = epgUrl;

  const files: PlaylistIndexEntry[] = [];
  let totalEntries = 0;

  const write = async (
    relativePath: string,
    name: string,
    group: string,
    entries: M3uEntry[],
    channelCount: number,
    headerOverride?: Record<string, string>,
  ): Promise<void> => {
    if (entries.length === 0) return;
    const target = path.join(PATHS.playlists, relativePath);
    await ensureDir(path.dirname(target));
    await writeText(target, writeM3u(entries, { header: headerOverride ?? header }));
    files.push({
      path: `playlists/${relativePath}`,
      name,
      group,
      channels: channelCount,
      streams: entries.length,
    });
    totalEntries += entries.length;
  };

  // Ordered by channel number so players that ignore tvg-chno still list
  // channels in a stable order; unnumbered channels go last.
  const numberOf = (channel: EnrichedChannel): number =>
    numbers.get(channel.id) ?? Number.MAX_SAFE_INTEGER;
  const withStreams = channels
    .filter((channel) => channel.streams.length > 0)
    .sort((a, b) => numberOf(a) - numberOf(b));

  const groupFor = (channel: EnrichedChannel): string => {
    switch (settings.playlists.group_by) {
      case 'country':
        return meta.countries.get(channel.country?.toUpperCase() ?? '') ?? 'Undefined';
      case 'language':
        return meta.languages.get(channel.languages[0] ?? '') ?? 'Undefined';
      default:
        return meta.categories.get(channel.categories[0] ?? '') ?? 'Undefined';
    }
  };

  // --- master playlists ----------------------------------------------------
  const allEntries: M3uEntry[] = [];
  const bestEntries: M3uEntry[] = [];
  for (const channel of withStreams) {
    const group = groupFor(channel);
    for (const stream of playableStreams(channel, settings, false)) {
      allEntries.push(toEntry(channel, stream, context, group));
    }
    const best = playableStreams(channel, settings, true)[0];
    if (best) bestEntries.push(toEntry(channel, best, context, group));
  }

  await write('index.m3u', 'All streams', 'master', allEntries, withStreams.length);
  await write('best.m3u', 'One best stream per channel', 'master', bestEntries, bestEntries.length);

  const onlineEntries = bestEntries.filter((entry) =>
    Number.parseInt(entry.attributes['nexus-score'] ?? '0', 10) >= settings.health.healthy_threshold,
  );
  await write('online.m3u', 'Healthy streams only', 'master', onlineEntries, onlineEntries.length);

  // --- sharded playlists ---------------------------------------------------
  const bucketBy = (
    keyOf: (channel: EnrichedChannel) => string[],
  ): Map<string, EnrichedChannel[]> => {
    const buckets = new Map<string, EnrichedChannel[]>();
    for (const channel of withStreams) {
      for (const key of keyOf(channel)) {
        if (!key) continue;
        const bucket = buckets.get(key) ?? [];
        bucket.push(channel);
        buckets.set(key, bucket);
      }
    }
    return buckets;
  };

  const shardGroups: Array<{
    directory: string;
    buckets: Map<string, EnrichedChannel[]>;
    label: (key: string) => string;
  }> = [
    {
      directory: 'country',
      buckets: bucketBy((channel) => [channel.country?.toLowerCase() ?? '']),
      label: (key) => meta.countries.get(key.toUpperCase()) ?? key.toUpperCase(),
    },
    {
      directory: 'category',
      buckets: bucketBy((channel) => channel.categories),
      label: (key) => meta.categories.get(key) ?? key,
    },
    {
      directory: 'language',
      buckets: bucketBy((channel) => channel.languages),
      label: (key) => meta.languages.get(key) ?? key,
    },
  ];

  for (const { directory, buckets, label } of shardGroups) {
    for (const [key, bucket] of buckets) {
      const entries: M3uEntry[] = [];
      for (const channel of bucket) {
        const best = playableStreams(channel, settings, true)[0];
        if (best) entries.push(toEntry(channel, best, context, groupFor(channel)));
      }
      let shardHeader: Record<string, string> | undefined;
      if (directory === 'country' && epgUrl && meta.guideShards) {
        // No shard means no programmes for any channel of this country, so
        // the full guide would not help either; leave the header out.
        shardHeader = meta.guideShards.has(key)
          ? { 'x-tvg-url': publicUrl(settings, `epg/${key}.xml.gz`) }
          : {};
      }
      await write(
        `${directory}/${slugify(key) || key}.m3u`,
        label(key),
        directory,
        entries,
        bucket.length,
        shardHeader,
      );
    }
  }

  log.success(`Generated ${files.length} playlist file(s), ${totalEntries} entries`);
  return { files, total_entries: totalEntries };
}
