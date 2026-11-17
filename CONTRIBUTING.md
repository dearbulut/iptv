# Contributing

## Getting set up

```bash
npm install
npm run typecheck && npm test
```

Node 22.12+ is required. `ffprobe` (FFmpeg) is optional — health checks fall back
to HTTP-only when it is missing.

## Adding a stream or a channel

Use the [Add a stream](https://github.com/dearbulut/iptv/issues/new?template=add-stream.yml)
issue form — no pull request needed. A bot checks the stream, probes it and adds
it to `data/nexus/` within minutes, creating the channel if it is new. Streams
must be free to watch; subscription (reseller panel) streams are rejected.

## Correcting a channel

Corrections go in `data/nexus/channels.ndjson`: one JSON object per line with
the channel `id` and only the fields you change. They override the iptv-org
copy field by field and survive every database sync. Open a pull request.

## Adding a source

Whole playlists are an entry in `config/sources.yml`:

```yaml
  - id: unique-id
    name: Human readable name
    type: m3u
    url: https://example.com/playlist.m3u
    enabled: true
    trust: 0.7
```

Before opening the PR, please confirm the source is appropriate to index —
`docs/LEGAL.md` explains what that means. Sources that are paid, credential-
protected or obviously leaked are declined.

Check what your source actually adds:

```bash
npm run cli -- aggregate
npm run cli -- health --limit 100 --force
```

## Changing the pipeline

- `src/core/` — parsers, config and matching. Changes here affect everything, so
  they need tests.
- `src/aggregate/`, `src/health/`, `src/epg/`, `src/discovery/`, `src/api/` —
  one stage each; they only talk through `.data/`.
- `site/` — the web UI. No build step, no framework, and it should stay that way.

Run the full pipeline before submitting anything that touches output shape:

```bash
npm run cli -- aggregate
npm run cli -- api --clean
node scripts/validate-api.mjs
```

## Tests

`npm test` runs `node:test` over `tests/*.test.ts`. New parsing, matching or
scoring logic should come with cases — those three areas are where subtle bugs
hide, and where a wrong answer quietly corrupts thousands of records.
