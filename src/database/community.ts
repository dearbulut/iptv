/**
 * Community contributions and takedown requests, filed as GitHub issues and
 * processed by the Community workflow without a human in the loop:
 *
 *   Add a stream    the form is parsed, the URL checked against our rules,
 *                   probed live, matched to a channel (or a new channel is
 *                   created), and on success written to data/nexus/ and the
 *                   issue closed with a report. Failures get an explanation
 *                   and stay open; editing the issue re-runs the checks.
 *
 *   Takedown        a copyright or rights-holder request removes the listed
 *                   channels or streams immediately (data/nexus/blocklist),
 *                   then notifies the owner, who can restore an entry by
 *                   deleting its line. Removing first is the safe default for
 *                   a notice-and-takedown process; see docs/LEGAL.md.
 *
 * Everything here is pure or takes its I/O as parameters, so it is tested
 * without the network.
 */

import { streamKey } from "../core/http.js";
import type { BlocklistEntry, Channel, HealthCheck } from "../core/types.js";
import { buildChannelIndex, resolveChannel } from "../aggregate/match.js";

// ------------------------------------------------------------------- forms

/**
 * Parses the Markdown GitHub renders from an issue form: `### Label`
 * followed by the answer. "_No response_" becomes an empty string.
 */
export function parseIssueForm(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  const parts = body
    .replace(/\r\n/g, "\n")
    .split(/^###\s+/m)
    .slice(1);
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const label = (newline === -1 ? part : part.slice(0, newline))
      .trim()
      .toLowerCase();
    const value = (newline === -1 ? "" : part.slice(newline + 1)).trim();
    fields.set(label, value === "_No response_" ? "" : value);
  }
  return fields;
}

/** True when every checkbox in a checkbox field was ticked. */
export function allChecked(value: string | undefined): boolean {
  if (!value) return false;
  const boxes = value.match(/^- \[( |x|X)\]/gm) ?? [];
  return boxes.length > 0 && boxes.every((box) => /\[(x|X)\]/.test(box));
}

const field = (fields: Map<string, string>, ...labels: string[]): string => {
  for (const label of labels) {
    const value = fields.get(label.toLowerCase());
    if (value) return value.replace(/^```\w*\n?|\n?```$/g, "").trim();
  }
  return "";
};

// ------------------------------------------------------------------- rules

/**
 * Patterns of URLs we never accept from the public: reseller panel streams
 * carry a customer's credentials and are not free to air, whatever the
 * submitter says.
 */
const PANEL_PATTERNS = [
  /\/live\/[^/]+\/[^/]+\/\d+(\.\w+)?$/i,
  /\/(movie|series)\/[^/]+\/[^/]+\//i,
  /[?&](username|password)=/i,
  /\/get\.php\b/i,
  /\/player_api\.php\b/i,
];

export function checkStreamUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "This is not a valid URL.";
  }
  if (!/^https?:$/.test(parsed.protocol))
    return "Only http:// and https:// streams are accepted.";
  if (parsed.username || parsed.password)
    return "URLs with embedded credentials are not accepted.";
  if (url.length > 1000) return "This URL is too long.";
  if (PANEL_PATTERNS.some((pattern) => pattern.test(url))) {
    return "This looks like a subscription (reseller panel) stream with account credentials in it. Only streams that are free to watch are accepted.";
  }
  return null;
}

/** `Alabbassia TV` + `IQ` → `AlabbassiaTV.iq`, the iptv-org id convention. */
export function makeChannelId(name: string, country: string): string {
  const base = name
    // Letters NFKD cannot decompose to ASCII.
    .replace(/ı/g, "i")
    .replace(/ß/g, "ss")
    .replace(/[øØ]/g, "o")
    .replace(/[łŁ]/g, "l")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, "and")
    .replace(/\+/g, "Plus")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join("");
  return `${base || "Channel"}.${country.toLowerCase()}`;
}

