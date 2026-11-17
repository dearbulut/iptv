/**
 * Publishes the VOD catalogue (src/vod) in every format the live channels
 * already use:
 *
 *   api/v1/vod.json          the whole catalogue
 *   xtream/vod.json          compact data for the Worker's VOD and series
 *                            actions (get_vod_streams, get_series_info…)
 *   stremio/…                movie and series catalogues, metas and streams
 *   playlists/vod/*.m3u      films, and series episode by episode
 */

import type { VodCatalog, VodMovie, VodSeries } from "../vod/index.js";
import type { StremioFile } from "./stremio.js";

export const VOD_PREFIX = "nexusvod-";
const PAGE = 100;

const attr = (value: unknown) =>
  String(value ?? "")
    .replace(/"/g, "'")
    .replace(/[\r\n]+/g, " ");

/** Shelves, by name, with stable ids derived from the sorted names. */
function shelves(
  items: ReadonlyArray<VodMovie | VodSeries>,
): Array<[number, string]> {
  return [...new Set(items.flatMap((item) => item.categories))]
    .sort((a, b) => a.localeCompare(b))
    .map((name, i) => [i + 1, name]);
}

export interface XtreamVod {
  version: 1;
  categories: {
    movies: Array<[number, string]>;
    series: Array<[number, string]>;
  };
  /** [number, title, poster, year, category ids, url, runtime seconds, description, licence label] */
  movies: Array<
    [
      number,
      string,
      string,
      number | null,
      number[],
      string,
      number | null,
      string,
      string,
    ]
  >;
  series: Array<{
    number: number;
    title: string;
    poster: string;
    year: number | null;
    categories: number[];
    description: string;
    license: string;
    /** [number, episode, title, url, runtime seconds] */
    episodes: Array<[number, number, string, string, number | null]>;
  }>;
}

export function xtreamVod(catalog: VodCatalog): XtreamVod {
  const movieShelves = shelves(catalog.movies);
  const seriesShelves = shelves(catalog.series);
  const movieId = new Map(movieShelves.map(([id, name]) => [name, id]));
  const seriesId = new Map(seriesShelves.map(([id, name]) => [name, id]));
  return {
    version: 1,
    categories: { movies: movieShelves, series: seriesShelves },
    movies: catalog.movies.map((movie) => [
      movie.number,
      movie.title,
      movie.poster,
      movie.year,
      movie.categories.map((name) => movieId.get(name)!).filter(Boolean),
      movie.url,
      movie.runtime,
      movie.description.slice(0, 400),
      movie.license.label,
    ]),
    series: catalog.series.map((series) => ({
      number: series.number,
      title: series.title,
      poster: series.poster,
      year: series.year,
      categories: series.categories
        .map((name) => seriesId.get(name)!)
        .filter(Boolean),
      description: series.description.slice(0, 400),
      license: series.license.label,
      episodes: series.episodes.map((episode) => [
        episode.number,
        episode.episode,
        episode.title,
        episode.url,
        episode.runtime,
      ]),
    })),
  };
}

const credit = (item: VodMovie | VodSeries) =>
  `${item.license.label} · Internet Archive${item.year ? ` · ${item.year}` : ""}`;

/** Stremio catalogues, metas and streams, plus the manifest entries for them. */
export function stremioVod(catalog: VodCatalog): {
  files: StremioFile[];
  catalogs: Array<Record<string, unknown>>;
} {
  const files: StremioFile[] = [];
  const catalogs: Array<Record<string, unknown>> = [];

  const preview = (item: VodMovie | VodSeries, type: "movie" | "series") => ({
    id: VOD_PREFIX + item.id,
    type,
    name: item.title,
    poster: item.poster,
    genres: item.categories,
    releaseInfo: item.year ? String(item.year) : undefined,
    description: item.description || undefined,
  });

  const shelf = (
    type: "movie" | "series",
    id: string,
    name: string,
    items: ReadonlyArray<VodMovie | VodSeries>,
  ) => {
    if (items.length === 0) return;
    const byGenre = new Map<string, Array<VodMovie | VodSeries>>();
    for (const item of items)
      for (const genre of item.categories)
        byGenre.set(genre, [...(byGenre.get(genre) ?? []), item]);
    const paginate = (
      list: ReadonlyArray<VodMovie | VodSeries>,
      extra: string | null,
    ) => {
      for (let skip = 0; skip === 0 || skip < list.length; skip += PAGE) {
        const args = [extra, skip > 0 ? `skip=${skip}` : null]
          .filter(Boolean)
          .join("&");
        files.push({
          path: args
            ? `catalog/${type}/${id}/${args}.json`
            : `catalog/${type}/${id}.json`,
          data: {
            metas: list
              .slice(skip, skip + PAGE)
              .map((item) => preview(item, type)),
          },
        });
      }
    };
    paginate(items, null);
    for (const [genre, list] of byGenre) paginate(list, `genre=${genre}`);
    catalogs.push({
      type,
      id,
      name,
      extra: [
        { name: "genre", options: [...byGenre.keys()].sort() },
        { name: "skip" },
      ],
    });
  };

  shelf("movie", "nexus-movies", "IPTV Nexus · Free Films", catalog.movies);
  shelf("series", "nexus-series", "IPTV Nexus · Free Series", catalog.series);

  for (const movie of catalog.movies) {
    const id = VOD_PREFIX + movie.id;
    files.push({
      path: `meta/movie/${id}.json`,
      data: {
        meta: {
          ...preview(movie, "movie"),
          background: movie.poster,
          runtime: movie.runtime
            ? `${Math.round(movie.runtime / 60)} min`
            : undefined,
          language: movie.language ?? undefined,
          links: [
            { name: credit(movie), category: "Source", url: movie.source_url },
          ],
        },
      },
    });
    files.push({
      path: `stream/movie/${id}.json`,
      data: {
        streams: [
          { url: movie.url, name: "Internet Archive", title: credit(movie) },
        ],
      },
    });
  }

  for (const series of catalog.series) {
    const id = VOD_PREFIX + series.id;
    const released = `${series.year ?? 1970}-01-01T00:00:00.000Z`;
    files.push({
      path: `meta/series/${id}.json`,
      data: {
        meta: {
          ...preview(series, "series"),
          background: series.poster,
          links: [
            {
              name: credit(series),
              category: "Source",
              url: series.source_url,
            },
          ],
          videos: series.episodes.map((episode) => ({
            id: `${VOD_PREFIX}${episode.id}`,
            title: episode.title,
            season: 1,
            episode: episode.episode,
            released,
          })),
        },
      },
    });
    for (const episode of series.episodes) {
      files.push({
        path: `stream/series/${VOD_PREFIX}${episode.id}.json`,
        data: {
          streams: [
            {
              url: episode.url,
              name: "Internet Archive",
              title: credit(series),
            },
          ],
        },
      });
    }
  }
  return { files, catalogs };
}

/** M3U for players that take VOD as playlist entries (VLC, Kodi, TiviMate). */
export function vodPlaylists(catalog: VodCatalog): {
  movies: string;
  series: string;
} {
  const movies = ["#EXTM3U"];
  for (const movie of catalog.movies) {
    movies.push(
      `#EXTINF:${movie.runtime ?? -1} tvg-id="" tvg-name="${attr(movie.title)}" tvg-logo="${attr(movie.poster)}" group-title="${attr(movie.categories[0])}",${movie.title}${movie.year ? ` (${movie.year})` : ""}`,
      movie.url,
    );
  }
  const series = ["#EXTM3U"];
  for (const show of catalog.series) {
    for (const episode of show.episodes) {
      series.push(
        `#EXTINF:${episode.runtime ?? -1} tvg-name="${attr(show.title)}" tvg-logo="${attr(show.poster)}" group-title="${attr(show.title)}",${show.title} — ${episode.title}`,
        episode.url,
      );
    }
  }
  return { movies: `${movies.join("\n")}\n`, series: `${series.join("\n")}\n` };
}

/** The public API document: the catalogue without internal bookkeeping. */
export function vodApi(catalog: VodCatalog) {
  return {
    generated_at: catalog.generated_at,
    counts: {
      movies: catalog.movies.length,
      series: catalog.series.length,
      episodes: catalog.series.reduce((n, s) => n + s.episodes.length, 0),
    },
    note: "Openly licensed films and series (public domain or Creative Commons) from the Internet Archive. Videos play from archive.org.",
    movies: catalog.movies,
    series: catalog.series,
  };
}
