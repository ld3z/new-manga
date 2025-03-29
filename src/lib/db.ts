import Redis from "ioredis";
import type { FeedMapping } from "./types";
import { ReJSON } from 'redis-modules-sdk';
import * as zlib from 'zlib';
import { promisify } from 'util';

// Configuration constants
const DEFAULT_CACHE_TTL = 60 * 60 * 24 * 30; // 30 days
export const CHAPTER_CACHE_TTL = 60 * 60; // 1 hour
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 50;
const IS_VERCEL = process.env.VERCEL || false;
const HEALTH_CHECK_INTERVAL = 60 * 1000; // Check primary health every minute
const REPLICA_PROMOTION_THRESHOLD = 5; // After 5 failed primary health checks, promote a replica to primary
const SYNC_BUFFER_SIZE = 100; // Maximum number of operations to buffer before syncing
const SYNC_INTERVAL = 10 * 1000; // Sync replicas every 10 seconds

// Redis URLs from environment variables
const PRIMARY_REDIS_URL =
  import.meta.env.PRIMARY_REDIS_URL ||
  process.env.PRIMARY_REDIS_URL ||
  process.env.REDIS_URL;

const REPLICA_URLS = [
  import.meta.env.REPLICA_REDIS_URL_1 ||
    process.env.REPLICA_REDIS_URL_1 ||
    import.meta.env.REPLICA_REDIS_URL,
  import.meta.env.REPLICA_REDIS_URL_2 || process.env.REPLICA_REPLICA_URL_2 || process.env.REPLICA_REDIS_URL_2,
  import.meta.env.REPLICA_REDIS_URL_3 || process.env.REPLICA_REDIS_URL_3,
].filter(Boolean) as string[];

// Log available Redis instances
console.log(`Primary Redis URL: ${PRIMARY_REDIS_URL ? 'Available' : 'Not configured'}`);
console.log(`Replica URLs available: ${REPLICA_URLS.length}`);

// Singleton clients with health status tracking
let primaryClient: Redis | null = null;
let primaryHealthy: boolean = true;
let primaryFailedChecks = 0;
let replicaClients: Map<string, Redis> = new Map();
let activeReplicaUrl: string | null = null;

// Track which replica was used when primary was down
let lastUsedReplica: string | null = null;

// Operation buffer for sync
interface RedisOperation {
  key: string;
  value: string;
  ttl?: number;
  type: 'set' | 'del';
  timestamp: number;
}

// Buffer to store operations that need to be synced
const operationBuffer: RedisOperation[] = [];

// Redis instance naming for logging
const redisInstanceNames = new Map<string, string>();

// Add zlib for compression
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Compression threshold (in bytes)
const COMPRESSION_THRESHOLD = 1024; // 1KB

// Helper function to determine if compression should be used
function shouldCompress(data: string): boolean {
  return Buffer.byteLength(data, 'utf8') > COMPRESSION_THRESHOLD;
}

/**
 * Initialize Redis instance names for better logging
 */
function initializeRedisNames() {
  if (PRIMARY_REDIS_URL) {
    redisInstanceNames.set(PRIMARY_REDIS_URL, "Primary");
  }
  
  REPLICA_URLS.forEach((url, index) =>
    redisInstanceNames.set(url, `Replica ${index + 1}`)
  );
}

initializeRedisNames();

/**
 * Get the friendly name of a Redis instance
 */
const getRedisName = (url: string) => redisInstanceNames.get(url) || "Unknown";

// Add at the top of your file, after the imports
declare module "ioredis" {
  interface Redis {
    json_set(key: string, path: string, json: any): Promise<string>;
    json_get(key: string, ...paths: string[]): Promise<string>;
  }
}

/**
 * Create a new Redis client with optimized settings
 */
