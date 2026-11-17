#!/usr/bin/env node
/** IPTV Nexus command line interface. */

import { Command, Option } from "commander";
import { logger, type LogLevel } from "./core/logger.js";
import { loadConfig, PATHS } from "./core/config.js";
import { formatBytes, remove } from "./core/fs.js";
import { aggregate } from "./aggregate/index.js";
import { runHealthScan, pruneRetired } from "./health/index.js";
import { buildEpg } from "./epg/index.js";
import { runDiscovery } from "./discovery/index.js";
import { buildApi } from "./api/build.js";
import { promises as fsp } from "node:fs";
import {
  appendNexus,
  appendNexusFile,
  loadDatabase,
  NEXUS_DIR,
  readTable,
} from "./database/index.js";
import { reportMarkdown, syncDatabase } from "./database/sync.js";
import { buildDump } from "./database/dump.js";
import {
  buildVodCatalog,
  loadVodBlocklist,
  loadVodCatalog,
  loadVodSources,
  VOD_PATH,
} from "./vod/index.js";
import {
  evaluateSource,
  evaluationMarkdown,
  reviewPullRequest,
  type ChangedFile,
} from "./database/review.js";
import { execFileSync } from "node:child_process";
import { httpGetText } from "./core/http.js";
import {
  processBrokenReport,
  processStreamSubmission,
  processTakedown,
} from "./database/community.js";
import { hasFfprobe, probeStream } from "./health/probe.js";
import { streamKey } from "./core/http.js";
import type { Channel } from "./core/types.js";

const program = new Command();

program
  .name("iptv-nexus")
  .description(
    "Self-updating IPTV channel, stream and EPG index with a free static API",
  )
  .version("1.0.0")
  .addOption(
    new Option("-l, --log-level <level>", "log verbosity")
      .choices(["debug", "info", "warn", "error", "silent"])
      .default("info"),
  )
  .hook("preAction", (command) => {
    const level = command.opts()["logLevel"] as LogLevel;
    logger.setLevel(level);
    process.env["LOG_LEVEL"] = level;
  });

// ---------------------------------------------------------------------------

program
  .command("aggregate")
  .description("Fetch upstream + configured sources and rebuild the dataset")
  .option("--upstream-only", "skip third-party sources", false)
  .action(async (options: { upstreamOnly: boolean }) => {
    const dataset = await logger.time("Aggregate", () =>
      aggregate({ upstreamOnly: options.upstreamOnly }),
    );
    logger.info(
      `Channels: ${dataset.channels.length}, streams: ${dataset.stats.merged_streams}`,
    );
  });

program
  .command("health")
  .description("Probe streams and update availability scores")
  .option("--shard-count <n>", "total number of parallel shards", Number)
  .option("--shard-index <n>", "this shard, 0-based", Number)
  .option("--limit <n>", "check at most N streams", Number)
  .option(
    "--min-age <minutes>",
    "skip streams checked within this window",
    Number,
  )
  .option("--concurrency <n>", "override configured concurrency", Number)
  .option("-f, --force", "ignore --min-age", false)
  .option(
    "--prune",
    "remove retired streams from the dataset afterwards",
    false,
  )
  .action(
    async (options: {
      shardCount?: number;
      shardIndex?: number;
      limit?: number;
      minAge?: number;
      concurrency?: number;
      force: boolean;
      prune: boolean;
    }) => {
      const result = await logger.time("Health scan", () =>
        runHealthScan({
          shardCount: options.shardCount,
          shardIndex: options.shardIndex,
          limit: options.limit,
          minAgeMinutes: options.minAge,
          concurrency: options.concurrency,
          force: options.force,
        }),
      );
      logger.info(
        `online=${result.summary.online} offline=${result.summary.offline} ` +
          `blocked=${result.summary.blocked} avg score=${result.summary.average_score}`,
      );
      if (options.prune) {
        const pruned = await pruneRetired();
        logger.info(`Pruned ${pruned.removed} stream(s)`);
      }
    },
  );

program
  .command("epg")
  .description("Grab, normalise and match EPG guides, then emit XMLTV")
  .action(async () => {
    const result = await logger.time("EPG build", buildEpg);
    logger.info(
      `${result.programmes} programmes, ${result.epg_channels} channels, ` +
        `${result.unmatched.length} unmatched`,
    );
  });

