import Redis from 'ioredis';
import type { FeedMapping } from './types';
import { getChaptersForSlugs } from './api';

// Extended Error interface for network errors
interface RedisNetworkError extends Error {
  code?: string;
}

// Primary Redis configuration - with more robust fallbacks and logging
const PRIMARY_REDIS_URL = import.meta.env.PRIMARY_REDIS_URL || process.env.PRIMARY_REDIS_URL || process.env.REDIS_URL;

// Log Redis URL status (without exposing sensitive data)
console.log(`Redis URLs status: Primary=${Boolean(PRIMARY_REDIS_URL)}`);

if (!PRIMARY_REDIS_URL) {
  console.warn('WARNING: No Redis URL configured. Database functionality will not work properly.');
}

// Multiple replicas support
const REPLICA_URLS = [
  import.meta.env.REPLICA_REDIS_URL_1 || process.env.REPLICA_REDIS_URL_1 || import.meta.env.REPLICA_REDIS_URL || process.env.REPLICA_REDIS_URL,
  import.meta.env.REPLICA_REDIS_URL_2 || process.env.REPLICA_REDIS_URL_2,
  import.meta.env.REPLICA_REDIS_URL_3 || process.env.REPLICA_REDIS_URL_3,
].filter(Boolean) as string[];

console.log(`Found ${REPLICA_URLS.length} Redis replica URLs`);

// Create a mapping of URLs to friendly names for logging
const redisInstanceNames = new Map<string, string>();

// Initialize friendly names for each Redis instance
function initializeRedisNames() {
  redisInstanceNames.set(PRIMARY_REDIS_URL!, 'Primary');
  
  REPLICA_URLS.forEach((url, index) => {
    redisInstanceNames.set(url, `Replica ${index + 1}`);
  });
}

// Call this immediately
initializeRedisNames();

// Helper function to get a safe name for a Redis instance
function getRedisName(url: string): string {
  return redisInstanceNames.get(url) || 'Unknown Redis instance';
}

// Client instances
let primaryClient: Redis | null = null;
let replicaClients: Map<string, Redis> = new Map();

const DEFAULT_CACHE_TTL = 60 * 60 * 24 * 30; // 30 days
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 100;
const IS_VERCEL = process.env.VERCEL || import.meta.env.VERCEL || false;
const VERCEL_CONNECTION_TIMEOUT = 25000; // 25 seconds for Vercel
const LOCAL_CONNECTION_TIMEOUT = 5000;   // 5 seconds for local

// Improved connection handling with exponential backoff
async function createRedisClient(url: string): Promise<Redis> {
  if (!url) throw new Error('Redis URL is not set');
  
  const redisName = getRedisName(url);
  console.log(`Connecting to ${redisName} Redis instance in ${IS_VERCEL ? 'Vercel' : 'local'} environment`);
  
  // Parse URL to extract authentication info
  const options = {
    retryStrategy: (times) => {
      if (times >= MAX_RETRIES) {
        console.error(`${redisName} max retries (${MAX_RETRIES}) reached, giving up`);
        return null;
      }
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, times), 5000);
      console.log(`${redisName} retry attempt ${times}, next try in ${delay}ms`);
      return delay + Math.random() * 200; // Add jitter
    },
    maxRetriesPerRequest: 3,    // Limit retries for queued commands
    enableOfflineQueue: true,   // Enable command queuing
    enableReadyCheck: true,
    connectTimeout: IS_VERCEL ? VERCEL_CONNECTION_TIMEOUT : LOCAL_CONNECTION_TIMEOUT,
    disconnectTimeout: 10000,   // Increase disconnect timeout to 10 seconds
    keepAlive: 10000,          // Send keepalive every 10 seconds
    commandTimeout: 15000,      // Command timeout
    retryMaxDelay: 5000,        // Maximum delay between retries
    reconnectOnError: (err) => {
      const targetErrors = ['READONLY', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND'];
      const shouldReconnect = targetErrors.some(e => err.message.includes(e));
      if (shouldReconnect) {
        console.log(`Reconnecting due to error: ${err.message}`);
      }
      return shouldReconnect;
    }
  };

  return new Redis(url, options);
}

