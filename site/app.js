/**
 * IPTV Nexus web client.
 *
 * Loads the compact search index once (~a few MB gzipped for 40k channels),
 * filters entirely in the browser, and fetches per-channel detail documents
 * lazily when a channel is opened. No framework, no build step.
 */

const API = 'api/v1';

const state = {
  channels: [],
  filtered: [],
  countries: new Map(),
  categories: new Map(),
  languages: new Map(),
  manifest: null,
  favourites: loadFavourites(),
  rendered: 0,
  pageSize: 60,
  query: '',
  // `playable` defaults on: roughly three quarters of the catalogue is
  // metadata for channels with no stream at all, and showing those by
  // default promises far more than the site can actually play.
  filters: { country: '', category: '', language: '', playable: true, online: false, hd: false, browser: false, favourites: false },
  sort: 'relevance',
  detailCache: new Map(),
  epgCache: new Map(),
  current: null,
  hls: null,
};

// Field positions in a search-index row — must match src/api/search-index.ts.
const F = {
  ID: 0,
  NAME: 1,
  SEARCH: 2,
  COUNTRY: 3,
  CATEGORIES: 4,
  LANGUAGES: 5,
  LOGO: 6,
  SCORE: 7,
  ONLINE: 8,
  STREAMS: 9,
  QUALITY: 10,
  // Appended later — older indexes simply lack them.
  BROWSER: 11,
  AVAIL: 12,
  NUMBER: 13,
};

const $ = (selector) => document.querySelector(selector);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// ---------------------------------------------------------------- storage

function loadFavourites() {
  try {
    return new Set(JSON.parse(localStorage.getItem('nexus:favourites') ?? '[]'));
  } catch {
    return new Set();
  }
}

function saveFavourites() {
  try {
    localStorage.setItem('nexus:favourites', JSON.stringify([...state.favourites]));
  } catch {
    /* private mode — favourites stay in memory for this session */
  }
}

