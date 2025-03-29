import type { Comic, Genre, ComicType, ChapterDetail } from './types';
import { getRedisClient, CHAPTER_CACHE_TTL } from './db';
import pThrottle from 'p-throttle';

const languageMap = {
  "en": "English",
  "fr": "French",
  "es": "Spanish",
  "es-419": "Spanish (Latin America)",
  "it": "Italian",
  "pl": "Polish",
  "tr": "Turkish",
  "ja": "Japanese",
  "zh": "Chinese",
  "sv": "Swedish",
  "ar": "Arabic",
  "de": "German",
  "ko": "Korean",
  "pt": "Portuguese",
  "pt-br": "Portuguese (Brazil)",
  "pt-pt": "Portuguese (Portugal)"
} as const;

const languages = new Set(Object.keys(languageMap));
const contentTypes = new Set(["sfw", "nsfw"]);
const comicTypes = new Set(['manga', 'manhwa', 'manhua', 'all']);
const urlBase = "https://api.comick.fun/chapter";

let genreCache: Genre[] = [];

const RETRY_COUNT = 3;
const RETRY_DELAY = 1000;

// Rate limiting configuration - adjust these values if needed
const API_REQUESTS_PER_SECOND = 10;  // Maximum requests per second
const API_CONCURRENT_REQUESTS = 6;   // Maximum concurrent requests
const DELAY_AFTER_429 = 1000;        // Wait 1 second after a rate limit hit

