/**
 * Canonical data model for IPTV Nexus.
 *
 * The upstream `iptv-org` schema is used as the baseline so that existing
 * tooling keeps working, then extended with the fields this project adds:
 * health metrics, provenance, scoring and EPG linkage.
 */

// ---------------------------------------------------------------------------
// Upstream-compatible entities
// ---------------------------------------------------------------------------

export interface Channel {
  id: string;
  name: string;
  alt_names: string[];
  network: string | null;
  owners: string[];
  country: string;
  subdivision?: string | null;
  city?: string | null;
  categories: string[];
  is_nsfw: boolean;
  launched: string | null;
  closed: string | null;
  replaced_by: string | null;
  website: string | null;
  logo?: string | null;
}

export interface Feed {
  channel: string;
  id: string;
  name: string;
  alt_names: string[];
  is_main: boolean;
  broadcast_area: string[];
  timezones: string[];
  languages: string[];
  format: string | null;
  video_format?: string | null;
}

export interface Logo {
  channel: string;
  feed: string | null;
  in_use: boolean;
  tags: string[];
  width: number;
  height: number;
  format: string | null;
  url: string;
}

export interface Stream {
  channel: string | null;
  feed: string | null;
  title: string;
  url: string;
  referrer: string | null;
  user_agent: string | null;
  quality: string | null;
  label?: string | null;
}

export interface Guide {
  channel: string | null;
  feed: string | null;
  site: string;
  site_id: string;
  site_name: string;
  lang: string;
  sources?: string[];
}

export interface Category {
  id: string;
  name: string;
  description?: string;
}

export interface Language {
  name: string;
  code: string;
}

export interface Country {
  name: string;
  code: string;
  languages: string[];
  flag: string;
}

export interface Subdivision {
  country: string;
  name: string;
  code: string;
  parent: string | null;
}

export interface Region {
  code: string;
  name: string;
  countries: string[];
}

export interface Timezone {
  id: string;
  utc_offset: string;
  countries: string[];
}

export interface BlocklistEntry {
  /** Channel removed entirely. Empty when the entry removes one stream. */
  channel: string;
  reason: string;
  ref: string;
  /** IPTV Nexus extension: remove only this stream URL. */
  url?: string;
  /** IPTV Nexus extension: when the entry was added. */
  added_at?: string;
}

// ---------------------------------------------------------------------------
// Nexus extensions
// ---------------------------------------------------------------------------

/** Stable identity for a stream, derived from its normalised URL. */
export type StreamKey = string;

export type StreamStatus = 'online' | 'offline' | 'timeout' | 'blocked' | 'error' | 'unknown';

export interface StreamMedia {
  width: number | null;
  height: number | null;
  /** Human label such as `1080p`. */
  resolution: string | null;
  frame_rate: number | null;
  /** Total bitrate in bits/second when reported by the container. */
  bitrate: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  /** Number of variants in an HLS master playlist. */
  variants: number | null;
}

export interface HealthCheck {
  /** ISO-8601 timestamp of the check. */
  checked_at: string;
  status: StreamStatus;
  /** Milliseconds until the first byte of the manifest. */
  latency_ms: number | null;
  http_status: number | null;
  error: string | null;
  media: StreamMedia | null;
}

export interface HealthRecord {
  key: StreamKey;
  url: string;
  status: StreamStatus;
  /** 0-100 rolling availability score (exponentially weighted). */
  score: number;
  checked_at: string;
  first_seen: string;
  last_online: string | null;
  /** Consecutive failed checks. Used to retire a stream. */
  failures: number;
  checks: number;
  latency_ms: number | null;
  http_status: number | null;
  error: string | null;
  media: StreamMedia | null;
  /** Compact history, newest last. `1` = online, `0` = offline. */
  history: number[];
}

export interface StreamProvenance {
  /** Id of the source (see `config/sources.yml`). */
  source: string;
  /** Where this entry was literally read from. */
  origin: string;
  added_at: string;
}

/** A stream enriched with health, provenance and resolved channel metadata. */
export interface EnrichedStream extends Stream {
  key: StreamKey;
  provenance: StreamProvenance[];
  health: HealthRecord | null;
  /** Sort weight: higher is better. Derived from health + quality + source trust. */
  rank: number;
}

export interface EnrichedChannel extends Channel {
  /** Feeds that belong to this channel. */
  feeds: Feed[];
  /** All known playable streams, best first. */
  streams: EnrichedStream[];
  /** EPG channel ids this channel is linked to. */
  guides: ChannelGuideLink[];
  /** Best available logo URL. */
  logo: string | null;
  /** Aggregate availability score across streams (0-100). */
  score: number;
  /** `true` when at least one stream responded on the last scan. */
  online: boolean;
  languages: string[];
  broadcast_area: string[];
  timezones: string[];
}

export interface ChannelGuideLink {
  site: string;
  site_id: string;
  lang: string;
  /** 0-1 confidence when the link was produced by fuzzy matching. */
  confidence: number;
  /** How this link was established. */
  method: 'upstream' | 'exact' | 'alias' | 'fuzzy' | 'manual';
}

// ---------------------------------------------------------------------------
// EPG
// ---------------------------------------------------------------------------

export interface EpgChannel {
  id: string;
  display_names: string[];
  icon: string | null;
  /** Source site the channel came from. */
  site: string;
  lang: string | null;
}

export interface EpgProgramme {
  channel: string;
  /** ISO-8601 UTC. */
  start: string;
  stop: string;
  title: string;
  sub_title: string | null;
  description: string | null;
  categories: string[];
  icon: string | null;
  episode: string | null;
  season: number | null;
  episode_num: number | null;
  rating: string | null;
  lang: string | null;
}

export interface EpgBundle {
  site: string;
  generated_at: string;
  channels: EpgChannel[];
  programmes: EpgProgramme[];
}

// ---------------------------------------------------------------------------
// M3U
// ---------------------------------------------------------------------------

export interface M3uEntry {
  /** Raw `#EXTINF` duration, usually `-1`. */
  duration: number;
  title: string;
  url: string;
  attributes: Record<string, string>;
  /** `#EXTVLCOPT` / `#EXTHTTP` derived headers. */
  headers: Record<string, string>;
  /** `#EXTGRP` value when present. */
  group: string | null;
}

export interface M3uPlaylist {
  /** Attributes on the `#EXTM3U` header line. */
  header: Record<string, string>;
  entries: M3uEntry[];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface DiscoveryCandidate {
  url: string;
  title: string;
  source: string;
  /** Normalised URL key, used for dedupe. */
  key: StreamKey;
  attributes: Record<string, string>;
  /** Best-guess channel id from fuzzy matching, if any. */
  suggested_channel: string | null;
  confidence: number;
  health: HealthCheck | null;
}

export interface DiscoveryReport {
  generated_at: string;
  scanned_sources: number;
  candidates_seen: number;
  candidates_new: number;
  accepted: DiscoveryCandidate[];
  rejected: Array<{ url: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// API manifest
// ---------------------------------------------------------------------------

export interface ApiManifest {
  name: string;
  version: string;
  generated_at: string;
  /** Base URL the files are served from, when configured. */
  base_url: string | null;
  counts: {
    channels: number;
    /** Channels with at least one stream. */
    playable_channels: number;
    online_channels: number;
    feeds: number;
    streams: number;
    online_streams: number;
    guides: number;
    epg_programmes: number;
    countries: number;
    languages: number;
    categories: number;
  };
  endpoints: Record<string, string>;
  upstream: {
    source: string;
    fetched_at: string;
  };
}
