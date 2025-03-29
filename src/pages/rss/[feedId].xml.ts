import { Feed } from 'feed';
import { getChaptersForSlugs, isValidLanguage } from "../../lib/api";
import { getFeedMapping, warmChapterCache } from "../../lib/db";
import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ params, request }) => {
  const feedId = params.feedId?.replace('.xml', '');
  
  if (!feedId) {
    return new Response("Feed ID not provided", { status: 400 });
  }

  const mapping = await getFeedMapping(feedId);
  
  if (!mapping) {
    return new Response("Feed not found", { status: 404 });
  }

  const { slugs, lang } = mapping;

  if (!isValidLanguage(lang)) {
    return new Response("Invalid language", { status: 400 });
  }

  await warmChapterCache(slugs, lang);

  const chapters = await getChaptersForSlugs(slugs, lang);

  if (chapters.length === 0) {
    return new Response("No chapters found for the provided comics", { status: 404 });
  }

  const siteUrl = new URL(request.url).origin;
  const feedUrl = new URL(request.url).href;

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
    if (!chapter?.created_at) {
      console.error('Chapter missing created_at:', chapter);
      return;
    }

    const chapterUrl = `https://comick.io/comic/${chapter.md_comics.slug}`;
    
    const rawDate = chapter.created_at.endsWith('Z') 
      ? chapter.created_at 
      : `${chapter.created_at}Z`;
    
    const pubDate = isValidDate(rawDate) ? new Date(rawDate) : new Date();

    feed.addItem({
      title: `${chapter.md_comics.title} - Chapter ${chapter.chap}`,
      id: `${chapter.md_comics.slug}-${chapter.chap}`,
      link: chapterUrl,
      description: `
        <div>
          ${
            chapter.md_comics.md_covers?.[0]
              ? `<img src="https://meo.comick.pictures/${chapter.md_comics.md_covers[0].b2key}" 
                  alt="Cover" style="max-width: 300px; margin-bottom: 1rem;" />`
              : ""
          }
          <p>New chapter available: Chapter ${chapter.chap}</p>
        </div>
      `,
      date: pubDate,
    });
  });

  return new Response(feed.rss2(), {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
    },
  });
};

function isValidDate(dateString: string): boolean {
  return !isNaN(Date.parse(dateString));
} 