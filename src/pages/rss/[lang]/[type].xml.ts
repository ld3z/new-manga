import rss from "@astrojs/rss";
import {
  fetchComics,
  isValidLanguage,
  isValidContentType,
  fetchGenres,
  getGenreNames,
} from "../../../lib/api";
import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ params, request }) => {
  const { lang = "en", type = "sfw" } = params;

  if (!isValidLanguage(lang) || !isValidContentType(type)) {
    return new Response("Invalid language or content type", { status: 400 });
  }

  const [comics, genres] = await Promise.all([
    fetchComics(lang, type),
    fetchGenres(),
  ]);
  
  const siteURL = new URL(request.url).origin;

  return rss({
    title: `ComicK - ${lang.toUpperCase()} ${type.toUpperCase()}`,
    description: `A simple RSS feed for ComicK!`,
    site: "https://github.com/ld3z/manga-rss",
    items: comics.map((comic) => {
      const genreNames = getGenreNames(comic.md_comics.genres, genres);
      const genresHtml = genreNames.length > 0 
        ? `<p>Genres: ${genreNames.join(', ')}</p>` 
        : '';

      return {
        title: `${comic.md_comics.title} - Chapter ${comic.chap}`,
        link: `https://comick.io/comic/${comic.md_comics.slug}`,
        pubDate: new Date(comic.updated_at),
        description: `Chapter ${comic.chap} of ${comic.md_comics.title} is now available on ComicK!
          ${genresHtml}
          ${
            comic.md_comics.md_covers[0]
              ? `<img src="https://meo.comick.pictures/${comic.md_comics.md_covers[0].b2key}" 
                alt="Cover" style="max-width: 300px;" />`
              : ""
          }
        `,
      };
    }),
  });
};

export function getStaticPaths() {
  return [
    { params: { lang: "en", type: "sfw" } },
    { params: { lang: "en", type: "nsfw" } },
    { params: { lang: "fr", type: "sfw" } },
    { params: { lang: "fr", type: "nsfw" } },
    { params: { lang: "es", type: "nsfw" } },
    { params: { lang: "es", type: "sfw" } },
    { params: { lang: "it", type: "sfw" } },
    { params: { lang: "it", type: "nsfw" } },
    { params: { lang: "pl", type: "sfw" } },
    { params: { lang: "pl", type: "nsfw" } },
    { params: { lang: "tr", type: "sfw" } },
    { params: { lang: "tr", type: "nsfw" } },
    { params: { lang: "ja", type: "sfw" } },
    { params: { lang: "ja", type: "nsfw" } },
    { params: { lang: "zh", type: "sfw" } },
    { params: { lang: "zh", type: "nsfw" } },
    { params: { lang: "sv", type: "sfw" } },
    { params: { lang: "sv", type: "nsfw" } },
    { params: { lang: "ar", type: "sfw" } },
    { params: { lang: "ar", type: "nsfw" } },
    { params: { lang: "de", type: "sfw" } },
    { params: { lang: "de", type: "nsfw" } },
  ];
}