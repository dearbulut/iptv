/**
 * IPTV Nexus Worker — one small Cloudflare Worker that adds what a static
 * site cannot do:
 *
 *   /play/<number>        smart link: redirects to the first stream of that
 *                         channel that answers right now, checked from the
 *                         Cloudflare location nearest the viewer (failover)
 *   /m3u?country=tr,de…   playlist builder: any combination of country,
 *                         category, language and "working now", with smart
 *                         links and the right guide
 *   /player_api.php …     Xtream Codes API for TiviMate, IPTV Smarters,
 *                         XCIPTV and TV boxes that only take an Xtream login
 *   /mcp                  Model Context Protocol endpoint, so AI assistants
 *                         can search channels and read the guide
 *   /check/<number>       tests a channel's streams from the viewer's
 *                         nearest Cloudflare location
 *   /regional.json        where channels work, by viewer country, from those
 *                         checks and from playback reports (needs D1)
 *   Xtream VOD & series   openly licensed films and series (xtream/vod.json);
 *                         /movie/… and /series/… redirect to archive.org
 *
 * It stores nothing and streams nothing. Its data is `xtream/index.json` and
 * `epg/channels/<id>.json`, which the Sync workflow publishes to GitHub Pages;
 * stream requests are answered with a redirect to the upstream URL.
 *
 * Environment (wrangler.toml [vars] or dashboard):
 *   NEXUS_ORIGIN     Pages site, default https://dearbulut.github.io/iptv
 *   XTREAM_PASSWORD  optional; when set, Xtream logins must use it
 *   DB               optional D1 binding for regional availability
 *
 * Regional availability: a Worker always runs at the Cloudflare location
 * nearest whoever made the request, so when a viewer in Turkey opens a
 * channel, its streams are tested from Turkey. Each outcome is counted per
 * viewer country and channel — never per person; no IP address is stored.
 */

const DEFAULT_ORIGIN = 'https://dearbulut.github.io/iptv';
const VERSION = '1.3.0';
/** Days of regional checks summarised in /regional.json; older rows are deleted after 30. */
const REGIONAL_DAYS = 14;
/** How long an isolate reuses the index before refetching it. */
const INDEX_TTL_MS = 10 * 60 * 1000;
/** How long the failover choice for a channel is remembered per location. */
const PLAY_CACHE_SECONDS = 300;
const PROBE_TIMEOUT_MS = 2500;

// Row layout of xtream/index.json (see src/api/xtream.ts).
const R = {
  ID: 0, NAME: 1, ICON: 2, EPG: 3, CATS: 4, COUNTRY_CAT: 5, URL: 6,
  FALLBACKS: 7, COUNTRY: 8, CATEGORIES: 9, LANGUAGES: 10, STATE: 11,
  REFERRER: 12, USER_AGENT: 13, QUALITY: 14,
};

let cached = null; // { origin, at, index, byId, byEpg }
let cachedVod = null; // { origin, at, vod, movies, series, episodes }

/** Openly licensed films and series (xtream/vod.json), or null when there are none. */
async function loadVod(origin) {
  if (cachedVod && cachedVod.origin === origin && Date.now() - cachedVod.at < INDEX_TTL_MS) return cachedVod.vod ? cachedVod : null;
  const response = await fetch(`${origin}/xtream/vod.json`, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!response.ok) {
    cachedVod = { origin, at: Date.now(), vod: null };
    return null;
  }
  const vod = await response.json();
  const episodes = new Map();
  for (const show of vod.series) for (const episode of show.episodes) episodes.set(episode[0], { show, episode });
  cachedVod = {
    origin,
    at: Date.now(),
    vod,
    movies: new Map(vod.movies.map((movie) => [movie[0], movie])),
    series: new Map(vod.series.map((show) => [show.number, show])),
    episodes,
  };
  return cachedVod;
}

