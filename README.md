# IPTV Nexus

I've spent the last 7 years building IPTV systems end to end — multi-platform player apps (iOS, Android TV, Tizen, webOS), streaming backends, and reseller/admin panels. 
If you need a custom build or want to take an existing setup further, let's talk. 
Telegram: https://t.me/bulutworksdev

Here are just a few examples of projects I have worked on previously;


We build powerful, scalable, and modern software for IPTV providers and businesses worldwide.

📺 Our flagship app, Point TV, is now live on 4 platforms:

🟢 Android & Android TV — Google Play
https://play.google.com/store/apps/details?id=com.pointtv.app

iOS (iPhone & iPad) — App Store
https://apps.apple.com/app/id6778933243

📺 LG Smart TV (webOS) — LG Content Store
https://tr.lgappstv.com/main/tvapp/detail?appId=1307447&catCode1=&moreYn=N&cateYn=N&orderType=0&headerName=&appRankCode=&sellrUsrNo=

🪟 Windows — Microsoft Store
https://apps.microsoft.com/detail/9nsxfq0w6n2s

What we do:
💻 Custom Software Development
📺 IPTV Apps — LG webOS, Samsung Tizen, Android, Android TV, iOS, Apple TV, Windows & macOS
🔗 Xtream API & M3U Integration
⚙️ IPTV Middleware & Management Panels
🌐 Web & Mobile Applications
☁️ Cloud Infrastructure & API Integrations

Whether you're launching a new IPTæV platform or scaling an existing one, BulutWorks delivers reliable, high-performance solutions tailored to your needs.

🌐 Website: https://bulutworks.com

https://bonu.tv

https://pointtv.tv


A self-updating index of free-to-air IPTV channels, with **live stream health
scoring**, **merged EPG data**, a **free static JSON API** and a **web player** —
all running on GitHub Actions and GitHub Pages at zero cost.

