# Legal notes

This is practical guidance, not legal advice. IPTV law varies a great deal by
country, and if you are deploying this publicly you should satisfy yourself that
what you are indexing is lawful where you operate.

## What this project does and does not do

**Does:** collect stream URLs that are already publicly listed, check whether
they respond, describe them, and publish that description as data.

**Does not:** host, transcode, proxy, re-encode or rebroadcast any video. No
video traffic passes through this project or its deployment. It also ships no
mechanism for accessing paid, encrypted or credential-protected services, and
adding one is out of scope.

The closest analogy is a search engine index or a link directory: it points at
things that are already public and says something useful about them.

## What to keep in mind

**Publicly reachable is not the same as licensed for redistribution.** A stream
being fetchable does not mean its operator intended it to be listed. When adding
sources, prefer:

- official free-to-air and public broadcaster feeds
- FAST services that publish their own playlists
- lists that state a licence permitting redistribution

Avoid anything that is obviously a leak of a paid service, that requires
credentials, or that is distributed as a subscription line. Sources like that
will be removed from this repository when found.

**Blocklists are honoured.** `aggregate.respect_blocklist` defaults to `true`,
so channels flagged by iptv-org for DMCA or NSFW reasons, and every channel or
stream removed through our own takedown process, are dropped. Leave it on.

**NSFW channels are excluded by default** via `aggregate.exclude_nsfw`. If you
turn that off, the responsibility for age-gating whatever you publish is yours.

**Community submissions are checked by rules, not trust.** The "Add a stream"
form only accepts http(s) streams that play when checked, rejects anything that
looks like a subscription (reseller panel) line or carries credentials, limits
each person to 10 additions a day, and records who added what and from which
issue. Health checks then treat these streams like any other and retire them if
they stop working.

## Takedown requests

IPTV Nexus links to streams on third-party servers and hosts no video. If you
hold the rights to something linked here, use the
**[Copyright / takedown request](https://github.com/dearbulut/iptv/issues/new?template=takedown.yml)**
form. It is processed automatically:

1. The form checks that the notice is complete: your name and contact, the
   work concerned, what to remove, the good-faith and accuracy statements, and
   a signature.
2. **The listed channels and streams are removed at once** — written to
   `data/nexus/blocklist.ndjson` with a reference to the request — and drop out
   of the website, playlists, API, Stremio addon and Worker at the next sync,
   within six hours.
3. The repository owner is assigned to review the request.

Requests filed with iptv-org reach us too: its blocklist is part of the daily
database sync.

### Counter-notice

If something was removed by mistake, or you have the right to make it
available, open an issue explaining why and identify the original request. A
removal is undone by deleting its line from `data/nexus/blocklist.ndjson` once
the owner is satisfied it should be. Abusing the takedown form to remove
content you have no rights to may itself be unlawful where you live.

## Licence

Code and data are released under [the Unlicense](../LICENSE), into the public
domain. The channel database began as a copy of
[iptv-org/database](https://github.com/iptv-org/database), which is itself
under the Unlicense, and is kept in this repository (`data/`). Individual
streams are governed by whatever terms their operators apply — this project
makes no claim over them and grants no rights to them.
