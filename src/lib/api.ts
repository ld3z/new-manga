import type { Comic, Genre, ComicType } from './types';
import { getRedisClient } from './db';

const languageMap = {
  "en": "English",
  "fr": "French",
  "es": "Spanish",
  "it": "Italian",
  "pl": "Polish",
  "tr": "Turkish",
  "ja": "Japanese",
  "zh": "Chinese",
  "sv": "Swedish",
  "ar": "Arabic",
  "de": "German",
  "ko": "Korean"
} as const;

const languages = new Set(Object.keys(languageMap));
const contentTypes = new Set(["sfw", "nsfw"]);
const comicTypes = new Set(['manga', 'manhwa', 'manhua', 'all']);
const urlBase = "https://api.comick.fun/chapter";

let genreCache: Genre[] = [];

const RETRY_COUNT = 3;
const RETRY_DELAY = 1000;

async function fetchWithRetry(url: string, options: RequestInit = {}, retries = RETRY_COUNT): Promise<Response> {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; ComicReader/1.0)',
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response;
  } catch (error) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw error;
  }
}

export async function fetchGenres(): Promise<Genre[]> {
  if (genreCache.length > 0) return genreCache;

  try {
    const response = await fetchWithRetry('https://api.comick.fun/genre');
    genreCache = await response.json();
    return genreCache;
  } catch (error) {
    console.error('Error fetching genres:', error);
    return [];
  }
}

export function getGenreNames(genreIds: number[], genres: Genre[]): string[] {
  return genreIds
    .map(id => genres.find(g => g.id === id)?.name ?? '')
    .filter(name => name !== '');
}

export class APIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public endpoint?: string
  ) {
    super(message);
    this.name = 'APIError';
  }
}

export async function fetchComics(
  language: string = 'en', 
  contentType: string = 'sfw', 
  comicType: ComicType = 'all',
  page: number = 1
): Promise<Comic[]> {
  const apiUrl = `${urlBase}?lang=${language}&page=${page}&order=new&accept_erotic_content=${contentType === 'nsfw'}${comicType === 'all' ? '' : `&type=${comicType}`}`;
  
  try {
    console.log('Fetching comics from:', apiUrl);
    
    const response = await fetchWithRetry(apiUrl);
    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new APIError('Invalid API response format', undefined, apiUrl);
    }

    return data;
  } catch (error) {
    if (error instanceof APIError) throw error;
    throw new APIError(
      'Failed to fetch comics',
      error instanceof Response ? error.status : undefined,
      apiUrl
    );
  }
}

export function isValidLanguage(lang: string): boolean {
  return languages.has(lang);
}

export function isValidContentType(type: string): boolean {
  return contentTypes.has(type);
}

export function isValidComicType(type: string): boolean {
  return comicTypes.has(type);
}

export function getLanguageName(code: string): string {
  return languageMap[code as keyof typeof languageMap] || code.toUpperCase();
}

export const availableLanguages = Array.from(languages);
export const availableContentTypes = Array.from(contentTypes);
export const availableComicTypes = Array.from(comicTypes);
export { languageMap };

interface ComicDetail {
  comic: {
    hid: string;
    title: string;
    slug: string;
  };
}

interface ChapterDetail {
  id: string;
  chap: string;
  title: string;
  updated_at: string;
  md_comics: {
    title: string;
    slug: string;
    md_covers?: {
      b2key: string;
    }[];
  };
}

interface ChapterParams {
  limit?: number;
  lang?: string;
}

