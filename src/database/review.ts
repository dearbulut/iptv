/**
 * What the repository bot decides about pull requests and source proposals.
 *
 * Pull requests that only add records to data/nexus are checked line by line
 * with the same rules as the issue forms — stream URLs probed live, channels
 * validated — and merged when everything passes. Anything else (removals,
 * blocklist or report edits, code, config, workflows) is summarised and left
 * for a human. The bot never runs code from a pull request: the files are
 * read as data.
 */

import { streamKey } from '../core/http.js';
import { parseM3u } from '../core/m3u.js';
import type { Channel, HealthCheck } from '../core/types.js';
import { buildChannelIndex, resolveChannel } from '../aggregate/match.js';
import { checkStreamUrl } from './community.js';

type Row = Record<string, unknown>;

export interface ChangedFile {
  path: string;
  /** Contents on the base branch; null when the file is new. */
  before: string | null;
  /** Contents in the pull request; null when the file is deleted. */
  after: string | null;
}

/** Lines added and removed, as multisets — order changes are not changes. */
export function lineChanges(before: string | null, after: string | null): { added: string[]; removed: string[] } {
  const count = (text: string | null) => {
    const map = new Map<string, number>();
    for (const line of (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
      map.set(line, (map.get(line) ?? 0) + 1);
    }
    return map;
  };
  const old = count(before);
  const next = count(after);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [line, n] of next) for (let i = (old.get(line) ?? 0); i < n; i++) added.push(line);
  for (const [line, n] of old) for (let i = (next.get(line) ?? 0); i < n; i++) removed.push(line);
  return { added, removed };
}

/** Files contributors may add records to through a pull request. */
export const OPEN_DATA_FILES = new Set([
  'data/nexus/channels.ndjson',
  'data/nexus/feeds.ndjson',
  'data/nexus/logos.ndjson',
  'data/nexus/streams.ndjson',
]);

export interface ReviewContext {
  channels: readonly Channel[];
  knownStreams: ReadonlySet<string>;
  countries: ReadonlySet<string>;
  probe: (url: string, referrer: string | null, userAgent: string | null) => Promise<HealthCheck>;
}

export interface ReviewResult {
  verdict: 'merge' | 'manual' | 'changes';
  message: string;
}

const CHANNEL_ID = /^[A-Za-z0-9]+\.[a-z]{2}$/;