const extension = (url) => (url.match(/\.(mp4|mkv|m4v|ogv|webm|avi|mpeg|mpg|mov)(?:$|\?)/i)?.[1] ?? 'mp4').toLowerCase();
const minutes = (seconds) => (seconds ? `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : '');

// Rows: movies [number, title, poster, year, category ids, url, runtime, description, licence]
const M = { ID: 0, TITLE: 1, POSTER: 2, YEAR: 3, CATS: 4, URL: 5, RUNTIME: 6, PLOT: 7, LICENSE: 8 };

async function loadIndex(origin) {
  if (cached && cached.origin === origin && Date.now() - cached.at < INDEX_TTL_MS) return cached;
  const response = await fetch(`${origin}/xtream/index.json`, { cf: { cacheTtl: 600, cacheEverything: true } });
  if (!response.ok) throw new Error(`index.json: HTTP ${response.status}`);
  const index = await response.json();
  const byId = new Map(index.streams.map((row) => [row[R.ID], row]));
  const byEpg = new Map(index.streams.map((row) => [String(row[R.EPG]).toLowerCase(), row]));
  cached = { origin, at: Date.now(), index, byId, byEpg };
  return cached;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-expose-headers': 'mcp-session-id',
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300', ...CORS, ...extra },
  });

const text = (body, status = 200, type = 'text/plain') =>
  new Response(body, { status, headers: { 'content-type': `${type}; charset=utf-8`, ...CORS } });

const redirect = (url) =>
  new Response(null, { status: 302, headers: { location: url, 'cache-control': 'no-store', ...CORS } });

const has = (row, i) => row.length > i && row[i] !== undefined && row[i] !== null;

// --------------------------------------------------------------- regional

let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.exec(
    'CREATE TABLE IF NOT EXISTS regional (day TEXT NOT NULL, country TEXT NOT NULL, channel INTEGER NOT NULL, ok INTEGER NOT NULL DEFAULT 0, fail INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, country, channel))',
  );
  schemaReady = true;
}

/** Real two-letter countries only: not Tor (T1), unknown (XX) or missing. */
const viewerCountry = (request) => {
  const country = request.cf?.country;
  return typeof country === 'string' && /^[A-Z]{2}$/.test(country) && country !== 'XX' && country !== 'T1' ? country : null;
};

/** Counts one outcome for a channel in the viewer's country. Never blocks the response. */
function recordOutcome(env, ctx, request, channel, ok) {
  const country = viewerCountry(request);
  if (!env.DB || !country) return;
  const day = new Date().toISOString().slice(0, 10);
  ctx.waitUntil(
    ensureSchema(env.DB)
      .then(() =>
        env.DB.prepare(
          'INSERT INTO regional (day, country, channel, ok, fail) VALUES (?1, ?2, ?3, ?4, ?5) ' +
            'ON CONFLICT (day, country, channel) DO UPDATE SET ok = ok + excluded.ok, fail = fail + excluded.fail',
        )
          .bind(day, country, channel, ok ? 1 : 0, ok ? 0 : 1)
          .run(),
      )
      .catch(() => {}),
  );
}

async function regionalSummary(env, ctx) {
  if (!env.DB) return json({ error: 'Regional data is not enabled on this Worker (no D1 binding).' }, 404);
  const cache = caches.default;
  const key = new Request('https://nexus.invalid/regional.json');
  const hit = await cache.match(key);
  if (hit) return hit;

  await ensureSchema(env.DB);
  const since = new Date(Date.now() - REGIONAL_DAYS * 86_400_000).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    'SELECT channel, country, SUM(ok) AS ok, SUM(fail) AS fail FROM regional WHERE day >= ?1 GROUP BY channel, country',
  )
    .bind(since)
    .all();
  const channels = {};
  for (const row of results ?? []) {
    (channels[row.channel] ??= {})[row.country] = [row.ok, row.fail];
  }
  const response = json(
    { generated_at: new Date().toISOString(), days: REGIONAL_DAYS, channels },
    200,
    { 'cache-control': 'public, max-age=3600' },
  );
  ctx.waitUntil(
    Promise.all([
      cache.put(key, response.clone()),
      env.DB.prepare('DELETE FROM regional WHERE day < ?1')
        .bind(new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10))
        .run()
        .catch(() => {}),
    ]),
  );
  return response;
}

/** Tests every candidate stream of a channel from here, for the Tools page. */
async function checkHere(id, request, env, ctx) {
  const { byId } = await loadIndex(env.NEXUS_ORIGIN || DEFAULT_ORIGIN);
  const row = byId.get(Number(id));
  if (!row) return json({ error: 'Unknown channel number' }, 404);
  const candidates = [row[R.URL], ...(has(row, R.FALLBACKS) ? row[R.FALLBACKS] : [])];
  const results = await Promise.all(candidates.map(async (url) => ({ url, ok: await answers(url) })));
  const ok = results.some((result) => result.ok);
  recordOutcome(env, ctx, request, row[R.ID], ok);
  return json(
    {
      channel: row[R.NAME],
      number: row[R.ID],
      country: request.cf?.country ?? null,
      location: request.cf?.colo ?? null,
      works: ok,
      streams: results,
      note: row[R.REFERRER] || row[R.USER_AGENT] ? 'This channel needs special headers; results are for the stream without them.' : undefined,
    },
    200,
    { 'cache-control': 'no-store' },
  );
}

/** Playback reports from the website's player: successes only (see site/app.js). */
async function playbackReport(request, env, ctx) {
  if (request.method !== 'POST') return text('POST only', 405);
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return text('Bad request', 400);
  }
  const { byId } = await loadIndex(env.NEXUS_ORIGIN || DEFAULT_ORIGIN);
  const number = Number(body?.number);
  if (!byId.has(number) || body?.ok !== true) return new Response(null, { status: 204, headers: CORS });
  recordOutcome(env, ctx, request, number, true);
  return new Response(null, { status: 204, headers: CORS });
}
const list = (value) => (value ? String(value).split(';').filter(Boolean) : []);

// ------------------------------------------------------------- smart links

/** True when `url` answers like a stream would, within the timeout. */
async function answers(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (IPTV Nexus failover check)', range: 'bytes=0-2047' },
    });
    const type = response.headers.get('content-type') ?? '';
    response.body?.cancel();
    // Error pages come back as HTML with a 200 surprisingly often.
    return response.status < 400 && !type.includes('text/html');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The URL to send a viewer to: the primary stream if it answers, otherwise
 * the first fallback that does. The choice is cached per Cloudflare location
 * for a few minutes, so a channel is probed at most once per location in
 * that window however many people zap to it.
 */
async function chooseStream(row, ctx, onProbed) {
  const candidates = [row[R.URL], ...(has(row, R.FALLBACKS) ? row[R.FALLBACKS] : [])];
  if (candidates.length === 1) return candidates[0];

  const cache = caches.default;
  const key = new Request(`https://nexus.invalid/play/${row[R.ID]}`);
  const hit = await cache.match(key);
  if (hit) {
    const chosen = await hit.text();
    if (candidates.includes(chosen)) return chosen;
  }

  let chosen = candidates[0];
  let anyAnswered = false;
  for (const candidate of candidates) {
    if (await answers(candidate)) {
      chosen = candidate;
      anyAnswered = true;
      break;
    }
  }
  onProbed?.(anyAnswered);
  ctx.waitUntil(
    cache.put(key, new Response(chosen, { headers: { 'cache-control': `max-age=${PLAY_CACHE_SECONDS}` } })),
  );
  return chosen;
}

