import Redis from "ioredis";
import type { FeedMapping } from "./types";

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
  import.meta.env.REPLICA_REDIS_URL_2 || process.env.REPLICA_REDIS_URL_2,
  import.meta.env.REPLICA_REDIS_URL_3 || process.env.REPLICA_REDIS_URL_3,
].filter(Boolean) as string[];

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
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, times), 1000); // Cap at 1s
      console.log(
        `${redisName} retry ${times}/${MAX_RETRIES}, delay ${delay}ms`
      );
      return delay;
    },
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    enableReadyCheck: true,
    connectTimeout: IS_VERCEL ? 5000 : 10000, // 5s for Vercel, 10s local
    keepAlive: IS_VERCEL ? 2000 : 10000, // 2s ping for Vercel
    commandTimeout: 5000, // Align with Vercel's timeout
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
 * Add an operation to the buffer for replication
 */
function bufferOperation(operation: RedisOperation): void {
  operationBuffer.push(operation);
  
  // If buffer exceeds size limit, trigger a sync
  if (operationBuffer.length >= SYNC_BUFFER_SIZE) {
    syncReplicas().catch(err => console.error("Failed to sync replicas:", err));
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
        '[a-f0-9]*', // Match feed IDs (hex format)
        'COUNT',
        '100'
      );
      
      cursor = nextCursor;
      feedKeys.push(...keys);
    } while (cursor !== '0');
    
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
 * Synchronize operations from buffer to all replicas
 */
async function syncReplicas(): Promise<void> {
  if (operationBuffer.length === 0) return;
  
  // Get operations to sync and clear buffer
  const operations = [...operationBuffer];
  operationBuffer.length = 0;
  
  // Skip if no operations or no replicas
  if (operations.length === 0 || replicaClients.size === 0) return;
  
  console.log(`Syncing ${operations.length} operations to ${replicaClients.size} replicas...`);
  
  // Process each replica
  const syncPromises = Array.from(replicaClients.entries()).map(async ([url, client]) => {
    try {
      if (client.status !== "ready" || !(await checkConnection(client, getRedisName(url)))) {
        return;
      }
      
      const pipeline = client.pipeline();
      
      // Add all operations to pipeline
      for (const op of operations) {
        if (op.type === 'set') {
          if (op.ttl) {
            pipeline.set(op.key, op.value, 'EX', op.ttl);
          } else {
            pipeline.set(op.key, op.value);
          }
        } else if (op.type === 'del') {
          pipeline.del(op.key);
        }
      }
      
      // Execute pipeline
      await pipeline.exec();
      console.log(`Successfully synced ${operations.length} operations to ${getRedisName(url)}`);
    } catch (error) {
      console.error(`Error syncing to ${getRedisName(url)}:`, error);
    }
  });
  
  await Promise.allSettled(syncPromises);
}

/**
 * Schedule periodic health checks to detect when primary recovers
 */
function scheduleHealthChecks() {
  if (typeof setInterval === 'undefined') return; // Skip in environments without setInterval

  // Check primary health
  setInterval(async () => {
    if (!primaryHealthy && primaryClient) {
      try {
        const isPrimaryHealthy = await checkConnection(primaryClient, "Primary");
        if (isPrimaryHealthy) {
          console.log("Primary Redis recovered");
          primaryHealthy = true;
          primaryFailedChecks = 0;
          
          // If we used a replica when primary was down, sync data back
          if (lastUsedReplica) {
            syncFromReplicaToPrimary(lastUsedReplica).catch(err => 
              console.error(`Failed to sync from replica to primary: ${err}`));
          }
        } else {
          primaryFailedChecks++;
          console.log(`Primary still unhealthy, failed checks: ${primaryFailedChecks}`);
        }
      } catch (err) {
        primaryFailedChecks++;
        console.error("Health check for primary Redis failed:", err);
      }
    }
  }, HEALTH_CHECK_INTERVAL);
  
  // Schedule regular replica sync
  setInterval(async () => {
    await syncReplicas().catch(err => console.error("Failed to sync replicas:", err));
  }, SYNC_INTERVAL);
}

// Start health checks and sync if not in a build context
if (!import.meta.env.SSR) {
  scheduleHealthChecks();
}

/**
 * Store a feed mapping in Redis with automatic failover and replication
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
    // First write to primary/active client
    const redis = await getRedisClient(); // This already handles failover
    await redis.set(feedId, stringValue, "EX", DEFAULT_CACHE_TTL);
    console.log(`Successfully stored mapping for feed ${feedId}`);
    
    // Buffer operation for replication to other instances
    bufferOperation({
      key: feedId,
      value: stringValue,
      ttl: DEFAULT_CACHE_TTL,
      type: 'set',
      timestamp: Date.now()
    });
    
    // If we're writing to a replica because primary is down, force immediate sync
    // to other replicas to ensure consistent data
    if (!primaryHealthy && lastUsedReplica) {
      await syncReplicas().catch(err => console.error("Failed to sync replicas after write:", err));
    }
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
    const redis = await getRedisClient(); // This already handles failover
    const mapping = await redis.get(feedId);
    
    if (!mapping) return null;
    
    // Reset expiration on access
    await redis.expire(feedId, DEFAULT_CACHE_TTL);
    
    // Buffer this TTL-reset operation for replication
    bufferOperation({
      key: feedId,
      value: mapping,
      ttl: DEFAULT_CACHE_TTL,
      type: 'set',
      timestamp: Date.now()
    });
    
    try {
      const data = JSON.parse(mapping);
      return { 
        slugs: data.slugs, 
        lang: data.lang 
      };
    } catch (e) {
      console.error(`Error parsing feed mapping for ${feedId}:`, e);
      return null;
    }
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

// Initialize connections lazily
console.log("Redis will connect on first use");