// Get the best available Redis client
export async function getRedisClient(): Promise<Redis> {
  // Special handling for Vercel environment
  if (IS_VERCEL) {
    console.log('Running in Vercel environment - using optimized Redis connection strategy');
  }

  // Check if Redis is configured
  if (!PRIMARY_REDIS_URL && REPLICA_URLS.length === 0) {
    throw new Error('No Redis URLs configured. Please check your environment variables in the Vercel dashboard.');
  }

  try {
    // Try primary first
    if (!primaryClient) {
      console.log('Creating new primary Redis client');
      if (!PRIMARY_REDIS_URL) {
        throw new Error('Primary Redis URL is not set. Please check your environment variables.');
      }
      primaryClient = await createRedisClient(PRIMARY_REDIS_URL);
    } else if (primaryClient.status !== 'ready') {
      console.log('Primary Redis client not ready, reconnecting');
      try {
        await primaryClient.disconnect();
      } catch (e) {
        console.error('Error disconnecting primary client:', e);
      }
      primaryClient = await createRedisClient(PRIMARY_REDIS_URL);
    }

    try {
      // Add timeout to ping
      const pingPromise = primaryClient.ping();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Ping timeout')), 5000)
      );
      
      await Promise.race([pingPromise, timeoutPromise]);
      return primaryClient;
    } catch (error) {
      console.error('Primary Redis client ping failed:', error);
      throw error;
    }
  } catch (primaryError) {
    console.error('Error connecting to primary Redis:', primaryError);
    
    // Special handling for Vercel ETIMEDOUT errors
    if (IS_VERCEL && primaryError instanceof Error) {
      const errorMsg = primaryError.message;
      
      if (errorMsg.includes('ETIMEDOUT')) {
        console.log('Encountered ETIMEDOUT in Vercel environment. This is a common issue with Vercel serverless functions and Redis.');
        throw new Error('Redis connection timed out. Please ensure your Redis service allows connections from Vercel IP ranges. See Vercel documentation for IP ranges used by their serverless functions.');
      } else if (errorMsg.includes('ECONNREFUSED')) {
        throw new Error('Redis connection refused. Please check if your Redis service is running and accessible from Vercel.');
      } else if (errorMsg.includes('ENOTFOUND')) {
        throw new Error('Redis host not found. Please check your PRIMARY_REDIS_URL environment variable.');
      }
    }
    
    throw primaryError;
  }
}

// Write to primary and all replicas for redundancy
export async function writeToAllRedis(operation: (redis: Redis) => Promise<any>): Promise<void> {
  const errors = [];
  let successCount = 0;
  
  // Try primary
  try {
    if (!primaryClient || primaryClient.status !== 'ready') {
      primaryClient = await createRedisClient(PRIMARY_REDIS_URL!);
    }
    await operation(primaryClient);
    successCount++;
  } catch (error) {
    console.error('Failed to write to Primary Redis:', error);
    errors.push(error);
  }
  
  // Try all replicas
  for (const url of REPLICA_URLS) {
    try {
      let client = replicaClients.get(url);
      if (!client || client.status !== 'ready') {
        client = await createRedisClient(url);
        replicaClients.set(url, client);
      }
      await operation(client);
      successCount++;
    } catch (error) {
      console.error(`Failed to write to ${getRedisName(url)}:`, error);
      errors.push(error);
    }
  }
  
  // If all writes failed, throw an error
  if (successCount === 0) {
    throw new Error('Failed to write to any Redis instance');
  }
  
  // Log warning if some writes failed
  if (errors.length > 0) {
    console.warn(`${errors.length} Redis writes failed out of ${errors.length + successCount} attempts`);
  }
}