const splitList = (value: string): string[] =>
  value
    .split(/[,;\n]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

// ------------------------------------------------------------- submissions

export interface SubmissionContext {
  channels: readonly Channel[];
  /** Keys (streamKey) of every stream already in the database. */
  knownStreams: ReadonlySet<string>;
  blocklist: readonly BlocklistEntry[];
  /** Community streams already added by this author in the last 24 hours. */
  recentByAuthor: number;
  countries: ReadonlySet<string>;
  categories: ReadonlySet<string>;
  probe: (
    url: string,
    referrer: string | null,
    userAgent: string | null,
  ) => Promise<HealthCheck>;
  now: string;
}

export interface SubmissionResult {
  status: "accepted" | "rejected" | "duplicate";
  /** Markdown for the issue comment. */
  message: string;
  stream?: Record<string, unknown>;
  channel?: Record<string, unknown>;
  /** A new channel's main feed, which is where iptv-org keeps languages. */
  feed?: Record<string, unknown>;
}

export const DAILY_LIMIT = 10;

export async function processStreamSubmission(
  body: string,
  author: string,
  issue: number,
  ctx: SubmissionContext,
): Promise<SubmissionResult> {
  const fields = parseIssueForm(body);
  const url = field(fields, "Stream URL");
  const channelInput = field(fields, "Channel");
  const referrer = field(fields, "Referrer") || null;
  const userAgent = field(fields, "User-Agent", "User agent") || null;
  const country = field(fields, "Country").toUpperCase().slice(0, 2);
  const reject = (...reasons: string[]): SubmissionResult => ({
    status: "rejected",
    message: [
      "**Not added yet.**",
      "",
      ...reasons.map((reason) => `- ${reason}`),
      "",
      "Edit the issue to fix this and the checks run again automatically.",
    ].join("\n"),
  });

  if (!allChecked(fields.get("confirmation"))) {
    return reject(
      "Please tick the confirmation that the stream is free to watch and publicly available.",
    );
  }
  if (ctx.recentByAuthor >= DAILY_LIMIT) {
    return reject(
      `You have added ${ctx.recentByAuthor} streams in the last 24 hours, the daily limit. Please try again tomorrow.`,
    );
  }
  if (!url) return reject("The stream URL is missing.");
  const urlProblem = checkStreamUrl(url);
  if (urlProblem) return reject(urlProblem);
  if (!channelInput)
    return reject(
      "Say which channel this is — its id (like `TRT1.tr`) or its name.",
    );

  const key = streamKey(url);
  if (ctx.knownStreams.has(key)) {
    return {
      status: "duplicate",
      message:
        "This stream is **already in IPTV Nexus** — thank you! Nothing to add.",
    };
  }
  const blockedUrl = ctx.blocklist.find(
    (entry) => entry.url && streamKey(entry.url) === key,
  );
  if (blockedUrl)
    return reject(
      "This stream was removed after a rights-holder request and cannot be added again.",
    );

  // --- the channel ---------------------------------------------------------
  const idFromLink = channelInput.match(/[?&]channel=([^&\s]+)/)?.[1];
  const wanted = decodeURIComponent(idFromLink ?? channelInput).trim();
  const index = buildChannelIndex(ctx.channels as Channel[], []);
  let channel: Channel | undefined =
    index.byId.get(wanted) ??
    index.byLowerId.get(wanted.toLowerCase().split("@")[0]!);
  if (!channel) {
    const match = resolveChannel(
      wanted,
      index,
      { country: country || null },
      0.92,
    );
    channel = match?.channel;
  }

  let newChannel: Record<string, unknown> | undefined;
  let newFeed: Record<string, unknown> | undefined;
  if (!channel) {
    if (!allChecked(fields.get("new channel"))) {
      return reject(
        `No channel matches "${wanted}". Use the channel's id from its page on the website (\`?channel=…\`), or, if it is not in IPTV Nexus yet, tick "This is a new channel" and fill in its country.`,
      );
    }
    if (!ctx.countries.has(country))
      return reject(
        "A new channel needs its two-letter country code (for example `TR`).",
      );
    const categories = splitList(field(fields, "Categories")).filter((c) =>
      ctx.categories.has(c),
    );
    const languages = splitList(field(fields, "Languages")).filter((l) =>
      /^[a-z]{3}$/.test(l),
    );
    const id = makeChannelId(wanted, country);
    if (index.byLowerId.get(id.toLowerCase())) {
      return reject(
        `A channel with the id \`${id}\` already exists. Use that id instead.`,
      );
    }
    const website = field(fields, "Website");
    const logo = field(fields, "Logo URL", "Logo");
    newChannel = {
      id,
      name: wanted,
      alt_names: [],
      network: null,
      owners: [],
      country,
      categories: categories.length > 0 ? categories : ["general"],
      is_nsfw: false,
      launched: null,
      closed: null,
      replaced_by: null,
      website: /^https?:\/\//.test(website) ? website : null,
      logo: /^https:\/\//.test(logo) ? logo : null,
      added_by: author,
      added_at: ctx.now,
      issue,
    };
    newFeed = {
      channel: id,
      id: "SD",
      name: "SD",
      alt_names: [],
      is_main: true,
      broadcast_area: [`c/${country}`],
      timezones: [],
      languages,
      format: null,
    };
  } else if (ctx.blocklist.some((entry) => entry.channel === channel!.id)) {
    return reject(
      `\`${channel.id}\` was removed after a rights-holder request and cannot take new streams.`,
    );
  }

  // --- the live check --------------------------------------------------------
  const check = await ctx.probe(url, referrer, userAgent);
  if (check.status !== "online") {
    const reason =
      check.status === "blocked"
        ? "The stream refused our checker (geo-blocked or protected). We can only add streams we can verify."
        : `The stream did not play when we checked it (${check.status}${check.http_status ? `, HTTP ${check.http_status}` : ""}${check.error ? `: ${check.error}` : ""}).`;
    return reject(reason);
  }

  const channelId = (newChannel?.["id"] as string | undefined) ?? channel!.id;
  const channelName =
    (newChannel?.["name"] as string | undefined) ?? channel!.name;
  const stream = {
    channel: channelId,
    feed: null,
    title: channelName,
    url,
    referrer,
    user_agent: userAgent,
    quality: check.media?.resolution ?? null,
    label: null,
    added_by: author,
    added_at: ctx.now,
    issue,
  };

  const details = [
    check.media?.resolution ? `${check.media.resolution}` : null,
    check.media?.video_codec ?? null,
    check.latency_ms !== null ? `${check.latency_ms} ms` : null,
  ].filter(Boolean);
  return {
    status: "accepted",
    stream,
    channel: newChannel,
    feed: newFeed,
    message: [
      `**Added — thank you!** The stream played when we checked it${details.length ? ` (${details.join(", ")})` : ""}.`,
      "",
      newChannel
        ? `A new channel, \`${channelId}\` (${channelName}), was created for it.`
        : `It was added to \`${channelId}\` (${channelName}).`,
      "",
      `It goes live with the next sync (within six hours): https://dearbulut.github.io/iptv/?channel=${encodeURIComponent(channelId)}`,
      "",
      "Health checks keep testing it from now on, and it is retired automatically if it stops working.",
    ].join("\n"),
  };
}

// --------------------------------------------------------------- takedowns

export interface TakedownResult {
  status: "removed" | "incomplete";
  message: string;
  entries: BlocklistEntry[];
}

/** Channel ids, website links and stream URLs, one per line or comma-separated. */
export function extractTargets(
  text: string,
  channels: readonly Channel[],
): { channels: string[]; urls: string[]; unknown: string[] } {
  const byLowerId = new Map(
    channels.map((channel) => [channel.id.toLowerCase(), channel.id]),
  );
  const result = {
    channels: [] as string[],
    urls: [] as string[],
    unknown: [] as string[],
  };
  for (const raw of text
    .split(/[\n,]+/)
    .map((item) => item.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean)) {
    // A film or series: its Films page link becomes the archive.org item.
    const film = raw.match(/films\.html#(?:movies|series)\/([^/?#\s]+)/i)?.[1];
    if (film) {
      const url = `https://archive.org/details/${film}`;
      if (!result.urls.includes(url)) result.urls.push(url);
      continue;
    }
    const fromLink = raw.match(/[?&]channel=([^&\s]+)/)?.[1];
    const candidate = decodeURIComponent(fromLink ?? raw);
    const id = byLowerId.get(candidate.toLowerCase().split("@")[0]!);
    if (id) {
      if (!result.channels.includes(id)) result.channels.push(id);
    } else if (/^https?:\/\//i.test(raw) && !fromLink) {
      if (!result.urls.includes(raw)) result.urls.push(raw);
    } else {
      result.unknown.push(raw);
    }
  }
  return result;
}

export function processTakedown(
  body: string,
  issueUrl: string,
  channels: readonly Channel[],
  now: string,
): TakedownResult {
  const fields = parseIssueForm(body);
  const missing: string[] = [];
  if (!field(fields, "Your name", "Full name")) missing.push("your name");
  if (!field(fields, "Contact email", "Email")) missing.push("a contact email");
  if (!field(fields, "Copyrighted work", "Work"))
    missing.push("the work or rights concerned");
  if (!field(fields, "Signature"))
    missing.push("your signature (your full name)");
  if (!allChecked(fields.get("statements")))
    missing.push("all three statements ticked");

  const targets = extractTargets(
    field(fields, "What to remove", "Channels or streams to remove"),
    channels,
  );
  if (targets.channels.length + targets.urls.length === 0) {
    missing.push(
      "at least one channel id, channel page link or stream URL to remove",
    );
  }

  if (missing.length > 0) {
    return {
      status: "incomplete",
      entries: [],
      message: [
        "**This request is not complete yet, so nothing was removed.**",
        "",
        `Still needed: ${missing.join("; ")}.`,
        ...(targets.unknown.length > 0
          ? [
              "",
              `Not recognised: ${targets.unknown.map((item) => `\`${item}\``).join(", ")}. Use channel ids (like \`TRT1.tr\`), links to channel pages, stream URLs, or links to a film on the Films page or archive.org.`,
            ]
          : []),
        "",
        "Edit the issue and it is processed again automatically.",
      ].join("\n"),
    };
  }

  const entries: BlocklistEntry[] = [
    ...targets.channels.map((channel) => ({
      channel,
      reason: "dmca",
      ref: issueUrl,
      added_at: now,
    })),
    ...targets.urls.map((url) => ({
      channel: "",
      url,
      reason: "dmca",
      ref: issueUrl,
      added_at: now,
    })),
  ];
  return {
    status: "removed",
    entries,
    message: [
      "**Removed.** Thank you for your notice.",
      "",
      ...targets.channels.map(
        (id) => `- channel \`${id}\` and all of its streams`,
      ),
      ...targets.urls.map((url) =>
        /archive\.org\/details\//.test(url)
          ? `- film or series \`${url}\``
          : `- stream \`${url}\``,
      ),
      ...(targets.unknown.length > 0
        ? [
            "",
            `Not recognised and not acted on: ${targets.unknown.map((item) => `\`${item}\``).join(", ")}.`,
          ]
        : []),
      "",
      "The removal takes effect with the next sync (within six hours) on the website, the playlists, the API, the Stremio addon and the Worker. Streams on IPTV Nexus are links to third-party servers; nothing is hosted here.",
      "",
      "The repository owner has been notified and will review this request. If you believe content was removed by mistake, see the counter-notice section of [docs/LEGAL.md](https://github.com/dearbulut/iptv/blob/main/docs/LEGAL.md).",
    ].join("\n"),
  };
}

// ------------------------------------------------------- broken streams

/** How long a stream reported and confirmed dead stays hidden. */
export const HIDE_DAYS = 7;

export interface ReportContext {
  channels: readonly Channel[];
  /** Every stream we list, by channel id. */
  streamsByChannel: ReadonlyMap<
    string,
    ReadonlyArray<{
      url: string;
      referrer: string | null;
      user_agent: string | null;
    }>
  >;
  probe: (
    url: string,
    referrer: string | null,
    userAgent: string | null,
  ) => Promise<HealthCheck>;
  now: string;
}

export interface ReportResult {
  status: "hidden" | "working" | "manual" | "rejected";
  message: string;
  /** Rows for data/nexus/reports.ndjson. */
  reports: Array<Record<string, unknown>>;
}

/**
 * A "this does not play" report: every stream of the channel (or the one
 * named) is probed again. Dead ones are hidden for HIDE_DAYS — not deleted —
 * so a stream that was down for an afternoon comes back and is re-tested.
 * Problems a probe cannot judge (wrong channel, wrong details) go to a human.
 */
export async function processBrokenReport(
  body: string,
  issue: number,
  ctx: ReportContext,
): Promise<ReportResult> {
  const fields = parseIssueForm(body);
  const problem = field(fields, "Problem");
  const input = field(fields, "Channel");
  const named = field(fields, "Stream URL");
  const country = field(fields, "Your country").toUpperCase().slice(0, 2);

  const idFromLink = input.match(/[?&]channel=([^&\s]+)/)?.[1];
  const wanted = decodeURIComponent(idFromLink ?? input).trim();
  const index = buildChannelIndex(ctx.channels as Channel[], []);
  const channel =
    index.byId.get(wanted) ??
    index.byLowerId.get(wanted.toLowerCase().split("@")[0]!) ??
    resolveChannel(wanted, index, { country: country || null }, 0.92)?.channel;
  if (!channel) {
    return {
      status: "rejected",
      reports: [],
      message: `**No channel matches "${wanted}".** Use the channel's id from its page on the website (\`?channel=…\`) and edit this issue.`,
    };
  }

  if (problem && !/does not play/i.test(problem)) {
    return {
      status: "manual",
      reports: [],
      message: `Thanks — "${problem}" needs a person to look at it, so this stays open for the maintainers. Channel: \`${channel.id}\` (${channel.name}).`,
    };
  }

  const listed = ctx.streamsByChannel.get(channel.id) ?? [];
  const streams = named
    ? listed.filter((stream) => streamKey(stream.url) === streamKey(named))
    : listed;
  if (named && streams.length === 0) {
    return {
      status: "rejected",
      reports: [],
      message: `That URL is not one of the streams we list for \`${channel.id}\`, so there is nothing to hide. Leave the URL empty to test all of the channel's streams.`,
    };
  }
  if (streams.length === 0) {
    return {
      status: "manual",
      reports: [],
      message: `\`${channel.id}\` has no streams listed at the moment, so there is nothing to test.`,
    };
  }

  const expires = new Date(
    Date.parse(ctx.now) + HIDE_DAYS * 86_400_000,
  ).toISOString();
  const results: Array<{
    stream: (typeof streams)[number];
    check: HealthCheck;
  }> = [];
  for (const stream of streams.slice(0, 10)) {
    results.push({
      stream,
      check: await ctx.probe(stream.url, stream.referrer, stream.user_agent),
    });
  }
  const dead = results.filter(({ check }) =>
    ["offline", "error", "timeout"].includes(check.status),
  );
  const blocked = results.filter(({ check }) => check.status === "blocked");
  const working = results.filter(({ check }) => check.status === "online");

  const line = ({ stream, check }: (typeof results)[number]) =>
    `- \`${stream.url}\` — **${check.status}**${check.http_status ? ` (HTTP ${check.http_status})` : ""}${check.media?.resolution ? `, ${check.media.resolution}` : ""}`;
  const reports = dead.map(({ stream, check }) => ({
    url: stream.url,
    channel: channel.id,
    status: check.status,
    reported_at: ctx.now,
    expires_at: expires,
    issue,
  }));

  const lines = [
    `Tested ${results.length} stream${results.length === 1 ? "" : "s"} of \`${channel.id}\` (${channel.name}):`,
    "",
    ...results.map(line),
    "",
  ];
  if (dead.length > 0) {
    lines.push(
      `**Hidden ${dead.length} dead stream${dead.length === 1 ? "" : "s"}** for ${HIDE_DAYS} days, from the next sync. After that they are tested again and come back if they work. Thank you!`,
    );
  }
  if (working.length > 0) {
    lines.push(
      `${working.length} stream${working.length === 1 ? " works" : "s work"} from our checker. If it still does not play for you, it may be blocked in your country${country ? ` (${country})` : ""}, need a different player (try VLC), or be blocked by your network.`,
    );
  }
  if (blocked.length > 0) {
    lines.push(
      `${blocked.length} refused our checker — usually a regional block, so they are kept.`,
    );
  }
  return {
    status: dead.length > 0 ? "hidden" : "working",
    reports,
    message: lines.join("\n"),
  };
}

/** Reports whose hiding period has not ended. */
export function activeReports<T extends { expires_at?: unknown }>(
  reports: readonly T[],
  now: string,
): T[] {
  return reports.filter((report) => String(report.expires_at ?? "") > now);
}
