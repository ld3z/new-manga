import Redis from 'ioredis';
import type { FeedMapping } from './types';
import { getChaptersForSlugs } from './api';

const PRIMARY_REDIS_URL = import.meta.env.PRIMARY_REDIS_URL || process.env.PRIMARY_REDIS_URL || process.env.REDIS_URL;
const REPLICA_REDIS_URL = import.meta.env.REPLICA_REDIS_URL || process.env.REPLICA_REDIS_URL;
let redisClient: Redis | null = null;
let replicaClient: Redis | null = null;
const DEFAULT_CACHE_TTL = 60 * 60 * 24 * 30; // 30 days
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 100;

// Improved connection handling with exponential backoff
async function createRedisClient(url: string): Promise<Redis> {
  if (!url) throw new Error('Redis URL is not set');
  
  return new Redis(url, {
    retryStrategy: (times) => {
      if (times >= MAX_RETRIES) return null;
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, times), 5000);
      console.log(`Redis retry attempt ${times}, next try in ${delay}ms`);
      return delay + Math.random() * 200; // Add jitter
    },
    maxRetriesPerRequest: null,  // Allow retries for queued commands
    enableOfflineQueue: true,     // Enable command queuing
    enableReadyCheck: true,
    reconnectOnError: (err) => {
      return err.message.includes('READONLY');
    }
  });
}

// Get the best available Redis client
export async function getRedisClient(): Promise<Redis> {
  // Try primary first
  if (redisClient?.status === 'ready') {
    try {
      await redisClient.ping();
      return redisClient;
    } catch (error) {
      console.warn('Primary Redis connection failed, will try replica:', error);
      // Fall through to try replica
    }
  }
  
  // Try replica if available
  if (REPLICA_REDIS_URL && replicaClient?.status === 'ready') {
    try {
      await replicaClient.ping();
      return replicaClient;
    } catch (error) {
      console.warn('Replica Redis connection failed:', error);
      // Fall through to reconnect
    }
  }

  // Reconnect to primary
  try {
    console.log('Initializing new primary Redis connection...');
    redisClient = await createRedisClient(PRIMARY_REDIS_URL!);
    
    redisClient
      .on('ready', () => console.log('Primary Redis connection ready'))
      .on('error', (err) => console.error('Primary Redis error:', err))
      .on('reconnecting', () => console.log('Primary Redis reconnecting'))
      .on('end', () => console.log('Primary Redis connection closed'));
    
    return redisClient;
  } catch (error) {
    console.error('Failed to connect to primary Redis:', error);
    
    // If primary fails and we have a replica URL, try connecting to replica
    if (REPLICA_REDIS_URL) {
      console.log('Falling back to replica Redis...');
      replicaClient = await createRedisClient(REPLICA_REDIS_URL);
      
      replicaClient
        .on('ready', () => console.log('Replica Redis connection ready'))
        .on('error', (err) => console.error('Replica Redis error:', err))
        .on('reconnecting', () => console.log('Replica Redis reconnecting'))
        .on('end', () => console.log('Replica Redis connection closed'));
      
      return replicaClient;
    }
    
    throw new Error('All Redis connections failed');
  }
}

// Write to both primary and replica for redundancy
export async function writeToAllRedis(operation: (redis: Redis) => Promise<any>): Promise<void> {
  const errors = [];
  
  // Try primary
  try {
    if (!redisClient || redisClient.status !== 'ready') {
      redisClient = await createRedisClient(PRIMARY_REDIS_URL!);
    }
    await operation(redisClient);
  } catch (error) {
    console.error('Failed to write to primary Redis:', error);
    errors.push(error);
  }
  
  // Try replica if available (for redundancy)
  if (REPLICA_REDIS_URL) {
    try {
      if (!replicaClient || replicaClient.status !== 'ready') {
        replicaClient = await createRedisClient(REPLICA_REDIS_URL);
      }
      await operation(replicaClient);
    } catch (error) {
      console.error('Failed to write to replica Redis:', error);
      errors.push(error);
    }
  }
  
  // If both writes failed, throw an error
  if (errors.length === (REPLICA_REDIS_URL ? 2 : 1)) {
    throw new Error('Failed to write to any Redis instance');
  }
}

