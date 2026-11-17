// Free films and series (api/v1/vod.json): openly licensed titles from the
// Internet Archive, browsable and playable in the page.
(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const PAGE = 60;
  const state = { data: null, kind: 'movies', shelf: '', query: '', shown: PAGE };

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fold = (value) => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const minutes = (seconds) => (seconds ? `${Math.round(seconds / 60)} min` : '');

  try {
    const stored = localStorage.getItem('nexus:theme');
    if (stored) document.documentElement.dataset.theme = stored;
  } catch {}

  function items() {
    const list = state.data?.[state.kind] ?? [];
    const q = fold(state.query);
    return list.filter((item) => (!state.shelf || item.categories.includes(state.shelf)) && (!q || fold(item.title).includes(q)));
  }

  function renderShelves() {
    const list = state.data?.[state.kind] ?? [];
    const counts = new Map();
    for (const item of list) for (const name of item.categories) counts.set(name, (counts.get(name) ?? 0) + 1);
    const names = [...counts.keys()].sort((a, b) => a.localeCompare(b));
    $('#shelves').innerHTML = ['', ...names]
      .map(
        (name) =>
          `<button class="shelf" data-shelf="${esc(name)}" aria-pressed="${state.shelf === name}">${esc(name || 'All')}<span>${
            name ? counts.get(name) : list.length
          }</span></button>`,
      )
      .join('');
  }

  function render() {
    const list = items();
    const target = $('#posters');
    if (!state.data) return;
    if (list.length === 0) {
      target.innerHTML = '<p class="empty">Nothing matches.</p>';
      $('#more').hidden = true;
      return;
    }
    target.innerHTML = list
      .slice(0, state.shown)
      .map(
        (item) => `<button class="poster" data-id="${esc(item.id)}">
          <img loading="lazy" src="${esc(item.poster)}" alt="" />
          <span class="poster__title">${esc(item.title)}</span>
          <span class="poster__sub">${[item.year, item.episodes ? `${item.episodes.length} episodes` : minutes(item.runtime), item.license.label]
            .filter(Boolean)
            .map(esc)
            .join(' · ')}</span>
        </button>`,
      )
      .join('');
    $('#more').hidden = list.length <= state.shown;
  }

  function play(url, title) {
    const video = $('#video');
    video.src = url;
    video.title = title;
    video.play().catch(() => {});
  }

  function open(id) {
    const item = (state.data[state.kind] ?? []).find((entry) => entry.id === id);
    if (!item) return;
    $('#player-title').textContent = item.title;
    $('#player-sub').textContent = [item.year, item.categories.join(', '), item.runtime ? minutes(item.runtime) : ''].filter(Boolean).join(' · ');
    $('#player-licence').innerHTML = `<a href="${esc(item.license.url)}" target="_blank" rel="noopener">${esc(item.license.label)}</a> · <a href="${esc(
      item.source_url,
    )}" target="_blank" rel="noopener">archive.org</a>`;
    $('#player-plot').textContent = item.description;
    const episodes = $('#player-episodes');
    const video = $('#video');
    video.poster = item.poster;
    if (item.episodes) {
      episodes.innerHTML = item.episodes
        .map(
          (episode, i) =>
            `<button class="stream-btn" data-url="${esc(episode.url)}" aria-pressed="${i === 0}">${esc(episode.episode)}. ${esc(episode.title)}${
              episode.runtime ? ` <span class="muted">· ${minutes(episode.runtime)}</span>` : ''
            }</button>`,
        )
        .join('');
      video.src = item.episodes[0]?.url ?? '';
    } else {
      episodes.innerHTML = '';
      video.src = item.url;
    }
    $('#player').hidden = false;
    history.replaceState(null, '', `#${state.kind}/${encodeURIComponent(item.id)}`);
  }

  function close() {
    const video = $('#video');
    video.pause();
    video.removeAttribute('src');
    video.load();
    $('#player').hidden = true;
    history.replaceState(null, '', location.pathname);
  }

  $('#films-search').addEventListener('input', (event) => {
    state.query = event.target.value;
    state.shown = PAGE;
    render();
  });
  document.querySelectorAll('[data-kind]').forEach((button) =>
    button.addEventListener('click', () => {
      state.kind = button.dataset.kind;
      state.shelf = '';
      state.shown = PAGE;
      document.querySelectorAll('[data-kind]').forEach((b) => b.setAttribute('aria-selected', String(b === button)));
      renderShelves();
      render();
    }),
  );
  $('#shelves').addEventListener('click', (event) => {
    const button = event.target.closest('[data-shelf]');
    if (!button) return;
    state.shelf = button.dataset.shelf;
    state.shown = PAGE;
    renderShelves();
    render();
  });
  $('#posters').addEventListener('click', (event) => {
    const card = event.target.closest('[data-id]');
    if (card) open(card.dataset.id);
  });
  $('#more').addEventListener('click', () => {
    state.shown += PAGE;
    render();
  });
  $('#player-episodes').addEventListener('click', (event) => {
    const button = event.target.closest('[data-url]');
    if (!button) return;
    document.querySelectorAll('#player-episodes [data-url]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
    play(button.dataset.url, button.textContent);
  });
  document.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', close));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#player').hidden) close();
  });

  fetch('api/v1/vod.json')
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
    .then((data) => {
      state.data = data;
      $('#films-count').textContent = `${data.counts.movies.toLocaleString()} films · ${data.counts.series.toLocaleString()} series`;
      if (data.counts.movies === 0 && data.counts.series > 0) document.querySelector('[data-kind="series"]').click();
      renderShelves();
      render();
      const [kind, id] = decodeURIComponent(location.hash.slice(1)).split('/');
      if ((kind === 'movies' || kind === 'series') && id) {
        if (kind !== state.kind) document.querySelector(`[data-kind="${kind}"]`).click();
        open(id);
      }
    })
    .catch(() => {
      $('#posters').innerHTML = '<p class="empty">The film catalogue is being prepared. Check back soon.</p>';
    });
})();
