/**
 * M3U enricher core: parse any playlist, match its entries to Nexus channels
 * and write it back with tvg-id, logo, channel number and guide URL filled in.
 *
 * Pure functions, no DOM: the tools page runs them in the browser (so a
 * provider's playlist never leaves the device) and the test suite runs them
 * in Node.
 */

// ------------------------------------------------------------------ parsing

const ATTR = /([A-Za-z0-9_-]+)="([^"]*)"/g;

/**
 * Parses an M3U playlist into a header and entries. Every line is kept, so a
 * playlist can be written back with only the attributes we touched changed.
 */
export function parseM3u(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = { attrs: {}, raw: '#EXTM3U' };
  const entries = [];
  let current = null;
  let pending = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#EXTM3U')) {
      header.raw = trimmed;
      header.attrs = readAttrs(trimmed.slice(7));
      continue;
    }
    if (trimmed.startsWith('#EXTINF')) {
      current = parseExtinf(trimmed);
      current.extra = pending;
      pending = [];
      continue;
    }
    if (trimmed.startsWith('#')) {
      // #EXTVLCOPT, #KODIPROP, #EXTGRP… belong to the next URL.
      (current ? (current.extra ??= []) : pending).push(trimmed);
      continue;
    }
    if (current) {
      current.url = trimmed;
      entries.push(current);
      current = null;
    } else {
      entries.push({ duration: '-1', attrs: {}, title: trimmed, url: trimmed, extra: pending });
      pending = [];
    }
  }
  return { header, entries };
}

function readAttrs(text) {
  const attrs = {};
  for (const [, key, value] of text.matchAll(ATTR)) attrs[key] = value;
  return attrs;
}

function parseExtinf(line) {
  const body = line.slice('#EXTINF:'.length);
  // The title follows the first comma that is not inside a quoted attribute.
  let inQuotes = false;
  let split = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) {
      split = i;
      break;
    }
  }
  const meta = split === -1 ? body : body.slice(0, split);
  const title = split === -1 ? '' : body.slice(split + 1).trim();
  const duration = (meta.match(/^\s*(-?\d+(?:\.\d+)?)/) ?? [, '-1'])[1];
  return { duration, attrs: readAttrs(meta), title, url: '', extra: [] };
}

const quote = (value) => String(value).replace(/"/g, "'");

/** Writes entries back as M3U, attributes in their original order. */
export function writeM3u(header, entries) {
  const head = Object.entries(header.attrs)
    .map(([key, value]) => ` ${key}="${quote(value)}"`)
    .join('');
  const out = [`#EXTM3U${head}`];
  for (const entry of entries) {
    const attrs = Object.entries(entry.attrs)
      .map(([key, value]) => ` ${key}="${quote(value)}"`)
      .join('');
    out.push(`#EXTINF:${entry.duration}${attrs},${entry.title}`);
    for (const line of entry.extra ?? []) out.push(line);
    out.push(entry.url);
  }
  return `${out.join('\n')}\n`;
}

// ------------------------------------------------------------ normalising

/** Words that describe a feed, not a channel. */
// Deliberately short: removing a word that is part of a name ("Kanal D",
// "Canal+") would make different channels collide. Both sides of a match are
// normalised the same way, so "Show TV" and "Show TV HD" still meet.
const NOISE = new Set([
  'hd', 'fhd', 'uhd', 'sd', 'hq', 'lq', '4k', '8k', 'hevc', 'h264', 'h265', 'x264', 'x265',
  'raw', 'backup', 'tv', 'fps', '50fps', '60fps', '25fps', '1080p', '1080i', '720p', '576p',
  '576i', '480p', '360p', '2160p', 'vip', 'orig',
]);

/**
 * Leading tags providers put in front of names: `TR:`, `TR |`, `|TR|`,
 * `[TR]`, `TR -`. Returns the country-ish tag and the rest of the name.
 */
export function splitPrefix(name) {
  const match = String(name ?? '').match(
    /^\s*(?:\|\s*([A-Za-z]{2,4})\s*\||\[\s*([A-Za-z]{2,4})\s*\]|([A-Z]{2,4})\s*[:|»•]|([A-Z]{2,4})\s+-\s)\s*(.*)$/,
  );
  if (!match || !match[5]) return { tag: null, rest: String(name ?? '') };
  return { tag: (match[1] ?? match[2] ?? match[3] ?? match[4]).toUpperCase(), rest: match[5] };
}

/**
 * Candidate keys for a name: with any leading tag removed, and as written.
 * Trying both means "TR: TRT 1" finds TRT 1 while "CNN: Live" — not a
 * country tag — still has its full name to fall back on.
 */
export function keysFor(name) {
  const rest = splitPrefix(name).rest;
  // Exact spellings first ("ART TV" must find ART TV, not ART), then the
  // forms with feed words removed ("TRT 1 FHD" finds TRT 1).
  const keys = [
    normaliseName(rest, true),
    normaliseName(name, true),
    normaliseName(rest),
    normaliseName(name),
  ];
  return [...new Set(keys.filter(Boolean))];
}

/**
 * A matching key: lower case, no accents, alphanumerics only, and — unless
 * `keepNoise` — without feed words like HD or TV.
 */
export function normaliseName(name, keepNoise = false) {
  const cleaned = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ') // (1080p) [Geo-blocked]
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, ' ');
  const words = cleaned.split(' ').filter((word) => word && (keepNoise || !NOISE.has(word)));
  return words.join('');
}

