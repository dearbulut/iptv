/**
 * Films and series from the Internet Archive — openly licensed only.
 *
 * An item is accepted only when its `licenseurl` names a public-domain
 * dedication (Public Domain Mark, CC0) or a Creative Commons licence. Items
 * without a licence statement are skipped, however old or famous: "probably
 * public domain" is not good enough for a catalogue other apps build on.
 *
 * Videos are linked, not copied: playback goes straight to archive.org.
 */

import { httpGetJson } from '../core/http.js';
import { mapConcurrent } from '../core/concurrency.js';
import { Logger } from '../core/logger.js';

const log = new Logger('vod:archive');

const SEARCH = 'https://archive.org/advancedsearch.php';
const METADATA = 'https://archive.org/metadata';
export const DOWNLOAD = 'https://archive.org/download';
export const POSTER = 'https://archive.org/services/img';

export interface ArchiveDoc {
  identifier: string;
  title?: string | string[];
  date?: string;
  year?: string | number;
  description?: string | string[];
  licenseurl?: string;
  subject?: string | string[];
  language?: string | string[];
  runtime?: string | string[];
  downloads?: number;
  collection?: string | string[];
}

export interface ArchiveFile {
  name: string;
  format?: string;
  source?: string;
  size?: string;
  length?: string;
  title?: string;
  height?: string;
}

export interface VodLicense {
  /** Short label: "Public Domain", "CC0", "CC BY", "CC BY-SA"… */
  label: string;
  url: string;
}

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : value)?.toString().trim() ?? '';
const all = (value: string | string[] | undefined): string[] =>
  (Array.isArray(value) ? value : value ? [value] : []).map((v) => String(v).trim()).filter(Boolean);

const CC_ORDER = ['BY', 'NC', 'SA', 'ND'];

/** Recognises an open licence from its URL, or returns null. */
export function openLicense(url: string | undefined): VodLicense | null {
  if (!url) return null;
  const clean = url.trim().replace(/^http:/, 'https:');
  if (/creativecommons\.org\/publicdomain\/zero/i.test(clean)) return { label: 'CC0', url: clean };
  // The Public Domain Mark, and the retired CC Public Domain Dedication (licenses/publicdomain).
  if (/creativecommons\.org\/(publicdomain\/mark|licenses\/publicdomain)/i.test(clean)) return { label: 'Public Domain', url: clean };
  const cc = clean.match(/creativecommons\.org\/licenses\/([a-z-]+)\/?/i);
  if (cc) {
    // Canonical order, so "nd-nc" and "nc-nd" read the same: BY, NC, SA, ND.
    const parts = [...new Set(cc[1]!.toUpperCase().split('-').filter(Boolean))];
    if (parts.some((part) => !CC_ORDER.includes(part))) return null;
    return { label: `CC ${parts.sort((a, b) => CC_ORDER.indexOf(a) - CC_ORDER.indexOf(b)).join('-')}`, url: clean };
  }
  return null;
}

/** Titles and tags that keep an item out of a general-audience catalogue. */
const ADULT =
  /\b(porn\w*|xxx|erotic\w*|nude|nudes|nudity|nudis[mt]\w*|naturis[mt]\w*|sex|sexy|sexual\w*|sexploitation|strip-?tease|stripper\w*|stag films?|burlesque|adult films?|orgy|orgies|exploitation)\b/i;

export function isFamilySafe(doc: ArchiveDoc): boolean {
  return !ADULT.test([first(doc.title), ...all(doc.subject)].join(' '));
}

/** Video formats archive.org derives, most widely playable first. */
const FORMAT_RANK = ['h.264', 'h.264 ia', 'mpeg4', 'h.264 hd', '512kb mpeg4', 'matroska', 'ogg video', 'webm'];

const formatRank = (format: string | undefined) => {
  const index = FORMAT_RANK.indexOf((format ?? '').toLowerCase());
  return index === -1 ? Number.POSITIVE_INFINITY : index;
};

/** A file's "base" name, so derivatives of one original group together. */
const baseName = (name: string) =>
  name
    .replace(/\.[^.]+$/, '')
    .replace(/(_512kb|\.ia|_h264|\.h264|_hd)$/i, '')
    .toLowerCase();

