/**
 * IPTV Nexus — Xtream Codes compatible API, as a Cloudflare Worker.
 *
 * Lets apps that only accept an Xtream login (TiviMate, IPTV Smarters,
 * XCIPTV, many TV boxes) use the Nexus catalogue:
 *
 *   Server    https://<your-worker>.workers.dev
 *   Username  anything — or `country` to group channels by country
 *   Password  anything, unless XTREAM_PASSWORD is set
 *
 * It holds no data of its own. Everything comes from `xtream/index.json`,
 * which the Sync workflow rebuilds and publishes to GitHub Pages; the Worker
 * reshapes it into Xtream responses and redirects stream requests to the
 * upstream URL. No video passes through the Worker.
 *
 * Environment (wrangler.toml [vars] or dashboard):
 *   NEXUS_ORIGIN     Pages site, default https://dearbulut.github.io/iptv
 *   XTREAM_PASSWORD  optional; when set, logins must use this password
 */

const DEFAULT_ORIGIN = 'https://dearbulut.github.io/iptv';
/** How long an isolate reuses the index before refetching it. */
const INDEX_TTL_MS = 10 * 60 * 1000;

let cached = null; // { origin, at, index, byId }

async function loadIndex(origin) {
  if (cached && cached.origin === origin && Date.now() - cached.at < INDEX_TTL_MS) return cached;
  const response = await fetch(`${origin}/xtream/index.json`, { cf: { cacheTtl: 600, cacheEverything: true } });
  if (!response.ok) throw new Error(`index.json: HTTP ${response.status}`);
  const index = await response.json();
  const byId = new Map(index.streams.map((row) => [row[0], row]));
  cached = { origin, at: Date.now(), index, byId };
  return cached;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  });

const redirect = (url) =>
  new Response(null, { status: 302, headers: { location: url, 'cache-control': 'no-store' } });

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

/** Row: [stream_id, name, icon, epg_id, category ids, country category id, url]. */
function liveStream(row, byCountry, position) {
  const categoryIds = byCountry ? [row[5]] : row[4];
  return {
    num: position,
    name: row[1],
    stream_type: 'live',
    stream_id: row[0],
    stream_icon: row[2],
    epg_channel_id: row[3],
    added: '0',
    is_adult: '0',
    category_id: String(categoryIds[0]),
    category_ids: categoryIds,
    custom_sid: '',
    tv_archive: 0,
    direct_source: row[6],
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
      const list = byCountry ? index.categories.country : index.categories.category;
      return json(list.map(([id, name]) => ({ category_id: String(id), category_name: name, parent_id: 0 })));
    }
    case 'get_live_streams': {
      const { index } = await loadIndex(origin);
      const wanted = params.get('category_id');
      const rows = wanted
        ? index.streams.filter((row) =>
            byCountry ? String(row[5]) === wanted : row[4].some((id) => String(id) === wanted),
          )
        : index.streams;
      return json(rows.map((row, i) => liveStream(row, byCountry, i + 1)));
    }
    case 'get_short_epg':
    case 'get_simple_data_table':
      // Guides come from xmltv.php; per-channel EPG would need the full guide
      // parsed in the Worker, which is beyond its memory budget.
      return json({ epg_listings: [] });
    case 'get_vod_categories':
    case 'get_vod_streams':
    case 'get_series_categories':
    case 'get_series':
      return json([]);
    default:
      return json([]);
  }
}

async function streamRedirect(id, env) {
  const { byId } = await loadIndex(env.NEXUS_ORIGIN || DEFAULT_ORIGIN);
  const row = byId.get(Number(id));
  return row ? redirect(row[6]) : new Response('Unknown stream', { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = env.NEXUS_ORIGIN || DEFAULT_ORIGIN;
    const path = url.pathname;

    try {
      if (path === '/player_api.php' || path === '/panel_api.php') return await playerApi(url, env);

      if (path === '/xmltv.php') return redirect(`${origin}/epg/guide.xml.gz`);

      if (path === '/get.php') {
        if (!authorised(env, url.searchParams.get('password') ?? '')) {
          return new Response('Invalid password', { status: 401 });
        }
        return redirect(`${origin}/playlists/best.m3u`);
      }

      // /live/<user>/<pass>/<id>.<ext>  and the short form /<user>/<pass>/<id>
      const live = path.match(/^\/(?:live\/)?([^/]+)\/([^/]+)\/(\d+)(?:\.\w+)?$/);
      if (live) {
        if (!authorised(env, decodeURIComponent(live[2]))) {
          return new Response('Invalid password', { status: 401 });
        }
        return await streamRedirect(live[3], env);
      }

      if (path === '/' || path === '') {
        return new Response(
          'IPTV Nexus — Xtream Codes compatible API.\n\n' +
            `Server:   ${url.origin}\nUsername: anything (or "country" to group by country)\n` +
            `Password: ${env.XTREAM_PASSWORD ? 'ask the owner' : 'anything'}\n\nCatalogue: ${origin}\n`,
          { headers: { 'content-type': 'text/plain; charset=utf-8' } },
        );
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      return json({ error: String(error?.message ?? error) }, 502);
    }
  },
};