program
  .command("discover")
  .description("Scan configured sources for new streams and write a proposal")
  .option("--skip-validation", "do not probe candidates", false)
  .option("--max-probes <n>", "cap the number of live probes", Number)
  .option("--apply", "merge accepted streams into config/discovered.m3u", false)
  .action(
    async (options: {
      skipValidation: boolean;
      maxProbes?: number;
      apply: boolean;
    }) => {
      const report = await logger.time("Discovery", () =>
        runDiscovery({
          skipValidation: options.skipValidation,
          maxProbes: options.maxProbes,
          apply: options.apply,
        }),
      );
      logger.info(
        `accepted=${report.accepted.length} rejected=${report.rejected.length}`,
      );
    },
  );

program
  .command("api")
  .description(
    "Render the static JSON API, playlists and web site into public/",
  )
  .option("--clean", "wipe public/ first", false)
  .action(async (options: { clean: boolean }) => {
    const result = await logger.time("API build", () =>
      buildApi({ clean: options.clean }),
    );
    logger.info(`${result.files} files, ${formatBytes(result.bytes)}`);
  });

program
  .command("pipeline")
  .description("Run the full pipeline: aggregate → health → epg → api")
  .option("--skip-health", "do not probe streams", false)
  .option("--skip-epg", "do not rebuild the guide", false)
  .option("--health-limit <n>", "cap streams probed in this run", Number)
  .action(
    async (options: {
      skipHealth: boolean;
      skipEpg: boolean;
      healthLimit?: number;
    }) => {
      await logger.time("Pipeline", async () => {
        await aggregate();
        if (!options.skipHealth) {
          await runHealthScan({
            limit: options.healthLimit,
            minAgeMinutes: 60,
          });
          await pruneRetired();
        }
        if (!options.skipEpg) await buildEpg();
        await buildApi({ clean: true });
      });
    },
  );

program
  .command("config")
  .description("Print the resolved configuration")
  .action(async () => {
    const config = await loadConfig();
    console.log(JSON.stringify(config, null, 2));
  });

program
  .command("clean")
  .description("Remove generated output")
  .option("--cache", "also clear the HTTP cache", false)
  .option("--all", "also clear persisted health and dataset state", false)
  .action(async (options: { cache: boolean; all: boolean }) => {
    await remove(PATHS.public);
    logger.info("Removed public/");
    if (options.cache || options.all) {
      await remove(PATHS.cache);
      logger.info("Removed HTTP cache");
    }
    if (options.all) {
      await remove(PATHS.data);
      logger.warn("Removed .data/ — health history is gone");
    }
  });

program
  .command("db-sync")
  .description(
    "Update the iptv-org mirror in data/ (refuses mass removals unless --force)",
  )
  .option(
    "--force",
    "apply even if a table would lose more than its limit",
    false,
  )
  .option("--report <file>", "write the Markdown report here")
  .action(async (options: { force: boolean; report?: string }) => {
    const { settings } = await loadConfig();
    const report = await logger.time("Database sync", () =>
      syncDatabase(settings, { force: options.force }),
    );
    const markdown = reportMarkdown(report);
    if (options.report) await fsp.writeFile(options.report, markdown);
    else process.stdout.write(markdown);
    // 3 = refused by the mass-removal guard; the workflow opens an issue.
    if (!report.applied) process.exitCode = 3;
  });

/** Probe function and lookup sets shared by the bot commands. */
async function botContext() {
  const { settings } = await loadConfig();
  const { data } = await loadDatabase();
  const community = await readTable(NEXUS_DIR, "streams");
  const useFfprobe = await hasFfprobe();
  return {
    settings,
    data,
    channels: data.channels as Channel[],
    knownStreams: new Set(
      [
        ...data.streams.map((stream) => stream.url),
        ...community.map((stream) => String(stream["url"])),
      ].map(streamKey),
    ),
    countries: new Set(
      data.countries.map((country) => country.code.toUpperCase()),
    ),
    probe: (url: string, referrer: string | null, userAgent: string | null) =>
      probeStream(url, {
        timeoutMs: settings.health.timeout_seconds * 1000,
        referrer,
        userAgent,
        useFfprobe,
        probeDuration: settings.health.probe_duration,
      }),
  };
}