export interface VideoFile {
  name: string;
  url: string;
  title: string;
  /** Seconds, when known. */
  duration: number | null;
  format: string;
  size: number;
}

/**
 * One playable file per original video in the item, best format first, in
 * the item's own order. A film is usually one entry; a series item holds one
 * per episode.
 */
export function pickVideos(identifier: string, files: readonly ArchiveFile[]): VideoFile[] {
  const best = new Map<string, ArchiveFile>();
  const order: string[] = [];
  for (const file of files) {
    if (!Number.isFinite(formatRank(file.format))) continue;
    const key = baseName(file.name);
    const current = best.get(key);
    if (!current) {
      best.set(key, file);
      order.push(key);
    } else if (formatRank(file.format) < formatRank(current.format)) {
      best.set(key, file);
    }
  }
  return order
    .map((key) => best.get(key)!)
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
    .map((file) => ({
      name: file.name,
      url: `${DOWNLOAD}/${encodeURIComponent(identifier)}/${file.name.split('/').map(encodeURIComponent).join('/')}`,
      title: (file.title ?? file.name.replace(/\.[^.]+$/, '')).replace(/[_]+/g, ' ').trim(),
      duration: parseDuration(file.length),
      format: file.format ?? '',
      size: Number(file.size ?? 0),
    }));
}

/** "5400.12", "1:30:00", "90:00" → seconds. */
export function parseDuration(value: string | undefined): number | null {
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value));
  const parts = value.split(':').map(Number);
  if (parts.some((part) => Number.isNaN(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function yearOf(doc: ArchiveDoc): number | null {
  const match = String(doc.year ?? doc.date ?? '').match(/\b(18|19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

/** Plain text from archive.org's HTML descriptions, trimmed. */
export function plainText(value: string | string[] | undefined, max = 600): string {
  const text = all(value)
    .join('\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : text;
}

export const titleOf = (doc: ArchiveDoc) => first(doc.title) || doc.identifier;
export const subjectsOf = (doc: ArchiveDoc) =>
  all(doc.subject)
    .flatMap((s) => s.split(/[;,]/))
    .map((s) => s.trim())
    .filter(Boolean);
export const languageOf = (doc: ArchiveDoc) => first(doc.language) || null;

/** Searches archive.org, most downloaded first, up to `max` items. */
export async function searchArchive(query: string, max: number): Promise<ArchiveDoc[]> {
  const fields = [
    'identifier',
    'title',
    'date',
    'year',
    'description',
    'licenseurl',
    'subject',
    'language',
    'runtime',
    'downloads',
    'collection',
  ];
  const rows = Math.min(500, max);
  const docs: ArchiveDoc[] = [];
  for (let page = 1; docs.length < max; page++) {
    const params = new URLSearchParams({
      q: query,
      rows: String(rows),
      page: String(page),
      output: 'json',
    });
    for (const field of fields) params.append('fl[]', field);
    params.append('sort[]', 'downloads desc');
    const response = await httpGetJson<{
      response?: { docs?: ArchiveDoc[]; numFound?: number };
    }>(`${SEARCH}?${params}`, {
      timeoutMs: 60_000,
      attempts: 3,
    });
    const batch = response.response?.docs ?? [];
    docs.push(...batch);
    if (batch.length < rows) break;
  }
  log.info(`"${query}": ${docs.length} item(s)`);
  return docs.slice(0, max);
}

export async function fetchFiles(identifiers: readonly string[], concurrency = 6): Promise<Map<string, ArchiveFile[]>> {
  const result = new Map<string, ArchiveFile[]>();
  await mapConcurrent(
    identifiers,
    async (identifier) => {
      const metadata = await httpGetJson<{ files?: ArchiveFile[] }>(`${METADATA}/${encodeURIComponent(identifier)}`, {
        timeoutMs: 30_000,
        attempts: 2,
      });
      result.set(identifier, metadata.files ?? []);
    },
    { concurrency, tolerant: true },
  );
  return result;
}
