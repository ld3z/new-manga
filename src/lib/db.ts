import Redis from 'ioredis';
import type { FeedMapping } from './types';
import { getChaptersForSlugs } from './api';

// Extended Error interface for network errors
interface RedisNetworkError extends Error {
  code?: string;
}

// Primary Redis configuration
const PRIMARY_REDIS_URL = import.meta.env.PRIMARY_REDIS_URL || process.env.PRIMARY_REDIS_URL || process.env.REDIS_URL;

// Multiple replicas support
const REPLICA_URLS = [
  import.meta.env.REPLICA_REDIS_URL_1 || process.env.REPLICA_REDIS_URL_1 || import.meta.env.REPLICA_REDIS_URL || process.env.REPLICA_REDIS_URL,
  import.meta.env.REPLICA_REDIS_URL_2 || process.env.REPLICA_REDIS_URL_2,
  import.meta.env.REPLICA_REDIS_URL_3 || process.env.REPLICA_REDIS_URL_3,
].filter(Boolean) as string[];

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
const IS_VERCEL = process.env.VERCEL || false;
const VERCEL_CONNECTION_TIMEOUT = 15000; // 15 seconds for Vercel
const LOCAL_CONNECTION_TIMEOUT = 5000;   // 5 seconds for local

// Improved connection handling with exponential backoff
async function createRedisClient(url: string): Promise<Redis> {
  if (!url) throw new Error('Redis URL is not set');
  
  const redisName = getRedisName(url);
  
  // Parse URL to extract authentication info
  const options = {
    retryStrategy: (times) => {
      if (times >= MAX_RETRIES) return null;
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, times), 5000);
      console.log(`${redisName} retry attempt ${times}, next try in ${delay}ms`);
      return delay + Math.random() * 200; // Add jitter
    },
    maxRetriesPerRequest: null,  // Allow retries for queued commands
    enableOfflineQueue: true,     // Enable command queuing
    enableReadyCheck: true,
    connectTimeout: 15000,     // Increase connection timeout to 15 seconds for Vercel's serverless environment
    disconnectTimeout: 10000,   // Increase disconnect timeout to 10 seconds
    keepAlive: 10000,          // Send keepalive every 10 seconds
    commandTimeout: 10000,      // Command timeout
    retryMaxDelay: 5000,        // Maximum delay between retries
    reconnectOnError: (err) => {
      const targetErrors = ['READONLY', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND'];
      return targetErrors.some(e => err.message.includes(e));
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

  // Try primary first
  if (primaryClient?.status === 'ready') {
    try {
      // Add timeout to ping
      const pingPromise = primaryClient.ping();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Ping timeout')), 3000)
      );
      
      await Promise.race([pingPromise, timeoutPromise]);
      return primaryClient;
    } catch (error) {
      console.warn('Primary Redis connection failed, will try replicas:', error);
      // Fall through to try replicas
    }
  }
  
  // Try replicas in sequence
  for (const [url, client] of replicaClients.entries()) {
    if (client.status === 'ready') {
      try {
        // Add timeout to ping
        const pingPromise = client.ping();
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Ping timeout')), 3000)
        );
        
        await Promise.race([pingPromise, timeoutPromise]);
        console.log(`Using ${getRedisName(url)}`);
        return client;
      } catch (error) {
        console.warn(`${getRedisName(url)} connection failed:`, error);
        // Continue to next replica
      }
    }
  }

  // Reconnect to primary
  try {
    console.log('Initializing new primary Redis connection...');
    primaryClient = await createRedisClient(PRIMARY_REDIS_URL!);
    
    primaryClient
      .on('ready', () => console.log('Primary Redis connection ready'))
      .on('error', (err: RedisNetworkError) => {
        // Log more details for connection errors
        if (err.code === 'ETIMEDOUT') {
          console.error('Primary Redis connection timeout. This is common in serverless environments like Vercel. Check your network connectivity and Redis server availability.');
        } else if (err.code === 'ECONNREFUSED') {
          console.error('Primary Redis connection refused. Ensure the Redis server is running and the URL is correct.');
        } else if (err.code === 'ENOTFOUND') {
          console.error('Primary Redis host not found. Check your PRIMARY_REDIS_URL environment variable.');
        } else {
          console.error('Primary Redis error:', err);
        }
      })
      .on('reconnecting', () => console.log('Primary Redis reconnecting'))
      .on('end', () => console.log('Primary Redis connection closed'));
    
    return primaryClient;
  } catch (error) {
    console.error('Failed to connect to primary Redis:', error);
    
    // Special handling for Vercel ETIMEDOUT errors
    if (IS_VERCEL && error instanceof Error && error.message.includes('ETIMEDOUT')) {
      console.log('Encountered ETIMEDOUT in Vercel environment. Retrying with longer timeout...');
      try {
        // Try one more time with increased timeout
        const tempClient = new Redis(PRIMARY_REDIS_URL!, {
          connectTimeout: 20000,  // Increased timeout for last-ditch effort
          retryStrategy: () => null // No retries for this attempt
        });
        
        // Wait for ready or error
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            tempClient.disconnect();
            reject(new Error('Final connection attempt timed out'));
          }, 20000);
          
          tempClient.once('ready', () => {
            clearTimeout(timeout);
            resolve(true);
          });
          
          tempClient.once('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });
        
        // If we get here, connection was successful
        primaryClient = tempClient;
        return tempClient;
      } catch (finalError) {
        console.error('Final Redis connection attempt failed:', finalError);
      }
    }
    
    // Try connecting to any replica that might be available
    for (const url of REPLICA_URLS) {
      try {
        const redisName = getRedisName(url);
        console.log(`Trying to connect to ${redisName}...`);
        const client = await createRedisClient(url);
        
        client
          .on('ready', () => console.log(`${redisName} connection ready`))
          .on('error', (err: RedisNetworkError) => {
            // Log more details for connection errors
            if (err.code === 'ETIMEDOUT') {
              console.error(`${redisName} connection timeout. This is common in serverless environments like Vercel. Check your network connectivity and Redis server availability.`);
            } else if (err.code === 'ECONNREFUSED') {
              console.error(`${redisName} connection refused. Ensure the Redis server is running and the URL is correct.`);
            } else if (err.code === 'ENOTFOUND') {
              console.error(`${redisName} host not found. Check your Redis URL environment variables.`);
            } else {
              console.error(`${redisName} error:`, err);
            }
          })
          .on('reconnecting', () => console.log(`${redisName} reconnecting`))
          .on('end', () => console.log(`${redisName} connection closed`));
        
        replicaClients.set(url, client);
        return client;
      } catch (replicaError) {
        console.error(`Failed to connect to ${getRedisName(url)}:`, replicaError);
        // Continue to next replica
      }
    }
    
    throw new Error('All Redis connections failed');
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