async function play(id, env, ctx, request) {
  const { byId } = await loadIndex(env.NEXUS_ORIGIN || DEFAULT_ORIGIN);
  const row = byId.get(Number(id));
  if (!row) return text('Unknown channel number', 404);
  // Every real probe doubles as a regional data point for the viewer's country.
  return redirect(await chooseStream(row, ctx, (ok) => recordOutcome(env, ctx, request, row[R.ID], ok)));
}

// -------------------------------------------------------- playlist builder

function parseFilters(params) {
  const set = (name) => {
    const values = (params.get(name) ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    return values.length > 0 ? new Set(values) : null;
  };
  return {
    countries: set('country'),
    categories: set('category'),
    languages: set('language'),
    online: params.get('online') === '1',
    query: (params.get('q') ?? '').trim().toLowerCase(),
  };
}

function filterRows(rows, filters) {
  return rows.filter((row) => {
    if (filters.countries && !filters.countries.has(String(row[R.COUNTRY] ?? '').toLowerCase())) return false;
    if (filters.categories && !list(row[R.CATEGORIES]).some((c) => filters.categories.has(c))) return false;
    if (filters.languages && !list(row[R.LANGUAGES]).some((l) => filters.languages.has(l))) return false;
    if (filters.online && row[R.STATE] !== 2) return false;
    if (filters.query && !String(row[R.NAME]).toLowerCase().includes(filters.query)) return false;
    return true;
  });
}

async function guideFor(filters, origin) {
  if (filters.countries?.size === 1) {
    const [code] = filters.countries;
    const shard = `${origin}/epg/${code}.xml.gz`;
    const head = await fetch(shard, { method: 'HEAD', cf: { cacheTtl: 3600 } }).catch(() => null);
    if (head?.ok) return shard;
  }
  return `${origin}/epg/guide.xml.gz`;
}

const attr = (value) => String(value ?? '').replace(/"/g, "'");

async function buildPlaylist(url, env) {
  const origin = env.NEXUS_ORIGIN || DEFAULT_ORIGIN;
  const { index } = await loadIndex(origin);
  if (!has(index.streams[0] ?? [], R.COUNTRY)) {
    return text('The catalogue has not been rebuilt with builder data yet; try again after the next sync.', 503);
  }
  const params = url.searchParams;
  const filters = parseFilters(params);
  const smart = params.get('links') !== 'direct';
  const groupBy = params.get('group') ?? 'category';
  const categoryName = new Map(index.categories.category.map(([id, name]) => [id, name]));
  const countryName = new Map(index.categories.country.map(([id, name]) => [id, name]));

  const rows = filterRows(index.streams, filters);
  const lines = [`#EXTM3U x-tvg-url="${await guideFor(filters, origin)}"`];
  for (const row of rows) {
    const group =
      groupBy === 'country' ? countryName.get(row[R.COUNTRY_CAT])
      : groupBy === 'language' ? list(row[R.LANGUAGES])[0] ?? 'Other'
      : categoryName.get(row[R.CATS][0]) ?? 'Other';
    const needsHeaders = Boolean(row[R.REFERRER] || row[R.USER_AGENT]);
    lines.push(
      `#EXTINF:-1 tvg-id="${attr(row[R.EPG])}" tvg-chno="${row[R.ID]}" tvg-name="${attr(row[R.NAME])}"` +
        ` tvg-logo="${attr(row[R.ICON])}" tvg-country="${attr(row[R.COUNTRY])}"` +
        ` tvg-language="${attr(list(row[R.LANGUAGES]).join(';'))}" group-title="${attr(group)}",${row[R.NAME]}`,
    );
    // Smart links cannot carry headers, so channels that need them get the
    // direct URL plus the VLC options most players understand.
    if (smart && !needsHeaders) {
      lines.push(`${url.origin}/play/${row[R.ID]}.m3u8`);
    } else {
      if (row[R.REFERRER]) lines.push(`#EXTVLCOPT:http-referrer=${row[R.REFERRER]}`);
      if (row[R.USER_AGENT]) lines.push(`#EXTVLCOPT:http-user-agent=${row[R.USER_AGENT]}`);
      lines.push(row[R.URL]);
    }
  }
  return new Response(`${lines.join('\n')}\n`, {
    headers: {
      'content-type': 'audio/x-mpegurl; charset=utf-8',
      'content-disposition': 'inline; filename="nexus.m3u"',
      'cache-control': 'public, max-age=600',
      'x-channel-count': String(rows.length),
      ...CORS,
    },
  });
}

// ------------------------------------------------------------------- guide

async function schedule(origin, epgId) {
  const response = await fetch(`${origin}/epg/channels/${encodeURIComponent(epgId)}.json`, {
    cf: { cacheTtl: 900, cacheEverything: true },
  });
  if (!response.ok) return [];
  const data = await response.json();
  return data.programmes ?? [];
}

const b64 = (value) => {
  const bytes = new TextEncoder().encode(String(value ?? ''));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const xtreamTime = (iso) => iso.replace('T', ' ').slice(0, 19);

async function shortEpg(params, env, all) {
  const origin = env.NEXUS_ORIGIN || DEFAULT_ORIGIN;
  const { byId } = await loadIndex(origin);
  const row = byId.get(Number(params.get('stream_id')));
  if (!row) return json({ epg_listings: [] });
  const now = Date.now();
  let programmes = (await schedule(origin, row[R.EPG])).filter((p) => Date.parse(p.stop) > now);
  if (!all) programmes = programmes.slice(0, Number(params.get('limit')) || 4);
  return json({
    epg_listings: programmes.map((p, i) => ({
      id: String(i + 1),
      epg_id: String(row[R.ID]),
      title: b64(p.title),
      lang: '',
      start: xtreamTime(p.start),
      end: xtreamTime(p.stop),
      description: b64(p.description ?? ''),
      channel_id: row[R.EPG],
      start_timestamp: String(Math.floor(Date.parse(p.start) / 1000)),
      stop_timestamp: String(Math.floor(Date.parse(p.stop) / 1000)),
      now_playing: Date.parse(p.start) <= now && Date.parse(p.stop) > now ? 1 : 0,
      has_archive: 0,
    })),
  });
}

// ------------------------------------------------------------------ Xtream

function authorised(env, password) {
  return !env.XTREAM_PASSWORD || password === env.XTREAM_PASSWORD;
}

function userInfo(username, password) {
  return {
    username,
    password,
    message: 'IPTV Nexus — free, open catalogue',
    auth: 1,
    status: 'Active',
    exp_date: null,
    is_trial: '0',
    active_cons: '0',
    created_at: '1700000000',
    max_connections: '100',
    allowed_output_formats: ['m3u8', 'ts'],
  };
}

function serverInfo(url) {
  const now = new Date();
  return {
    url: url.hostname,
    port: '443',
    https_port: '443',
    server_protocol: 'https',
    rtmp_port: '0',
    timezone: 'UTC',
    timestamp_now: Math.floor(now.getTime() / 1000),
    time_now: now.toISOString().replace('T', ' ').slice(0, 19),
    process: true,
  };
}

function liveStream(row, byCountry, position) {
  const categoryIds = byCountry ? [row[R.COUNTRY_CAT]] : row[R.CATS];
  return {
    num: position,
    name: row[R.NAME],
    stream_type: 'live',
    stream_id: row[R.ID],
    stream_icon: row[R.ICON],
    epg_channel_id: row[R.EPG],
    added: '0',
    is_adult: '0',
    category_id: String(categoryIds[0]),
    category_ids: categoryIds,
    custom_sid: '',
    tv_archive: 0,
    direct_source: '',
    tv_archive_duration: 0,
  };
}

async function playerApi(url, env) {
  const params = url.searchParams;
  const username = params.get('username') ?? '';
  const password = params.get('password') ?? '';
  if (!authorised(env, password)) {
    return json({ user_info: { auth: 0, status: 'Disabled', message: 'Invalid password' } }, 401);
  }

  const action = params.get('action');
  if (!action) return json({ user_info: userInfo(username, password), server_info: serverInfo(url) });

  const byCountry = username.toLowerCase() === 'country';
  const origin = env.NEXUS_ORIGIN || DEFAULT_ORIGIN;

  switch (action) {
    case 'get_live_categories': {
      const { index } = await loadIndex(origin);
      const categories = byCountry ? index.categories.country : index.categories.category;
      return json(categories.map(([id, name]) => ({ category_id: String(id), category_name: name, parent_id: 0 })));
    }
    case 'get_live_streams': {
      const { index } = await loadIndex(origin);
      const wanted = params.get('category_id');
      const rows = wanted
        ? index.streams.filter((row) =>
            byCountry ? String(row[R.COUNTRY_CAT]) === wanted : row[R.CATS].some((id) => String(id) === wanted),
          )
        : index.streams;
      return json(rows.map((row, i) => liveStream(row, byCountry, i + 1)));
    }
    case 'get_vod_categories':
    case 'get_series_categories': {
      const data = await loadVod(origin);
      const list = data ? (action === 'get_vod_categories' ? data.vod.categories.movies : data.vod.categories.series) : [];
      return json(list.map(([id, name]) => ({ category_id: String(id), category_name: name, parent_id: 0 })));
    }
    case 'get_vod_streams': {
      const data = await loadVod(origin);
      if (!data) return json([]);
      const wanted = params.get('category_id');
      const rows = wanted ? data.vod.movies.filter((m) => m[M.CATS].some((id) => String(id) === wanted)) : data.vod.movies;
      return json(
        rows.map((movie, i) => ({
          num: i + 1,
          name: movie[M.YEAR] ? `${movie[M.TITLE]} (${movie[M.YEAR]})` : movie[M.TITLE],
          stream_type: 'movie',
          stream_id: movie[M.ID],
          stream_icon: movie[M.POSTER],
          rating: '',
          rating_5based: 0,
          added: '0',
          is_adult: '0',
          category_id: String(movie[M.CATS][0] ?? ''),
          category_ids: movie[M.CATS],
          container_extension: extension(movie[M.URL]),
          custom_sid: '',
          direct_source: '',
        })),
      );
    }
    case 'get_vod_info': {
      const data = await loadVod(origin);
      const movie = data?.movies.get(Number(params.get('vod_id')));
      if (!movie) return json({ info: {}, movie_data: {} });
      return json({
        info: {
          name: movie[M.TITLE],
          o_name: movie[M.TITLE],
          cover_big: movie[M.POSTER],
          movie_image: movie[M.POSTER],
          releasedate: movie[M.YEAR] ? String(movie[M.YEAR]) : '',
          plot: `${movie[M.PLOT]}${movie[M.PLOT] ? '\n\n' : ''}${movie[M.LICENSE]} · Internet Archive`,
          duration_secs: movie[M.RUNTIME] ?? 0,
          duration: minutes(movie[M.RUNTIME]),
          genre: movie[M.CATS].map((id) => data.vod.categories.movies.find(([c]) => c === id)?.[1]).filter(Boolean).join(', '),
        },
        movie_data: {
          stream_id: movie[M.ID],
          name: movie[M.TITLE],
          added: '0',
          category_id: String(movie[M.CATS][0] ?? ''),
          container_extension: extension(movie[M.URL]),
          custom_sid: '',
          direct_source: '',
        },
      });
    }
    case 'get_series': {
      const data = await loadVod(origin);
      if (!data) return json([]);
      const wanted = params.get('category_id');
      const rows = wanted ? data.vod.series.filter((s) => s.categories.some((id) => String(id) === wanted)) : data.vod.series;
      return json(
        rows.map((show, i) => ({
          num: i + 1,
          name: show.title,
          series_id: show.number,
          cover: show.poster,
          plot: show.description,
          cast: '',
          director: '',
          genre: show.categories.map((id) => data.vod.categories.series.find(([c]) => c === id)?.[1]).filter(Boolean).join(', '),
          releaseDate: show.year ? String(show.year) : '',
          last_modified: '0',
          rating: '0',
          rating_5based: 0,
          backdrop_path: [],
          youtube_trailer: '',
          episode_run_time: '',
          category_id: String(show.categories[0] ?? ''),
          category_ids: show.categories,
        })),
      );
    }
    case 'get_series_info': {
      const data = await loadVod(origin);
      const show = data?.series.get(Number(params.get('series_id')));
      if (!show) return json({ seasons: [], info: {}, episodes: {} });
      return json({
        seasons: [{ season_number: 1, name: 'Season 1', episode_count: show.episodes.length, cover: show.poster, cover_big: show.poster }],
        info: {
          name: show.title,
          cover: show.poster,
          plot: `${show.description}${show.description ? '\n\n' : ''}${show.license} · Internet Archive`,
          genre: show.categories.map((id) => data.vod.categories.series.find(([c]) => c === id)?.[1]).filter(Boolean).join(', '),
          releaseDate: show.year ? String(show.year) : '',
          category_id: String(show.categories[0] ?? ''),
        },
        episodes: {
          1: show.episodes.map(([number, episode, title, url, runtime]) => ({
            id: String(number),
            episode_num: episode,
            title,
            container_extension: extension(url),
            info: { duration_secs: runtime ?? 0, duration: minutes(runtime), movie_image: show.poster },
            season: 1,
            custom_sid: '',
            added: '0',
            direct_source: '',
          })),
        },
      });
    }
    case 'get_short_epg':
      return shortEpg(params, env, false);
    case 'get_simple_data_table':
      return shortEpg(params, env, true);
    default:
      return json([]);
  }
}

// --------------------------------------------------------------------- MCP

const MCP_TOOLS = [
  {
    name: 'search_channels',
    description:
      'Search free-to-air TV channels. Filter by name, ISO country code (tr, de, us…), category (news, sports, kids, music, movies…) and language (ISO 639-3: tur, eng, deu…). Returns channel numbers, ids and smart play links.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Part of the channel name' },
        country: { type: 'string', description: 'ISO 3166-1 alpha-2 code, e.g. tr' },
        category: { type: 'string' },
        language: { type: 'string', description: 'ISO 639-3 code, e.g. eng' },
        working_only: { type: 'boolean', description: 'Only channels that worked on the last check' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    },
  },
  {
    name: 'get_channel',
    description: 'Details of one channel by id (e.g. TRT1.tr) or channel number: streams with health, website, languages.',
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string', description: 'Channel id or number' } },
      required: ['channel'],
    },
  },
  {
    name: 'whats_on',
    description: "The programme guide for a channel: what is on now and what's next.",
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel id or number' },
        hours: { type: 'number', default: 6, description: 'How far ahead to look' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'search_films',
    description: 'Search free films and series that are in the public domain or under Creative Commons (Internet Archive). Returns titles, years, licence and a playable link.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Part of the title' },
        kind: { type: 'string', enum: ['film', 'series', 'any'], default: 'any' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
    },
  },
  {
    name: 'build_playlist',
    description: 'Make an M3U playlist URL for any combination of countries, categories and languages, for use in VLC, Kodi, TiviMate, Jellyfin…',
    inputSchema: {
      type: 'object',
      properties: {
        countries: { type: 'array', items: { type: 'string' } },
        categories: { type: 'array', items: { type: 'string' } },
        languages: { type: 'array', items: { type: 'string' } },
        working_only: { type: 'boolean' },
      },
    },
  },
];

async function resolveChannel(arg, origin) {
  const { byId, byEpg } = await loadIndex(origin);
  const value = String(arg ?? '').trim();
  return /^\d+$/.test(value) ? byId.get(Number(value)) : byEpg.get(value.toLowerCase());
}

async function callTool(name, args, env, base) {
  const origin = env.NEXUS_ORIGIN || DEFAULT_ORIGIN;
  switch (name) {
    case 'search_channels': {
      const { index } = await loadIndex(origin);
      const params = new URLSearchParams();
      if (args.country) params.set('country', args.country);
      if (args.category) params.set('category', args.category);
      if (args.language) params.set('language', args.language);
      if (args.working_only) params.set('online', '1');
      if (args.query) params.set('q', args.query);
      const rows = filterRows(index.streams, parseFilters(params));
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      return {
        total: rows.length,
        channels: rows.slice(0, limit).map((row) => ({
          number: row[R.ID],
          id: row[R.EPG],
          name: row[R.NAME],
          country: row[R.COUNTRY],
          categories: list(row[R.CATEGORIES]),
          languages: list(row[R.LANGUAGES]),
          working: row[R.STATE] === 2,
          quality: row[R.QUALITY] || null,
          play: `${base}/play/${row[R.ID]}.m3u8`,
          page: `${origin}/?channel=${encodeURIComponent(row[R.EPG])}`,
        })),
      };
    }
    case 'get_channel': {
      const row = await resolveChannel(args.channel, origin);
      if (!row) return { error: `No channel "${args.channel}"` };
      const response = await fetch(`${origin}/api/v1/channels/${encodeURIComponent(row[R.EPG])}.json`, {
        cf: { cacheTtl: 900 },
      });
      const detail = response.ok ? await response.json() : null;
      return {
        number: row[R.ID],
        id: row[R.EPG],
        name: row[R.NAME],
        country: row[R.COUNTRY],
        website: detail?.website ?? null,
        availability: detail?.availability ?? null,
        play: `${base}/play/${row[R.ID]}.m3u8`,
        streams: (detail?.streams ?? []).slice(0, 5).map((s) => ({
          url: s.url,
          quality: s.quality,
          status: s.health?.status ?? 'unchecked',
          uptime: s.health?.uptime ?? null,
          needs_headers: Boolean(s.referrer || s.user_agent),
        })),
      };
    }
    case 'whats_on': {
      const row = await resolveChannel(args.channel, origin);
      if (!row) return { error: `No channel "${args.channel}"` };
      const now = Date.now();
      const until = now + (Number(args.hours) || 6) * 3600_000;
      const programmes = (await schedule(origin, row[R.EPG])).filter(
        (p) => Date.parse(p.stop) > now && Date.parse(p.start) < until,
      );
      return {
        channel: row[R.NAME],
        now: programmes.find((p) => Date.parse(p.start) <= now) ?? null,
        upcoming: programmes.filter((p) => Date.parse(p.start) > now),
        note: programmes.length === 0 ? 'No guide data for this channel.' : undefined,
      };
    }
    case 'search_films': {
      const data = await loadVod(origin);
      if (!data) return { total: 0, results: [], note: 'No film catalogue is published yet.' };
      const query = String(args.query ?? '').toLowerCase();
      const kind = args.kind ?? 'any';
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
      const films = kind === 'series' ? [] : data.vod.movies.filter((m) => m[M.TITLE].toLowerCase().includes(query));
      const shows = kind === 'film' ? [] : data.vod.series.filter((s) => s.title.toLowerCase().includes(query));
      const results = [
        ...films.map((m) => ({ type: 'film', title: m[M.TITLE], year: m[M.YEAR], licence: m[M.LICENSE], minutes: m[M.RUNTIME] ? Math.round(m[M.RUNTIME] / 60) : null, play: m[M.URL] })),
        ...shows.map((s) => ({ type: 'series', title: s.title, year: s.year, licence: s.license, episodes: s.episodes.length, first_episode: s.episodes[0]?.[3] })),
      ];
      return { total: results.length, results: results.slice(0, limit) };
    }
    case 'build_playlist': {
      const params = new URLSearchParams();
      for (const [key, value] of [['country', args.countries], ['category', args.categories], ['language', args.languages]]) {
        if (Array.isArray(value) && value.length > 0) params.set(key, value.join(','));
      }
      if (args.working_only) params.set('online', '1');
      const query = params.toString();
      return { url: `${base}/m3u${query ? `?${query}` : ''}` };
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

/** Streamable-HTTP MCP, stateless: every POST carries one JSON-RPC message or a batch. */
async function mcp(request, env, url) {
  if (request.method !== 'POST') {
    return text('MCP endpoint. POST JSON-RPC 2.0 here, e.g. from an MCP client configured with this URL.', 405);
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  const handle = async (message) => {
    const { id, method, params = {} } = message ?? {};
    if (id === undefined || id === null) return null; // notification
    try {
      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: params.protocolVersion ?? '2025-06-18',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'iptv-nexus', version: VERSION },
              instructions:
                'Free-to-air TV catalogue with live stream health and programme guides. Use search_channels to find channels, whats_on for the guide, build_playlist for an M3U URL.',
            },
          };
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
        case 'tools/call': {
          const result = await callTool(params.name, params.arguments ?? {}, env, url.origin);
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: Boolean(result?.error) },
          };
        }
        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    } catch (error) {
      return { jsonrpc: '2.0', id, error: { code: error.code ?? -32603, message: String(error.message ?? error) } };
    }
  };

  if (Array.isArray(payload)) {
    const responses = (await Promise.all(payload.map(handle))).filter(Boolean);
    return responses.length > 0 ? json(responses, 200, { 'cache-control': 'no-store' }) : new Response(null, { status: 202, headers: CORS });
  }
  const response = await handle(payload);
  return response ? json(response, 200, { 'cache-control': 'no-store' }) : new Response(null, { status: 202, headers: CORS });
}

