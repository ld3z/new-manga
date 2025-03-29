import rss from "@astrojs/rss";
import {
  fetchComics,
  isValidLanguage,
  isValidContentType,
  isValidComicType,
  fetchGenres,
  getGenreNames,
} from "../../../../lib/api";
import type { APIRoute } from "astro";
import type { ComicType } from "../../../../lib/types";

export const GET: APIRoute = async ({ params, request }) => {
  const { lang = "en", contentType = "sfw", type = "all" } = params;

  if (!isValidLanguage(lang) || !isValidContentType(contentType) || !isValidComicType(type)) {
    return new Response("Invalid parameters", { status: 400 });
  }

  const [comics, genres] = await Promise.all([
    fetchComics(lang, contentType, type as ComicType),
    fetchGenres(),
  ]);
  
  const siteURL = new URL(request.url).origin;

  return rss({
    title: `ComicK - ${lang.toUpperCase()} ${contentType.toUpperCase()} ${type.toUpperCase()}`,
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