function loadTheme() {
  try {
    const stored = localStorage.getItem('nexus:theme');
    if (stored) document.documentElement.dataset.theme = stored;
    else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      document.documentElement.dataset.theme = 'light';
    }
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- helpers

/** Same normalisation the index build uses, so queries match the blob. */
function normalise(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[ıİ]/g, 'i')
    .replace(/[ğ]/g, 'g')
    .replace(/[şç]/g, (c) => (c === 'ş' ? 's' : 'c'))
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function scoreClass(score, online) {
  if (online) return 'good';
  if (score >= 60) return 'good';
  if (score >= 25) return 'warn';
  if (score > 0) return 'bad';
  return 'unknown';
}

function initials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function formatTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '--:--'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function getJson(path) {
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  return response.json();
}

// ---------------------------------------------------------------- boot

async function boot() {
  loadTheme();
  wireEvents();

  try {
    const [index, manifest] = await Promise.all([
      getJson(`${API}/search.json`),
      getJson(`${API}/index.json`).catch(() => null),
    ]);

    state.channels = index.channels ?? [];
    state.manifest = manifest;
    renderBrandMeta();

    // Facets are small; failing to load them just leaves the selects empty.
    const [countries, categories, languages] = await Promise.all([
      getJson(`${API}/countries.json`).catch(() => []),
      getJson(`${API}/categories.json`).catch(() => []),
      getJson(`${API}/languages.json`).catch(() => []),
    ]);

    const facetLabel = (item) =>
      `${item.name} (${formatNumber(item.playable ?? item.channels ?? 0)})`;
    fillSelect($('#filter-country'), countries, 'code', (item) =>
      `${item.flag ? `${item.flag} ` : ''}${facetLabel(item)}`,
    );
    fillSelect($('#filter-category'), categories, 'id', facetLabel);
    fillSelect($('#filter-language'), languages, 'code', facetLabel);

    for (const country of countries) state.countries.set(country.code.toLowerCase(), country);
    for (const category of categories) state.categories.set(category.id, category);
    for (const language of languages) state.languages.set(language.code, language);

    // Deep link to a channel (`?channel=TRT1.tr`), used by the Stremio links
    // back to this site. Read it first: applyFilters rewrites the URL.
    const deepLink = new URLSearchParams(location.search).get('channel');

    readUrlState();
    applyFilters();
    renderStats();
    if (deepLink) openChannel(deepLink);
  } catch (error) {
    $('#result-count').textContent =
      'Could not load the channel index. If you are opening this file directly, serve it over HTTP instead.';
    console.error(error);
  }
}

function fillSelect(select, items, valueKey, labelOf) {
  if (!Array.isArray(items) || items.length === 0) return;
  const fragment = document.createDocumentFragment();
  // Counts shown to the user are playable counts — an option reading "(417)"
  // that yields 232 results once the default filter applies is just wrong.
  for (const item of [...items].sort((a, b) => (b.playable ?? 0) - (a.playable ?? 0))) {
    if ((item.playable ?? item.channels ?? 0) === 0) continue;
    const option = el('option', null, labelOf(item));
    option.value = String(item[valueKey]).toLowerCase();
    fragment.append(option);
  }
  select.append(fragment);
}

function renderBrandMeta() {
  if (!state.manifest) {
    $('#brand-meta').textContent = `${formatNumber(state.channels.length)} channels`;
    return;
  }
  const { counts, generated_at: generatedAt } = state.manifest;
  // Lead with what is actually watchable. `channels` counts every database
  // entry, most of which have no stream attached.
  const playable = counts.playable_channels ?? counts.channels;
  $('#brand-meta').textContent =
    `${formatNumber(playable)} playable · ${formatNumber(counts.online_streams)} live` +
    ` · ${formatNumber(counts.channels)} indexed`;
  $('#footer-meta').textContent =
    `Last updated ${new Date(generatedAt).toLocaleString()} · ` +
    `${formatNumber(counts.streams)} streams · ${formatNumber(counts.epg_programmes)} EPG entries · ` +
    `data from ${state.manifest.upstream?.source ?? 'upstream'}`;
}

function renderStats() {
  const withStream = state.channels.filter((row) => row[F.STREAMS] > 0);
  const online = state.channels.filter((row) => row[F.ONLINE] === 1).length;
  const hd = withStream.filter((row) => parseInt(row[F.QUALITY], 10) >= 720).length;
  $('#stats').innerHTML = '';
  const rows = [
    ['With a stream', formatNumber(withStream.length)],
    ['Working now', formatNumber(online)],
    ['HD or better', formatNumber(hd)],
    ['Indexed total', formatNumber(state.channels.length)],
    ['Favourites', formatNumber(state.favourites.size)],
  ];
  for (const [label, value] of rows) {
    const line = el('div');
    line.append(`${label}: `, el('b', null, value));
    $('#stats').append(line);
  }
}

// ---------------------------------------------------------------- filtering

function applyFilters(resetScroll = true) {
  const query = normalise(state.query);
  const { country, category, language, playable, online, hd, browser, favourites } = state.filters;

  let rows = state.channels;

  if (playable) rows = rows.filter((row) => row[F.STREAMS] > 0);
  if (favourites) rows = rows.filter((row) => state.favourites.has(row[F.ID]));
  if (online) rows = rows.filter((row) => row[F.ONLINE] === 1);
  if (hd) rows = rows.filter((row) => parseInt(row[F.QUALITY], 10) >= 720);
  if (browser) rows = rows.filter((row) => row[F.BROWSER] === 1);
  if (country) rows = rows.filter((row) => row[F.COUNTRY].toLowerCase() === country);
  if (category) {
    rows = rows.filter((row) => row[F.CATEGORIES].toLowerCase().split(';').includes(category));
  }
  if (language) {
    rows = rows.filter((row) => row[F.LANGUAGES].toLowerCase().split(';').includes(language));
  }

  if (query) {
    // Prefix hits rank above substring hits; both beat non-matches.
    const scored = [];
    for (const row of rows) {
      const haystack = row[F.SEARCH];
      const at = haystack.indexOf(query);
      if (at === -1) continue;
      scored.push([row, at === 0 ? 2 : 1]);
    }
    scored.sort((a, b) => {
      if (a[1] !== b[1]) return b[1] - a[1];
      if (state.sort === 'relevance') return b[0][F.SCORE] - a[0][F.SCORE];
      return 0;
    });
    rows = scored.map((entry) => entry[0]);
  }

  if (state.sort === 'name') {
    rows = [...rows].sort((a, b) => a[F.NAME].localeCompare(b[F.NAME]));
  } else if (state.sort === 'score') {
    rows = [...rows].sort((a, b) => b[F.SCORE] - a[F.SCORE] || a[F.NAME].localeCompare(b[F.NAME]));
  } else if (state.sort === 'quality') {
    rows = [...rows].sort(
      (a, b) =>
        (parseInt(b[F.QUALITY], 10) || 0) - (parseInt(a[F.QUALITY], 10) || 0) ||
        b[F.SCORE] - a[F.SCORE],
    );
  }

  state.filtered = rows;
  state.rendered = 0;
  $('#results').innerHTML = '';
  if (resetScroll) window.scrollTo({ top: 0, behavior: 'auto' });

  const label = `${formatNumber(rows.length)} channel${rows.length === 1 ? '' : 's'}`;
  $('#result-count').textContent = state.filters.playable
    ? `${label} with a stream`
    : label;
  $('#empty').hidden = rows.length > 0;

  renderChips();
  renderMore();
  writeUrlState();
}

function renderChips() {
  const container = $('#active-chips');
  container.innerHTML = '';
  const active = [];

  if (state.filters.country) {
    active.push(['country', state.countries.get(state.filters.country)?.name ?? state.filters.country]);
  }
  if (state.filters.category) {
    active.push(['category', state.categories.get(state.filters.category)?.name ?? state.filters.category]);
  }
  if (state.filters.language) {
    active.push(['language', state.languages.get(state.filters.language)?.name ?? state.filters.language]);
  }
  if (state.filters.playable) active.push(['playable', 'Has a stream']);
  if (state.filters.online) active.push(['online', 'Working only']);
  if (state.filters.hd) active.push(['hd', 'HD+']);
  if (state.filters.browser) active.push(['browser', 'Plays in browser']);
  if (state.filters.favourites) active.push(['favourites', 'Favourites']);

  for (const [key, label] of active) {
    const chip = el('button', 'chip', label);
    chip.type = 'button';
    chip.addEventListener('click', () => clearFilter(key));
    container.append(chip);
  }

  const count = $('#filter-count');
  count.textContent = String(active.length);
  count.hidden = active.length === 0;
}

function clearFilter(key) {
  if (['playable', 'online', 'hd', 'browser', 'favourites'].includes(key)) {
    state.filters[key] = false;
    $(`#filter-${key === 'favourites' ? 'favorites' : key}`).checked = false;
  } else {
    state.filters[key] = '';
    $(`#filter-${key}`).value = '';
  }
  applyFilters();
}

function resetFilters() {
  state.filters = { country: '', category: '', language: '', playable: true, online: false, hd: false, browser: false, favourites: false };
  state.query = '';
  $('#search').value = '';
  for (const id of ['country', 'category', 'language']) $(`#filter-${id}`).value = '';
  for (const id of ['online', 'hd', 'browser', 'favorites']) $(`#filter-${id}`).checked = false;
  $('#filter-playable').checked = true;
  applyFilters();
}

// ---------------------------------------------------------------- rendering

function renderMore() {
  const slice = state.filtered.slice(state.rendered, state.rendered + state.pageSize);
  if (slice.length === 0) return;

  const fragment = document.createDocumentFragment();
  for (const row of slice) fragment.append(renderCard(row));
  $('#results').append(fragment);
  state.rendered += slice.length;
}

function renderCard(row) {
  const card = el('button', 'card');
  card.type = 'button';
  card.dataset.id = row[F.ID];
  card.setAttribute('aria-label', `Open ${row[F.NAME]}`);

  const top = el('div', 'card__top');

  if (row[F.LOGO]) {
    const logo = el('img', 'card__logo');
    logo.src = row[F.LOGO];
    logo.alt = '';
    logo.loading = 'lazy';
    logo.decoding = 'async';
    logo.addEventListener('error', () => logo.replaceWith(fallbackLogo(row[F.NAME])), { once: true });
    top.append(logo);
  } else {
    top.append(fallbackLogo(row[F.NAME]));
  }

  const titles = el('div');
  titles.append(el('div', 'card__name', row[F.NAME]));

  const country = state.countries.get(row[F.COUNTRY].toLowerCase());
  const subtitle = [
    row[F.NUMBER] ? `#${row[F.NUMBER]}` : null,
    country ? `${country.flag ?? ''} ${country.name}` : row[F.COUNTRY],
    row[F.CATEGORIES].split(';')[0],
  ]
    .filter(Boolean)
    .join(' · ');
  titles.append(el('div', 'card__sub', subtitle));
  top.append(titles);
  card.append(top);

  const tags = el('div', 'card__tags');

  if (row[F.STREAMS] === 0) {
    // No stream at all: the channel exists in the database but there is
    // nothing to play, which is a different thing from "not yet checked".
    tags.append(el('span', 'dot dot--unknown'));
    tags.append(el('span', 'tag', 'No stream'));
    card.append(tags);
    card.addEventListener('click', () => openChannel(row[F.ID]));
    return card;
  }

  // Geo-blocked from our scanner is not the same as broken: the stream may
  // well play where the viewer is.
  const regional = row[F.ONLINE] !== 1 && row[F.AVAIL] === 'regional';
  const status = regional ? 'warn' : scoreClass(row[F.SCORE], row[F.ONLINE] === 1);
  tags.append(el('span', `dot dot--${status}`));
  const statusTag = el(
    'span',
    `tag tag--${status === 'unknown' ? '' : status}`.trim(),
    row[F.ONLINE] === 1
      ? 'Live'
      : regional
        ? 'Regional'
        : row[F.SCORE] > 0
          ? `${Math.round(row[F.SCORE])}%`
          : 'Unchecked',
  );
  if (regional) statusTag.title = 'Refused our scanner with a geo-block — may work in your country';
  tags.append(statusTag);
  if (row[F.QUALITY]) {
    tags.append(el('span', `tag${parseInt(row[F.QUALITY], 10) >= 720 ? ' tag--hd' : ''}`, row[F.QUALITY]));
  }
  if (row[F.STREAMS] > 1) tags.append(el('span', 'tag', `${row[F.STREAMS]} streams`));
  if (row[F.BROWSER] === 0) {
    const vlc = el('span', 'tag', 'VLC');
    vlc.title = 'No stream for this channel plays in a browser — use VLC, Kodi or TiviMate';
    tags.append(vlc);
  }
  if (state.favourites.has(row[F.ID])) tags.append(el('span', 'tag', '★'));
  card.append(tags);

  card.addEventListener('click', () => openChannel(row[F.ID]));
  return card;
}

function fallbackLogo(name) {
  return el('div', 'card__logo card__logo--fallback', initials(name));
}

// ---------------------------------------------------------------- player

async function openChannel(id) {
  const panel = $('#player');
  panel.hidden = false;
  document.body.style.overflow = 'hidden';

  $('#player-title').textContent = 'Loading…';
  $('#player-sub').textContent = '';
  $('#player-streams').innerHTML = '';
  $('#player-epg').innerHTML = '';
  $('#player-meta').innerHTML = '';

  let channel = state.detailCache.get(id);
  if (!channel) {
    try {
      channel = await getJson(`${API}/channels/${encodeURIComponent(id)}.json`);
      state.detailCache.set(id, channel);
    } catch {
      $('#player-title').textContent = 'Channel unavailable';
      $('#player-sub').textContent = 'The detail document could not be loaded.';
      return;
    }
  }

  state.current = channel;
  renderPlayerHeader(channel);
  renderStreamList(channel);
  renderEpg(channel);
  renderMeta(channel);
  renderRegional(channel);

  const streams = channel.streams ?? [];
  if (streams.length === 0) {
    renderActions(null);
    setStatus('No stream is currently listed for this channel.');
    return;
  }
  // Streams arrive best-first; play the best one a browser can actually open.
  // Older API documents lack the flag, so treat a missing flag as playable.
  const index = streams.findIndex((stream) => stream.browser_playable !== false);
  playStream(streams[index === -1 ? 0 : index], index === -1 ? 0 : index);
}

function renderPlayerHeader(channel) {
  const logo = $('#player-logo');
  if (channel.logo) {
    logo.src = channel.logo;
    logo.hidden = false;
  } else {
    logo.hidden = true;
  }

  $('#player-title').textContent = channel.name;
  const country = state.countries.get((channel.country ?? '').toLowerCase());
  $('#player-sub').textContent = [
    country ? `${country.flag ?? ''} ${country.name}` : channel.country,
    channel.categories?.join(', '),
    channel.stream_count ? `${channel.stream_count} stream${channel.stream_count === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const favourite = state.favourites.has(channel.id);
  const button = $('#player-fav');
  button.setAttribute('aria-pressed', String(favourite));
  button.onclick = () => {
    if (state.favourites.has(channel.id)) state.favourites.delete(channel.id);
    else state.favourites.add(channel.id);
    saveFavourites();
    button.setAttribute('aria-pressed', String(state.favourites.has(channel.id)));
    renderStats();
  };
}

function renderStreamList(channel) {
  const container = $('#player-streams');
  container.innerHTML = '';
  if (!channel.streams?.length) return;

  container.append(el('p', 'section-title', 'Streams'));

  channel.streams.forEach((stream, index) => {
    const button = el('button', 'stream-btn');
    button.type = 'button';
    const status = scoreClass(stream.health?.score ?? 0, stream.health?.status === 'online');
    button.append(el('span', `dot dot--${status}`));

    const quality = stream.quality ?? '—';
    const label = el('span', 'stream-btn__label', `${quality}${stream.title ? ` · ${stream.title}` : ''}`);
    button.append(label);

    if (stream.health?.latency_ms) {
      button.append(el('span', 'tag', `${stream.health.latency_ms}ms`));
    }
    if (stream.health?.uptime) {
      button.append(el('span', 'tag', `${stream.health.uptime}%`));
    }
    if (stream.health?.history) button.append(sparkline(stream.health.history, 48, 14));
    if (stream.browser_playable === false) {
      const vlc = el('span', 'tag', 'VLC');
      vlc.title = BLOCKER_TEXT[stream.browser_blocker] ?? BLOCKER_TEXT.format;
      button.append(vlc);
    }

    button.addEventListener('click', () => playStream(stream, index));
    container.append(button);
  });
}

async function renderEpg(channel) {
  const container = $('#player-epg');
  container.innerHTML = '';
  if (!channel.guides?.length) return;

  const country = (channel.country ?? 'int').toLowerCase();
  let programmes = state.epgCache.get(country);

  if (programmes === undefined) {
    try {
      const response = await fetch(`epg/${country}.xml`, { cache: 'no-cache' });
      if (!response.ok) throw new Error('no guide');
      programmes = parseGuide(await response.text());
    } catch {
      programmes = null;
    }
    state.epgCache.set(country, programmes);
  }

  if (!programmes) return;
  const list = (programmes.get(channel.id) ?? []).slice(0, 12);
  if (list.length === 0) return;

  container.append(el('p', 'section-title', "What's on"));
  const now = Date.now();

  for (const programme of list) {
    const start = new Date(programme.start).getTime();
    const stop = new Date(programme.stop).getTime();
    const isNow = now >= start && now < stop;

    const item = el('div', `epg-item${isNow ? ' epg-item--now' : ''}`);
    item.append(el('span', 'epg-item__time', formatTime(programme.start)));
    const body = el('div');
    body.append(el('div', 'epg-item__title', programme.title));
    if (programme.desc) body.append(el('div', 'epg-item__desc', programme.desc));
    item.append(body);
    container.append(item);
  }
}

/** Minimal XMLTV reader — the browser already has a parser, so use it. */
function parseGuide(xml) {
  const document_ = new DOMParser().parseFromString(xml, 'text/xml');
  if (document_.querySelector('parsererror')) return null;

  const byChannel = new Map();
  for (const node of document_.querySelectorAll('programme')) {
    const channel = node.getAttribute('channel');
    if (!channel) continue;
    const list = byChannel.get(channel) ?? [];
    list.push({
      start: xmltvDate(node.getAttribute('start')),
      stop: xmltvDate(node.getAttribute('stop')),
      title: node.querySelector('title')?.textContent ?? '',
      desc: node.querySelector('desc')?.textContent ?? '',
    });
    byChannel.set(channel, list);
  }

  const now = Date.now();
  for (const [channel, list] of byChannel) {
    byChannel.set(
      channel,
      list
        .filter((programme) => new Date(programme.stop).getTime() >= now)
        .sort((a, b) => a.start.localeCompare(b.start)),
    );
  }
  return byChannel;
}

function xmltvDate(value) {
  if (!value) return '';
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(value);
  if (!match) return '';
  const [, y, mo, d, h, mi, s = '00', offset = '+0000'] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${offset.slice(0, 3)}:${offset.slice(3)}`;
}

function renderMeta(channel) {
  const list = $('#player-meta');
  list.innerHTML = '';
  const stream = channel.streams?.[0];
  const rows = [
    ['Channel ID', channel.id],
    ['Country', channel.country],
    ['Languages', channel.languages?.join(', ') || '—'],
    ['Categories', channel.categories?.join(', ') || '—'],
    ['Website', channel.website || '—'],
    ['Health score', `${channel.score}/100`],
    ['Codec', stream?.health?.media?.video_codec ?? '—'],
    ['Bitrate', stream?.health?.media?.bitrate ? `${Math.round(stream.health.media.bitrate / 1000)} kbps` : '—'],
    ['Last checked', stream?.health?.checked_at ? new Date(stream.health.checked_at).toLocaleString() : '—'],
    ['API', `${API}/channels/${channel.id}.json`],
  ];
  for (const [term, description] of rows) {
    list.append(el('dt', null, term), el('dd', null, String(description)));
  }
}

function setStatus(message) {
  const overlay = $('#player-status');
  overlay.textContent = message ?? '';
  overlay.hidden = !message;
}

function playStream(stream, index) {
  const video = $('#video');
  destroyPlayer();

  document.querySelectorAll('.stream-btn').forEach((button, i) => {
    button.setAttribute('aria-current', String(i === index));
  });

  renderActions(stream);
  renderUptime(stream);

  if (stream.browser_playable === false) {
    setStatus(
      `${BLOCKER_TEXT[stream.browser_blocker] ?? BLOCKER_TEXT.format} ` +
        'Use “Copy URL” or “Open in player” below.',
    );
    return;
  }

  setStatus('Connecting…');

  const onReady = () => {
    setStatus(null);
    reportPlayback(state.current);
  };
  const onFail = (detail) =>
    setStatus(
      `This stream could not be played in the browser${detail ? ` (${detail})` : ''}. ` +
        'It may be geo-restricted, require custom headers, or be offline. ' +
        'Try another stream, or open the URL in VLC.',
    );

  const isHls = /\.m3u8(\?|$)/i.test(stream.url) || stream.url.includes('m3u8');

  if (isHls && window.Hls?.isSupported()) {
    const hls = new window.Hls({
      lowLatencyMode: true,
      backBufferLength: 30,
      manifestLoadingTimeOut: 15000,
      manifestLoadingMaxRetry: 2,
    });
    state.hls = hls;
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      onReady();
      video.play().catch(() => setStatus('Press play to start.'));
    });
    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      // Mixed content is the single most common failure on an HTTPS page.
      const mixed = location.protocol === 'https:' && stream.url.startsWith('http:');
      onFail(mixed ? 'insecure http stream on an https page' : data.details);
      destroyPlayer();
    });
    hls.loadSource(stream.url);
    hls.attachMedia(video);
    return;
  }

  video.src = stream.url;
  video.addEventListener('loadedmetadata', onReady, { once: true });
  video.addEventListener('error', () => onFail('playback error'), { once: true });
  video.play().catch(() => setStatus('Press play to start.'));
}