// ----------------------------------------------------------------- routing

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = env.NEXUS_ORIGIN || DEFAULT_ORIGIN;
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      if (path === '/mcp') return await mcp(request, env, url);

      const smart = path.match(/^\/play\/(\d+)(?:\.\w+)?$/);
      if (smart) return await play(smart[1], env, ctx, request);

      const check = path.match(/^\/check\/(\d+)$/);
      if (check) return await checkHere(check[1], request, env, ctx);

      if (path === '/report') return await playbackReport(request, env, ctx);

      if (path === '/regional.json') return await regionalSummary(env, ctx);

      if (path === '/m3u' || path === '/playlist.m3u') return await buildPlaylist(url, env);

      if (path === '/player_api.php' || path === '/panel_api.php') return await playerApi(url, env);

      if (path === '/xmltv.php') return redirect(`${origin}/epg/guide.xml.gz`);

      if (path === '/get.php') {
        if (!authorised(env, url.searchParams.get('password') ?? '')) return text('Invalid password', 401);
        return await buildPlaylist(url, env);
      }

      // /movie/<user>/<pass>/<id>.<ext> and /series/<user>/<pass>/<episode id>.<ext>
      const vodPath = path.match(/^\/(movie|series)\/([^/]+)\/([^/]+)\/(\d+)(?:\.\w+)?$/);
      if (vodPath) {
        if (!authorised(env, decodeURIComponent(vodPath[3]))) return text('Invalid password', 401);
        const data = await loadVod(origin);
        const id = Number(vodPath[4]);
        const target = vodPath[1] === 'movie' ? data?.movies.get(id)?.[M.URL] : data?.episodes.get(id)?.episode[3];
        return target ? redirect(target) : text('Unknown title', 404);
      }

      // /live/<user>/<pass>/<id>.<ext>  and the short form /<user>/<pass>/<id>
      const live = path.match(/^\/(?:live\/)?([^/]+)\/([^/]+)\/(\d+)(?:\.\w+)?$/);
      if (live) {
        if (!authorised(env, decodeURIComponent(live[2]))) return text('Invalid password', 401);
        return await play(live[3], env, ctx, request);
      }

      if (path === '/' || path === '') {
        return text(
          [
            `IPTV Nexus Worker ${VERSION}`,
            '',
            `Playlist builder  ${url.origin}/m3u?country=tr&online=1`,
            `Smart link        ${url.origin}/play/<channel number>`,
            `Xtream login      server ${url.origin}, any username (or "country"), password ${env.XTREAM_PASSWORD ? 'from the owner' : 'anything'}`,
            `MCP endpoint      ${url.origin}/mcp`,
            `Check a channel   ${url.origin}/check/<channel number>`,
            `Regional data     ${url.origin}/regional.json${env.DB ? '' : ' (disabled: no D1 binding)'}`,
            '',
            `Catalogue         ${origin}`,
          ].join('\n') + '\n',
        );
      }

      return text('Not found', 404);
    } catch (error) {
      return json({ error: String(error?.message ?? error) }, 502);
    }
  },
};
