/**
 * A static Stremio addon, served straight from GitHub Pages.
 *
 * Stremio addons are plain HTTP: the app fetches `manifest.json`, then
 * `catalog/<type>/<id>[/<extra>].json`, `meta/<type>/<id>.json` and
 * `stream/<type>/<id>.json`. Everything except free-text search can be
 * precomputed, so no server is needed — users install it with
 *
 *   https://dearbulut.github.io/iptv/stremio/manifest.json
 *
 * Extras are encoded in the path as `genre=News&skip=100`. Stremio
 * URL-encodes the value and Pages decodes it before looking up the file, so
 * files are written under the decoded name.
 */

import type { Availability } from './compat.js';

export const STREMIO_PAGE_SIZE = 100;
/** Ids are prefixed so Stremio routes only our items to this addon. */
export const STREMIO_PREFIX = 'nexus-';

export interface StremioChannel {
  id: string;
  name: string;
  alt_names: string[];
  country: string;
  categories: string[];
  languages: string[];
  is_nsfw: boolean;
  website: string | null;
  logo: string | null;
  number: number | null;
  availability: Availability;
  score: number;
  streams: Array<{
    url: string;
    title: string;
    referrer: string | null;
    user_agent: string | null;
    quality: string | null;
    browser_playable: boolean;
    health: { status: string; uptime: number } | null;
  }>;
}

export interface StremioContext {
  name: string;
  description: string;
  version: string;
  /** Site URL, linked from each channel's page. */
  homepage: string | null;
  countries: ReadonlyMap<string, string>;
  categories: ReadonlyMap<string, string>;
}

export interface StremioFile {
  /** Relative to `public/stremio/`. */
  path: string;
  data: unknown;
}

/** Channels worth listing: something to play that is not known to be dead. */
export function stremioEligible(channel: StremioChannel): boolean {
  return (
    !channel.is_nsfw &&
    channel.streams.length > 0 &&
    (channel.availability === 'online' ||
      channel.availability === 'regional' ||
      channel.availability === 'unchecked')
  );
}

const AVAILABILITY_ORDER: Record<Availability, number> = {
  online: 0,
  regional: 1,
  unchecked: 2,
  offline: 3,
  none: 4,
};

