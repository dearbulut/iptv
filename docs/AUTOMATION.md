# Automation

Once set up, the repository maintains itself. Nothing below needs a human on a
normal day.

## Daily schedule (UTC)

| Time | Workflow | What happens |
| --- | --- | --- |
| Sun 04:20 | **Database Dump** | Builds `iptv-nexus.sqlite.gz` and `iptv-nexus-data.zip` and uploads them to the `database` release |
| 01:30 | **Database Sync** | Updates `data/iptv-org` — our copy of the iptv-org database — with the day's additions, corrections and removals; refuses mass removals and opens an alert issue instead |
| 01:00 | **EPG Grab** | Scrapes each site in `config/epg-grab.yml`, one job per site, publishes XMLTV to the `state` branch |
| 02:00 | **Discover Streams** | Scans configured playlists for streams we lack, probes each, commits the survivors to `config/discovered.m3u` |
| 03:00 | **Health Scan** | Probes every stream in 6 parallel shards, updates rolling scores, retires dead links |
| 00:15 / 06:15 / 12:15 / 18:15 | **Sync & Deploy** | Re-reads upstream + all sources, rebuilds the API, playlists, guide and site, deploys to Pages |
| 15:00 | **Health Scan** | Second pass |

Plus **CI** on every push and pull request, and **Dependabot** monthly.

## What updates without you

- **New channels and streams from iptv-org.** The Database Sync copies the
  day's changes into `data/iptv-org` and commits them, with a report of what was
  added and removed. If iptv-org breaks or disappears, the last good copy stays
  and everything keeps running on it.
- **Community submissions.** The *Add a stream* issue form is processed by the
  Community workflow within minutes: the stream is checked, probed, matched to
  a channel (or a new channel is created) and written to `data/nexus`.
- **Takedown requests.** The *Copyright / takedown request* form removes the
  listed channels and streams immediately and assigns the owner to review.
- **Broken-stream reports.** The *Report a broken stream* form re-tests the
  channel's streams; dead ones are hidden for 7 days (`data/nexus/reports.ndjson`)
  and come back to be tested again.
- **Issues and pull requests** (Repository Bot): source proposals get an
  automatic evaluation; issues without a form get pointed at the right one;
  pull requests that only add lines to `data/nexus/` are checked like the forms
  and merged; Dependabot updates are merged when CI passes (major single-package
  updates wait for review). Code, config and workflow changes are always left
  for you.
- **Regional availability.** The Worker counts, per viewer country, whether a
  channel's streams answered when tested from the viewer's nearest Cloudflare
  location; Sync folds it into the API (needs the D1 database, see
  `workers/xtream/README.md`).
- **New streams from discovery.** Anything matching a channel we already index,
  from a source already listed in `config/discovery.yml`, that answers a live
  probe.
- **Dead links.** Streams that fail repeatedly lose score and are dropped.
- **Quality metadata.** Resolution, codec, bitrate and latency are re-measured
  on every scan, so a channel that silently drops from 1080p to 480p shows it.
- **The guide.** Rebuilt nightly and re-matched to channel ids.
- **`PLAYLISTS.md` and the README table.** Regenerated and committed on sync.

## What still needs you

Two things: **adding a new source**, and **reviewing takedown requests** after
the fact (they are applied automatically; the review is whether to keep them).
A refused database sync also opens an issue for you.

`config/sources.yml`, `config/discovery.yml` and `config/epg-grab.yml` are the
trust boundary. Everything downstream of them is automatic; deciding that a
particular list is appropriate to index is not, and should not be. That single
human decision is what separates a curated index from an unattended scraper —
see [`LEGAL.md`](LEGAL.md).

## Running the bot under its own identity

By default automated commits appear as `github-actions[bot]`. That works, with
one real limitation: commits made with the default `GITHUB_TOKEN` **do not
trigger other workflows**, so a discovery commit will not kick off a sync — it
waits for the next scheduled one.

Giving the automation its own GitHub App fixes that and puts a recognisable
name on its commits, the way `iptv-bot` does for iptv-org.

You have to create the App yourself — it involves generating a private key,
which should never pass through anyone else's hands:

1. **github.com → Settings → Developer settings → GitHub Apps → New GitHub App**
2. Name it (e.g. `iptv-nexus-bot`), set Homepage URL to your repository, and
   **uncheck Webhook → Active**.
3. Under **Repository permissions** grant:
   - Contents: **Read and write**
   - Pull requests: **Read and write**
   - Metadata: Read-only (automatic)
4. Create the App, then **Generate a private key** and download the `.pem`.
5. **Install App** → select only this repository.
6. In the repository: **Settings → Secrets and variables → Actions**
   - Variable `BOT_APP_ID` = the App ID shown on the App's page
   - Secret `BOT_PRIVATE_KEY` = the entire contents of the `.pem` file

The workflows already look for these and fall back to `GITHUB_TOKEN` when they
are absent, so nothing breaks if you skip this.

## Manual controls

Every workflow has a **Run workflow** button with useful inputs:

| Workflow | Inputs |
| --- | --- |
| EPG Grab | `sites` (comma-separated subset), `days` |
| Database Sync | `force` (apply a mass removal the guard refused) |
| Discover Streams | `max_probes`, `apply` (off = open a PR instead of committing) |
| Health Scan | `limit` (streams per shard, 0 = all) |
| Sync & Deploy | `skip_epg` |

## Cost

All of it runs on GitHub's free tier for public repositories: Actions minutes
are unlimited for public repos, and Pages serves the output. The heaviest job
is the health scan at roughly 6 × 5 minutes per run.