// Initialize all connections on startup
(async () => {
  try {
    // Initialize primary
    if (PRIMARY_REDIS_URL) {
      primaryClient = await createRedisClient(PRIMARY_REDIS_URL);
      await primaryClient.ping();
      console.log('Primary Redis pre-connected successfully');
    }
    
    // Initialize all replicas
    for (const url of REPLICA_URLS) {
      try {
        const client = await createRedisClient(url);
        await client.ping();
        replicaClients.set(url, client);
        console.log(`${getRedisName(url)} pre-connected successfully`);
      } catch (error) {
        console.error(`Failed to pre-connect to ${getRedisName(url)}:`, error);
      }
    }
    
    console.log(`Redis setup complete: 1 primary and ${replicaClients.size} replicas connected`);
  } catch (error) {
    console.error('Redis pre-connection failed:', error);
  }
})();

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
  if (!feedId) throw new Error('Feed ID is required');
  if (!Array.isArray(slugs) || slugs.length === 0) throw new Error('Slugs array is required and cannot be empty');
  if (!lang) throw new Error('Language is required');

  const mapping = {
    slugs,
    lang,
    created_at: new Date().toISOString()
  };
  
  console.log(`Attempting to store feed mapping with ID: ${feedId}, language: ${lang}, and ${slugs.length} slugs`);
  
  // Check if Redis is configured
  if (!PRIMARY_REDIS_URL && REPLICA_URLS.length === 0) {
    console.error('No Redis URLs configured. Cannot store feed mapping.');
    throw new Error('Database connection not configured. Please check your environment variables.');
  }
  
  try {
    await writeToAllRedis(async (redis) => {
      console.log(`Writing feed mapping to Redis instance...`);
      
      try {
        await redis.set(
          feedId, 
          JSON.stringify(mapping),
          'EX',
          DEFAULT_CACHE_TTL
        );
        console.log(`Successfully stored feed mapping in Redis instance`);
      } catch (redisError: any) {
        console.error(`Redis set operation failed:`, redisError);
        throw new Error(`Redis operation failed: ${redisError.message || 'Unknown Redis error'}`);
      }
    });
    
    console.log(`Feed mapping successfully stored with ID: ${feedId}`);
  } catch (error: any) {
    console.error('Error storing feed mapping:', error);
    
    // Check for common connection issues
    const errorMsg = error.message || '';
    if (errorMsg.includes('ECONNREFUSED')) {
      throw new Error('Unable to connect to the Redis database. Connection refused.');
    } else if (errorMsg.includes('ETIMEDOUT')) {
      throw new Error('Connection to Redis database timed out. This may be due to network issues or firewall settings.');
    } else if (errorMsg.includes('ENOTFOUND')) {
      throw new Error('Redis host not found. Please check your database URL configuration.');
    } else {
      throw new Error(`Failed to store feed mapping: ${errorMsg}`);
    }
  }
}

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
  let foundMapping: string | null = null;
  let sourceRedisName: string = "";
  
  // First try primary
  try {
    // Check primary database if available
    if (primaryClient?.status === 'ready') {
      try {
        await primaryClient.ping();
        const mapping = await primaryClient.get(feedId);
        if (mapping) {
          await primaryClient.expire(feedId, DEFAULT_CACHE_TTL);
          foundMapping = mapping;
          sourceRedisName = "Primary";
        }
      } catch (error) {
        console.warn('Primary Redis connection failed while retrieving mapping:', error);
        // Fall through to try replicas
      }
    }

    // If not found in primary, check replicas
    if (!foundMapping) {
      for (const [url, client] of replicaClients.entries()) {
        if (client.status === 'ready') {
          try {
            await client.ping();
            console.log(`Trying to get key from ${getRedisName(url)}`);
            const mapping = await client.get(feedId);
            if (mapping) {
              await client.expire(feedId, DEFAULT_CACHE_TTL);
              foundMapping = mapping;
              sourceRedisName = getRedisName(url);
              break; // Exit the loop once we find the mapping
            }
          } catch (error) {
            console.warn(`${getRedisName(url)} connection failed while retrieving mapping:`, error);
            // Continue to next replica
          }
        }
      }
    }

    // If we found the mapping in any database, re-synchronize to all other databases
    if (foundMapping) {
      console.log(`Found mapping in ${sourceRedisName}. Re-synchronizing to all Redis instances...`);
      
      // Parse data for returning
      const data = JSON.parse(foundMapping);
      const result = {
        slugs: data.slugs,
        lang: data.lang
      };
      
      // Fire-and-forget re-sync to all databases
      (async () => {
        try {
          await writeToAllRedis(async (redis) => {
            await redis.set(
              feedId, 
              foundMapping!, 
              'EX',
              DEFAULT_CACHE_TTL
            );
          });
          console.log(`Successfully re-synchronized mapping for ${feedId} to all Redis instances`);
        } catch (syncError) {
          console.error('Error during Redis re-synchronization:', syncError);
        }
      })();
      
      return result;
    }

    // If we get here, the key wasn't found in any database
    return null;
  } catch (error) {
    console.error('Error retrieving feed mapping:', error);
    throw new Error('Failed to retrieve feed mapping');
  }
}

// No need for manual cleanup as we're using TTL (expire) 