import { buildMatcher, enrichPlaylist, parseM3u, writeM3u } from './enrich-core.js';

const API = 'api/v1';
const $ = (selector) => document.querySelector(selector);

const getJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = label), 1400);
  } catch {
    window.prompt('Copy this:', text);
  }
}

let manifest = null;
let facets = { countries: [], categories: [], languages: [] };

// ---------------------------------------------------------------- builder

function fillMultiSelect(select, items, key, label) {
  select.innerHTML = items.map((item) => `<option value="${escapeHtml(item[key])}">${escapeHtml(label(item))}</option>`).join('');
}

function builderUrl() {
  const base = manifest?.endpoints?.worker;
  if (!base) return null;
  const picked = (id) => [...$(id).selectedOptions].map((option) => option.value.toLowerCase());
  const params = new URLSearchParams();
  const countries = picked('#b-country');
  const categories = picked('#b-category');
  const languages = picked('#b-language');
  if (countries.length) params.set('country', countries.join(','));
  if (categories.length) params.set('category', categories.join(','));
  if (languages.length) params.set('language', languages.join(','));
  if ($('#b-online').checked) params.set('online', '1');
  if (!$('#b-smart').checked) params.set('links', 'direct');
  if ($('#b-group').value !== 'category') params.set('group', $('#b-group').value);
  const query = params.toString().replace(/%2C/g, ',');
  return `${base}/m3u${query ? `?${query}` : ''}`;
}

function refreshBuilder() {
  const url = builderUrl();
  $('#b-url').textContent = url ?? '';
  $('#b-open').href = url ?? '#';
  $('#b-status').textContent = '';
}

