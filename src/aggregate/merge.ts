/** Merges upstream + third-party streams into the canonical channel dataset. */

import { isPlayableUrl, streamKey } from '../core/http.js';
import { blockedUrls } from '../database/index.js';
import { qualityWeight } from '../core/text.js';
import { Logger } from '../core/logger.js';
import type { Settings, StreamSource } from '../core/config.js';
import type {
  BlocklistEntry,
  Channel,
  ChannelGuideLink,
  EnrichedChannel,
  EnrichedStream,
  Feed,
  Guide,
  HealthRecord,
  Stream,
  StreamProvenance,
} from '../core/types.js';
import { buildChannelIndex, resolveChannel, type ChannelIndex } from './match.js';
import type { SourcedStream } from './sources.js';

const log = new Logger('merge');

export interface MergeInput {
  channels: Channel[];
  feeds: Feed[];
  guides: Guide[];
  blocklist: BlocklistEntry[];
  logoIndex: Map<string, string>;
  upstreamStreams: Stream[];
  extraStreams: SourcedStream[];
  sources: StreamSource[];
  /** Previously recorded health, keyed by stream key. */
  health: Map<string, HealthRecord>;
  settings: Settings;
}

export interface MergeResult {
  channels: EnrichedChannel[];
  /** Streams that could not be attached to any known channel. */
  orphans: EnrichedStream[];
  index: ChannelIndex;
  stats: {
    upstream_streams: number;
    extra_streams: number;
    merged_streams: number;
    duplicates: number;
    matched: number;
    orphaned: number;
    blocked: number;
    nsfw_removed: number;
  };
}

interface Accumulator {
  stream: Stream;
  key: string;
  provenance: StreamProvenance[];
  trust: number;
  channelId: string | null;
  feedId: string | null;
  matchScore: number;
}

/**
 * Ranking weight for a stream. Health dominates because a beautiful 1080p
 * stream that never responds is worth less than a reliable 720p one.
 */
export function rankStream(
  stream: Stream,
  health: HealthRecord | null,
  trust: number,
  healthyThreshold: number,
): number {
  const quality = qualityWeight(health?.media?.resolution ?? stream.quality);
  const qualityScore = Math.min(1, quality / 1080) * 25;

  let healthScore = 12; // Unknown streams sit between healthy and dead.
  if (health) {
    healthScore = (health.score / 100) * 55;
    if (health.status === 'online') healthScore += 8;
    if (health.status === 'offline' || health.status === 'error') healthScore -= 25;
    if (health.score < healthyThreshold) healthScore -= 10;
  }

  const latency = health?.latency_ms;
  const latencyScore = latency === null || latency === undefined ? 0 : Math.max(0, 8 - latency / 500);

  const trustScore = trust * 12;
  // Streams needing custom headers are more fragile in most players.
  const penalty = (stream.referrer ? 2 : 0) + (stream.user_agent ? 1 : 0);

  return Math.round((qualityScore + healthScore + latencyScore + trustScore - penalty) * 100) / 100;
}