/** Country code hints from the entry's attributes, name prefix and group. */
export function countryHints(entry, countryNames) {
  const hints = new Set();
  const add = (code) => {
    const upper = String(code ?? '').toUpperCase();
    if (upper === 'UK') hints.add('GB');
    if (countryNames.has(upper)) hints.add(upper);
  };
  for (const code of String(entry.attrs['tvg-country'] ?? '').split(/[;,]/)) add(code.trim());
  add(splitPrefix(entry.title).tag);
  add(splitPrefix(entry.attrs['tvg-name'] ?? '').tag);
  const group = entry.attrs['group-title'] ?? '';
  add(splitPrefix(group).tag);
  const groupKey = normaliseName(group);
  for (const [code, key] of countryNames) {
    if (key && groupKey.includes(key)) add(code);
  }
  // Feed-suffixed ids name the country too: `TRT1.tr`, `TRT1.tr@HD`.
  const id = entry.attrs['tvg-id'] ?? '';
  const suffix = id.split('@')[0].split('.').pop();
  if (suffix && suffix !== id) add(suffix);
  return hints;
}

// ---------------------------------------------------------------- matching

/**
 * Builds lookup tables from `api/v1/match.json`
 * (rows: id, name, alt names joined by `|`, country, logo, number, state, guide).
 */
export function buildMatcher(matchIndex, countries = []) {
  const position = Object.fromEntries(matchIndex.fields.map((field, i) => [field, i]));
  const byId = new Map();
  const byKey = new Map();
  const byCountry = new Map();
  const channels = [];
  for (const row of matchIndex.channels) {
    const channel = {
      id: row[position.id],
      name: row[position.name],
      alt: row[position.alt] ? row[position.alt].split('|') : [],
      country: row[position.country],
      logo: row[position.logo] || null,
      number: row[position.number] ?? null,
      state: row[position.state] ?? 0,
      guide: row[position.guide] === 1,
    };
    channels.push(channel);
    byId.set(channel.id.toLowerCase(), channel);
    const names = [channel.name, ...channel.alt];
    const keys = new Set([
      ...names.map((name) => normaliseName(name, true)),
      ...names.map((name) => normaliseName(name)),
    ]);
    // The id without its country suffix is often the cleanest name of all.
    const idKey = normaliseName(channel.id.split('.')[0].replace(/([a-z])([A-Z])/g, '$1 $2'), true);
    keys.add(idKey);
    keys.delete('');
    channel.keys = [...keys];
    const sameCountry = byCountry.get(channel.country) ?? [];
    sameCountry.push(channel);
    byCountry.set(channel.country, sameCountry);
    // The id-derived key counts as the channel's own name too.
    const primary = new Set([normaliseName(channel.name, true), normaliseName(channel.name), idKey]);
    for (const key of channel.keys) {
      const bucket = byKey.get(key) ?? [];
      bucket.push({ channel, primary: primary.has(key) });
      byKey.set(key, bucket);
    }
  }
  const countryNames = new Map(countries.map((c) => [c.code.toUpperCase(), normaliseName(c.name)]));
  return { byId, byKey, byCountry, channels, countryNames };
}

/**
 * Prefer the hinted country, then a channel whose own name this is (over one
 * that merely lists it as an alias), then one we can play, then one with a
 * guide.
 */
function rank(candidates, hints) {
  return [...candidates]
    .sort(
      (a, b) =>
        Number(hints.has(b.channel.country)) - Number(hints.has(a.channel.country)) ||
        Number(b.primary) - Number(a.primary) ||
        b.channel.state - a.channel.state ||
        Number(b.channel.guide) - Number(a.channel.guide) ||
        a.channel.id.localeCompare(b.channel.id),
    )
    .map((candidate) => candidate.channel);
}

