/**
 * Regional availability: where a channel works, by viewer country.
 *
 * The Worker counts, per channel and viewer country, how often its streams
 * answered when tested from the Cloudflare location nearest a viewer, and
 * successful plays reported by the web player. The build fetches the summary
 * (`<worker>/regional.json`) and attaches it to each channel. Countries with
 * fewer than MIN_CHECKS data points are left out as noise.
 */

import { httpGetJson } from '../core/http.js';
import { Logger } from '../core/logger.js';

const log = new Logger('regional');

export const MIN_CHECKS = 3;

export interface RegionalSummary {
  generated_at: string;
  days: number;
  /** channel number → country → [ok, fail] */
  channels: Record<string, Record<string, [number, number]>>;
}

export interface CountryAvailability {
  ok: number;
  fail: number;
  /** Share of checks that worked, 0-1. */
  ratio: number;
}

export type Regional = Record<string, CountryAvailability>;

export async function fetchRegional(workerUrl: string | null): Promise<RegionalSummary | null> {
  if (!workerUrl) return null;
  try {
    const summary = await httpGetJson<RegionalSummary>(`${workerUrl}/regional.json`, { timeoutMs: 20_000, attempts: 2 });
    if (!summary || typeof summary.channels !== 'object') return null;
    log.info(`Regional data for ${Object.keys(summary.channels).length} channel(s) over ${summary.days} days`);
    return summary;
  } catch (error) {
    log.warn(`No regional data: ${(error as Error).message}`);
    return null;
  }
}

/** Per channel id, the countries with enough checks to say something. */
export function regionalByChannel(
  summary: RegionalSummary | null,
  numbers: Readonly<Record<string, number>>,
): Map<string, Regional> {
  const result = new Map<string, Regional>();
  if (!summary) return result;
  const idByNumber = new Map(Object.entries(numbers).map(([id, number]) => [String(number), id]));
  for (const [number, countries] of Object.entries(summary.channels)) {
    const id = idByNumber.get(number);
    if (!id) continue;
    const regional: Regional = {};
    for (const [country, [ok, fail]] of Object.entries(countries)) {
      if (ok + fail < MIN_CHECKS) continue;
      regional[country] = { ok, fail, ratio: Math.round((ok / (ok + fail)) * 100) / 100 };
    }
    if (Object.keys(regional).length > 0) result.set(id, regional);
  }
  return result;
}