async function createRedisClient(url: string): Promise<Redis> {
  if (!url) {
    throw new Error("Redis URL not provided");
  }

  const redisName = getRedisName(url);
  
  const client = new Redis(url, {
    retryStrategy: (times) => {
      if (times >= MAX_RETRIES) return null;
      return Math.min(BASE_DELAY_MS * Math.pow(1.5, times), 1000);
    },
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    enableReadyCheck: true,
    connectTimeout: 3000,
    keepAlive: 5000,
    commandTimeout: 3000,
    reconnectOnError: (err) =>
      ["READONLY", "ETIMEDOUT", "ECONNRESET"].some((e) =>
        err.message.includes(e)
      ),
  });

  // Setup event listeners
  client
    .on("ready", () => {
      console.log(`${redisName} ready`);
      
      // If primary recovers and we had used a replica, initiate sync from replica to primary
      if (url === PRIMARY_REDIS_URL && lastUsedReplica) {
        syncFromReplicaToPrimary(lastUsedReplica).catch(err => 
          console.error(`Failed to sync from replica to primary: ${err}`));
      }
    })
    .on("error", (err) => {
      console.error(`${redisName} error:`, err);
      if (url === PRIMARY_REDIS_URL) {
        primaryHealthy = false;
      }
    })
    .on("reconnecting", () => console.log(`${redisName} reconnecting`))
    .on("end", () => {
      console.log(`${redisName} closed`);
      if (url === PRIMARY_REDIS_URL) {
        primaryHealthy = false;
      }
    });

  return client;
}

/**
 * Initialize all replicas to establish connections early
 */
async function initializeAllClients(): Promise<void> {
  try {
    // Initialize primary
    if (PRIMARY_REDIS_URL && (!primaryClient || primaryClient.status !== "ready")) {
      primaryClient = await createRedisClient(PRIMARY_REDIS_URL);
      primaryHealthy = await checkConnection(primaryClient, "Primary");
      console.log(`Primary Redis initialized, healthy: ${primaryHealthy}`);
    }
    
    // Initialize all replicas
    for (const url of REPLICA_URLS) {
      if (!replicaClients.has(url)) {
        try {
          const client = await createRedisClient(url);
          const isHealthy = await checkConnection(client, getRedisName(url));
          if (isHealthy) {
            replicaClients.set(url, client);
            console.log(`Replica ${getRedisName(url)} initialized successfully`);
          }
        } catch (error) {
          console.error(`Failed to initialize replica ${getRedisName(url)}:`, error);
        }
      }
    }
    
    console.log(`Initialized ${replicaClients.size} replica connections`);
  } catch (error) {
    console.error("Error during client initialization:", error);
  }
}

/**
 * Check if a Redis client is connected and responsive
 */
async function checkConnection(client: Redis, name: string): Promise<boolean> {
  try {
    await Promise.race([
      client.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Ping timeout")), 2000)
      ),
    ]);
    return true;
  } catch (err) {
    console.warn(`${name} ping failed:`, err);
    return false;
  }
}

/**
 * Get an active Redis client from the pool
 * Prioritizes primary, falls back to replicas
 */
export async function getRedisClient(): Promise<Redis> {
  // Try primary client first if it's considered healthy
  if (primaryHealthy && (primaryClient === null || primaryClient.status !== "ready")) {
    try {
      primaryClient = await createRedisClient(PRIMARY_REDIS_URL!);
      const isPrimaryConnected = await checkConnection(primaryClient, "Primary");
      primaryHealthy = isPrimaryConnected;
      if (isPrimaryConnected) {
        primaryFailedChecks = 0;
        console.log("Initialized primary Redis connection");
        return primaryClient;
      }
    } catch (err) {
      console.error("Failed to initialize primary Redis:", err);
      primaryHealthy = false;
      primaryFailedChecks++;
    }
  } else if (primaryHealthy && primaryClient && primaryClient.status === "ready") {
    return primaryClient;
  }

  // Primary is unhealthy, try to use the active replica if we have one
  if (activeReplicaUrl && replicaClients.has(activeReplicaUrl)) {
    const activeReplica = replicaClients.get(activeReplicaUrl)!;
    if (activeReplica.status === "ready" && await checkConnection(activeReplica, getRedisName(activeReplicaUrl))) {
      console.log(`Using active replica: ${getRedisName(activeReplicaUrl)}`);
      lastUsedReplica = activeReplicaUrl; // Track that we used this replica
      return activeReplica;
    }
  }

  // No active replica, try replicas in order
  for (const url of REPLICA_URLS) {
    try {
      let client = replicaClients.get(url);
      if (!client || client.status !== "ready") {
        client = await createRedisClient(url);
        replicaClients.set(url, client);
      }
      
      if (await checkConnection(client, getRedisName(url))) {
        console.log(`Switching to replica: ${getRedisName(url)}`);
        activeReplicaUrl = url;
        lastUsedReplica = url; // Track that we used this replica
        
        // If primary has been down for a while, promote this replica to be the new primary
        if (primaryFailedChecks >= REPLICA_PROMOTION_THRESHOLD) {
          console.log(`Promoting ${getRedisName(url)} to primary after ${primaryFailedChecks} failed checks`);
          primaryClient = client;
          primaryHealthy = true;
          primaryFailedChecks = 0;
        }
        
        return client;
      }
    } catch (err) {
      console.error(`Failed to connect to replica ${getRedisName(url)}:`, err);
    }
  }

  // If all else fails, try one more time with primary
  console.warn("All Redis connections failed, making last attempt with primary");
  primaryClient = await createRedisClient(PRIMARY_REDIS_URL!);
  return primaryClient;
}

