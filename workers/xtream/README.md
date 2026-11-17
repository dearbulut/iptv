# IPTV Nexus Worker (Cloudflare)

One small, free Cloudflare Worker that adds what a static site cannot:

| Feature | Address | For |
| --- | --- | --- |
| **Playlist builder** | `/m3u?country=tr,de&category=news&online=1` | Any mix of countries, categories and languages as one playlist |
| **Smart links** | `/play/<channel number>` | Automatic failover to a working stream |
| **Xtream Codes API** | server = the Worker URL | TiviMate, IPTV Smarters, XCIPTV, TV boxes |
| **MCP endpoint** | `/mcp` | AI assistants: search channels, read the guide |
| **Regional availability** | `/regional.json`, `/check/<number>` | Where each channel works, by viewer country |

It stores nothing and no video passes through it. Its data is
`xtream/index.json` and `epg/channels/<id>.json`, which the Sync workflow
rebuilds and publishes to GitHub Pages four times a day. Stream requests are
answered with a redirect to the upstream URL.

## Deploy (about two minutes, free plan)

You need a free Cloudflare account.

```bash
cd workers/xtream
npx wrangler login      # opens the browser once
npx wrangler deploy
```

Wrangler prints the URL, e.g. `https://iptv-nexus-xtream.<you>.workers.dev`.
Put it in `config/settings.yml` as `project.worker_url` so the website's
[Tools page](https://dearbulut.github.io/iptv/tools.html) and the API
manifest point at it.

To deploy from a fork, change `NEXUS_ORIGIN` in `wrangler.toml` to your own
Pages site.

**Updating:** after pulling a new version, run `npx wrangler deploy` again.

### Optional password

By default any Xtream username and password are accepted — the catalogue is
public anyway. To restrict who can log in to *your* Worker:

```bash
npx wrangler secret put XTREAM_PASSWORD
```

The playlist builder, smart links and MCP endpoint stay open.

## Playlist builder

```
https://<worker>/m3u?country=tr,de&category=news,sports&language=tur&online=1
```

| Parameter | Meaning |
| --- | --- |
| `country` | ISO 3166-1 codes, comma-separated (`tr,de,us`) |
| `category` | `news`, `sports`, `kids`, `music`, `movies`… |
| `language` | ISO 639-3 codes (`tur,eng,deu`) |
| `online=1` | Only channels that worked on the last check |
| `q` | Part of the channel name |
| `group` | `category` (default), `country` or `language` for `group-title` |
| `links=direct` | Upstream URLs instead of smart links |

Every entry carries `tvg-id`, the permanent `tvg-chno`, logo, country and
language. A single-country playlist points `x-tvg-url` at that country's
guide; otherwise at the merged guide. The website's Tools page builds these
URLs for you.

## Smart links and failover

`/play/<number>` (also with `.m3u8` or `.ts`) checks the channel's streams
from the Cloudflare location nearest the viewer and redirects to the first
one that answers. A channel therefore keeps working when one of its streams
goes down, and a stream that is geo-blocked elsewhere but works in the
viewer's region is found. The choice is cached per location for five minutes,
so each channel is checked at most once per location in that window.

Xtream stream requests (`/live/<user>/<pass>/<id>.ts`) use the same failover.

A redirect cannot carry `Referer` or `User-Agent` headers, so only streams
that need none are used as fallbacks. In builder playlists, channels whose
only streams need headers get the direct URL with `#EXTVLCOPT` lines instead.

## Xtream Codes login

| Field    | Value                                                     |
| -------- | --------------------------------------------------------- |
| Server   | `https://iptv-nexus-xtream.<you>.workers.dev`             |
| Username | anything — or **`country`** to group channels by country  |
| Password | anything (or your `XTREAM_PASSWORD`)                      |

| Request | Answer |
| --- | --- |
| `player_api.php` (login) | account and server info |
| `action=get_live_categories` | categories, or countries for user `country` |
| `action=get_live_streams[&category_id=]` | live channels |
| `action=get_short_epg` / `get_simple_data_table` | now and next, from the merged guide |
| `/live/<user>/<pass>/<id>.ts` / `.m3u8` | smart redirect (see above) |
| `xmltv.php` | the merged guide |
| `get.php` | the full playlist, with smart links |
| VOD and series actions | empty lists — Nexus is live TV only |

`stream_id` is the channel's permanent Nexus number, so favourites and channel
positions in your app survive every rebuild.

## MCP endpoint (AI assistants)

`https://<worker>/mcp` speaks the Model Context Protocol over Streamable HTTP,
without sessions or authentication. Add it as a remote MCP server in Claude,
ChatGPT, Cursor or any MCP client. Tools:

| Tool | Does |
| --- | --- |
| `search_channels` | Find channels by name, country, category, language, working now |
| `get_channel` | One channel's streams, health and website |
| `whats_on` | What is on now and next |
| `build_playlist` | A playlist builder URL for a given mix |

Try: *"Which Turkish news channels work right now, and what is on TRT Haber?"*

## Regional availability

A Worker always runs at the Cloudflare location nearest whoever made the
request. So when a viewer in Turkey opens a smart link, the channel's streams
are tested from Turkey; a viewer in Germany tests them from Germany. The
Worker counts each outcome per **viewer country and channel**, adds successful
plays reported by the website's player, and publishes the last 14 days at
`/regional.json`. The Sync workflow folds that into the API (`regional` on each
channel) and the website shows it as "Where it works".

Nothing about the viewer is stored except the country Cloudflare reports for
the request — no IP address, no identifier. A country needs at least three data
points before it is shown. The website's player reports successful plays only:
a browser failure is usually CORS or mixed content, not geography.

`/check/<channel number>` tests a channel from the caller's location on demand;
the website's "Check from my location" button uses it.

### Turning it on (once)

```bash
cd workers/xtream
npx wrangler d1 create iptv-nexus
```

Copy the `database_id` it prints into the commented `[[d1_databases]]` block at
the end of `wrangler.toml`, uncomment the block, and deploy again:

```bash
npx wrangler deploy
```

The table is created on first use. D1's free plan (5 GB, 100,000 writes a day)
covers this comfortably: one write per tested channel switch or play.

## Limits

- The free Workers plan allows 100,000 requests a day. A channel switch is
  one request, a builder playlist one per refresh, which is ample for personal
  use and small groups.
- Guide data for `get_short_epg` and `whats_on` exists only for channels the
  merged guide covers.
