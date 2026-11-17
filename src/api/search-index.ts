/**
 * Compact client-side search index.
 *
 * Rows are positional arrays rather than objects — for ~40k channels that is
 * roughly a third of the bytes, which matters when a browser downloads the
 * whole index up front to search offline.
 */

import { matchKey } from '../core/text.js';

export const SEARCH_FIELDS = [
  'id',
  'name',
  'search',
  'country',
  'categories',
  'languages',
  'logo',
  'score',
  'online',
  'streams',
  'quality',
  // Appended 2026-11. Fields are only ever added at the end so clients that
  // read positions keep working.
  'browser',
  'availability',
  'number',
] as const;

export type SearchRow = [
  string, // id
  string, // name
  string, // normalised search blob
  string, // country
  string, // categories, semicolon separated
  string, // languages, semicolon separated
  string, // logo
  number, // score
  0 | 1, // online
  number, // stream count
  string, // best quality
  0 | 1, // at least one stream plays in a browser
  string, // availability: online | regional | offline | unchecked | none
  number, // stable channel number, 0 when unnumbered
];

export interface SearchIndex {
  generated_at: string;
  fields: readonly string[];
  count: number;
  channels: SearchRow[];
}

interface IndexableChannel {
  id: string;
  name: string;
  alt_names: string[];
  network: string | null;
  country: string;
  categories: string[];
  languages: string[];
  logo: string | null;
  score: number;
  online: boolean;
  stream_count: number;
  best_quality: string | null;
  browser_playable?: boolean;
  availability?: string;
  number?: number | null;
}

/** Builds the positional search index. */
export function buildSearchIndex(channels: readonly IndexableChannel[]): SearchIndex {
  const rows: SearchRow[] = channels.map((channel) => {
    // One normalised blob so the client can do a single `includes()` test.
    const searchable = [
      channel.name,
      ...channel.alt_names,
      channel.network ?? '',
      channel.id.replace(/\./g, ' '),
    ]
      .filter(Boolean)
      .map((value) => matchKey(value))
      .filter(Boolean);

    return [
      channel.id,
      channel.name,
      [...new Set(searchable)].join(' '),
      channel.country ?? '',
      channel.categories.join(';'),
      channel.languages.join(';'),
      channel.logo ?? '',
      channel.score,
      channel.online ? 1 : 0,
      channel.stream_count,
      channel.best_quality ?? '',
      channel.browser_playable ? 1 : 0,
      channel.availability ?? (channel.online ? 'online' : 'unchecked'),
      channel.number ?? 0,
    ];
  });

  // Playable and healthy channels first — clients can slice the head for
  // "top results" without sorting the whole array.
  rows.sort((a, b) => {
    if (a[8] !== b[8]) return b[8] - a[8];
    if (a[7] !== b[7]) return b[7] - a[7];
    return a[1].localeCompare(b[1]);
  });

  return {
    generated_at: new Date().toISOString(),
    fields: SEARCH_FIELDS,
    count: rows.length,
    channels: rows,
  };
}
