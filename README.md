# IPTV Nexus

**Free TV from around the world — checked every day, with a programme guide, in any app.**

[![Sync & Deploy](https://github.com/dearbulut/iptv/actions/workflows/sync.yml/badge.svg)](https://github.com/dearbulut/iptv/actions/workflows/sync.yml)
[![CI](https://github.com/dearbulut/iptv/actions/workflows/ci.yml/badge.svg)](https://github.com/dearbulut/iptv/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/dearbulut/iptv)](https://github.com/dearbulut/iptv/releases/latest)
[![License: Unlicense](https://img.shields.io/badge/license-Unlicense-blue)](LICENSE)

Built by [BulutWorks](https://bulutworks.com) · Telegram: [@bulutworksdev](https://t.me/bulutworksdev)

IPTV Nexus is an open database of **31,000+ TV channels** in 230 countries, with
**10,000+ that have a free stream** and around **8,000 working at any moment**.
Every stream is tested twice a day, dead links are retired, and a merged
programme guide covers **270,000+ programmes**. Watch in the browser, add a
playlist to any player, log in from TiviMate or IPTV Smarters, install it in
Stremio — or use the data in your own app.

Everything runs on GitHub Actions, GitHub Pages and a free Cloudflare Worker.
No server, no cost, no account needed.

**[▶ Open the channel browser](https://dearbulut.github.io/iptv)** · **[🛠 Tools](https://dearbulut.github.io/iptv/tools.html)** ·
**[📖 Setup guides](docs/CLIENTS.md)** · **[⬇ Download the database](https://github.com/dearbulut/iptv/releases/tag/database)**

---

## Watch

| You use | Add this |
| --- | --- |
| **A web browser** | [dearbulut.github.io/iptv](https://dearbulut.github.io/iptv) — search, filter, play, check where a channel works |
| **VLC, Kodi, Jellyfin, Plex, Channels DVR…** | `https://dearbulut.github.io/iptv/playlists/country/tr.m3u` (any country) or `best.m3u` — the guide comes with it |
| **Your own mix** | `https://iptv-nexus-xtream.bulutworks.workers.dev/m3u?country=tr,de&category=news&online=1` — or build it on the [Tools page](https://dearbulut.github.io/iptv/tools.html#builder) |
| **TiviMate, IPTV Smarters, XCIPTV, TV boxes** | Xtream login — server `https://iptv-nexus-xtream.bulutworks.workers.dev`, any username and password (username `country` groups by country) |
| **Stremio** | `https://dearbulut.github.io/iptv/stremio/manifest.json` |
| **An AI assistant** (Claude, ChatGPT, Cursor…) | MCP server `https://iptv-nexus-xtream.bulutworks.workers.dev/mcp` — "which Turkish news channels work right now?" |

Step-by-step instructions for every player: **[docs/CLIENTS.md](docs/CLIENTS.md)**.

<!-- PLAYLISTS:START -->

| Playlist | Contents | URL |
| --- | --- | --- |
| **Best** | One stream per channel, best first | `https://dearbulut.github.io/iptv/playlists/best.m3u` |
| **Working only** | Only streams that passed the last health check | `https://dearbulut.github.io/iptv/playlists/online.m3u` |
| **Everything** | Every stream, including backups | `https://dearbulut.github.io/iptv/playlists/index.m3u` |
| **EPG** | Programme guide for every linked channel | `https://dearbulut.github.io/iptv/epg/guide.xml.gz` |

Per-country, per-category and per-language playlists: [**PLAYLISTS.md**](PLAYLISTS.md).

<!-- PLAYLISTS:END -->

---

## What makes it different

**For viewers**

- **Tested, not just listed.** Every stream is probed twice a day for status,
  resolution, codec and latency. Scores follow a stream's history, so one bad
  minute doesn't remove it; channels that stop working are retired.
- **Where it works.** Each channel shows the countries where it plays and where
  it doesn't, measured from viewers' nearest Cloudflare locations — and a
  "Check from my location" button.
- **Automatic failover.** Smart links send you to whichever of a channel's
  streams answers right now, so a channel survives a dead stream.
- **Permanent channel numbers.** Numbers never change and are never reused, so
  favourites and channel order survive every update.
- **A guide that lines up.** One programme guide, matched to the channel ids
  in every playlist; country playlists load only their own country's guide.
- **Honest status.** Channels that geo-block our checker are shown as
  *Regional*, not *offline*; streams a browser can't play say why and offer
  *Open in player*.

**For panel owners and providers**

- **[Fix my playlist](https://dearbulut.github.io/iptv/tools.html#fix).** Load any M3U and get it back with
  `tvg-id`, logos and channel numbers filled in, so the guide works. It runs in
  your browser — the playlist and its credentials are never uploaded. 99.9%
  correct on 10,000 channels written the way panels write them.
- **Guide corrections in one line:** [`config/epg-overrides.yml`](config/epg-overrides.yml),
  with every unmatched guide channel listed in [`epg-unmatched.json`](https://dearbulut.github.io/iptv/api/v1/epg-unmatched.json).

**For developers**

- A **free static JSON API** with an [OpenAPI schema](https://dearbulut.github.io/iptv/api/v1/openapi.json):
  channels, streams with health, shards by country/category/language, search
  index, per-channel guide, regional availability.
- A **change feed** ([JSON](https://dearbulut.github.io/iptv/api/v1/changes.json), [Atom](https://dearbulut.github.io/iptv/api/v1/changes.xml))
  of channels that became or stopped being watchable.
- The **whole database as one SQLite file**, rebuilt every Sunday:
  [database release](https://github.com/dearbulut/iptv/releases/tag/database).
- An **MCP server** for AI tools, and an **Xtream Codes API**, both in one
  [Cloudflare Worker](workers/xtream/README.md) you can deploy in two minutes.

---

## Contribute — no pull request needed

| You want to | Use | What happens |
| --- | --- | --- |
| Add a stream or a new channel | [Add a stream](https://github.com/dearbulut/iptv/issues/new?template=add-stream.yml) | A bot checks the URL, plays it, matches or creates the channel and adds it — in minutes |
| Report a channel that doesn't play | [Report a broken stream](https://github.com/dearbulut/iptv/issues/new?template=broken-stream.yml) | Its streams are re-tested; dead ones are hidden for 7 days and tested again |
| Remove content you hold the rights to | [Takedown request](https://github.com/dearbulut/iptv/issues/new?template=takedown.yml) | Removed immediately, then reviewed — see [docs/LEGAL.md](docs/LEGAL.md) |
| Propose a whole playlist | [Add a stream source](https://github.com/dearbulut/iptv/issues/new?template=add-source.yml) | Evaluated automatically; a maintainer decides |

Only streams that are **free to watch** are accepted: official broadcaster
streams, FAST channels, public service media. Subscription (reseller panel)
links are rejected automatically.

Pull requests that only **add** lines to `data/nexus/` are checked the same way
and merged automatically. Code changes are reviewed by a person — see
[CONTRIBUTING.md](CONTRIBUTING.md).

---

## How it works

```
                 ┌──────────────── data/ ─────────────────┐
  nightly sync → │ iptv-org/  31k channels, 18k streams   │
                 │ nexus/     community streams, channels,│ ← issue forms, PRs, bots
                 │            corrections, takedowns      │
                 └───────────────────┬────────────────────┘
                                     ▼
          aggregate → health scan (2×/day) → guide (nightly) → build
                                     ▼
   GitHub Pages: site · API · playlists · guide · Stremio addon · weekly SQLite
                                     ▼
   Cloudflare Worker: playlist builder · smart links · Xtream · MCP · regional data
```

### The database

Everything lives in this repository, under [`data/`](data):

- **`data/iptv-org/`** — the channel database this project started from: every
  channel, feed, logo, stream, guide mapping and blocklist entry, one record per
  line. The *Database Sync* workflow brings in the day's additions, corrections
  and removals every night, with a report in the commit — and refuses a mass
  removal, keeping the last good copy, so an upstream outage never empties the
  catalogue.
- **`data/nexus/`** — our own data: streams and channels added by the
  community, corrections, hidden broken streams and takedowns. The sync never
  touches it, and its records take precedence.

### Automation

| Workflow | When | What it does |
| --- | --- | --- |
| **Sync & Deploy** | every 6 h | Build the catalogue, guide, API, playlists, site and addon; deploy to Pages |
| **Health Scan** | 2×/day | Probe every stream in 6 parallel shards; update scores; retire dead links |
| **EPG Grab** | nightly | Scrape each guide site in `config/epg-grab.yml` into XMLTV |
| **Database Sync** | nightly | Apply the day's upstream changes to `data/`; refuse mass removals |
| **Discover Streams** | nightly | Find new streams in listed sources, probe them, add the ones that work |
| **Community** | on issue | Process *add a stream*, *broken stream* and *takedown* forms |
| **Repository Bot** | on issue / PR | Evaluate proposed sources, guide other issues, merge passing data PRs and Dependabot updates |
| **Database Dump** | Sundays | Publish the database as one SQLite file |
| **CI** | on push / PR | Typecheck, tests, pipeline smoke test |

Details, schedules and manual controls: [docs/AUTOMATION.md](docs/AUTOMATION.md).

---

## API

Everything is a static file on a CDN — no key, no rate limit. Files over 32 KB
also come gzipped (`.gz`).

| Endpoint | Contents |
| --- | --- |
| [`/api/v1/index.json`](https://dearbulut.github.io/iptv/api/v1/index.json) | Manifest: counts and every endpoint |
| `/api/v1/channels.json` | All channels with streams, health, numbers, availability |
| `/api/v1/channels/{id}.json` | One channel in detail |
| `/api/v1/by-country/{code}.json` · `by-category` · `by-language` | Shards |
| `/api/v1/search.json` | Compact index for client-side search |
| `/api/v1/regional.json` | Where each channel works, by country |
| `/api/v1/changes.json` · `changes.xml` | What became or stopped being watchable |
| `/epg/guide.xml.gz` · `/epg/{country}.xml.gz` · `/epg/channels/{id}.json` | Guide: merged, by country, by channel |
| `/playlists/…` | M3U playlists — see [PLAYLISTS.md](PLAYLISTS.md) |
| `/stremio/manifest.json` | Stremio addon |

```js
const BASE = 'https://dearbulut.github.io/iptv';
const channels = await (await fetch(`${BASE}/api/v1/by-country/de.json`)).json();
const news = channels.filter((c) => c.availability === 'online' && c.categories.includes('news'));
console.log(news[0].name, news[0].number, news[0].streams[0].url);
```

Full reference: [docs/API.md](docs/API.md) · schema: [`openapi.json`](https://dearbulut.github.io/iptv/api/v1/openapi.json).

---

## Run your own copy

1. **Fork** this repository.
2. *Settings → Pages → Source:* **GitHub Actions**.
3. In `config/settings.yml`, set `project.base_url` to your Pages URL.
4. Run **Database Sync**, then **Sync & Deploy**, from the Actions tab.
5. Optional: deploy [the Worker](workers/xtream/README.md) for the playlist
   builder, smart links, Xtream, MCP and regional data, and set
   `project.worker_url`.

From then on it maintains itself.

### Locally

Requires Node 22.12+. `ffprobe` (FFmpeg) is optional; without it health checks
still run but report no resolution or codecs.

```bash
git clone https://github.com/dearbulut/iptv.git && cd iptv
npm install

npm run cli -- aggregate             # build the catalogue from data/
npm run cli -- health --limit 200    # probe a sample of streams
npm run cli -- epg                   # build the guide
npm run cli -- api --clean           # render public/
npm run serve                        # → http://localhost:8080
```

| Command | What it does |
| --- | --- |
| `aggregate` | Read `data/` and the configured sources; merge, dedupe, resolve channels |
| `health` | Probe streams, update scores, retire dead links |
| `epg` | Normalise grabbed guides, match them to channels, write XMLTV |
| `api` | Render the API, playlists, site, Stremio addon and Worker data |
| `db-sync` | Update `data/iptv-org` from upstream (refuses mass removals) |
| `dump` | Write the whole database as one SQLite file |
| `discover` | Find new streams in listed sources and validate them |
| `pipeline` | aggregate → health → epg → api |

Configuration lives in [`config/`](config) — `settings.yml`, `sources.yml`,
`discovery.yml`, `epg-grab.yml`, `epg-sources.yml`, `epg-overrides.yml` — and
every value has a sensible default.

---

## Legal

IPTV Nexus **hosts no video**. It lists links to streams on third-party servers
— official free-to-air broadcasts, FAST channels and public service media — and
describes whether they work. Subscription and credential-protected streams are
excluded. Rights holders can have anything removed instantly with the
[takedown form](https://github.com/dearbulut/iptv/issues/new?template=takedown.yml). Details:
[docs/LEGAL.md](docs/LEGAL.md).

## Credits

The channel database began as a copy of [iptv-org](https://github.com/iptv-org/database),
which is in the public domain, and still receives its daily updates. Guides are
grabbed with [iptv-org/epg](https://github.com/iptv-org/epg). Additional free
streams are discovered from [Free-TV/IPTV](https://github.com/Free-TV/IPTV).
Browser playback uses [hls.js](https://github.com/video-dev/hls.js).

## License

[The Unlicense](LICENSE) — code and data are in the public domain. Streams belong
to whoever operates them.