export async function reviewPullRequest(files: readonly ChangedFile[], ctx: ReviewContext): Promise<ReviewResult> {
  const other = files.filter((file) => !OPEN_DATA_FILES.has(file.path));
  if (other.length > 0) {
    const kinds = new Set(
      other.map((file) =>
        file.path.startsWith('.github/workflows/') ? 'workflows'
        : file.path.startsWith('data/') ? 'protected data'
        : file.path.startsWith('src/') || file.path.startsWith('site/') || file.path.startsWith('workers/') ? 'code'
        : file.path.startsWith('config/') ? 'configuration'
        : file.path.endsWith('.md') ? 'documentation'
        : 'other files',
      ),
    );
    return {
      verdict: 'manual',
      message: [
        `Thanks! This pull request changes ${[...kinds].join(', ')}, which a maintainer reviews by hand.`,
        '',
        ...other.slice(0, 30).map((file) => `- \`${file.path}\``),
        ...(kinds.has('workflows') ? ['', '⚠️ It changes GitHub Actions workflows; these run with repository permissions and get extra scrutiny.'] : []),
        '',
        'Adding a stream or a channel? The [Add a stream](../issues/new?template=add-stream.yml) form is checked and merged automatically.',
      ].join('\n'),
    };
  }

  const problems: string[] = [];
  const accepted: string[] = [];
  const newChannels = new Set<string>();
  const index = buildChannelIndex(ctx.channels as Channel[], []);
  const hasChannel = (id: unknown) =>
    typeof id === 'string' && (index.byId.has(id) || newChannels.has(id));

  // Channels first, so streams in the same pull request can refer to them.
  const ordered = [...files].sort((a, b) => Number(!a.path.endsWith('channels.ndjson')) - Number(!b.path.endsWith('channels.ndjson')));
  for (const file of ordered) {
    const { added, removed } = lineChanges(file.before, file.after);
    if (removed.length > 0) {
      return {
        verdict: 'manual',
        message: `This pull request removes or edits ${removed.length} existing line(s) in \`${file.path}\`. Only additions are merged automatically; a maintainer will review it.`,
      };
    }
    for (const line of added) {
      let row: Row;
      try {
        row = JSON.parse(line) as Row;
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('not an object');
      } catch {
        problems.push(`\`${file.path}\`: a line is not valid JSON — \`${line.slice(0, 80)}\``);
        continue;
      }
      const table = file.path.split('/').pop()!.replace('.ndjson', '');
      if (table === 'channels') {
        const id = row['id'];
        if (typeof id !== 'string' || !CHANNEL_ID.test(id)) {
          problems.push(`channel id \`${String(id)}\` must look like \`ChannelName.cc\``);
        } else if (index.byId.has(id)) {
          accepted.push(`correction to \`${id}\` (${Object.keys(row).filter((k) => k !== 'id').join(', ') || 'no fields'})`);
        } else if (typeof row['name'] !== 'string' || !ctx.countries.has(String(row['country'] ?? '').toUpperCase())) {
          problems.push(`new channel \`${id}\` needs a \`name\` and a valid two-letter \`country\``);
        } else {
          newChannels.add(id);
          accepted.push(`new channel \`${id}\` (${row['name']})`);
        }
      } else if (table === 'streams') {
        const url = String(row['url'] ?? '');
        const rule = checkStreamUrl(url);
        if (rule) {
          problems.push(`\`${url}\`: ${rule}`);
        } else if (!hasChannel(row['channel'])) {
          problems.push(`\`${url}\`: channel \`${String(row['channel'])}\` does not exist`);
        } else if (ctx.knownStreams.has(streamKey(url))) {
          problems.push(`\`${url}\` is already listed`);
        } else {
          const check = await ctx.probe(url, (row['referrer'] as string) ?? null, (row['user_agent'] as string) ?? null);
          if (check.status === 'online') accepted.push(`stream for \`${row['channel']}\` — plays${check.media?.resolution ? ` (${check.media.resolution})` : ''}`);
          else problems.push(`\`${url}\` did not play when checked (${check.status}${check.http_status ? `, HTTP ${check.http_status}` : ''})`);
        }
      } else if (table === 'feeds' || table === 'logos') {
        if (!hasChannel(row['channel'])) problems.push(`${table}: channel \`${String(row['channel'])}\` does not exist`);
        else if (table === 'logos' && !/^https:\/\//.test(String(row['url'] ?? ''))) problems.push('logos need an https:// `url`');
        else accepted.push(`${table.slice(0, -1)} for \`${row['channel']}\``);
      }
    }
  }

  if (problems.length > 0) {
    return {
      verdict: 'changes',
      message: ['**Not merged yet** — some lines need fixing:', '', ...problems.map((p) => `- ${p}`), '', 'Push a fix and the checks run again.'].join('\n'),
    };
  }
  if (accepted.length === 0) {
    return { verdict: 'manual', message: 'No data lines were added, so there is nothing to merge automatically.' };
  }
  return {
    verdict: 'merge',
    message: ['**All checks passed — merging.** Thank you!', '', ...accepted.map((a) => `- ${a}`), '', 'It goes live with the next sync, within six hours.'].join('\n'),
  };
}

// ------------------------------------------------------ source proposals

export interface SourceEvaluation {
  entries: number;
  matched: number;
  newStreams: number;
  newForUnplayable: number;
  panelLike: number;
  sample: Array<{ url: string; status: string }>;
}

/** Measures what a proposed playlist would add. Inputs are injected for testing. */
export async function evaluateSource(
  playlist: string,
  ctx: ReviewContext & { playable: ReadonlySet<string>; sampleSize?: number },
): Promise<SourceEvaluation> {
  const entries = parseM3u(playlist).entries;
  const index = buildChannelIndex(ctx.channels as Channel[], []);
  const result: SourceEvaluation = { entries: entries.length, matched: 0, newStreams: 0, newForUnplayable: 0, panelLike: 0, sample: [] };
  const fresh: string[] = [];
  for (const entry of entries) {
    if (checkStreamUrl(entry.url)) {
      result.panelLike++;
      continue;
    }
    const match = resolveChannel(entry.title, index, { tvgId: entry.attributes['tvg-id'] ?? null, group: entry.attributes['group-title'] ?? null }, 0.88);
    if (match) result.matched++;
    if (!ctx.knownStreams.has(streamKey(entry.url))) {
      result.newStreams++;
      fresh.push(entry.url);
      if (match && !ctx.playable.has(match.channel.id)) result.newForUnplayable++;
    }
  }
  for (const url of fresh.slice(0, ctx.sampleSize ?? 12)) {
    const check = await ctx.probe(url, null, null);
    result.sample.push({ url, status: check.status });
  }
  return result;
}

export function evaluationMarkdown(url: string, evaluation: SourceEvaluation): string {
  const working = evaluation.sample.filter((s) => s.status === 'online').length;
  return [
    `**Automatic evaluation of** \`${url}\``,
    '',
    '| | |',
    '| --- | ---: |',
    `| Entries in the playlist | ${evaluation.entries.toLocaleString('en')} |`,
    `| Matched to a known channel | ${evaluation.matched.toLocaleString('en')} |`,
    `| Streams we do not have | ${evaluation.newStreams.toLocaleString('en')} |`,
    `| …giving a channel its first stream | ${evaluation.newForUnplayable.toLocaleString('en')} |`,
    `| Subscription-panel URLs (rejected) | ${evaluation.panelLike.toLocaleString('en')} |`,
    `| Sample of new streams that play | ${working} / ${evaluation.sample.length} |`,
    '',
    evaluation.panelLike > evaluation.entries / 10
      ? '⚠️ A large share of this playlist looks like subscription lines. It is very unlikely to be accepted.'
      : 'A maintainer decides whether to add a source — that is the one step kept for a person (see docs/LEGAL.md). This report is to help that decision.',
  ].join('\n');
}
