import Redis from 'ioredis';
import type { FeedMapping } from './types';
import { getChaptersForSlugs } from './api';

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
    reconnectOnError: (err) => {
      return err.message.includes('READONLY');
    }
  };

  return new Redis(url, options);
}

// Get the best available Redis client
export async function getRedisClient(): Promise<Redis> {
  // Try primary first
  if (primaryClient?.status === 'ready') {
    try {
      await primaryClient.ping();
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
        await client.ping();
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
      .on('error', (err) => console.error('Primary Redis error:', err))
      .on('reconnecting', () => console.log('Primary Redis reconnecting'))
      .on('end', () => console.log('Primary Redis connection closed'));
    
    return primaryClient;
  } catch (error) {
    console.error('Failed to connect to primary Redis:', error);
    
    // Try connecting to any replica that might be available
    for (const url of REPLICA_URLS) {
      try {
        const redisName = getRedisName(url);
        console.log(`Trying to connect to ${redisName}...`);
        const client = await createRedisClient(url);
        
        client
          .on('ready', () => console.log(`${redisName} connection ready`))
          .on('error', (err) => console.error(`${redisName} error:`, err))
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