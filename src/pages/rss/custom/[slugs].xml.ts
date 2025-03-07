import { Feed } from 'feed';
import { getChaptersForSlugs, isValidLanguage } from "../../../lib/api";
import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ params, url }) => {
  const slugs = params.slugs?.split(',') || [];
  const lang = url.searchParams.get('lang') || 'en';
  
  if (slugs.length === 0) {
    return new Response("No slugs provided", { status: 400 });
  }

  if (!isValidLanguage(lang)) {
    return new Response("Invalid language", { status: 400 });
  }

  console.log('Processing RSS request for slugs:', slugs, 'in language:', lang);
  const chapters = await getChaptersForSlugs(slugs, lang);

  if (chapters.length === 0) {
    console.log('No chapters found for any of the provided slugs');
    return new Response("No chapters found for the provided comics", { status: 404 });
  }

  const siteUrl = new URL(url).origin;
  const feedUrl = new URL(url).href;

  const feed = new Feed({
    title: `ComicK - Custom Feed (${lang.toUpperCase()})`,
    description: `Custom RSS feed for selected comics: ${slugs.join(', ')}`,
    id: feedUrl,
    link: siteUrl,
    feedLinks: {
      rss2: feedUrl
    },
    language: lang,
    copyright: "All rights reserved",
    updated: new Date(),
    generator: 'ComicK RSS Generator',
  });

  chapters.forEach((chapter) => {
    const chapterUrl = `https://comick.io/comic/${chapter.md_comics.slug}`;
    feed.addItem({
      title: `${chapter.md_comics.title} - Chapter ${chapter.chap}`,
      id: `${chapter.md_comics.slug}-${chapter.chap}`,
      link: chapterUrl,
      description: `New chapter available: Chapter ${chapter.chap}`,
      date: new Date(chapter.updated_at),
    });
  });

  return new Response(feed.rss2(), {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
    },
  });
}; 