// Create throttled fetch function to avoid rate limits
const throttledFetch = pThrottle({
  limit: API_REQUESTS_PER_SECOND,
  interval: 1000,
  concurrency: API_CONCURRENT_REQUESTS
} as any)((url: string, options: RequestInit = {}, retries = RETRY_COUNT) => {
  return fetchWithRetry(url, options, retries);
});

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

    // Special handling for rate limit errors
    if (response.status === 429) {
      console.warn(`Rate limited on ${url}. Waiting ${DELAY_AFTER_429}ms before retry.`);
      
      // Wait for the specified delay
      await new Promise(resolve => setTimeout(resolve, DELAY_AFTER_429));
      
      // Retry with one less retry count but only if we have retries left
      if (retries > 0) {
        return fetchWithRetry(url, options, retries - 1);
      }
    }

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response;
  } catch (error) {
    if (retries > 0) {
      // For non-429 errors, use exponential backoff
      const delay = Math.min(RETRY_DELAY * Math.pow(2, RETRY_COUNT - retries), 10000);
      console.log(`Retrying after ${delay}ms. Retries left: ${retries-1}`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw error;
  }
}

export async function fetchGenres(): Promise<Genre[]> {
  if (genreCache.length > 0) return genreCache;

  try {
    // No tachiyomi param for genre endpoint
    const response = await throttledFetch('https://api.comick.fun/genre');
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
    
    const response = await throttledFetch(apiUrl);
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

interface ChapterParams {
  limit?: number;
  lang?: string;
}

export async function getComicBySlug(slug: string): Promise<ComicDetail | null> {
  try {
    const response = await throttledFetch(`https://api.comick.fun/comic/${slug}`);
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
    const comicResponse = await throttledFetch(
      `https://api.comick.fun/comic/${hid}`
    );
    const comicData = await comicResponse.json();
    const comicTitle = comicData?.comic?.title || 'Unknown Comic';
    const covers = comicData?.comic?.md_covers || [];
    
    const response = await throttledFetch(
      `https://api.comick.fun/comic/${hid}/chapters?${queryParams}`
    );
    const data = await response.json();
    
    if (!data?.chapters || !Array.isArray(data.chapters)) {
      console.error(`Invalid chapters data for hid ${hid}:`, data);
      return [];
    }

    console.log('Processing chapters for comic:', comicTitle);
    
    const now = new Date();
    
    const chapters: ChapterDetail[] = [];
    const rawChapters = data.chapters || [];

    for (const chap of rawChapters) {
      try {
        // Add created_at check
        if (!chap.id || !chap.chap || !chap.created_at) {
          console.warn(`Skipping chapter with missing fields in ${hid}:`, chap);
          continue;
        }
        
        // Validate both dates
        const isValidCreated = !isNaN(Date.parse(chap.created_at));
        const isValidUpdated = !isNaN(Date.parse(chap.updated_at));
        
        if (!isValidCreated || !isValidUpdated) {
          console.warn(`Invalid dates for chapter ${chap.id}`);
          continue;
        }
        
        chapters.push({
          id: chap.id,
          chap: chap.chap.toString(),
          title: chap.title || `Chapter ${chap.chap}`,
          created_at: new Date(chap.created_at).toISOString(), // Use created_at
          md_comics: {
            title: comicTitle,
            slug: slug,
            md_covers: covers
          }
        });
      } catch (e) {
        console.error(`Error processing chapter ${chap.id}:`, e);
      }
    }

    console.log(`Successfully processed ${chapters.length} chapters for ${comicTitle}`);
    return chapters;
  } catch (error) {
    console.error(`Error fetching chapters for hid ${hid}:`, error);
    return [];
  }
}

// Add deduplication function
function deduplicateChapters(chapters: ChapterDetail[]): ChapterDetail[] {
  const seen = new Set<string>();
  return chapters.filter(chapter => {
    const key = `${chapter.md_comics.slug}-${chapter.chap}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function getChaptersForSlugs(
  slugs: string[], 
  lang: string = 'en'
): Promise<ChapterDetail[]> {
  console.log(`Fetching chapters for ${slugs.length} comics`);
  const redis = await getRedisClient();
  
  const uniqueSlugs = [...new Set(slugs)];
  const pipeline = redis.pipeline();

  // Check cache for all slugs
  uniqueSlugs.forEach(slug => {
    if (!slug.match(/^[a-z0-9-]+$/)) {
      console.error(`Invalid slug format: ${slug}`);
      return; // Skip invalid slugs immediately
    }
    const cacheKey = `chapters:${slug}:${lang}`;
    pipeline.get(cacheKey);
  });

  const cacheResults = await pipeline.exec();
  
  // Process cache results
  const cachedChapters: ChapterDetail[] = [];
  const slugsToFetch: string[] = [];
  
  // Separate cached and uncached slugs in one pass
  cacheResults.forEach(([err, result], index) => {
    const slug = uniqueSlugs[index];
    if (!err && result) {
      try {
        const parsed = JSON.parse(result as string);
        if (Array.isArray(parsed)) {
          cachedChapters.push(...parsed);
        }
      } catch (e) {
        console.error(`Cache parse error for ${slug}:`, e);
        slugsToFetch.push(slug);
      }
    } else {
      slugsToFetch.push(slug);
    }
  });

  // Skip validation if we have recent cache data
  const cachedSlugs = new Set(cachedChapters.map(c => c.md_comics.slug));
  console.log(`Cache hits: ${cachedChapters.length} chapters from ${cachedSlugs.size} comics`);
  
  // Only fetch if we have slugs that need fetching
  let liveChapters: ChapterDetail[] = [];
  if (slugsToFetch.length > 0) {
    console.log(`Fetching ${slugsToFetch.length} comics from API`);
    
    // Use Promise.all for concurrent fetching with higher concurrency
    const fetchPromises = slugsToFetch.map(async (slug) => {
      try {
        const comicDetail = await getComicBySlug(slug);
        
        if (!comicDetail?.comic?.hid) {
          return [];
        }
        
        return getChaptersByHid(comicDetail.comic.hid, slug, {
          limit: 5,
          lang: lang
        });
      } catch (error) {
        console.error(`Error processing ${slug}:`, error);
        return [];
      }
    });

    liveChapters = (await Promise.all(fetchPromises)).flat();
    
    // Cache new results in batch if we have any
    if (liveChapters.length > 0) {
      const cachePipeline = redis.pipeline();
      const chaptersBySlug: Record<string, ChapterDetail[]> = {};

      liveChapters.forEach(chapter => {
        const slug = chapter.md_comics.slug;
        if (!chaptersBySlug[slug]) {
          chaptersBySlug[slug] = [];
        }
        chaptersBySlug[slug].push(chapter);
      });

      Object.entries(chaptersBySlug).forEach(([slug, chaps]) => {
        const cacheKey = `chapters:${slug}:${lang}`;
        cachePipeline.set(
          cacheKey, 
          JSON.stringify(chaps), 
          'EX', 
          CHAPTER_CACHE_TTL
        );
      });

      await cachePipeline.exec();
    }
  }

  // Combine and deduplicate
  return deduplicateChapters([...cachedChapters, ...liveChapters]);
}

// Replace validateSlugs with a more efficient implementation
export async function validateSlugs(slugs: string[]): Promise<string[]> {
  // Skip validation in production for cached items
  if (process.env.NODE_ENV === 'production') {
    return slugs;
  }
  
  const validSlugs: string[] = [];
  const invalidSlugs: string[] = [];
  
  // Increase batch size for faster processing
  const batchSize = 5;
  for (let i = 0; i < slugs.length; i += batchSize) {
    const batch = slugs.slice(i, i + batchSize);
    
    await Promise.all(batch.map(async (slug) => {
      try {
        // Reduced retries (1 instead of 3) and removed tachiyomi parameter
        const response = await throttledFetch(`https://api.comick.fun/comic/${slug}`, {}, 1);
        if (response.ok) {
          validSlugs.push(slug);
        } else {
          invalidSlugs.push(slug);
        }
      } catch {
        invalidSlugs.push(slug);
      }
    }));
  }
  
  if (invalidSlugs.length > 0) {
    console.warn(`Skipping invalid slugs: ${invalidSlugs.length} items`);
  }
  
  return validSlugs;
}