program
  .command("review-pr")
  .description(
    "Review a pull request between two git refs (files are read as data, never run)",
  )
  .requiredOption("--base <ref>", "base ref, e.g. origin/main")
  .requiredOption("--head <ref>", "pull request head ref")
  .requiredOption("--out <file>", "write {verdict, message} JSON here")
  .action(async (options: { base: string; head: string; out: string }) => {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
    const show = (ref: string, file: string) => {
      try {
        return git("show", `${ref}:${file}`);
      } catch {
        return null;
      }
    };
    // Shallow clones may lack the merge base; diffing against the base itself
    // is then a close enough approximation for a data-only check.
    let mergeBase = options.base;
    try {
      mergeBase = git("merge-base", options.base, options.head).trim();
    } catch {
      logger.warn("No merge base found; diffing against the base ref");
    }
    const paths = git("diff", "--name-only", mergeBase, options.head)
      .split("\n")
      .filter(Boolean);
    const files: ChangedFile[] = paths.map((file) => ({
      path: file,
      before: show(options.base, file),
      after: show(options.head, file),
    }));
    const ctx = await botContext();
    const result = await reviewPullRequest(files, ctx);
    await fsp.writeFile(options.out, JSON.stringify(result, null, 2));
    logger.info(`review: ${result.verdict} (${files.length} file(s))`);
  });

