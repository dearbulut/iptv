/**
 * What changed in the catalogue since the previous build: channels that
 * gained their first working stream, and channels that lost their last one.
 *
 * Published as `api/v1/changes.json` and an Atom feed (`changes.xml`), so
 * people can follow the catalogue in any feed reader and developers can sync
 * incrementally. Online/offline flapping of individual streams is
 * deliberately not reported — it changes every few hours and would bury the
 * news; health.json covers it.
 *
 * The previous snapshot and the history are persisted on the state branch by
 * the Sync workflow, like the channel numbers.
 */

export interface CatalogueSnapshot {
  version: 1;
  generated_at: string;
  playable: string[];
}

export interface ChangedChannel {
  id: string;
  name: string;
  country: string;
}

export interface ChangeEntry {
  at: string;
  added: ChangedChannel[];
  removed: ChangedChannel[];
  playable: number;
}

export interface ChangeHistory {
  version: 1;
  entries: ChangeEntry[];
}

export const HISTORY_LIMIT = 120;

export function normaliseSnapshot(raw: unknown): CatalogueSnapshot | null {
  const value = raw as Partial<CatalogueSnapshot> | null;
  if (!value || !Array.isArray(value.playable)) return null;
  return {
    version: 1,
    generated_at: String(value.generated_at ?? ''),
    playable: value.playable.filter((id) => typeof id === 'string'),
  };
}

export function normaliseHistory(raw: unknown): ChangeHistory {
  const value = raw as Partial<ChangeHistory> | null;
  return { version: 1, entries: Array.isArray(value?.entries) ? value.entries : [] };
}

/**
 * Compares the current catalogue with the previous snapshot. Returns the new
 * snapshot, the updated history and the entry recorded by this build (null
 * when nothing changed, or on the very first build, which has nothing to
 * compare with and would otherwise announce every channel as new).
 */
export function computeChanges(
  previous: CatalogueSnapshot | null,
  current: ReadonlyArray<ChangedChannel & { playable: boolean }>,
  history: ChangeHistory,
  now: string,
  names: ReadonlyMap<string, ChangedChannel> = new Map(),
): { snapshot: CatalogueSnapshot; history: ChangeHistory; entry: ChangeEntry | null } {
  const playable = current.filter((channel) => channel.playable);
  const snapshot: CatalogueSnapshot = {
    version: 1,
    generated_at: now,
    playable: playable.map((channel) => channel.id).sort(),
  };
  if (!previous) return { snapshot, history, entry: null };

  const before = new Set(previous.playable);
  const after = new Set(snapshot.playable);
  const byId = new Map(current.map((channel) => [channel.id, channel]));
  const describe = (id: string): ChangedChannel => {
    const channel = byId.get(id) ?? names.get(id);
    return { id, name: channel?.name ?? id, country: channel?.country ?? '' };
  };

  const added = snapshot.playable.filter((id) => !before.has(id)).map(describe);
  const removed = previous.playable.filter((id) => !after.has(id)).map(describe);
  if (added.length === 0 && removed.length === 0) return { snapshot, history, entry: null };

  const entry: ChangeEntry = { at: now, added, removed, playable: snapshot.playable.length };
  return {
    snapshot,
    history: { version: 1, entries: [entry, ...history.entries].slice(0, HISTORY_LIMIT) },
    entry,
  };
}

const escapeXml = (value: string): string =>
  value.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** Atom feed of the history, newest first. */
export function changesAtom(
  history: ChangeHistory,
  options: { title: string; siteUrl: string; feedUrl: string; updated: string },
): string {
  const link = (channel: ChangedChannel) =>
    `<li><a href="${escapeXml(`${options.siteUrl}/?channel=${encodeURIComponent(channel.id)}`)}">${escapeXml(channel.name)}</a>${channel.country ? ` (${escapeXml(channel.country)})` : ''}</li>`;
  const section = (heading: string, channels: ChangedChannel[]) => {
    if (channels.length === 0) return '';
    const shown = channels.slice(0, 100).map(link).join('');
    const more = channels.length > 100 ? `<li>…and ${channels.length - 100} more</li>` : '';
    return `<h3>${heading}</h3><ul>${shown}${more}</ul>`;
  };

  const entries = history.entries.map((entry) => {
    const parts = [
      entry.added.length > 0 ? `${entry.added.length} new` : null,
      entry.removed.length > 0 ? `${entry.removed.length} gone` : null,
    ].filter(Boolean);
    const html =
      section('Now watchable', entry.added) +
      section('No longer watchable', entry.removed) +
      `<p>${entry.playable.toLocaleString('en')} watchable channels in total.</p>`;
    return [
      '  <entry>',
      `    <id>${escapeXml(`${options.feedUrl}#${entry.at}`)}</id>`,
      `    <title>${escapeXml(`${parts.join(', ')} — ${entry.at.slice(0, 16).replace('T', ' ')} UTC`)}</title>`,
      `    <updated>${entry.at}</updated>`,
      `    <link href="${escapeXml(options.siteUrl)}"/>`,
      `    <content type="html">${escapeXml(html)}</content>`,
      '  </entry>',
    ].join('\n');
  });

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${escapeXml(options.title)} — catalogue changes</title>`,
    `  <id>${escapeXml(options.feedUrl)}</id>`,
    `  <link rel="self" href="${escapeXml(options.feedUrl)}"/>`,
    `  <link href="${escapeXml(options.siteUrl)}"/>`,
    `  <updated>${history.entries[0]?.at ?? options.updated}</updated>`,
    ...entries,
    '</feed>',
    '',
  ].join('\n');
}