/**
 * Get all available replicas that are not the active client
 */
async function getAvailableReplicas(activeClientUrl: string): Promise<Redis[]> {
  const availableReplicas: Redis[] = [];
  
  // Initialize clients if not already done
  await initializeAllClients();
  
  // Check each replica
  for (const [url, client] of replicaClients.entries()) {
    if (url !== activeClientUrl && client.status === "ready") {
      try {
        const isHealthy = await checkConnection(client, getRedisName(url));
        if (isHealthy) {
          availableReplicas.push(client);
        }
      } catch (error) {
        console.error(`Error checking replica ${getRedisName(url)}:`, error);
      }
    }
  }
  
  console.log(`Found ${availableReplicas.length} available replicas for replication`);
  return availableReplicas;
}

/**
 * Immediately replicate a Redis operation to all available replicas
 */
async function replicateOperation(
  activeClientUrl: string,
  key: string, 
  value: string, 
  ttl?: number
): Promise<void> {
  try {
    // Get available replicas that are not the active client
    const replicas = await getAvailableReplicas(activeClientUrl);
    
    if (replicas.length === 0) {
      console.log('No available replicas for replication');
      return;
    }
    
    console.log(`Replicating operation for key ${key} to ${replicas.length} replicas`);
    
    // Replicate to each available replica
    const replicationPromises = replicas.map(async (replica) => {
      try {
        if (ttl) {
          await replica.set(key, value, 'EX', ttl);
        } else {
          await replica.set(key, value);
        }
        return true;
      } catch (error) {
        console.error(`Replication failed for key ${key}:`, error);
        return false;
      }
    });
    
    const results = await Promise.allSettled(replicationPromises);
    const successful = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
    
    console.log(`Successfully replicated to ${successful}/${replicas.length} replicas`);
  } catch (error) {
    console.error('Error during replication:', error);
  }
}

/**
 * Synchronize data from a replica to the primary
 * Used when primary recovers after being down
 */
