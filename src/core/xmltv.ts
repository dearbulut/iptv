/** XMLTV parsing and serialisation. */

import { XMLParser } from 'fast-xml-parser';
import type { EpgChannel, EpgProgramme } from './types.js';

/**
 * Entity handling for real-world XMLTV.
 *
 * With `processEntities: true` fast-xml-parser caps the *total* number of
 * entity replacements across the whole document at 1000 — and it counts the
 * five predefined XML entities (`&amp;`, `&lt;`, …) towards that cap. Any guide
 * with more than a thousand "Tom &amp; Jerry"-style titles therefore failed to
 * parse with "Entity expansion limit exceeded", which silently took out every
 * large source we had (Pluto, mi.tv, Plex, Onet) and left only the smallest.
 *
 * The cap exists to stop billion-laughs attacks, which work through entities
 * *declared* in a DOCTYPE internal subset. XMLTV never needs those, so they
 * stay tightly limited here; only the predefined entities are uncapped.
 */
const ENTITY_LIMITS = {
  enabled: true,
  // Predefined entities are a fixed-size substitution and cannot amplify.
  maxTotalExpansions: Number.MAX_SAFE_INTEGER,
  // Declared entities: XMLTV has none, so these limits are deliberately small.
  maxEntityCount: 100,
  maxEntitySize: 1_000,
  maxExpansionDepth: 5,
  maxExpandedLength: 100_000,
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  processEntities: ENTITY_LIMITS,
  isArray: (name) => ['channel', 'programme', 'display-name', 'category', 'icon'].includes(name),
});

type XmlNode = Record<string, unknown>;

function text(node: unknown): string | null {
  if (node === null || node === undefined) return null;
  if (typeof node === 'string') return node.trim() || null;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === 'object') {
    const value = (node as XmlNode)['#text'];
    return value === undefined ? null : text(value);
  }
  return null;
}

function attr(node: unknown, name: string): string | null {
  if (node === null || typeof node !== 'object') return null;
  const value = (node as XmlNode)[`@${name}`];
  return value === undefined || value === null ? null : String(value);
}

function list(node: unknown): unknown[] {
  if (node === undefined || node === null) return [];
  return Array.isArray(node) ? node : [node];
}

/**
 * Parses an XMLTV timestamp (`20240115143000 +0300`) into an ISO-8601 UTC string.
 * Returns `null` for unparsable input rather than throwing — feeds are messy.
 */
export function parseXmltvDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*([+-]\d{4})?/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00', second = '00', offset] = match;

  let millis = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );

  if (offset) {
    const sign = offset[0] === '-' ? -1 : 1;
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMinutes = Number(offset.slice(3, 5));
    millis -= sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  }

  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Formats an ISO date back into XMLTV form (always UTC, `+0000`). */
