# Using IPTV Nexus in your player

Every playlist is a plain URL and every guide is a plain XMLTV URL, so any
player that accepts an M3U link works. This page covers the common ones.

## Which URLs to use

| You want | Playlist | Guide |
| --- | --- | --- |
| Everything, one stream per channel | `https://dearbulut.github.io/iptv/playlists/best.m3u` | `https://dearbulut.github.io/iptv/epg/guide.xml.gz` |
| Only channels that worked on the last check | `https://dearbulut.github.io/iptv/playlists/online.m3u` | same |
| One country (recommended for TV apps) | `https://dearbulut.github.io/iptv/playlists/country/tr.m3u` | `https://dearbulut.github.io/iptv/epg/tr.xml.gz` |
| One category or language | `…/playlists/category/news.m3u`, `…/playlists/language/tur.m3u` | `…/epg/guide.xml.gz` |

All playlists and guides: [PLAYLISTS.md](../PLAYLISTS.md).

**Prefer a country playlist on TV apps.** The full list has over ten thousand
channels and the full guide is about 13 MB compressed. A country playlist
already points at its own guide (`x-tvg-url`), which is usually a few
kilobytes, so many apps pick it up with no extra setup.

**Channel numbers are permanent.** Every channel carries `tvg-chno`, a number
that never changes and is never reused, so your favourites, channel order and
"news is on 101" habits survive every update. Apps that support it are noted
below.

**Guide ids line up.** Each entry's `tvg-id` is the Nexus channel id (for
example `TRT1.tr`), the same id the guide uses, so the guide matches without
manual mapping.

## Build your own playlist