It builds on the excellent [iptv-org](https://github.com/iptv-org/iptv) database
and adds the layer that database deliberately leaves out: knowing which streams
actually work right now, how good they are, and serving all of it as a queryable
API instead of one enormous playlist.

```
Upstream + your sources  →  merge & dedupe  →  probe & score  →  static API
                                    ↓                ↓               ↓
                             EPG grab/match    retire dead     web player
```

---

## What it adds over a plain playlist repo

| | iptv-org/iptv | IPTV Nexus |
| --- | --- | --- |
| Channel database | ✅ | ✅ (same upstream) |
| M3U playlists | ✅ | ✅ + health-filtered variants |
| **Stream health scoring** | — | ✅ rolling 0–100 score, uptime history |
| **Resolution / codec / bitrate** | — | ✅ via ffprobe |
| **Automatic dead-link retirement** | — | ✅ |
| **Merged, channel-matched EPG** | separate repo | ✅ built in, fuzzy-matched |
| **JSON API with filters** | flat files only | ✅ shards, per-channel docs, search index |
| **OpenAPI schema** | — | ✅ |
| **Web UI + player** | — | ✅ with uptime graphs, "plays in browser" filter |
| **Permanent channel numbers** (`tvg-chno`) | — | ✅ never change, never reused |
| **Geo-blocked streams shown as "Regional"** | — | ✅ instead of "offline" |
| **Stremio addon** | — | ✅ static, no server |
| **Xtream Codes login** (TiviMate, Smarters…) | — | ✅ via a free Cloudflare Worker, with now/next guide |
| **Custom playlists** (country + category + language) | one dimension per file | ✅ any combination, one URL |
| **Automatic failover** to a working stream | — | ✅ smart links, checked near the viewer |
| **Fix any playlist's EPG ids** (for providers and panels) | — | ✅ in the browser, nothing uploaded |
| **AI assistants** (MCP) | — | ✅ search channels, read the guide |
| **Change feed** (new / lost channels) | — | ✅ JSON and Atom |
| **Automatic source discovery** | manual PRs | ✅ scan → validate → commit |
| **Own database** | — | ✅ `data/` holds every channel and stream; survives upstream outages |
| **Add a stream** | pull request, human review | ✅ issue form, checked and added by a bot in minutes |
| **Takedowns** | manual | ✅ form, applied automatically, owner reviews |

### Stream health scoring

Every stream is probed on a schedule. Each probe records HTTP status, time to
first byte, and — via `ffprobe` — resolution, frame rate, bitrate and codecs.
Results feed an exponentially weighted score in 0–100, so a stream is judged on
its *history*, not on one unlucky request.

Two details make this trustworthy rather than noisy:

- **A single failure does not condemn a stream.** With the default `score_alpha`
  of `0.3` it takes several consecutive failures to fall below the healthy
  threshold, and a stream that recovers climbs back.
- **Geo-blocking is not counted as failure.** GitHub's runners are in a handful
  of regions, so a perfectly good regional channel often answers `403`. Those
  results are recorded but excluded from scoring, and can never retire a stream.
  This is the difference between a health checker and a tool that quietly
  deletes half the world's television.

A channel is only given a score once at least one of its streams has produced a
conclusive observation; until then the API reports `0` and the UI says
"unchecked" rather than inventing a number.

### Merged EPG

The guide is grabbed, not borrowed. A nightly workflow runs the
[iptv-org/epg](https://github.com/iptv-org/epg) scraper against the sites listed
in `config/epg-grab.yml` — one parallel job per site, so a single broken scraper
cannot take the guide down — and publishes the XMLTV to this repository's own
`state` branch. Pointing at a third party's EPG dump would be less code and a
worse idea; those dumps are exactly what `docs/LEGAL.md` warns about, and they
go offline without notice.

The sync then downloads those guides, normalises everything to UTC, and matches
each guide channel to a channel id — first via upstream's authoritative
mappings, then by exact id, then by fuzzy name matching narrowed to the guide's
countries. Anything below the confidence threshold is reported as unmatched
rather than guessed at.

The output is a single XMLTV file keyed by *Nexus channel id*, plus per-country
shards, so one guide URL works with every generated playlist.

---

## Quick start

### Get a playlist (nothing to install)

<!-- PLAYLISTS:START -->

| Playlist | Contents | URL |
| --- | --- | --- |
| **Best** | One stream per channel, best first | `https://dearbulut.github.io/iptv/playlists/best.m3u` |
| **Working only** | Only streams that passed the last health check | `https://dearbulut.github.io/iptv/playlists/online.m3u` |
| **Everything** | Every stream, including backups | `https://dearbulut.github.io/iptv/playlists/index.m3u` |
| **EPG** | Programme guide for every linked channel | `https://dearbulut.github.io/iptv/epg/guide.xml.gz` |

Per-country, per-category and per-language playlists: [**PLAYLISTS.md**](PLAYLISTS.md).

<!-- PLAYLISTS:END -->

### Use it in your player

Jellyfin, Plex, Kodi, TiviMate, IPTV Smarters, Channels DVR, VLC and Stremio
are covered step by step in [**docs/CLIENTS.md**](docs/CLIENTS.md). The short
version:

| Player | Add |
| --- | --- |
| Any M3U player | `https://dearbulut.github.io/iptv/playlists/country/tr.m3u` (or `best.m3u`) — the guide is picked up from the playlist |
| Your own mix | `https://iptv-nexus-xtream.bulutworks.workers.dev/m3u?country=tr,de&category=news&online=1` — or build it on the [Tools page](https://dearbulut.github.io/iptv/tools.html) |
| Stremio | `https://dearbulut.github.io/iptv/stremio/manifest.json` |
| Xtream-only apps | server `https://iptv-nexus-xtream.bulutworks.workers.dev`, any username and password |
| AI assistants (MCP) | `https://iptv-nexus-xtream.bulutworks.workers.dev/mcp` |
| Follow changes | `https://dearbulut.github.io/iptv/api/v1/changes.xml` (Atom) |

**Run a panel or have a provider playlist with a broken guide?** Open
[Tools → Fix my playlist](https://dearbulut.github.io/iptv/tools.html#fix), load
the M3U, and download it back with `tvg-id`, logos and channel numbers filled
in. Matching runs in your browser; the playlist is never uploaded.

### Use the API (nothing to install)

Once deployed, everything is a plain file on a CDN. No key, no rate limit:

```bash
BASE=https://dearbulut.github.io/iptv

curl "$BASE/api/v1/index.json"                  # manifest & counts
curl "$BASE/api/v1/channels.json"               # every channel
curl "$BASE/api/v1/by-country/tr.json"          # channels in Türkiye
curl "$BASE/api/v1/by-category/news.json"       # news channels
curl "$BASE/api/v1/channels/BBCNews.uk.json"    # one channel in detail
curl "$BASE/api/v1/health.json"                 # aggregate health report
curl "$BASE/playlists/best.m3u"                 # best stream per channel
curl "$BASE/epg/guide.xml.gz"                   # merged EPG
```

Every JSON document over 32 KB also has a `.gz` sibling.

```js
// "Working HD news channels in Germany, best stream first"
const channels = await (await fetch(`${BASE}/api/v1/by-country/de.json`)).json();

const picks = channels
  .filter((c) => c.online && c.categories.includes('news'))
  .filter((c) => parseInt(c.best_quality) >= 720)
  .sort((a, b) => b.score - a.score);

console.log(picks[0].name, picks[0].streams[0].url);
```

### Run your own copy

1. **Fork this repository.**
2. Enable GitHub Pages: *Settings → Pages → Source: **GitHub Actions***.
3. Run the **Sync & Deploy** workflow from the Actions tab.
4. Your API is live at `https://dearbulut.github.io/iptv/`.

From then on it maintains itself: sync every 6 hours, health scans twice daily,
source discovery weekly.

### Run locally

```bash
git clone https://github.com/dearbulut/iptv.git && cd iptv
npm install

npm run cli -- aggregate               # fetch and merge the dataset
npm run cli -- health --limit 200      # probe a sample of streams
npm run cli -- epg                     # build the guide (needs EPG sources)
npm run cli -- api --clean             # render public/
npm run serve                          # → http://localhost:8080
```

`ffprobe` (from FFmpeg) is optional but recommended — without it, health checks
still run but report no media metadata.

---

## CLI

| Command | What it does |
| --- | --- |
| `aggregate` | Fetch upstream + configured sources, merge, dedupe, resolve channels |
| `health` | Probe streams, update scores, mark dead links |
| `epg` | Grab guides, normalise, match to channels, write XMLTV |
| `discover` | Scan for new streams, validate, write a review proposal |
| `api` | Render the static JSON API, playlists and site into `public/` |
| `pipeline` | All of the above in order |
| `config` | Print the resolved configuration |
| `clean` | Remove generated output |

Useful flags:

```bash
npm run cli -- health --shard-count 6 --shard-index 2   # parallel CI shards
npm run cli -- health --min-age 300 --prune             # skip fresh, drop dead
npm run cli -- discover --skip-validation               # fast dry run
npm run cli -- aggregate --upstream-only                # ignore extra sources
npm run cli -- --log-level debug api
```

---

## Configuration

Everything lives in `config/`, and every value has a sensible default — you only
write down what you want to change.

| File | Purpose |
| --- | --- |
| `settings.yml` | Global behaviour: scoring, thresholds, output shape |
| `sources.yml` | Extra stream sources beyond upstream |
| `epg-grab.yml` | Which sites the nightly EPG scraper visits |
| `epg-sources.yml` | Which grabbed guides the sync consumes, and their countries |
| `epg-overrides.yml` | Hand fixes for EPG matching (link or skip a guide channel) |
| `discovery.yml` | Where automatic discovery looks for new streams |

Adding a source:

```yaml
sources:
  - id: my-list
    name: My curated channels
    type: m3u
    url: https://example.com/channels.m3u
    enabled: true
    trust: 0.8          # 0-1, biases ranking when lists disagree
    country: TR         # helps match channels that have no tvg-id
    exclude: "(?i)adult"
```

The settings worth knowing about:

| Setting | Default | Why you might change it |
| --- | --- | --- |
| `health.score_alpha` | `0.3` | Higher reacts to outages faster, but is noisier |
| `health.retire_after_failures` | `10` | Lower prunes dead links sooner |
| `health.timeout_seconds` | `12` | Raise for slow origins, lower for faster scans |
| `aggregate.exclude_nsfw` | `true` | Set `false` to include adult channels |
| `api.channel_details` | `playable` | `all` emits ~40k files (~300 MB) instead of ~11k |
| `playlists.min_score` | `0` | Raise to publish only proven streams |

---

## API reference

Full machine-readable schema: **`/api/v1/openapi.json`**. Human summary:
[`docs/API.md`](docs/API.md).

| Endpoint | Contents |
| --- | --- |
| `/api/v1/index.json` | Manifest: counts, endpoint map, generation time |
| `/api/v1/channels.json` | All channels with streams, health, guide links |
| `/api/v1/channels.online.json` | Only channels with a working stream |
| `/api/v1/channels/{id}.json` | One channel |
| `/api/v1/streams.json` | Flattened stream list |
| `/api/v1/by-country/{code}.json` | Country shard (`tr`, `de`, `us`, …) |
| `/api/v1/by-category/{id}.json` | Category shard (`news`, `sports`, …) |
| `/api/v1/by-language/{code}.json` | Language shard (`eng`, `tur`, …) |
| `/api/v1/countries.json` | Countries with channel counts |
| `/api/v1/categories.json` | Categories with channel counts |
| `/api/v1/languages.json` | Languages with channel counts |
| `/api/v1/health.json` | Aggregate health report |
| `/api/v1/search.json` | Compact positional index for client-side search |
| `/playlists/index.m3u` | Every stream |
| `/playlists/best.m3u` | Best stream per channel |
| `/playlists/online.m3u` | Healthy streams only |
| `/playlists/{country,category,language}/{key}.m3u` | Filtered playlists |
| `/epg/guide.xml[.gz]` | Merged guide |
| `/epg/{country}.xml[.gz]` | Per-country guide |
| `/api/v1/epg-unmatched.json` | Guide channels not yet matched — fix in `config/epg-overrides.yml` |
| `/stremio/manifest.json` | Stremio addon |
| `/xtream/index.json` | Data for the Worker |
| `/api/v1/match.json` | Index for matching any playlist to Nexus ids |
| `/api/v1/changes.json`, `/api/v1/changes.xml` | Channels that became or stopped being watchable (JSON, Atom) |
| `/epg/channels/{id}.json` | One channel's guide, next 48 hours |
| Worker `/m3u`, `/play/{number}`, `/mcp`, `player_api.php` | Playlist builder, smart links, MCP, Xtream — see [`workers/xtream`](workers/xtream/README.md) |

---

## Your own database, and how to contribute

Everything IPTV Nexus knows lives in this repository, under `data/`:

- `data/iptv-org/` — a full copy of the [iptv-org](https://github.com/iptv-org/database)
  database (channels, feeds, logos, streams, guides, blocklist…), one record per
  line. The **Database Sync** workflow applies iptv-org's changes every night,
  with a report in the commit, and refuses a mass removal rather than lose data.
- `data/nexus/` — our own data: streams and channels added by the community,
  corrections, and takedowns. The sync never touches it.

**Add a stream:** open an [Add a stream](https://github.com/dearbulut/iptv/issues/new?template=add-stream.yml)
issue. A bot checks it within minutes: if it is free to watch and plays, it is
added (new channels too) and goes live with the next sync. If not, the bot says
why; edit the issue and it checks again.

**Remove something you hold the rights to:** use the
[takedown form](https://github.com/dearbulut/iptv/issues/new?template=takedown.yml).
Removal is immediate; see [`docs/LEGAL.md`](docs/LEGAL.md).

## How the automation works

| Workflow | Schedule | Does |
| --- | --- | --- |
| `sync.yml` | every 6 h | Aggregate → EPG → API → deploy to Pages, refresh `PLAYLISTS.md` |
| `health.yml` | 2×/day | Probe streams in 6 parallel shards, merge, persist |
| `epg.yml` | nightly 01:00 | Grab each configured EPG site, publish XMLTV |
| `discover.yml` | nightly 02:00 | Find new streams, probe them, commit the survivors |
| `database.yml` | nightly 01:30 | Copy the day's iptv-org changes into `data/`; refuse mass removals |
| `community.yml` | on issue | Process *Add a stream* and *takedown* forms automatically |
| `ci.yml` | on push/PR | Typecheck, unit tests, pipeline smoke test |

Full detail, including how to run the automation under its own bot identity:
[`docs/AUTOMATION.md`](docs/AUTOMATION.md).

Health history and grabbed guides both live on an orphan `state` branch between
runs — health history is the memory that makes scoring mean anything, and
re-grabbing every guide on every sync would be gratuitous. Health Scan and EPG
Grab each own their own paths there and merge rather than force-push, so
neither can wipe the other's data. Sync only reads it.

Discovery commits directly, but only within a boundary that a human set: a
stream is auto-accepted only if it came from a source already listed in
`config/discovery.yml`, matched a channel already in the index, and answered a
live probe. It lands in `config/discovered.m3u` at low trust, so a curated list
always outranks it and health scoring retires it like anything else. Adding a
new *source* is still a human decision — that is the line between a curated
index and an unattended scraper.

---

## Architecture

```
src/
├── core/          types, config, HTTP+cache, M3U & XMLTV codecs, text matching
├── aggregate/     upstream client, extra sources, channel resolution, merge
├── health/        ffprobe + HTTP probing, rolling scores, retirement
├── epg/           guide grabbing, normalisation, channel matching
├── discovery/     candidate scanning, validation, proposal generation
├── api/           static JSON API, playlists, search index, OpenAPI
└── cli.ts
site/              the web player — no build step, no framework
```

The library is published as ESM, so you can build on it directly:

```ts
import { aggregate, runHealthScan, buildApi } from 'iptv-nexus';
```

---

## Contributing

```bash
npm run typecheck && npm test
```

Adding a source is a one-entry change to `config/sources.yml`. Please only add
sources you have the right to index — see [`docs/LEGAL.md`](docs/LEGAL.md).

## Legal

IPTV Nexus **hosts no video and rebroadcasts nothing**. It indexes stream URLs
that are already publicly listed elsewhere, in the same spirit as a search
engine. It provides no access to paid or encrypted services.

If you own a stream indexed here and want it removed, open an issue — removals
are honoured via the upstream blocklist and applied on the next sync.

## Credits

Built on [iptv-org/database](https://github.com/iptv-org/database) and
[iptv-org/api](https://github.com/iptv-org/api). Additional official free
streams are discovered from [Free-TV/IPTV](https://github.com/Free-TV/IPTV);
each one is probed before it is added, and the API lists `free-tv` among a
stream's `sources`. Playback in the browser uses
[hls.js](https://github.com/video-dev/hls.js).

## License

[The Unlicense](LICENSE): code and data are in the public domain, like the
iptv-org database they started from. Streams themselves belong to whoever
operates them; IPTV Nexus links to them and hosts nothing.