async function syncFromReplicaToPrimary(replicaUrl: string): Promise<void> {
  if (!primaryClient || primaryClient.status !== "ready" || !replicaClients.has(replicaUrl)) {
    console.log("Cannot sync: primary or replica not available");
    return;
  }
  
  const replicaClient = replicaClients.get(replicaUrl)!;
  console.log(`Starting sync from ${getRedisName(replicaUrl)} to Primary...`);
  
  try {
    // Get all feed keys using scan to prevent blocking
    const feedKeys: string[] = [];
    let cursor = '0';
    
    do {
      const [nextCursor, keys] = await replicaClient.scan(
        cursor, 
        'MATCH', 
        '[0-9a-f]*', // Match feed IDs (hex format)
        'COUNT',
        '100'
      );
      
      cursor = nextCursor;
      feedKeys.push(...keys);
    } while (cursor !== '0');
    
    // Also try scanning for any key pattern that might be a feed ID
    cursor = '0';
    const additionalKeys: string[] = [];
    
    do {
      const [nextCursor, keys] = await replicaClient.scan(
        cursor,
        'MATCH',
        'feed:*', // Try another pattern
        'COUNT',
        '100'
      );
      
      cursor = nextCursor;
      additionalKeys.push(...keys);
    } while (cursor !== '0');
    
    feedKeys.push(...additionalKeys);
    
    // Get chapter cache keys
    const chapterKeys: string[] = [];
    cursor = '0';
    
    do {
      const [nextCursor, keys] = await replicaClient.scan(
        cursor,
        'MATCH',
        'chapters:*',
        'COUNT',
        '100'
      );
      
      cursor = nextCursor;
      chapterKeys.push(...keys);
    } while (cursor !== '0');
    
    console.log(`Found ${feedKeys.length} feed keys and ${chapterKeys.length} chapter keys to sync`);
    
    // Sync feed mappings
    if (feedKeys.length > 0) {
      const feedPipeline = primaryClient.pipeline();
      
      for (const key of feedKeys) {
        const value = await replicaClient.get(key);
        const ttl = await replicaClient.ttl(key);
        
        if (value && ttl > 0) {
          feedPipeline.set(key, value, 'EX', ttl);
        }
      }
      
      await feedPipeline.exec();
      console.log(`Synced ${feedKeys.length} feed mappings from replica to primary`);
    }
    
    // Sync chapter cache
    if (chapterKeys.length > 0) {
      const chapterPipeline = primaryClient.pipeline();
      
      for (const key of chapterKeys) {
        const value = await replicaClient.get(key);
        const ttl = await replicaClient.ttl(key);
        
        if (value && ttl > 0) {
          chapterPipeline.set(key, value, 'EX', ttl);
        }
      }
      
      await chapterPipeline.exec();
      console.log(`Synced ${chapterKeys.length} chapter caches from replica to primary`);
    }
    
    lastUsedReplica = null; // Reset after successful sync
    console.log("Replica to primary sync completed successfully");
  } catch (error) {
    console.error("Error during replica to primary sync:", error);
  }
}

/**
 * Store a feed mapping in Redis with immediate replication
 */
export async function storeFeedMapping(
  feedId: string,
  slugs: string[],
  lang: string
): Promise<void> {
  const mapping = { 
    slugs, 
    lang, 
    created_at: new Date().toISOString() 
  };
  
  const stringValue = JSON.stringify(mapping);
  
  try {
    // Get Redis client
    const redis = await getRedisClient();
    const activeUrl = redis.options.host || '';
    
    // Check if compression should be used
    if (shouldCompress(stringValue)) {
      console.log(`Compressing large feed mapping for ${feedId} (${Buffer.byteLength(stringValue, 'utf8')} bytes)`);
      const compressed = await gzip(stringValue);
      const base64Compressed = compressed.toString('base64');
      
      // Store with compression flag
      await redis.set(`${feedId}:compressed`, base64Compressed, "EX", DEFAULT_CACHE_TTL);
      console.log(`Stored compressed mapping (${base64Compressed.length} bytes)`);
      
      // Replicate to other instances
      const replicas = await getAvailableReplicas(activeUrl);
      for (const replica of replicas) {
        await replica.set(`${feedId}:compressed`, base64Compressed, "EX", DEFAULT_CACHE_TTL);
      }
    } else {
      // Use standard set operations without compression
      await redis.set(feedId, stringValue, "EX", DEFAULT_CACHE_TTL);
      
      // Replicate to other instances
      const replicas = await getAvailableReplicas(activeUrl);
      for (const replica of replicas) {
        await replica.set(feedId, stringValue, "EX", DEFAULT_CACHE_TTL);
      }
    }
    
    console.log(`Successfully stored mapping for feed ${feedId}`);
  } catch (error) {
    console.error(`Error storing feed mapping for ${feedId}:`, error);
    throw error;
  }
}

/**
 * Retrieve a feed mapping from Redis with automatic failover
 */