program
  .command("evaluate-source")
  .description(
    "Measure what a proposed playlist would add, for a source proposal issue",
  )
  .requiredOption("--url <url>", "playlist URL")
  .requiredOption("--out <file>", "write the Markdown report here")
  .action(async (options: { url: string; out: string }) => {
    const ctx = await botContext();
    let report: string;
    try {
      if (!/^https?:\/\//i.test(options.url))
        throw new Error("not an http(s) URL");
      const playlist = await httpGetText(options.url, {
        timeoutMs: 30_000,
        attempts: 1,
      });
      if (playlist.length > 20 * 1024 * 1024)
        throw new Error("larger than 20 MB");
      const playable = new Set<string>(
        ctx.data.streams
          .map((stream) => stream.channel)
          .filter(Boolean) as string[],
      );
      report = evaluationMarkdown(
        options.url,
        await evaluateSource(playlist, { ...ctx, playable }),
      );
    } catch (error) {
      report = `Could not evaluate \`${options.url}\`: ${(error as Error).message}. A maintainer will look at it.`;
    }
    await fsp.writeFile(options.out, `${report}\n`);
  });

program
  .command("vod")
  .description(
    "Rebuild the catalogue of openly licensed films and series (config/vod.yml)",
  )
  .option(
    "--force",
    "keep the result even if it lost more than half of the previous catalogue",
    false,
  )
  .action(async (options: { force: boolean }) => {
    const previous = await loadVodCatalog();
    const catalog = await logger.time("VOD catalogue", async () =>
      buildVodCatalog({
        sources: await loadVodSources(),
        previous,
        blocked: await loadVodBlocklist(),
      }),
    );
    const before =
      (previous?.movies.length ?? 0) + (previous?.series.length ?? 0);
    const after = catalog.movies.length + catalog.series.length;
    // An archive.org outage looks like an empty search; keep the last good catalogue.
    if (!options.force && before > 0 && after < before / 2) {
      logger.warn(
        `Refusing to replace ${before} titles with ${after}; keeping the previous catalogue`,
      );
      process.exitCode = 3;
      return;
    }
    await fsp.mkdir(PATHS.data, { recursive: true });
    await fsp.writeFile(VOD_PATH, JSON.stringify(catalog));
    logger.info(
      `Wrote ${VOD_PATH}: ${catalog.movies.length} films, ${catalog.series.length} series`,
    );
  });

program
  .command("dump")
  .description("Write the whole database as one SQLite file")
  .requiredOption("--out <file>", "SQLite file to create")
  .option(
    "--channels <file>",
    "built api/v1/channels.json, adds status and health tables",
  )
  .action(async (options: { out: string; channels?: string }) => {
    await logger.time("Database dump", () =>
      buildDump({ out: options.out, channelsJson: options.channels }),
    );
  });

program
  .command("community")
  .description(
    "Process a community issue: a stream submission or a takedown request",
  )
  .requiredOption("--kind <kind>", "stream | takedown | broken")
  .requiredOption(
    "--body-file <file>",
    "the issue body (Markdown from the issue form)",
  )
  .requiredOption("--author <login>", "GitHub login of the issue author")
  .requiredOption("--issue <number>", "issue number", Number)
  .option(
    "--issue-url <url>",
    "issue URL, recorded as the takedown reference",
    "",
  )
  .requiredOption("--out <file>", "write the result JSON here")
  .action(
    async (options: {
      kind: string;
      bodyFile: string;
      author: string;
      issue: number;
      issueUrl: string;
      out: string;
    }) => {
      const { settings } = await loadConfig();
      const body = await fsp.readFile(options.bodyFile, "utf8");
      const { data } = await loadDatabase();
      const channels = data.channels as Channel[];
      const now = new Date().toISOString();
      let result: {
        status: string;
        message: string;
        changed: boolean;
        commit: string;
      };

      const probeWith = async () => {
        const useFfprobe = await hasFfprobe();
        return (
          url: string,
          referrer: string | null,
          userAgent: string | null,
        ) =>
          probeStream(url, {
            timeoutMs: settings.health.timeout_seconds * 1000,
            referrer,
            userAgent,
            useFfprobe,
            probeDuration: settings.health.probe_duration,
          });
      };

      if (options.kind === "broken") {
        const community = await readTable(NEXUS_DIR, "streams");
        const streamsByChannel = new Map<
          string,
          Array<{
            url: string;
            referrer: string | null;
            user_agent: string | null;
          }>
        >();
        for (const stream of [
          ...data.streams,
          ...(community as unknown as typeof data.streams),
        ]) {
          if (!stream.channel) continue;
          const bucket = streamsByChannel.get(stream.channel) ?? [];
          bucket.push({
            url: stream.url,
            referrer: stream.referrer ?? null,
            user_agent: stream.user_agent ?? null,
          });
          streamsByChannel.set(stream.channel, bucket);
        }
        const outcome = await processBrokenReport(body, options.issue, {
          channels,
          streamsByChannel,
          probe: await probeWith(),
          now,
        });
        await appendNexusFile("reports", outcome.reports);
        result = {
          status: outcome.status,
          message: outcome.message,
          changed: outcome.reports.length > 0,
          commit: `data: hide ${outcome.reports.length} dead stream(s) reported in #${options.issue}`,
        };
      } else if (options.kind === "takedown") {
        const outcome = processTakedown(body, options.issueUrl, channels, now);
        if (outcome.entries.length > 0)
          await appendNexus("blocklist", outcome.entries as never);
        result = {
          status: outcome.status,
          message: outcome.message,
          changed: outcome.entries.length > 0,
          commit: `data: takedown request #${options.issue} (${outcome.entries.length} removal(s))`,
        };
      } else {
        const community = await readTable(NEXUS_DIR, "streams");
        const dayAgo = Date.now() - 24 * 3600_000;
        const useFfprobe = await hasFfprobe();
        const outcome = await processStreamSubmission(
          body,
          options.author,
          options.issue,
          {
            channels,
            knownStreams: new Set(
              [
                ...data.streams.map((stream) => stream.url),
                ...community.map((stream) => String(stream["url"])),
              ].map(streamKey),
            ),
            blocklist: data.blocklist,
            recentByAuthor: community.filter(
              (s) =>
                s["added_by"] === options.author &&
                Date.parse(String(s["added_at"] ?? 0)) > dayAgo,
            ).length,
            countries: new Set(data.countries.map((c) => c.code.toUpperCase())),
            categories: new Set(data.categories.map((c) => c.id)),
            probe: (url, referrer, userAgent) =>
              probeStream(url, {
                timeoutMs: settings.health.timeout_seconds * 1000,
                referrer,
                userAgent,
                useFfprobe,
                probeDuration: settings.health.probe_duration,
              }),
            now,
          },
        );
        if (outcome.status === "accepted") {
          if (outcome.channel) await appendNexus("channels", [outcome.channel]);
          if (outcome.feed) await appendNexus("feeds", [outcome.feed]);
          if (outcome.stream) await appendNexus("streams", [outcome.stream]);
        }
        result = {
          status: outcome.status,
          message: outcome.message,
          changed: outcome.status === "accepted",
          commit: `data: add ${String(outcome.stream?.["channel"] ?? "stream")} from #${options.issue}`,
        };
      }
      await fsp.writeFile(options.out, JSON.stringify(result, null, 2));
      logger.info(`${options.kind} #${options.issue}: ${result.status}`);
    },
  );

// ---------------------------------------------------------------------------

/**
 * `npm run cli -- health -- --limit 30` is a natural thing to type, but the
 * second `--` is commander's end-of-options separator: everything after it
 * becomes an operand and the flags are silently ignored. This CLI has no
 * positional arguments at all, so dropping bare `--` tokens is unambiguous and
 * makes both spellings work.
 */
const argv = process.argv.filter(
  (token, index) => !(index >= 2 && token === "--"),
);

program.parseAsync(argv).catch((error: unknown) => {
  logger.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
