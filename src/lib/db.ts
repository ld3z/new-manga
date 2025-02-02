import Redis from 'ioredis';
import type { FeedMapping } from './types';

const REDIS_URL = import.meta.env.REDIS_URL || process.env.REDIS_URL;
let redis: Redis | null = null;
let redisRetryCount = 0;
const MAX_RETRIES = 3;
const DEFAULT_CACHE_TTL = 60 * 60 * 24 * 30; // 30 days

try {
  console.log('Environment check:', {
    hasEnvVar: !!REDIS_URL,
    envVarStart: REDIS_URL?.substring(0, 20) + '...',
    nodeEnv: process.env.NODE_ENV
  });

  if (!REDIS_URL) {
    throw new Error('REDIS_URL environment variable is not set');
  }

  console.log('Attempting to connect to Redis...');
  
  redis = new Redis(REDIS_URL, {
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      console.log(`Retry attempt ${times} with delay ${delay}ms`);
      return delay;
    },
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    reconnectOnError: (err) => {
      const targetError = 'READONLY';
      if (err.message.includes(targetError)) {
        return true;
      }
      return false;
    }
  });

  redis.on('error', (error) => {
    console.error('Redis connection error:', error.message);
  });

  redis.on('connect', () => {
    console.log('Successfully connected to Redis');
  });

  redis.on('ready', () => {
    console.log('Redis client is ready');
  });

  redis.on('reconnecting', () => {
    console.log('Redis client is reconnecting');
  });

} catch (error) {
  console.error('Failed to initialize Redis:', error);
  if (error instanceof Error) {
    console.error('Error details:', error.message);
    console.error('Stack trace:', error.stack);
  }
}

export async function getRedisClient(): Promise<Redis> {
  if (redis?.status === 'ready') return redis;
  
  if (redisRetryCount >= MAX_RETRIES) {
    throw new Error('Failed to connect to Redis after multiple attempts');
  }
  
  try {
    redis = new Redis(REDIS_URL, {
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        console.log(`Retry attempt ${times} with delay ${delay}ms`);
        return delay;
      },
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      reconnectOnError: (err) => {
        const targetError = 'READONLY';
        if (err.message.includes(targetError)) {
          return true;
        }
        return false;
      }
    });
    redisRetryCount = 0;
    return redis;
  } catch (error) {
    redisRetryCount++;
    throw error;
  }
}

export async function storeFeedMapping(feedId: string, slugs: string[], lang: string): Promise<void> {
  if (!redis) {
    console.error('Redis client not initialized');
    throw new Error('Storage system unavailable');
  }

  const mapping = {
    slugs,
    lang,
    created_at: new Date().toISOString()
  };
  
  try {
    await redis.set(
      feedId, 
      JSON.stringify(mapping),
      'EX',
      DEFAULT_CACHE_TTL
    );
  } catch (error) {
    console.error('Error storing feed mapping:', error);
    throw new Error('Failed to store feed mapping');
  }
}

export async function getFeedMapping(feedId: string): Promise<FeedMapping | null> {
  if (!redis) {
    console.error('Redis client not initialized');
    throw new Error('Storage system unavailable');
  }

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