The fixed playlists cover one country, category or language each. For any
combination — say Turkish and German news that work right now — use the
playlist builder on the [Tools page](https://dearbulut.github.io/iptv/tools.html),
or write the URL yourself:

```
https://iptv-nexus-xtream.bulutworks.workers.dev/m3u?country=tr,de&category=news&online=1
```

Parameters are listed in the [Worker guide](../workers/xtream/README.md#playlist-builder).
By default entries are **smart links**: when you open a channel, the Worker
sends you to whichever of its streams answers right now, so channels keep
working when a stream goes down.

## Fix a provider or panel playlist

If your provider's or panel's playlist has no guide, or the wrong one, the
channel ids are usually missing or don't match any guide. Open
[Tools → Fix my playlist](https://dearbulut.github.io/iptv/tools.html#fix), load
the `.m3u`, and download it back with `tvg-id`, logos and (optionally)
permanent channel numbers filled in, and the guide URL set. Your stream URLs
are not changed, VOD entries are left alone, and matching runs in your
browser, so the playlist — and any credentials in its URLs — is never
uploaded. In a test with 10,000 channels written the way panels write them
(`TR: TRT 1 FHD`, `|DE| Das Erste HD`), 99.9% were matched correctly.

## Jellyfin (and Emby)

1. *Dashboard → Live TV → Tuner Devices → +*. Type **M3U Tuner**, file or URL:
   the playlist URL.
2. *Dashboard → Live TV → TV Guide Data Providers → + → XMLTV*. File or URL:
   the guide URL.
3. Save, then *Refresh Guide Data* under *Scheduled Tasks*.

Jellyfin reads `tvg-chno` for channel numbers and `group-title` for
categories.

## Plex

Plex Live TV needs a Plex Pass and a tuner it recognises; it cannot read an
M3U directly. Run a small bridge that presents the playlist as an HDHomeRun
tuner:

- [Threadfin](https://github.com/Threadfin/Threadfin) (successor to xTeVe), or
- [Dispatcharr](https://github.com/Dispatcharr/Dispatcharr).

Add the playlist and guide URLs in the bridge, map channels (ids already
match), then in Plex choose *Settings → Live TV & DVR → Set up Plex DVR*; it
finds the bridge as a tuner. Use a country playlist: Plex handles a few
hundred channels far better than ten thousand.

## Kodi

1. *Add-ons → Install from repository → PVR clients →* **PVR IPTV Simple
   Client**.
2. Configure → *General*: Location **Remote path (Internet address)**, M3U
   play list URL: the playlist URL.
3. *EPG*: Location **Remote path**, XMLTV URL: the guide URL.
4. To use the permanent numbers, enable the options to use the backend's
   channel order and numbers under *Settings → PVR & Live TV*.

Kodi reads `#EXTVLCOPT` header lines, so streams that need a Referer or
User-Agent play too.

## TiviMate

Either:

- *Add playlist → Enter URL*: the playlist URL. TiviMate reads the guide from
  `x-tvg-url` automatically; to add it by hand use *Settings → EPG → EPG
  sources*.
- or *Add playlist → Xtream Codes* with your [Xtream Worker](../workers/xtream/README.md)
  if you run one.

To get the permanent numbers, set the playlist's channel numbering to use the
numbers from the playlist (`tvg-chno`) in its playlist settings.

## IPTV Smarters, XCIPTV and other Xtream-only apps

Many apps, and most TV-box firmware, only accept an Xtream Codes login. Log
in with:

- Server: `https://iptv-nexus-xtream.bulutworks.workers.dev`
- Username: anything, or `country` to group channels by country
- Password: anything

Channel switches use smart links (automatic failover), and the now/next guide
works in apps that ask for it. To run your own, deploy the
[Worker](../workers/xtream/README.md) (free Cloudflare account, about two
minutes).

Apps that also accept *M3U URL* work with the playlist URL directly.

## Stremio

Paste this into the Stremio search bar (or *Addons → Community addons →
paste URL*) and choose **Install**:

```
https://dearbulut.github.io/iptv/stremio/manifest.json
```

It adds two TV catalogues, by category and by country, under *Discover → TV*.
Only channels that are online, regional or not yet checked are listed.
Streams that need special headers play in the desktop and mobile apps (through
Stremio's streaming server) but not in Stremio Web.

## VLC

*Media → Open Network Stream* and paste a playlist URL; channels appear in the
*Playlist* view. VLC applies `#EXTVLCOPT` headers. To try a single channel
from the website, open the channel and choose **Open in player**: it downloads
a one-channel playlist with the right headers.

## Channels DVR

Add a *Custom Channels* source with stream format **HLS**, the playlist URL
as the source and the guide URL as XMLTV guide data. Choose to number channels
from `tvg-chno` to get the permanent numbers.

## Web browsers

The [website](https://dearbulut.github.io/iptv) plays channels directly. A
browser on an HTTPS page cannot play plain `http://` streams or streams that
need custom headers, so those are marked **VLC**; the *Plays in browser*
filter hides them. Channels marked **Regional** refused our scanner with a
geo-block and may well work from where you are.

## AI assistants (MCP)

Add `https://iptv-nexus-xtream.bulutworks.workers.dev/mcp` as a remote MCP server (Streamable HTTP, no
authentication) in Claude, ChatGPT, Cursor or another MCP client. The
assistant can then search channels, check which work, read what is on and
build playlist links — for example *"Which Turkish news channels work right
now, and what is on TRT Haber?"*

## Following changes

`https://dearbulut.github.io/iptv/api/v1/changes.xml` is an Atom feed of
channels that became watchable or stopped being watchable. Add it to any feed
reader. The same data is at `api/v1/changes.json`.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Channel list loads, nothing plays | Stream is down now; try `online.m3u`, or another stream from the website. |
| Plays in VLC or Kodi but not in the app | The stream needs a Referer or User-Agent the app does not send. |
| A provider playlist shows no guide | Run it through [Fix my playlist](https://dearbulut.github.io/iptv/tools.html#fix). |
| No guide | The channel has no guide source yet. The list of guide channels we could not match is at [`api/v1/epg-unmatched.json`](https://dearbulut.github.io/iptv/api/v1/epg-unmatched.json); a fix is one line in [`config/epg-overrides.yml`](../config/epg-overrides.yml). |
| Guide is shifted by hours | Set the app's EPG time offset to 0; guide times are in UTC with offsets. |
| "Regional" channel will not play | It is geo-restricted and you are outside its region. |