function bigrams(text) {
  const grams = new Map();
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const left = bigrams(a);
  let overlap = 0;
  for (const [gram, count] of bigrams(b)) {
    const other = left.get(gram);
    if (other) overlap += Math.min(count, other);
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

/** Entries from VOD sections of a provider playlist are left untouched. */
export function isVod(entry) {
  return /\/(movie|series|vod)\//i.test(entry.url) || /\.(mkv|mp4|avi)(\?|$)/i.test(entry.url);
}

/**
 * Matches one playlist entry. Returns `{ channel, method, confidence }` or
 * null. Methods: `id` (its tvg-id is already a Nexus id), `name` (exact
 * normalised name), `fuzzy` (close name within a hinted country only — never
 * guessed across the whole world).
 */
export function matchEntry(entry, matcher, { fuzzyThreshold = 0.86 } = {}) {
  const tvgId = (entry.attrs['tvg-id'] ?? '').split('@')[0].toLowerCase();
  if (tvgId && matcher.byId.has(tvgId)) {
    return { channel: matcher.byId.get(tvgId), method: 'id', confidence: 1 };
  }

  const hints = countryHints(entry, matcher.countryNames);
  // Collect candidates from every key, remembering how exact the key was.
  // A channel in the hinted country beats any spelling match elsewhere:
  // "|CZ| UTV HD" is the Czech UTV, not India's "UTV HD".
  const keys = [...new Set([...keysFor(entry.attrs['tvg-name']), ...keysFor(entry.title)])];
  const found = [];
  keys.forEach((key, order) => {
    for (const candidate of matcher.byKey.get(key) ?? []) found.push({ ...candidate, order });
  });
  if (found.length > 0) {
    found.sort(
      (a, b) =>
        Number(hints.has(b.channel.country)) - Number(hints.has(a.channel.country)) ||
        a.order - b.order,
    );
    const top = found[0];
    const tied = found.filter(
      (c) => c.order === top.order && hints.has(c.channel.country) === hints.has(top.channel.country),
    );
    const ranked = rank(tied, hints);
    const distinct = new Set(found.map((c) => c.channel.id)).size;
    // Same-named channels in different countries and no hint: the guess is
    // still useful, but say so.
    const unsure = distinct > 1 && !hints.has(ranked[0].country);
    return { channel: ranked[0], method: 'name', confidence: unsure ? 0.75 : 0.95 };
  }

  if (hints.size === 0) return null;
  const key = keysFor(entry.attrs['tvg-name'] || entry.title)[0] ?? '';
  if (key.length < 3) return null;
  let best = null;
  for (const country of hints) {
    for (const channel of matcher.byCountry.get(country) ?? []) {
      for (const name of channel.keys) {
        const score = dice(key, name);
        if (score >= fuzzyThreshold && (!best || score > best.confidence)) {
          best = { channel, method: 'fuzzy', confidence: Math.round(score * 100) / 100 };
        }
      }
    }
  }
  return best;
}

/**
 * Applies matches to a parsed playlist. Options choose what gets written:
 * `ids` (tvg-id), `logos` (only where missing), `numbers` (tvg-chno), and
 * `guideUrl` for the header. Returns the new entries and a summary.
 */
export function enrichPlaylist(parsed, matcher, options = {}) {
  const { ids = true, logos = true, numbers = false, guideUrl = null, minConfidence = 0.8 } = options;
  const summary = { total: 0, vod: 0, matched: 0, withGuide: 0, byMethod: { id: 0, name: 0, fuzzy: 0 }, unmatched: [] };
  const results = [];

  const entries = parsed.entries.map((entry) => {
    if (isVod(entry)) {
      summary.vod++;
      return entry;
    }
    summary.total++;
    const match = matchEntry(entry, matcher);
    results.push({ entry, match });
    if (!match || match.confidence < minConfidence) {
      summary.unmatched.push(entry.title || entry.attrs['tvg-name'] || entry.url);
      return entry;
    }
    summary.matched++;
    summary.byMethod[match.method]++;
    if (match.channel.guide) summary.withGuide++;

    const attrs = { ...entry.attrs };
    if (ids) attrs['tvg-id'] = match.channel.id;
    if (logos && !attrs['tvg-logo'] && match.channel.logo) attrs['tvg-logo'] = match.channel.logo;
    if (numbers && match.channel.number) attrs['tvg-chno'] = String(match.channel.number);
    return { ...entry, attrs };
  });

  const header = { ...parsed.header, attrs: { ...parsed.header.attrs } };
  if (guideUrl) {
    header.attrs['x-tvg-url'] = guideUrl;
    delete header.attrs['url-tvg'];
  }
  return { header, entries, summary, results };
}