const BLOCKER_TEXT = {
  insecure: 'This stream uses plain http://, which browsers block on a secure page.',
  headers: 'This stream needs custom HTTP headers that a browser cannot send.',
  format: 'This stream’s format does not play in a browser.',
};

/** Tiny bar chart of check history: one bar per check, oldest first. */
function sparkline(history, width, height) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const samples = history.slice(-30);
  svg.setAttribute('viewBox', `0 0 ${samples.length} 1`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('class', 'spark');
  svg.setAttribute('role', 'img');
  const up = [...samples].filter((value) => value === '1').length;
  svg.setAttribute('aria-label', `${up} of ${samples.length} recent checks succeeded`);
  [...samples].forEach((value, i) => {
    const bar = document.createElementNS(ns, 'rect');
    bar.setAttribute('x', String(i + 0.1));
    bar.setAttribute('width', '0.8');
    bar.setAttribute('y', value === '1' ? '0' : '0.6');
    bar.setAttribute('height', value === '1' ? '1' : '0.4');
    bar.setAttribute('class', value === '1' ? 'spark__up' : 'spark__down');
    svg.append(bar);
  });
  return svg;
}

/** Uptime panel for the stream being played. */
function renderUptime(stream) {
  const container = $('#player-uptime');
  if (!container) return;
  container.innerHTML = '';
  const history = stream?.health?.history ?? '';
  if (!history) return;
  container.append(el('p', 'section-title', 'Availability'));
  const row = el('div', 'uptime');
  row.append(sparkline(history, 240, 28));
  const checks = Math.min(history.length, 30);
  row.append(
    el(
      'span',
      'muted',
      `${stream.health.uptime ?? 0}% up over the last ${checks} check${checks === 1 ? '' : 's'}` +
        (stream.health.last_online
          ? ` · last seen up ${new Date(stream.health.last_online).toLocaleString()}`
          : ''),
    ),
  );
  container.append(row);
}