// Update existing functions to use the new methods

export async function storeFeedMappings(mappings: Array<{ feedId: string, slugs: string[], lang: string }>): Promise<void> {
  await writeToAllRedis(async (redis) => {
    const pipeline = redis.pipeline();
    
    mappings.forEach(({ feedId, slugs, lang }) => {
      const mapping = {
        slugs,
        lang,
        created_at: new Date().toISOString()
      };
      pipeline.set(feedId, JSON.stringify(mapping), 'EX', DEFAULT_CACHE_TTL);
    });
    
    await pipeline.exec();
  });
}

export async function warmChapterCache(slugs: string[], lang: string): Promise<void> {
  const redis = await getRedisClient();
  const needsCache = await checkCacheStatus(slugs, lang);
  
  if (needsCache.length > 0) {
    console.log(`Pre-warming cache for ${needsCache.length} comics`);
    
    await writeToAllRedis(async (redis) => {
      const pipeline = redis.pipeline();
      
      await Promise.all(needsCache.map(async slug => {
        try {
          const chapters = await getChaptersForSlugs([slug], lang);
          const cacheKey = `chapters:${slug}:${lang}`;
          pipeline.set(cacheKey, JSON.stringify(chapters), 'EX', 60 * 60);
        } catch (error) {
          console.error(`Failed to warm cache for ${slug}:`, error);
        }
      }));
      
      await pipeline.exec();
    });
  }
}

export async function storeFeedMapping(feedId: string, slugs: string[], lang: string): Promise<void> {
  const mapping = {
    slugs,
    lang,
    created_at: new Date().toISOString()
  };
  
  try {
    await writeToAllRedis(async (redis) => {
      await redis.set(
        feedId, 
        JSON.stringify(mapping),
        'EX',
        DEFAULT_CACHE_TTL
      );
    });
  } catch (error) {
    console.error('Error storing feed mapping:', error);
    throw new Error('Failed to store feed mapping');
  }
}

// Initialize both connections on startup
(async () => {
  try {
    // Initialize primary
    if (PRIMARY_REDIS_URL) {
      redisClient = await createRedisClient(PRIMARY_REDIS_URL);
      await redisClient.ping();
      console.log('Primary Redis pre-connected successfully');
    }
    
    // Initialize replica if available
    if (REPLICA_REDIS_URL) {
      replicaClient = await createRedisClient(REPLICA_REDIS_URL);
      await replicaClient.ping();
      console.log('Replica Redis pre-connected successfully');
    }
  } catch (error) {
    console.error('Redis pre-connection failed:', error);
  }
})();

// Batch operations for better performance
export async function checkCacheStatus(slugs: string[], lang: string): Promise<string[]> {
  const redis = await getRedisClient();
  const pipeline = redis.pipeline();
  
  slugs.forEach(slug => {
    const cacheKey = `chapters:${slug}:${lang}`;
    pipeline.exists(cacheKey);
  });

  const results = await pipeline.exec();
  return slugs.filter((_, index) => results![index][1] === 0);
}

export async function getFeedMapping(feedId: string): Promise<FeedMapping | null> {
  const redis = await getRedisClient();
  
  try {
    const mapping = await redis.get(feedId);
    if (!mapping) return null;
    
    await redis.expire(feedId, DEFAULT_CACHE_TTL);
    
    const data = JSON.parse(mapping);
    return {
      slugs: data.slugs,
      lang: data.lang
    };
  } catch (error) {
    console.error('Error retrieving feed mapping:', error);
    throw new Error('Failed to retrieve feed mapping');
  }
}

// No need for manual cleanup as we're using TTL (expire) 