/** Stremio genre values become file names, so keep them path-safe. */
function genreSafe(value: string): boolean {
  return value.length > 0 && !/[/\\?#%&=]/.test(value);
}

function metaPreview(channel: StremioChannel, ctx: StremioContext) {
  return {
    id: STREMIO_PREFIX + channel.id,
    type: 'tv',
    name: channel.name,
    poster: channel.logo ?? undefined,
    posterShape: 'square',
    genres: channel.categories.map((id) => ctx.categories.get(id) ?? id),
    description: describe(channel, ctx),
  };
}

function describe(channel: StremioChannel, ctx: StremioContext): string {
  const parts = [
    channel.number ? `Channel ${channel.number}` : null,
    ctx.countries.get(channel.country) ?? channel.country,
    channel.availability === 'regional' ? 'may be geo-restricted' : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

function streamTitle(stream: StremioChannel['streams'][number]): string {
  const bits = [stream.quality ?? stream.title];
  if (stream.health?.status === 'online') bits.push(`${Math.round(stream.health.uptime)}% up`);
  else if (stream.health?.status === 'blocked') bits.push('geo-restricted');
  return bits.join(' · ');
}

export function buildStremioAddon(
  channels: readonly StremioChannel[],
  ctx: StremioContext,
): StremioFile[] {
  const listed = channels
    .filter(stremioEligible)
    .sort(
      (a, b) =>
        AVAILABILITY_ORDER[a.availability] - AVAILABILITY_ORDER[b.availability] ||
        b.score - a.score ||
        a.name.localeCompare(b.name),
    );

  const files: StremioFile[] = [];

  // ---- catalogues ---------------------------------------------------------
  const byGenre = new Map<string, StremioChannel[]>();
  const byCountry = new Map<string, StremioChannel[]>();
  for (const channel of listed) {
    for (const id of channel.categories) {
      const genre = ctx.categories.get(id) ?? id;
      if (!genreSafe(genre)) continue;
      const bucket = byGenre.get(genre) ?? [];
      bucket.push(channel);
      byGenre.set(genre, bucket);
    }
    const country = ctx.countries.get(channel.country) ?? channel.country;
    if (genreSafe(country)) {
      const bucket = byCountry.get(country) ?? [];
      bucket.push(channel);
      byCountry.set(country, bucket);
    }
  }

  const paginate = (catalog: string, items: StremioChannel[], extra: string | null) => {
    const base = `catalog/tv/${catalog}`;
    for (let skip = 0; skip === 0 || skip < items.length; skip += STREMIO_PAGE_SIZE) {
      const metas = items.slice(skip, skip + STREMIO_PAGE_SIZE).map((c) => metaPreview(c, ctx));
      const args = [extra, skip > 0 ? `skip=${skip}` : null].filter(Boolean).join('&');
      files.push({ path: args ? `${base}/${args}.json` : `${base}.json`, data: { metas } });
    }
  };

  paginate('nexus-live', listed, null);
  for (const [genre, items] of byGenre) paginate('nexus-live', items, `genre=${genre}`);
  paginate('nexus-country', listed, null);
  for (const [country, items] of byCountry) paginate('nexus-country', items, `genre=${country}`);

  // ---- per-channel meta and streams --------------------------------------
  for (const channel of listed) {
    const id = STREMIO_PREFIX + channel.id;
    files.push({
      path: `meta/tv/${id}.json`,
      data: {
        meta: {
          ...metaPreview(channel, ctx),
          logo: channel.logo ?? undefined,
          country: ctx.countries.get(channel.country) ?? channel.country,
          language: channel.languages.join(', ') || undefined,
          website: channel.website ?? undefined,
          links: ctx.homepage
            ? [{ name: 'IPTV Nexus', category: 'Website', url: `${ctx.homepage}/?channel=${encodeURIComponent(channel.id)}` }]
            : undefined,
        },
      },
    });

    files.push({
      path: `stream/tv/${id}.json`,
      data: {
        streams: channel.streams.map((stream) => {
          const headers: Record<string, string> = {};
          if (stream.referrer) headers.Referer = stream.referrer;
          if (stream.user_agent) headers['User-Agent'] = stream.user_agent;
          const needsHeaders = Object.keys(headers).length > 0;
          return {
            url: stream.url,
            name: ctx.name,
            title: streamTitle(stream),
            behaviorHints: {
              // Not web-ready: Stremio Web cannot play it directly, so the
              // desktop and mobile apps route it through their streaming
              // server, which is also what applies proxyHeaders.
              notWebReady: !stream.browser_playable || undefined,
              proxyHeaders: needsHeaders ? { request: headers } : undefined,
            },
          };
        }),
      },
    });
  }

  // ---- manifest -----------------------------------------------------------
  const genreOptions = [...byGenre.keys()].sort();
  const countryOptions = [...byCountry.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([country]) => country);

  files.push({
    path: 'manifest.json',
    data: {
      id: 'io.github.dearbulut.iptv-nexus',
      version: ctx.version,
      name: ctx.name,
      description: `${ctx.description} ${listed.length.toLocaleString('en')} live TV channels.`,
      resources: ['catalog', 'meta', 'stream'],
      types: ['tv'],
      idPrefixes: [STREMIO_PREFIX],
      catalogs: [
        {
          type: 'tv',
          id: 'nexus-live',
          name: `${ctx.name} · Categories`,
          extra: [{ name: 'genre', options: genreOptions }, { name: 'skip' }],
        },
        {
          type: 'tv',
          id: 'nexus-country',
          name: `${ctx.name} · Countries`,
          extra: [{ name: 'genre', options: countryOptions }, { name: 'skip' }],
        },
      ],
      behaviorHints: { configurable: false, configurationRequired: false },
    },
  });

  return files;
}