// -------------------------------------------------------------- regional

const workerUrl = () => state.manifest?.endpoints?.worker ?? null;

/** 🇹🇷 from "TR". */
const flag = (code) =>
  /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '';

const reported = new Set();

/**
 * Tells the Worker this channel played here, so it counts towards "works in
 * <your country>". Successes only: a failure in a browser is usually CORS or
 * mixed content, not geography, and would read as a regional block. The Worker
 * sees the country from the request; nothing else is sent or stored.
 */
function reportPlayback(channel) {
  const base = workerUrl();
  if (!base || !channel?.number || reported.has(channel.number)) return;
  reported.add(channel.number);
  try {
    navigator.sendBeacon(`${base}/report`, JSON.stringify({ number: channel.number, ok: true }));
  } catch {
    /* reporting is best effort */
  }
}

function renderRegional(channel) {
  const container = $('#player-regional');
  if (!container) return;
  container.innerHTML = '';
  const entries = Object.entries(channel.regional ?? {}).sort(
    (a, b) => b[1].ok + b[1].fail - (a[1].ok + a[1].fail),
  );
  if (entries.length === 0 && !(workerUrl() && channel.number)) return;

  container.append(el('p', 'section-title', 'Where it works'));
  if (entries.length > 0) {
    const list = el('div', 'regional');
    for (const [country, { ok, fail, ratio }] of entries.slice(0, 16)) {
      const works = ratio >= 0.5;
      const chip = el('span', `regional__chip ${works ? 'regional__chip--ok' : 'regional__chip--fail'}`);
      chip.title = `${country}: worked in ${ok} of ${ok + fail} checks over the last two weeks`;
      chip.textContent = `${flag(country)} ${country} ${works ? '✓' : '✗'}`;
      list.append(chip);
    }
    container.append(list);
  } else {
    container.append(el('p', 'muted small', 'No regional data yet. It builds up as people watch.'));
  }

  if (workerUrl() && channel.number) {
    const result = el('p', 'muted small');
    const button = el('button', 'btn btn--ghost', 'Check from my location');
    button.addEventListener('click', async () => {
      button.disabled = true;
      result.textContent = 'Testing from the nearest location…';
      try {
        const response = await fetch(`${workerUrl()}/check/${channel.number}`);
        const data = await response.json();
        const working = data.streams.filter((stream) => stream.ok).length;
        result.textContent =
          `${data.country ? `${flag(data.country)} From ${data.country}` : 'From your location'}` +
          `${data.location ? ` (${data.location})` : ''}: ` +
          (data.works
            ? `works — ${working} of ${data.streams.length} stream${data.streams.length === 1 ? '' : 's'} answered.`
            : `none of the ${data.streams.length} stream${data.streams.length === 1 ? '' : 's'} answered.`);
      } catch {
        result.textContent = 'The check could not be run right now.';
      } finally {
        button.disabled = false;
      }
    });
    container.append(button, result);
  }
}