export async function getFeedMapping(
  feedId: string
): Promise<FeedMapping | null> {
  try {
    // Try primary first
    const redis = await getRedisClient();
    
    // Check for compressed version first
    const compressedKey = `${feedId}:compressed`;
    const compressedData = await redis.get(compressedKey);
    
    if (compressedData) {
      console.log(`Found compressed data for ${feedId}`);
      try {
        // Decompress and parse
        const buffer = Buffer.from(compressedData, 'base64');
        const decompressed = await gunzip(buffer);
        const data = JSON.parse(decompressed.toString());
        
        // Reset expiration
        await redis.expire(compressedKey, DEFAULT_CACHE_TTL);
        
        return {
          slugs: data.slugs,
          lang: data.lang
        };
      } catch (error) {
        console.error(`Error decompressing data for ${feedId}:`, error);
        // Fall through to try uncompressed version
      }
    }
    
    // If no compressed version, try regular key
    let jsonString = await redis.get(feedId);
    
    // If not found in primary but we have replicas, check them
    if (!jsonString && REPLICA_URLS.length > 0 && redis === primaryClient) {
      console.log(`Key ${feedId} not found in primary, checking replicas...`);
      
      // Try each replica
      for (const [url, replicaClient] of replicaClients.entries()) {
        if (replicaClient.status === "ready") {
          try {
            jsonString = await replicaClient.get(feedId);
            if (jsonString) {
              console.log(`Found key ${feedId} in replica ${getRedisName(url)}`);
              
              // Sync this key back to primary for future requests
              if (primaryClient && primaryClient.status === "ready") {
                primaryClient.set(feedId, jsonString, "EX", DEFAULT_CACHE_TTL)
                  .catch(err => console.error(`Failed to sync key ${feedId} to primary:`, err));
              }
              
              break;
            }
          } catch (error) {
            console.error(`Error checking replica ${getRedisName(url)} for ${feedId}:`, error);
          }
        }
      }
    }
    
    if (!jsonString) return null;
    
    // Reset expiration on access
    await redis.expire(feedId, DEFAULT_CACHE_TTL);
    
    // Parse the result
    const data = JSON.parse(jsonString as string);
    return {
      slugs: data.slugs,
      lang: data.lang
    };
  } catch (error) {
    console.error(`Error retrieving feed mapping for ${feedId}:`, error);
    return null;
  }
}

/**
 * Pre-warm the chapter cache for better performance
 * This function checks cache status and uses the getChaptersForSlugs function from api.ts 
 * to fetch and cache data in the background
 */
export async function warmChapterCache(
  slugs: string[],
  lang: string
): Promise<void> {
  try {
    console.log(`Warming chapter cache for ${slugs.length} comics in ${lang}`);
    const redis = await getRedisClient(); // This already handles failover
    
    // Validate slugs
    const validSlugs = slugs.filter(slug => 
      slug && typeof slug === 'string' && slug.match(/^[a-z0-9-]+$/));
    
    if (validSlugs.length !== slugs.length) {
      console.warn(`Filtered out ${slugs.length - validSlugs.length} invalid slugs`);
    }
    
    // Check which slugs are already in cache
    const pipeline = redis.pipeline();
    const cacheKeys = validSlugs.map(slug => `chapters:${slug}:${lang}`);
    
    cacheKeys.forEach(key => {
      pipeline.exists(key);
    });
    
    const results = await pipeline.exec();
    const slugsToFetch: string[] = [];
    
    results?.forEach(([err, exists], index) => {
      if (err) {
        console.error(`Error checking cache for ${cacheKeys[index]}:`, err);
        slugsToFetch.push(validSlugs[index]);
      } else if (!exists) {
        slugsToFetch.push(validSlugs[index]);
      }
    });
    
    if (slugsToFetch.length === 0) {
      console.log('All chapters already in cache, no warming needed');
      return;
    }
    
    console.log(`Cache miss for ${slugsToFetch.length} comics - starting background fetch`);
    
    // To avoid circular dependencies, we'll import getChaptersForSlugs dynamically
    const { getChaptersForSlugs } = await import('./api');
    
    // Start fetching in the background without waiting for the result
    getChaptersForSlugs(slugsToFetch, lang)
      .then(chapters => {
        console.log(`Successfully warmed cache with ${chapters.length} chapters`);
      })
      .catch(error => {
        console.error('Error warming chapter cache:', error);
      });

  } catch (error) {
    console.error('Error in warmChapterCache:', error);
  }
}

