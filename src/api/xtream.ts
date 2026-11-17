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

/** One row per channel: [stream_id, name, icon, epg_id, category ids, country category id, url]. */
export type XtreamRow = [number, string, string, string, number[], number, string];

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
export function pickXtreamStream(channel: StremioChannel): StremioChannel['streams'][number] | null {
  // Xtream clients request `/live/u/p/<id>.ts` and follow a redirect, which
  // only works for HTTP(S). RTMP/RTSP/UDP streams are left to the M3U lists.
  const streams = channel.streams.filter((stream) => /^https?:\/\//i.test(stream.url));
  const plain = (stream: StremioChannel['streams'][number]) => !stream.referrer && !stream.user_agent;
  const online = (stream: StremioChannel['streams'][number]) => stream.health?.status === 'online';
  return (
    streams.find((s) => online(s) && plain(s)) ??
    streams.find((s) => plain(s) && s.health?.status === 'blocked') ??
    streams.find(online) ??
    streams.find(plain) ??
    streams[0] ??
    null
  );
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
    const stream = pickXtreamStream(channel);
    if (!stream) continue;
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
