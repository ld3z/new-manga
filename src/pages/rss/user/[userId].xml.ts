import { Feed } from 'feed';
import type { APIRoute } from 'astro';
import { fetchUserComics, getComicBySlug, APIError } from '../../../lib/api';
import { getUserFeedMapping } from '../../../lib/db';
import sanitizeHtml from 'sanitize-html';

export const GET: APIRoute = async ({ params, site }) => {
  const feedId = params.userId?.replace('.xml', '');
  
  if (!feedId) {
    return new Response("Feed ID not provided", { status: 400 });
  }

  if (!site) {
    return new Response("Site configuration is missing", { status: 500 });
  }

  try {
    const mapping = await getUserFeedMapping(feedId);
    
    if (!mapping) {
      return new Response("Feed not found", { status: 404 });
    }

    const userId = mapping.userId;
    const userData = await fetchUserComics(userId);
    const now = new Date();

    // Store all items first so we can sort them
    const feedItems = [];
    let mostRecentDate = new Date(0);

    const comicDetailsPromises = userData.comics
        .filter(comic => comic.user_last_read_chapter !== null)
        .map(async (comic) => {
            try {
                const details = await getComicBySlug(comic.slug);
                if (comic.user_read_at) {
                    const readDate = new Date(comic.user_read_at);
                    if (!isNaN(readDate.getTime()) && readDate > mostRecentDate) {
                        mostRecentDate = readDate;
                    }
                }
                return { comic, details };
            } catch (error) {
                return { comic, details: null };
            }
        });

    const results = await Promise.all(comicDetailsPromises);

    const feed = new Feed({
        title: `Comick User Read Feed - ${userId}`,
        description: `Recently read chapters by Comick user ${userId}`,
        id: `${site}rss/user/${feedId}.xml`,
        link: site.toString(),
        language: "en",
        copyright: `All rights reserved`,
        updated: mostRecentDate > new Date(0) ? mostRecentDate : now,
        generator: "ComicK RSS Generator",
        feedLinks: {
            rss2: `${site}rss/user/${feedId}.xml`
        },
    });

    for (const { comic, details } of results) {
        if (comic.user_last_read_chapter && details?.comic) {
            const comicTitle = details.comic.title;
            const chapterNumber = comic.user_last_read_chapter.chap;
            const itemTitle = sanitizeHtml(comicTitle);
            const itemDescription = `User read chapter ${chapterNumber}`;
            const itemLink = `https://comick.fun/comic/${comic.slug}`;
            
            let readDate;
            if (comic.user_read_at) {
                readDate = new Date(comic.user_read_at);
                if (isNaN(readDate.getTime())) {
                    readDate = now;
                }
            } else {
                readDate = now;
            }

            feedItems.push({
                title: itemTitle,
                id: `${itemLink}#read-chapter-${chapterNumber}-${readDate.getTime()}`,
                link: itemLink,
                description: itemDescription,
                date: readDate,
                pubDate: readDate
            });
        }
    }

    feedItems.sort((a, b) => b.date.getTime() - a.date.getTime());
    feedItems.forEach(item => feed.addItem(item));

    return new Response(feed.rss2(), {
        status: 200,
        headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=600'
        }
    });

  } catch (error) {
    let status = 500;
    let message = 'Failed to generate RSS feed.';

    if (error instanceof APIError) {
        message = error.message;
        status = error.statusCode === 404 ? 404 : (error.statusCode || 500);
        if (status === 404) message = 'Comick user not found or scrape failed.';
    } else if (error instanceof Error) {
        message = error.message;
    }

    const errorFeed = new Feed({
        title: "Error Generating Feed",
        description: message,
        id: site.toString(),
        link: site.toString(),
        language: "en",
        copyright: ""
    });

    errorFeed.addItem({
        title: `Error ${status}`,
        description: message,
        link: site.toString(),
        date: new Date(),
        id: `${site}error/${status}/${new Date().getTime()}`
    });

    return new Response(errorFeed.rss2(), {
        status: status,
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
  }
};