// Add a new function for handling large feed mappings with compression
export async function storeLargeFeedMapping(
  feedId: string,
  slugs: string[],
  lang: string
): Promise<void> {
  const mapping = { 
    slugs, 
    lang, 
    created_at: new Date().toISOString() 
  };
  
  const jsonString = JSON.stringify(mapping);
  
  try {
    const redis = await getRedisClient();
    const activeUrl = redis.options.host || '';
    
    // Use compression for large mappings
    if (shouldCompress(jsonString)) {
      const compressed = await gzip(jsonString);
      const base64Compressed = compressed.toString('base64');
      
      // Store with compression flag
      await redis.set(`${feedId}:compressed`, base64Compressed, "EX", DEFAULT_CACHE_TTL);
      
      // Replicate to other instances
      await replicateOperation(activeUrl, `${feedId}:compressed`, base64Compressed, DEFAULT_CACHE_TTL);
      
      console.log(`Successfully stored compressed mapping for feed ${feedId} (${jsonString.length} → ${base64Compressed.length} bytes)`);
    } else {
      // Use normal storage for small mappings
      await redis.set(feedId, jsonString, "EX", DEFAULT_CACHE_TTL);
      await replicateOperation(activeUrl, feedId, jsonString, DEFAULT_CACHE_TTL);
      console.log(`Successfully stored mapping for feed ${feedId}`);
    }
  } catch (error) {
    console.error(`Error storing feed mapping for ${feedId}:`, error);
    throw error;
  }
}

// Batch get multiple feed mappings at once
export async function getBatchFeedMappings(
  feedIds: string[]
): Promise<Record<string, FeedMapping | null>> {
  if (!feedIds.length) return {};
  
  try {
    const redis = await getRedisClient();
    const pipeline = redis.pipeline();
    
    // Check regular keys first
    feedIds.forEach(id => {
      pipeline.get(id);
    });
    
    const results = await pipeline.exec();
    if (!results) return {};
    
    // Process results
    const mappings: Record<string, FeedMapping | null> = {};
    const ttlUpdates = redis.pipeline();
    const compressedChecks = redis.pipeline();
    const compressedIds: string[] = [];
    
    for (let i = 0; i < feedIds.length; i++) {
      const id = feedIds[i];
      const result = results[i];
      
      if (result[0]) {
        mappings[id] = null;
        continue;
      }
      
      if (result[1]) {
        // Process regular mapping
        try {
          const data = JSON.parse(result[1] as string);
          mappings[id] = {
            slugs: data.slugs,
            lang: data.lang
          };
          
          // Reset TTL
          ttlUpdates.expire(id, DEFAULT_CACHE_TTL);
        } catch (e) {
          mappings[id] = null;
        }
      } else {
        // Check for compressed version
        compressedChecks.exists(`${id}:compressed`);
        compressedIds.push(id);
      }
    }
    
    // Execute TTL updates in background
    ttlUpdates.exec().catch(err => console.error('TTL update error:', err));
    
    // Check compressed versions if needed
    if (compressedIds.length > 0) {
      const compressedResults = await compressedChecks.exec();
      
      if (compressedResults) {
        const compressedFetches = redis.pipeline();
        const compressedToFetch: string[] = [];
        
        compressedResults.forEach((result, index) => {
          if (!result[0] && result[1]) {
            const id = compressedIds[index];
            compressedFetches.get(`${id}:compressed`);
            compressedToFetch.push(id);
          }
        });
        
        if (compressedToFetch.length > 0) {
          const fetchResults = await compressedFetches.exec();
          
          if (fetchResults) {
            for (let i = 0; i < compressedToFetch.length; i++) {
              const id = compressedToFetch[i];
              const [err, compressedData] = fetchResults[i];
              
              if (!err && compressedData) {
                try {
                  const buffer = Buffer.from(compressedData as string, 'base64');
                  const decompressed = await gunzip(buffer);
                  const data = JSON.parse(decompressed.toString());
                  
                  mappings[id] = {
                    slugs: data.slugs,
                    lang: data.lang
                  };
                  
                  // Reset TTL in background
                  redis.expire(`${id}:compressed`, DEFAULT_CACHE_TTL).catch(() => {});
                } catch (e) {
                  mappings[id] = null;
                }
              } else {
                mappings[id] = null;
              }
            }
          }
        }
      }
    }
    
    return mappings;
  } catch (error) {
    console.error(`Error retrieving batch feed mappings:`, error);
    return {};
  }
}

// Initialize connections eagerly to establish connections as soon as possible
if (!import.meta.env.SSR) {
  initializeAllClients()
    .then(() => console.log("Redis clients initialized"))
    .catch(err => console.error("Failed to initialize Redis clients:", err));
}

// Initialize connections lazily as backup
console.log("Redis will connect on first use");