export function formatXmltvDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`
  );
}

export interface ParsedXmltv {
  channels: EpgChannel[];
  programmes: EpgProgramme[];
}

/** Parses an XMLTV document into normalised channels and programmes. */
export function parseXmltv(xml: string, site = 'unknown'): ParsedXmltv {
  const document = parser.parse(xml) as XmlNode;
  const root = (document['tv'] ?? {}) as XmlNode;

  const channels: EpgChannel[] = [];
  for (const node of list(root['channel'])) {
    const id = attr(node, 'id');
    if (!id) continue;
    const displayNames = list((node as XmlNode)['display-name'])
      .map((entry) => text(entry))
      .filter((value): value is string => Boolean(value));
    const icons = list((node as XmlNode)['icon']);
    channels.push({
      id,
      display_names: [...new Set(displayNames)],
      icon: icons.length > 0 ? attr(icons[0], 'src') : null,
      site,
      lang: list((node as XmlNode)['display-name'])
        .map((entry) => attr(entry, 'lang'))
        .find((value): value is string => Boolean(value)) ?? null,
    });
  }

  const programmes: EpgProgramme[] = [];
  for (const node of list(root['programme'])) {
    const channel = attr(node, 'channel');
    const start = parseXmltvDate(attr(node, 'start'));
    const stop = parseXmltvDate(attr(node, 'stop'));
    const title = text((node as XmlNode)['title']);
    if (!channel || !start || !title) continue;

    const episodeNodes = list((node as XmlNode)['episode-num']);
    const xmltvNs = episodeNodes.find((entry) => attr(entry, 'system') === 'xmltv_ns');
    const onscreen = episodeNodes.find((entry) => attr(entry, 'system') === 'onscreen');

    let season: number | null = null;
    let episodeNum: number | null = null;
    const nsValue = text(xmltvNs);
    if (nsValue) {
      const parts = nsValue.split('.');
      const seasonPart = parts[0]?.split('/')[0]?.trim();
      const episodePart = parts[1]?.split('/')[0]?.trim();
      if (seasonPart) season = Number.parseInt(seasonPart, 10) + 1;
      if (episodePart) episodeNum = Number.parseInt(episodePart, 10) + 1;
    }

    const icons = list((node as XmlNode)['icon']);
    const ratingNode = list((node as XmlNode)['rating'])[0];

    programmes.push({
      channel,
      start,
      stop: stop ?? start,
      title,
      sub_title: text((node as XmlNode)['sub-title']),
      description: text((node as XmlNode)['desc']),
      categories: list((node as XmlNode)['category'])
        .map((entry) => text(entry))
        .filter((value): value is string => Boolean(value)),
      icon: icons.length > 0 ? attr(icons[0], 'src') : null,
      episode: text(onscreen) ?? nsValue,
      season: Number.isFinite(season) ? season : null,
      episode_num: Number.isFinite(episodeNum) ? episodeNum : null,
      rating: ratingNode ? text((ratingNode as XmlNode)['value']) : null,
      lang: attr((node as XmlNode)['title'], 'lang'),
    });
  }

  return { channels, programmes };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Strip control characters that are illegal in XML 1.0.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

export interface WriteXmltvOptions {
  generatorName?: string;
  generatorUrl?: string;
}

/** Serialises channels and programmes into an XMLTV document. */
export function writeXmltv(
  channels: readonly EpgChannel[],
  programmes: readonly EpgProgramme[],
  options: WriteXmltvOptions = {},
): string {
  const { generatorName = 'IPTV Nexus', generatorUrl = 'https://github.com/iptv-nexus' } = options;
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
    `<tv generator-info-name="${escapeXml(generatorName)}" generator-info-url="${escapeXml(generatorUrl)}">`,
  ];

  for (const channel of channels) {
    out.push(`  <channel id="${escapeXml(channel.id)}">`);
    for (const name of channel.display_names) {
      const lang = channel.lang ? ` lang="${escapeXml(channel.lang)}"` : '';
      out.push(`    <display-name${lang}>${escapeXml(name)}</display-name>`);
    }
    if (channel.icon) out.push(`    <icon src="${escapeXml(channel.icon)}" />`);
    out.push('  </channel>');
  }

  for (const programme of programmes) {
    const stop = programme.stop ? ` stop="${formatXmltvDate(programme.stop)}"` : '';
    out.push(
      `  <programme start="${formatXmltvDate(programme.start)}"${stop} channel="${escapeXml(programme.channel)}">`,
    );
    const lang = programme.lang ? ` lang="${escapeXml(programme.lang)}"` : '';
    out.push(`    <title${lang}>${escapeXml(programme.title)}</title>`);
    if (programme.sub_title) {
      out.push(`    <sub-title${lang}>${escapeXml(programme.sub_title)}</sub-title>`);
    }
    if (programme.description) {
      out.push(`    <desc${lang}>${escapeXml(programme.description)}</desc>`);
    }
    for (const category of programme.categories) {
      out.push(`    <category${lang}>${escapeXml(category)}</category>`);
    }
    if (programme.icon) out.push(`    <icon src="${escapeXml(programme.icon)}" />`);
    if (programme.episode) {
      out.push(`    <episode-num system="onscreen">${escapeXml(programme.episode)}</episode-num>`);
    }
    if (programme.rating) {
      out.push(
        `    <rating><value>${escapeXml(programme.rating)}</value></rating>`,
      );
    }
    out.push('  </programme>');
  }

  out.push('</tv>');
  return `${out.join('\n')}\n`;
}
