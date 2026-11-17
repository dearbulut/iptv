/**
 * EPG pipeline: grab → normalise → match to Nexus channels → emit XMLTV.
 *
 * The output is keyed by *Nexus channel id*, not by each source's arbitrary
 * channel id, which is what makes a single merged guide usable in any player.
 */

import path from 'node:path';
import { loadConfig, PATHS, type EpgOverride, type Settings } from '../core/config.js';
import { ensureDir, writeGzip, writeJson, writeText } from '../core/fs.js';
import { Logger } from '../core/logger.js';
import { matchKey } from '../core/text.js';
import { writeXmltv } from '../core/xmltv.js';
import type {
  Channel,
  ChannelGuideLink,
  EpgBundle,
  EpgChannel,
  EpgProgramme,
  Guide,
} from '../core/types.js';
import { buildChannelIndex, resolveEpgChannel, type ChannelIndex } from '../aggregate/match.js';
import { loadDataset } from '../aggregate/index.js';
import { grabAll } from './grab.js';

const log = new Logger('epg');

export interface EpgLink {
  /** Nexus channel id. */
  channel: string;
  /** Source-side channel id. */
  site_id: string;
  site: string;
  confidence: number;
  method: ChannelGuideLink['method'];
}

export interface EpgBuildResult {
  generated_at: string;
  sources: number;
  epg_channels: number;
  linked_channels: number;
  programmes: number;
  /** Programmes per output country shard. */
  shards: Record<string, number>;
  unmatched: Array<{ site: string; id: string; name: string }>;
}

/**
 * Builds an index from the upstream `guides.json`, which already maps
 * `site` + `site_id` → channel. These links are authoritative and let us skip
 * fuzzy matching for most channels.
 */
function buildUpstreamGuideIndex(guides: readonly Guide[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const guide of guides) {
    if (!guide.channel) continue;
    index.set(`${guide.site}::${guide.site_id}`, guide.channel);
    // Some guides are only identifiable by their site_id.
    const bare = `*::${guide.site_id}`;
    if (!index.has(bare)) index.set(bare, guide.channel);
  }
  return index;
}

/** Indexes overrides by `site::site_id`, with `*` as a wildcard site. */
export function buildOverrideIndex(overrides: readonly EpgOverride[]): Map<string, EpgOverride> {
  return new Map(overrides.map((entry) => [`${entry.site}::${entry.site_id}`, entry]));
}

/** Resolves every EPG channel in a bundle to a Nexus channel id. */
export function linkEpgChannels(
  bundle: EpgBundle,
  index: ChannelIndex,
  upstreamGuides: Map<string, string>,
  settings: Settings,
  countries: string[] = [],
  overrides: ReadonlyMap<string, EpgOverride> = new Map(),
): { links: Map<string, EpgLink>; unmatched: EpgChannel[]; skipped: number } {
  const links = new Map<string, EpgLink>();
  const unmatched: EpgChannel[] = [];
  let skipped = 0;

  for (const epgChannel of bundle.channels) {
    // 0. A human said so. Overrides win over everything, so they can also
    //    correct a wrong fuzzy match, not only fill in a missing one.
    const override =
      overrides.get(`${bundle.site}::${epgChannel.id}`) ?? overrides.get(`*::${epgChannel.id}`);
    if (override?.skip) {
      skipped++;
      continue;
    }
    if (override?.channel) {
      if (index.byId.has(override.channel)) {
        links.set(epgChannel.id, {
          channel: override.channel,
          site_id: epgChannel.id,
          site: bundle.site,
          confidence: 1,
          method: 'manual',
        });
        continue;
      }
      log.warn(
        `epg-overrides.yml maps ${bundle.site}/${epgChannel.id} to unknown channel "${override.channel}"`,
      );
    }

    // 1. Exact upstream guide mapping.
    const viaGuide =
      upstreamGuides.get(`${bundle.site}::${epgChannel.id}`) ??
      upstreamGuides.get(`*::${epgChannel.id}`);
    if (viaGuide && index.byId.has(viaGuide)) {
      links.set(epgChannel.id, {
        channel: viaGuide,
        site_id: epgChannel.id,
        site: bundle.site,
        confidence: 1,
        method: 'upstream',
      });
      continue;
    }

    // 2. The EPG id often *is* the channel id (`BBCNews.uk`), sometimes with
    //    the iptv-org feed suffix (`TV85.tr@SD`, `AlJazeera.qa@English`).
    const bareId = epgChannel.id.split('@')[0] ?? epgChannel.id;
    const direct =
      index.byId.get(epgChannel.id) ??
      index.byLowerId.get(epgChannel.id.toLowerCase()) ??
      (bareId !== epgChannel.id
        ? (index.byId.get(bareId) ?? index.byLowerId.get(bareId.toLowerCase()))
        : undefined);
    if (direct) {
      links.set(epgChannel.id, {
        channel: direct.id,
        site_id: epgChannel.id,
        site: bundle.site,
        confidence: 0.99,
        method: 'exact',
      });
      continue;
    }

    // 3. Fuzzy match on display names, narrowed by the source's countries.
    const match = resolveEpgChannel(
      epgChannel.display_names,
      index,
      { countryHints: countries },
      settings.epg.match_threshold,
    );
    if (match) {
      links.set(epgChannel.id, {
        channel: match.channel.id,
        site_id: epgChannel.id,
        site: bundle.site,
        confidence: Math.round(match.score * 100) / 100,
        method: match.method === 'tvg-id' ? 'exact' : match.method,
      });
    } else {
      unmatched.push(epgChannel);
    }
  }

  return { links, unmatched, skipped };
}