/** Copy / open-in-player actions, which work for every stream. */
function renderActions(stream) {
  const container = $('#player-actions');
  if (!container) return;
  container.innerHTML = '';
  if (!stream) return;

  const copy = el('button', 'btn', 'Copy URL');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(stream.url);
      copy.textContent = 'Copied';
    } catch {
      window.prompt('Copy this URL:', stream.url);
    }
    setTimeout(() => (copy.textContent = 'Copy URL'), 1500);
  });

  // A one-entry playlist opens in the default media player on every desktop
  // OS and carries the headers that VLC needs, which a bare URL cannot.
  const name = state.current?.name ?? 'stream';
  const lines = ['#EXTM3U', `#EXTINF:-1,${name}`];
  if (stream.user_agent) lines.push(`#EXTVLCOPT:http-user-agent=${stream.user_agent}`);
  if (stream.referrer) lines.push(`#EXTVLCOPT:http-referrer=${stream.referrer}`);
  lines.push(stream.url, '');
  const open = el('a', 'btn', 'Open in player');
  open.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'audio/x-mpegurl' }));
  open.download = `${name.replace(/[^\w.-]+/g, '_')}.m3u`;

  container.append(copy, open);
}

function destroyPlayer() {
  const video = $('#video');
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function closePlayer() {
  destroyPlayer();
  $('#player').hidden = true;
  document.body.style.overflow = '';
  state.current = null;
  setStatus(null);
}

// ---------------------------------------------------------------- url state

function writeUrlState() {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  for (const [key, value] of Object.entries(state.filters)) {
    if (key === 'playable') continue;
    if (value === true) params.set(key, '1');
    else if (value) params.set(key, value);
  }
  // On by default, so only the disabled state is worth putting in the URL.
  if (!state.filters.playable) params.set('all', '1');
  if (state.sort !== 'relevance') params.set('sort', state.sort);
  const next = params.toString();
  history.replaceState(null, '', next ? `?${next}` : location.pathname);
}

function readUrlState() {
  const params = new URLSearchParams(location.search);
  state.query = params.get('q') ?? '';
  $('#search').value = state.query;

  for (const key of ['country', 'category', 'language']) {
    const value = params.get(key);
    if (value) {
      state.filters[key] = value.toLowerCase();
      $(`#filter-${key}`).value = value.toLowerCase();
    }
  }
  for (const [key, id] of [['online', 'online'], ['hd', 'hd'], ['browser', 'browser'], ['favourites', 'favorites']]) {
    if (params.get(key) === '1') {
      state.filters[key] = true;
      $(`#filter-${id}`).checked = true;
    }
  }
  if (params.get('all') === '1') {
    state.filters.playable = false;
    $('#filter-playable').checked = false;
  }
  const sort = params.get('sort');
  if (sort) {
    state.sort = sort;
    $('#sort').value = sort;
  }
}

// ---------------------------------------------------------------- events

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function wireEvents() {
  const onSearch = debounce(() => {
    state.query = $('#search').value.trim();
    applyFilters();
  }, 140);
  $('#search').addEventListener('input', onSearch);

  for (const key of ['country', 'category', 'language']) {
    $(`#filter-${key}`).addEventListener('change', (event) => {
      state.filters[key] = event.target.value;
      applyFilters();
    });
  }

  $('#filter-playable').addEventListener('change', (event) => {
    state.filters.playable = event.target.checked;
    applyFilters();
  });
  $('#filter-online').addEventListener('change', (event) => {
    state.filters.online = event.target.checked;
    applyFilters();
  });
  $('#filter-browser').addEventListener('change', (event) => {
    state.filters.browser = event.target.checked;
    applyFilters();
  });
  $('#filter-hd').addEventListener('change', (event) => {
    state.filters.hd = event.target.checked;
    applyFilters();
  });
  $('#filter-favorites').addEventListener('change', (event) => {
    state.filters.favourites = event.target.checked;
    applyFilters();
  });
  $('#sort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    applyFilters();
  });

  $('#filters-reset').addEventListener('click', resetFilters);
  $('#empty-reset').addEventListener('click', resetFilters);

  $('#filters-toggle').addEventListener('click', (event) => {
    const panel = $('#filters');
    const open = panel.classList.toggle('is-open');
    event.currentTarget.setAttribute('aria-expanded', String(open));
  });

  $('#theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('nexus:theme', next);
    } catch {
      /* ignore */
    }
  });

  for (const node of document.querySelectorAll('[data-close]')) {
    node.addEventListener('click', closePlayer);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#player').hidden) closePlayer();
    if (event.key === '/' && document.activeElement !== $('#search')) {
      event.preventDefault();
      $('#search').focus();
      $('#search').select();
    }
  });

  // Infinite scroll.
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) renderMore();
    },
    { rootMargin: '600px' },
  );
  observer.observe($('#sentinel'));
}

boot();
