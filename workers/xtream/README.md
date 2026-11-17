# Xtream Codes API (Cloudflare Worker)

Many IPTV apps — TiviMate, IPTV Smarters, XCIPTV and the players built into
most TV boxes — only accept an **Xtream Codes login** (server, username,
password), not a playlist URL. This Worker answers that protocol using the
Nexus catalogue.

It stores nothing and streams nothing. It reads `xtream/index.json` from the
GitHub Pages site (rebuilt by the Sync workflow four times a day), reshapes it
into Xtream responses, and answers stream requests with a redirect to the
upstream URL.

## Deploy (about two minutes, free plan)

You need a free Cloudflare account.

```bash
cd workers/xtream
npx wrangler login      # opens the browser once
npx wrangler deploy
```

Wrangler prints the URL, e.g. `https://iptv-nexus-xtream.<you>.workers.dev`.

To deploy from a fork, change `NEXUS_ORIGIN` in `wrangler.toml` to your own
Pages site.

### Optional password

By default any username and password are accepted — the catalogue is public
anyway. To restrict who can use *your* Worker:

```bash
npx wrangler secret put XTREAM_PASSWORD
```

## Log in from an app

| Field    | Value                                                     |
| -------- | --------------------------------------------------------- |
| Server   | `https://iptv-nexus-xtream.<you>.workers.dev`             |
| Username | anything — or **`country`** to group channels by country  |
| Password | anything (or your `XTREAM_PASSWORD`)                      |

With any other username, channels are grouped by category (News, Sports,
Kids…).

## What works

| Request                                     | Answer                                         |
| ------------------------------------------- | ---------------------------------------------- |
| `player_api.php` (login)                    | account and server info                        |
| `action=get_live_categories`                | categories, or countries for user `country`    |
| `action=get_live_streams[&category_id=]`    | live channels                                  |
| `/live/<user>/<pass>/<id>.ts` / `.m3u8`     | 302 to the best stream for that channel        |
| `xmltv.php`                                 | 302 to the merged guide (`epg/guide.xml.gz`)   |
| `get.php`                                   | 302 to `playlists/best.m3u`                    |
| VOD and series actions                      | empty lists — Nexus is live TV only            |

`stream_id` is the channel's permanent Nexus number (`tvg-chno`), so
favourites and channel positions in your app survive every rebuild.
`epg_channel_id` is the Nexus channel id, which is what the guide uses, so the
EPG lines up without any mapping.

## Limits

- A redirect cannot carry `Referer` or `User-Agent` headers, so for each
  channel the Worker prefers a stream that needs none. Channels whose only
  streams need headers still play in apps that ignore the requirement, and
  otherwise work through the M3U playlists, which include the headers.
- `get_short_epg` returns no listings; apps fall back to `xmltv.php`.
- The free Workers plan allows 100,000 requests a day. Each login is a few
  requests and each channel switch one, which is ample for personal use.
