/**
 * Data for the Xtream Codes compatible API (`workers/xtream`).
 *
 * TiviMate, IPTV Smarters, XCIPTV and many TV boxes only accept an Xtream
 * login (server + username + password), not an M3U URL. The protocol needs a
 * server — `player_api.php?action=…` and `/live/u/p/<id>.ts` — so it is
 * answered by a small Cloudflare Worker. Everything the Worker needs is
 * precomputed here into one compact file it fetches from Pages and caches:
 *
 *   public/xtream/index.json
 *
 * `stream_id` is the stable channel number, so favourites and channel
 * positions in those apps survive every rebuild.
 */

import type { StremioChannel } from './stremio.js';
import { stremioEligible } from './stremio.js';

/**
 * One row per channel. The first seven fields are the original layout, so a
 * Worker deployed before the extra fields existed keeps working:
 *
 *   0 stream_id (channel number)   7  fallback URLs (header-free, best first)
 *   1 name                         8  country code
 *   2 icon                         9  category ids, `;`-joined
 *   3 epg channel id               10 language codes, `;`-joined
 *   4 category ids (Xtream)        11 state: 2 online, 1 regional/unchecked
 *   5 country category id          12 referrer the primary URL needs, or ''
 *   6 primary URL                  13 user agent the primary URL needs, or ''
 *                                  14 quality, e.g. `1080p`, or ''
 */
export type XtreamRow = [
  number, string, string, string, number[], number, string,
  string[], string, string, string, number, string, string, string,
];

export interface XtreamIndex {
  version: 1;
  generated_at: string;
  /** `[id, name]` pairs for the two ways the Worker can group channels. */
  categories: { category: Array<[number, string]>; country: Array<[number, string]> };
  streams: XtreamRow[];
}

/**
 * The stream an Xtream client gets. A redirect cannot carry Referer or
 * User-Agent headers, so a stream that needs none is preferred, then an
 * online one, then the best-ranked.
 */
type Stream = StremioChannel['streams'][number];

const isHttp = (stream: Stream) => /^https?:\/\//i.test(stream.url);
const isPlain = (stream: Stream) => !stream.referrer && !stream.user_agent;
const isOnline = (stream: Stream) => stream.health?.status === 'online';

/**
 * HTTP(S) streams in the order a redirect-based client should try them:
 * online and header-free first, then geo-blocked header-free (it may work for
 * the viewer), then online, then header-free, then the rest. Xtream clients
 * request `/live/u/p/<id>.ts` and follow a redirect, which cannot play RTMP or
 * RTSP; those are left to the M3U lists.
 */
export function orderXtreamStreams(channel: StremioChannel): Stream[] {
  const tier = (stream: Stream): number =>
    isOnline(stream) && isPlain(stream) ? 0
    : isPlain(stream) && stream.health?.status === 'blocked' ? 1
    : isOnline(stream) ? 2
    : isPlain(stream) ? 3
    : 4;
  return channel.streams
    .filter(isHttp)
    .map((stream, index) => ({ stream, index }))
    .sort((a, b) => tier(a.stream) - tier(b.stream) || a.index - b.index)
    .map(({ stream }) => stream);
}

/** The stream an Xtream client gets first. */
export function pickXtreamStream(channel: StremioChannel): Stream | null {
  return orderXtreamStreams(channel)[0] ?? null;
}

export function buildXtreamIndex(
  channels: readonly StremioChannel[],
  ctx: {
    generatedAt: string;
    countries: ReadonlyMap<string, string>;
    categories: ReadonlyMap<string, string>;
  },
): XtreamIndex {
  const listed = channels
    .filter((channel) => stremioEligible(channel) && channel.number !== null)
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

  // Category ids must be stable across runs too, or a client's category
  // filter breaks. Derive them from the sorted names rather than from order
  // of appearance, so they only move when a category is added or removed.
  const categoryNames = [...new Set(listed.flatMap((c) => c.categories))]
    .map((id) => ctx.categories.get(id) ?? id)
    .sort((a, b) => a.localeCompare(b));
  const countryNames = [...new Set(listed.map((c) => ctx.countries.get(c.country) ?? c.country))].sort(
    (a, b) => a.localeCompare(b),
  );
  const categoryId = new Map(categoryNames.map((name, i) => [name, i + 1]));
  const countryId = new Map(countryNames.map((name, i) => [name, i + 1]));
  // "Other" for channels without a category.
  const OTHER = categoryNames.length + 1;

  const streams: XtreamRow[] = [];
  for (const channel of listed) {
    const ordered = orderXtreamStreams(channel);
    const stream = ordered[0];
    if (!stream) continue;
    // Fallbacks for the Worker's failover: a redirect cannot carry headers,
    // so only header-free streams qualify.
    const fallbacks = ordered
      .slice(1)
      .filter(isPlain)
      .filter((candidate) => candidate.health?.status !== 'offline')
      .slice(0, 3)
      .map((candidate) => candidate.url);
    const cats = channel.categories
      .map((id) => categoryId.get(ctx.categories.get(id) ?? id))
      .filter((id): id is number => id !== undefined);
    streams.push([
      channel.number as number,
      channel.name,
      channel.logo ?? '',
      channel.id,
      cats.length > 0 ? cats : [OTHER],
      countryId.get(ctx.countries.get(channel.country) ?? channel.country) ?? 0,
      stream.url,
      fallbacks,
      channel.country,
      channel.categories.join(';'),
      channel.languages.join(';'),
      channel.availability === 'online' ? 2 : 1,
      stream.referrer ?? '',
      stream.user_agent ?? '',
      stream.quality ?? '',
    ]);
  }

  return {
    version: 1,
    generated_at: ctx.generatedAt,
    categories: {
      category: [...categoryNames.map((name, i) => [i + 1, name] as [number, string]), [OTHER, 'Other']],
      country: countryNames.map((name, i) => [i + 1, name] as [number, string]),
    },
    streams,
  };
}
