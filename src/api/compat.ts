/**
 * What a stream can be played *on*, and how to describe a channel's
 * availability honestly.
 *
 * Measured on 2026-11-17: 20.9% of streams are plain `http://`, which an HTTPS
 * page (GitHub Pages) cannot load — browsers block it as mixed content — and
 * 7.8% need a Referer or User-Agent header, which browser JavaScript cannot
 * set. Together that is over a quarter of the catalogue that the web player
 * used to pick and then fail on, even though every one of those streams works
 * in VLC, Kodi or TiviMate.
 */

import type { HealthRecord, StreamStatus } from '../core/types.js';

export interface StreamLike {
  url: string;
  referrer: string | null;
  user_agent: string | null;
}

/** Containers browsers cannot play directly even over HTTPS. */
const NON_BROWSER_PATH = /\.(ts|mpd|flv|mkv|avi)(\?|$)/i;

/**
 * True when a browser on an HTTPS page can reasonably play the stream: HTTPS,
 * no custom headers, and not a raw transport-stream / DASH / RTMP URL. HLS
 * (`.m3u8`, or extension-less manifests) and MP4/WebM pass.
 */
export function isBrowserPlayable(stream: StreamLike): boolean {
  if (!/^https:\/\//i.test(stream.url)) return false;
  if (stream.referrer || stream.user_agent) return false;
  try {
    return !NON_BROWSER_PATH.test(new URL(stream.url).pathname);
  } catch {
    return false;
  }
}

/** Why a stream is not browser-playable, for the UI. Null when it is. */
export function browserBlocker(stream: StreamLike): 'insecure' | 'headers' | 'format' | null {
  if (!/^https:\/\//i.test(stream.url)) return 'insecure';
  if (stream.referrer || stream.user_agent) return 'headers';
  return isBrowserPlayable(stream) ? null : 'format';
}

/**
 * Compact uptime history: one character per recorded check, oldest first,
 * `1` up and `0` down. A string rather than an array keeps channels.json small.
 */
export function historyString(record: HealthRecord | null): string {
  return record ? record.history.map((value) => (value ? '1' : '0')).join('') : '';
}

/**
 * A channel's availability, as a viewer should understand it.
 *
 * - `online`    at least one stream answered on the last scan
 * - `regional`  nothing answered, but at least one stream refused our scanner
 *               with a geo-block. Our runners sit in one region; such a stream
 *               may well work where the viewer is, so calling it "unchecked"
 *               or "offline" would both be wrong.
 * - `offline`   streams were checked and none responded
 * - `unchecked` streams exist but none has been conclusively checked yet
 * - `none`      no stream at all
 */
export type Availability = 'online' | 'regional' | 'offline' | 'unchecked' | 'none';

export function channelAvailability(
  streams: ReadonlyArray<{ health: { status: StreamStatus | string } | null }>,
): Availability {
  if (streams.length === 0) return 'none';
  const statuses = streams.map((stream) => stream.health?.status ?? 'unknown');
  if (statuses.includes('online')) return 'online';
  if (statuses.includes('blocked')) return 'regional';
  if (statuses.some((status) => ['offline', 'error', 'timeout'].includes(status))) {
    return 'offline';
  }
  return 'unchecked';
}