/** Merges everything into per-channel records. */
export function mergeDataset(input: MergeInput): MergeResult {
  const { settings } = input;
  const index = buildChannelIndex(input.channels, input.feeds);

  // Channel-level entries (iptv-org's, and ours) remove a whole channel;
  // entries with a `url` (our takedowns) remove a single stream.
  const blocked = new Set(
    settings.aggregate.respect_blocklist
      ? input.blocklist.filter((entry) => entry.channel).map((entry) => entry.channel)
      : [],
  );
  const blockedStreams = blockedUrls(input.blocklist);
  let blockedStreamCount = 0;

  const trustBySource = new Map(input.sources.map((source) => [source.id, source.trust]));
  const upstreamTrust = trustBySource.get('iptv-org') ?? 0.9;

  const accumulators = new Map<string, Accumulator>();
  let duplicates = 0;

  // --- upstream streams: channel ids are authoritative ---------------------
  const now = new Date().toISOString();
  let unsupported = 0;
  for (const stream of input.upstreamStreams) {
    if (!stream.url) continue;
    // Upstream occasionally carries protocols nothing in the toolchain can
    // play (mmsh, mms). Filtering here keeps every downstream output — API,
    // playlists, health probes — consistent about what "a stream" means.
    if (!isPlayableUrl(stream.url)) {
      unsupported++;
      continue;
    }
    const key = streamKey(stream.url);
    const existing = accumulators.get(key);
    if (existing) {
      duplicates++;
      existing.provenance.push({ source: 'iptv-org', origin: 'upstream', added_at: now });
      continue;
    }
    accumulators.set(key, {
      stream,
      key,
      provenance: [{ source: 'iptv-org', origin: 'upstream', added_at: now }],
      trust: upstreamTrust,
      channelId: stream.channel,
      feedId: stream.feed,
      matchScore: stream.channel ? 1 : 0,
    });
  }

  // --- third-party streams: resolve the channel ---------------------------
  let matched = 0;
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));

  for (const stream of input.extraStreams) {
    const existing = accumulators.get(stream.key);
    if (existing) {
      duplicates++;
      existing.provenance.push(stream.provenance);
      // A higher-trust source can upgrade the metadata of a known stream.
      if (stream.trust > existing.trust) {
        existing.trust = stream.trust;
        if (stream.quality && !existing.stream.quality) existing.stream.quality = stream.quality;
      }
      continue;
    }

    const source = sourceById.get(stream.provenance.source);
    const resolved = resolveChannel(
      stream.title,
      index,
      {
        tvgId: stream.channel ?? stream.attributes['tvg-id'] ?? null,
        group: stream.attributes['group-title'] ?? null,
        country: source?.country ?? null,
      },
      0.88,
    );
    if (resolved) matched++;

    accumulators.set(stream.key, {
      stream: {
        channel: resolved?.channel.id ?? null,
        feed: stream.feed,
        title: stream.title,
        url: stream.url,
        referrer: stream.referrer,
        user_agent: stream.user_agent,
        quality: stream.quality,
        label: null,
      },
      key: stream.key,
      provenance: [stream.provenance],
      trust: stream.trust,
      channelId: resolved?.channel.id ?? null,
      feedId: stream.feed,
      matchScore: resolved?.score ?? 0,
    });
  }

  // --- guides index --------------------------------------------------------
  const guidesByChannel = new Map<string, ChannelGuideLink[]>();
  for (const guide of input.guides) {
    if (!guide.channel) continue;
    const bucket = guidesByChannel.get(guide.channel) ?? [];
    bucket.push({
      site: guide.site,
      site_id: guide.site_id,
      lang: guide.lang,
      confidence: 1,
      method: 'upstream',
    });
    guidesByChannel.set(guide.channel, bucket);
  }

  const feedsByChannel = new Map<string, Feed[]>();
  for (const feed of input.feeds) {
    const bucket = feedsByChannel.get(feed.channel) ?? [];
    bucket.push(feed);
    feedsByChannel.set(feed.channel, bucket);
  }

  // --- assemble ------------------------------------------------------------
  const streamsByChannel = new Map<string, EnrichedStream[]>();
  const orphans: EnrichedStream[] = [];

  for (const accumulator of accumulators.values()) {
    const health = input.health.get(accumulator.key) ?? null;
    const enriched: EnrichedStream = {
      ...accumulator.stream,
      key: accumulator.key,
      provenance: accumulator.provenance,
      health,
      rank: rankStream(
        accumulator.stream,
        health,
        accumulator.trust,
        settings.health.healthy_threshold,
      ),
    };

    if (blockedStreams.has(accumulator.key)) {
      blockedStreamCount++;
      continue;
    }
    if (!accumulator.channelId) {
      orphans.push(enriched);
      continue;
    }
    if (blocked.has(accumulator.channelId)) continue;

    const bucket = streamsByChannel.get(accumulator.channelId) ?? [];
    bucket.push(enriched);
    streamsByChannel.set(accumulator.channelId, bucket);
  }

  let blockedCount = 0;
  let nsfwRemoved = 0;
  const channels: EnrichedChannel[] = [];

  for (const channel of input.channels) {
    if (blocked.has(channel.id)) {
      blockedCount++;
      continue;
    }
    if (settings.aggregate.exclude_nsfw && channel.is_nsfw) {
      nsfwRemoved++;
      continue;
    }

    const streams = (streamsByChannel.get(channel.id) ?? [])
      .sort((a, b) => b.rank - a.rank)
      .slice(0, settings.aggregate.max_streams_per_channel);

    const feeds = feedsByChannel.get(channel.id) ?? [];
    const languages = [...new Set(feeds.flatMap((feed) => feed.languages))];
    const broadcastArea = [...new Set(feeds.flatMap((feed) => feed.broadcast_area))];
    const timezones = [...new Set(feeds.flatMap((feed) => feed.timezones))];

    // Only streams with a conclusive observation count towards the score.
    // A record that has only ever come back `blocked` still sits at the
    // neutral 50 seed, and reporting that as "50% healthy" would be a
    // measurement we never actually made.
    const scored = streams.filter((stream) => (stream.health?.history.length ?? 0) > 0);
    const score =
      scored.length > 0 ? Math.round(Math.max(...scored.map((stream) => stream.health!.score))) : 0;

    channels.push({
      ...channel,
      feeds,
      streams,
      guides: guidesByChannel.get(channel.id) ?? [],
      logo: input.logoIndex.get(channel.id) ?? channel.logo ?? null,
      score,
      online: streams.some((stream) => stream.health?.status === 'online'),
      languages: languages.length > 0 ? languages : [],
      broadcast_area: broadcastArea,
      timezones,
    });
  }

  const stats = {
    upstream_streams: input.upstreamStreams.length,
    extra_streams: input.extraStreams.length,
    merged_streams: accumulators.size,
    duplicates,
    matched,
    orphaned: orphans.length,
    blocked: blockedCount + blockedStreamCount,
    nsfw_removed: nsfwRemoved,
  };

  log.info(
    `Merged ${stats.merged_streams} unique streams ` +
      `(${stats.duplicates} duplicates collapsed, ${stats.matched} fuzzy-matched, ` +
      `${stats.orphaned} orphaned, ${unsupported} unsupported protocol)`,
  );

  return { channels, orphans, index, stats };
}
