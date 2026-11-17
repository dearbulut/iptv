/**
 * Stable channel numbers (`tvg-chno`).
 *
 * Jellyfin, Plex, Kodi and TiviMate order and address channels by number, and
 * users remember them ("news is on 101"). A number therefore has to survive
 * every future run: deriving it from sort position would renumber half the
 * catalogue whenever one channel is added.
 *
 * So numbers live in a registry that only ever grows. A channel keeps its
 * number forever — even if it disappears for a while and comes back — and a
 * number is never reused. The first assignment numbers channels grouped by
 * country and then by name, so the initial line-up is browsable; later
 * additions are appended after the highest number in use.
 *
 * The registry is persisted on the `state` branch by the Sync workflow.
 */

export interface ChannelNumberRegistry {
  version: 1;
  /** Highest number ever assigned, so retired numbers are never handed out again. */
  last: number;
  numbers: Record<string, number>;
}

export function emptyRegistry(): ChannelNumberRegistry {
  return { version: 1, last: 0, numbers: {} };
}

/** Accepts anything previously persisted and repairs what it can. */
export function normaliseRegistry(raw: unknown): ChannelNumberRegistry {
  if (!raw || typeof raw !== 'object') return emptyRegistry();
  const input = raw as Partial<ChannelNumberRegistry>;
  const numbers: Record<string, number> = {};
  for (const [id, value] of Object.entries(input.numbers ?? {})) {
    if (Number.isInteger(value) && (value as number) > 0) numbers[id] = value as number;
  }
  const highest = Math.max(0, ...Object.values(numbers));
  return { version: 1, last: Math.max(highest, Number(input.last) || 0), numbers };
}

export interface NumberableChannel {
  id: string;
  name: string;
  country: string;
}

/**
 * Assigns numbers to every channel that lacks one. Mutates and returns the
 * registry, plus how many numbers were newly assigned.
 */
export function assignChannelNumbers(
  registry: ChannelNumberRegistry,
  channels: readonly NumberableChannel[],
): { registry: ChannelNumberRegistry; assigned: number } {
  const missing = channels
    .filter((channel) => registry.numbers[channel.id] === undefined)
    .sort(
      (a, b) =>
        (a.country ?? '').localeCompare(b.country ?? '') ||
        a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
        a.id.localeCompare(b.id),
    );

  for (const channel of missing) {
    registry.last += 1;
    registry.numbers[channel.id] = registry.last;
  }
  return { registry, assigned: missing.length };
}