function setupBuilder() {
  if (!manifest?.endpoints?.worker) {
    $('#builder-body').hidden = true;
    $('#builder-missing').hidden = false;
    return;
  }
  const playable = (item) => (item.playable ?? item.channels ?? 0) > 0;
  const count = (item) => ` (${(item.playable ?? 0).toLocaleString()})`;
  fillMultiSelect($('#b-country'), facets.countries.filter(playable), 'code', (c) => `${c.flag ? `${c.flag} ` : ''}${c.name}${count(c)}`);
  fillMultiSelect($('#b-category'), facets.categories.filter(playable), 'id', (c) => `${c.name}${count(c)}`);
  fillMultiSelect($('#b-language'), facets.languages.filter(playable).sort((a, b) => b.playable - a.playable), 'code', (l) => `${l.name}${count(l)}`);

  for (const id of ['#b-country', '#b-category', '#b-language', '#b-online', '#b-smart', '#b-group']) {
    $(id).addEventListener('change', refreshBuilder);
  }
  $('#b-copy').addEventListener('click', (event) => copy(builderUrl(), event.currentTarget));
  $('#b-test').addEventListener('click', async () => {
    $('#b-status').textContent = 'Asking the Worker…';
    try {
      const response = await fetch(builderUrl());
      const body = await response.text();
      if (!response.ok) throw new Error(body.slice(0, 160));
      const channels = (body.match(/^#EXTINF/gm) ?? []).length;
      $('#b-status').textContent = `${channels.toLocaleString()} channel${channels === 1 ? '' : 's'} in this playlist.`;
    } catch (error) {
      $('#b-status').textContent = `Could not reach the Worker: ${error.message}`;
    }
  });
  refreshBuilder();
}

// --------------------------------------------------------------- enricher

let matcherPromise = null;
function loadMatcher() {
  matcherPromise ??= getJson(`${API}/match.json`).then((index) => buildMatcher(index, facets.countries));
  return matcherPromise;
}

const METHOD = { id: 'tvg-id', name: 'name', fuzzy: 'close name' };

async function runEnricher() {
  const source = $('#f-text').value.trim();
  if (!source) {
    $('#f-status').textContent = 'Load a file or paste a playlist first.';
    return;
  }
  $('#f-run').disabled = true;
  $('#f-status').textContent = 'Loading the channel database (about 0.9 MB)…';
  try {
    const matcher = await loadMatcher();
    $('#f-status').textContent = 'Matching…';
    await new Promise((resolve) => setTimeout(resolve)); // let the status paint

    const parsed = parseM3u(source);
    if (parsed.entries.length === 0) throw new Error('No channels found. Is this an M3U playlist?');
    const started = performance.now();
    const result = enrichPlaylist(parsed, matcher, {
      logos: $('#f-logos').checked,
      numbers: $('#f-numbers').checked,
      guideUrl: $('#f-guide').checked ? manifest?.endpoints?.epg ?? null : null,
      minConfidence: $('#f-unsure').checked ? 0.7 : 0.8,
    });
    const elapsed = Math.round(performance.now() - started);
    const output = writeM3u(result.header, result.entries);
    renderEnricher(result, output, elapsed);
    $('#f-status').textContent = '';
  } catch (error) {
    $('#f-status').textContent = error.message;
  } finally {
    $('#f-run').disabled = false;
  }
}

function renderEnricher({ summary, results }, output, elapsed) {
  const pct = (n) => (summary.total ? Math.round((n / summary.total) * 100) : 0);
  $('#f-stats').innerHTML = [
    ['Live channels', summary.total.toLocaleString()],
    ['Matched', `${summary.matched.toLocaleString()} <small>${pct(summary.matched)}%</small>`],
    ['With guide', `${summary.withGuide.toLocaleString()} <small>${pct(summary.withGuide)}%</small>`],
    ['VOD left as is', summary.vod.toLocaleString()],
  ]
    .map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`)
    .join('') + `<p class="muted small">Matched in ${elapsed} ms.</p>`;

  const blob = new Blob([output], { type: 'audio/x-mpegurl' });
  const link = $('#f-download');
  if (link.dataset.url) URL.revokeObjectURL(link.dataset.url);
  link.dataset.url = URL.createObjectURL(blob);
  link.href = link.dataset.url;
  $('#f-copy').onclick = (event) => copy(output, event.currentTarget);

  const shown = results.slice(0, 300);
  $('#f-rows').innerHTML = shown
    .map(({ entry, match }) => {
      const name = escapeHtml(entry.title || entry.attrs['tvg-name'] || '');
      if (!match) return `<tr class="none"><td>${name}</td><td colspan="3" class="muted">no match</td></tr>`;
      const channel = match.channel;
      const unsure = match.confidence < 0.8 ? ' <span class="tag tag--warn">check</span>' : '';
      return `<tr><td>${name}</td><td><a href="./?channel=${encodeURIComponent(channel.id)}" target="_blank" rel="noopener">${escapeHtml(channel.name)}</a> <span class="muted">${escapeHtml(channel.id)}</span>${unsure}</td><td>${METHOD[match.method]}</td><td>${channel.guide ? '✓' : ''}</td></tr>`;
    })
    .join('');
  $('#f-more').textContent =
    results.length > shown.length ? `Showing the first ${shown.length} of ${results.length.toLocaleString()} channels; the download includes all of them.` : '';
  $('#f-result').hidden = false;
}

function setupEnricher() {
  $('#f-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    $('#f-text').value = await file.text();
    $('#f-status').textContent = `${file.name} loaded.`;
  });
  $('#f-run').addEventListener('click', runEnricher);
}

// ---------------------------------------------------------------- connect

function setupConnect() {
  const e = manifest?.endpoints ?? {};
  const rows = [
    ['Any M3U player', e.playlist_best, 'Every channel, best stream each'],
    ['Programme guide (XMLTV)', e.epg, 'Matches the tvg-id of every playlist'],
    ['Stremio', e.stremio, 'Paste into the Stremio search bar, then Install'],
    ['Xtream Codes apps', e.xtream, 'Server URL — any username (or “country”) and password'],
    ['AI assistants (MCP)', e.mcp, 'Add as a remote MCP server in Claude, ChatGPT, Cursor…'],
    ['What changed (Atom feed)', e.changes_feed, 'New and lost channels, for any feed reader'],
    ['Developers (OpenAPI)', e.openapi, 'The full static JSON API'],
  ].filter(([, url]) => url);
  $('#connect-list').innerHTML = rows
    .map(
      ([label, url, hint], i) => `
      <div class="connect__row">
        <div><strong>${escapeHtml(label)}</strong><span class="muted small">${escapeHtml(hint)}</span></div>
        <code>${escapeHtml(url)}</code>
        <button class="btn btn--ghost" data-copy="${i}">Copy</button>
      </div>`,
    )
    .join('');
  $('#connect-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-copy]');
    if (button) copy(rows[Number(button.dataset.copy)][1], button);
  });
}

// ------------------------------------------------------------------- init

async function init() {
  try {
    manifest = await getJson(`${API}/index.json`);
    const [countries, categories, languages] = await Promise.all([
      getJson(`${API}/countries.json`).catch(() => []),
      getJson(`${API}/categories.json`).catch(() => []),
      getJson(`${API}/languages.json`).catch(() => []),
    ]);
    facets = { countries, categories, languages };
  } catch (error) {
    console.error(error);
  }
  setupBuilder();
  setupEnricher();
  setupConnect();
}

init();