export async function getComicBySlug(slug: string): Promise<ComicDetail | null> {
  try {
    const response = await fetchWithRetry(`https://api.comick.fun/comic/${slug}`);
    const data = await response.json();
    
    if (!data?.comic?.hid) {
      console.error(`Invalid comic data for slug ${slug}:`, data);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error(`Error fetching comic ${slug}:`, error);
    return null;
  }
}

export async function getChaptersByHid(
  hid: string,
  slug: string,
  params: ChapterParams = { limit: 5, lang: 'en' }
): Promise<ChapterDetail[]> {
  try {
    const queryParams = new URLSearchParams({
      limit: params.limit?.toString() || '5',
      lang: params.lang || 'en',
      ordering: '-created_at'
    });
    
    // Fetch comic details including cover
    const comicResponse = await fetchWithRetry(
      `https://api.comick.fun/comic/${hid}`
    );
    const comicData = await comicResponse.json();
    const comicTitle = comicData?.comic?.title || 'Unknown Comic';
    const covers = comicData?.comic?.md_covers || [];
    
    const response = await fetchWithRetry(
      `https://api.comick.fun/comic/${hid}/chapters?${queryParams}`
    );
    const data = await response.json();
    
    if (!data?.chapters || !Array.isArray(data.chapters)) {
      console.error(`Invalid chapters data for hid ${hid}:`, data);
      return [];
    }

    console.log('Processing chapters for comic:', comicTitle);
    
    const now = new Date();
    
    const chapters = data.chapters
      .filter(chapter => {
        // Basic validation
        const isValid = chapter && 
               chapter.chap &&
               chapter.hid;

        if (!isValid) return false;

        // Check publish time
        if (chapter.publish_at) {
          const publishTime = new Date(chapter.publish_at);
          if (publishTime > now) {
            console.log(`Chapter ${chapter.chap} will be published at ${publishTime}`);
            return false;
          }
        }

        // Use the earliest available timestamp
        const hasValidTimestamp = chapter.publish_at || chapter.created_at || chapter.updated_at;
        return Boolean(hasValidTimestamp);
      })
      .map(chapter => ({
        id: chapter.hid,
        chap: chapter.chap,
        title: chapter.title || `Chapter ${chapter.chap}`,
        updated_at: chapter.publish_at || chapter.created_at || chapter.updated_at,
        md_comics: {
          title: comicTitle,
          slug: slug,
          md_covers: covers
        }
      }));

    console.log(`Successfully processed ${chapters.length} chapters for ${comicTitle}`);
    return chapters;
  } catch (error) {
    console.error(`Error fetching chapters for hid ${hid}:`, error);
    return [];
  }
}

export async function getChaptersForSlugs(
  slugs: string[], 
  lang: string = 'en'
): Promise<ChapterDetail[]> {
  console.log(`Fetching chapters for slugs:`, slugs, `in language: ${lang}`);
  const chapters: ChapterDetail[] = [];
  const redis = await getRedisClient();
  
  // Cache results for 1 hour (3600 seconds)
  const CACHE_TTL = 60 * 60;

  for (const slug of slugs) {
    console.log(`Processing slug: ${slug}`);
    const cacheKey = `chapters:${slug}:${lang}`;
    
    try {
      // Try to get cached chapters
      const cachedChapters = await redis.get(cacheKey);
      if (cachedChapters) {
        console.log(`Using cached chapters for ${slug}`);
        chapters.push(...JSON.parse(cachedChapters));
        continue;
      }
    } catch (error) {
      console.error('Redis cache read error:', error);
    }

    const comicDetail = await getComicBySlug(slug);
    
    if (!comicDetail) {
      console.error(`Failed to get comic details for slug: ${slug}`);
      continue;
    }
    
    if (!comicDetail.comic?.hid) {
      console.error(`No HID found for slug ${slug}`, comicDetail);
      continue;
    }
    
    console.log(`Found HID ${comicDetail.comic.hid} for slug ${slug}`);
    const comicChapters = await getChaptersByHid(
      comicDetail.comic.hid,
      slug,
      {
        limit: 5,
        lang: lang
      }
    );
    console.log(`Found ${comicChapters.length} chapters for ${slug}`);
    
    if (comicChapters.length > 0) {
      chapters.push(...comicChapters);
      
      // Cache the results
      try {
        await redis.set(
          cacheKey,
          JSON.stringify(comicChapters),
          'EX',
          CACHE_TTL
        );
        console.log(`Cached chapters for ${slug}`);
      } catch (error) {
        console.error('Redis cache write error:', error);
      }
    }
  }
  
  // Sort by chapter number (descending) first, then by date
  const sortedChapters = chapters.sort((a, b) => {
    // Convert chapter numbers to floats for proper numerical sorting
    const chapA = parseFloat(a.chap);
    const chapB = parseFloat(b.chap);
    
    if (chapB !== chapA) {
      return chapB - chapA; // Sort by chapter number first
    }
    
    // If chapters are the same, sort by date
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });
  
  console.log(`Total chapters found: ${sortedChapters.length}`);
  return sortedChapters;
}