/** Deduplicates programmes that describe the same slot on the same channel. */
function dedupeProgrammes(programmes: EpgProgramme[]): EpgProgramme[] {
  const seen = new Map<string, EpgProgramme>();
  for (const programme of programmes) {
    const key = `${programme.channel}|${programme.start}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, programme);
      continue;
    }
    // Prefer the richer record.
    const existingWeight =
      (existing.description?.length ?? 0) + existing.categories.length * 10 + (existing.icon ? 20 : 0);
    const candidateWeight =
      (programme.description?.length ?? 0) + programme.categories.length * 10 + (programme.icon ? 20 : 0);
    if (candidateWeight > existingWeight) seen.set(key, programme);
  }
  return [...seen.values()].sort((a, b) =>
    a.channel === b.channel ? a.start.localeCompare(b.start) : a.channel.localeCompare(b.channel),
  );
}

/** Builds the merged EPG and writes XMLTV output under `public/epg`. */
export async function buildEpg(): Promise<EpgBuildResult> {
  const config = await loadConfig();
  const { settings } = config;

  if (!settings.epg.enabled) {
    log.warn('EPG is disabled in settings');
    return {
      generated_at: new Date().toISOString(),
      sources: 0,
      epg_channels: 0,
      linked_channels: 0,
      programmes: 0,
      shards: {},
      unmatched: [],
    };
  }

  const dataset = await loadDataset();
  if (!dataset) throw new Error('No dataset found. Run `aggregate` before `epg`.');

  const channels = dataset.channels as unknown as Channel[];
  const index = buildChannelIndex(
    channels,
    dataset.channels.flatMap((channel) => channel.feeds),
  );
  const upstreamGuides = buildUpstreamGuideIndex(dataset.guides);

  const bundles = await grabAll(config.epgSources, settings);
  const sourceById = new Map(config.epgSources.map((source) => [source.id, source]));
  const overrides = buildOverrideIndex(config.epgOverrides);

  const allLinks = new Map<string, EpgLink>(); // `site::site_id` → link
  const unmatched: EpgBuildResult['unmatched'] = [];
  const outChannels = new Map<string, EpgChannel>();
  const programmes: EpgProgramme[] = [];

  const channelById = new Map(dataset.channels.map((channel) => [channel.id, channel]));

  for (const bundle of bundles) {
    const source = sourceById.get(bundle.site);
    const { links, unmatched: missed } = linkEpgChannels(
      bundle,
      index,
      upstreamGuides,
      settings,
      source?.countries ?? [],
      overrides,
    );

    for (const [siteId, link] of links) {
      const existing = allLinks.get(`${bundle.site}::${siteId}`);
      if (!existing || link.confidence > existing.confidence) {
        allLinks.set(`${bundle.site}::${siteId}`, link);
      }

      const nexusChannel = channelById.get(link.channel);
      if (nexusChannel && !outChannels.has(link.channel)) {
        outChannels.set(link.channel, {
          id: link.channel,
          display_names: [nexusChannel.name, ...nexusChannel.alt_names].slice(0, 4),
          icon: nexusChannel.logo,
          site: bundle.site,
          lang: nexusChannel.languages[0] ?? source?.lang ?? null,
        });
      }
    }

    for (const epgChannel of missed) {
      unmatched.push({
        site: bundle.site,
        id: epgChannel.id,
        name: epgChannel.display_names[0] ?? epgChannel.id,
      });
    }

    // Rewrite programme channel ids to Nexus ids.
    const trust = source?.trust ?? 0.5;
    for (const programme of bundle.programmes) {
      const link = links.get(programme.channel);
      if (!link) continue;
      programmes.push({ ...programme, channel: link.channel, lang: programme.lang ?? source?.lang ?? null });
    }
    log.debug(`"${bundle.site}" linked ${links.size} channels (trust ${trust})`);
  }

  const merged = dedupeProgrammes(programmes);

  // ---- write output ------------------------------------------------------
  await ensureDir(PATHS.epg);
  const channelList = [...outChannels.values()];

  const fullXml = writeXmltv(channelList, merged, {
    generatorName: settings.project.name,
    generatorUrl: settings.project.repository ?? 'https://github.com',
  });
  await writeText(path.join(PATHS.epg, 'guide.xml'), fullXml);
  if (settings.epg.gzip) {
    await writeGzip(path.join(PATHS.epg, 'guide.xml.gz'), fullXml);
  }

  // Per-country shards keep player downloads small.
  const shards: Record<string, number> = {};
  const byCountry = new Map<string, { channels: EpgChannel[]; programmes: EpgProgramme[] }>();

  for (const epgChannel of channelList) {
    const country = channelById.get(epgChannel.id)?.country?.toLowerCase() ?? 'int';
    const bucket = byCountry.get(country) ?? { channels: [], programmes: [] };
    bucket.channels.push(epgChannel);
    byCountry.set(country, bucket);
  }
  const countryOfChannel = new Map(
    channelList.map((epgChannel) => [
      epgChannel.id,
      channelById.get(epgChannel.id)?.country?.toLowerCase() ?? 'int',
    ]),
  );
  for (const programme of merged) {
    const country = countryOfChannel.get(programme.channel);
    if (!country) continue;
    byCountry.get(country)?.programmes.push(programme);
  }

  for (const [country, bucket] of byCountry) {
    if (bucket.programmes.length === 0) continue;
    const xml = writeXmltv(bucket.channels, bucket.programmes, {
      generatorName: settings.project.name,
    });
    const target = path.join(PATHS.epg, `${country}.xml`);
    await writeText(target, xml);
    if (settings.epg.gzip) await writeGzip(`${target}.gz`, xml);
    shards[country] = bucket.programmes.length;
  }

  // Persist links so the API build can expose them per channel.
  await ensureDir(PATHS.epgDb);
  await writeJson(path.join(PATHS.epgDb, 'links.json'), [...allLinks.values()]);
  await writeJson(path.join(PATHS.epgDb, 'unmatched.json'), unmatched, { pretty: true });

  const result: EpgBuildResult = {
    generated_at: new Date().toISOString(),
    sources: bundles.length,
    epg_channels: channelList.length,
    linked_channels: allLinks.size,
    programmes: merged.length,
    shards,
    unmatched: unmatched.slice(0, 500),
  };

  await writeJson(path.join(PATHS.epgDb, 'report.json'), result, { pretty: true });

  log.success(
    `EPG: ${merged.length} programmes across ${channelList.length} channels ` +
      `from ${bundles.length} source(s); ${unmatched.length} unmatched`,
  );

  return result;
}

/** Loads the channel→guide links produced by the last EPG run. */
export async function loadEpgLinks(): Promise<EpgLink[]> {
  const { readJsonOr } = await import('../core/fs.js');
  return readJsonOr<EpgLink[]>(path.join(PATHS.epgDb, 'links.json'), []);
}

export { matchKey };
export * from './grab.js';
