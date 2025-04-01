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
let initializationPromise: Promise<void> | null = null; // Promise to track initialization

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
  // Prevent multiple concurrent initializations
  if (initializationPromise) {
    console.log("Initialization already in progress, awaiting existing promise.");
    return initializationPromise;
  }

  console.log("Starting Redis client initialization...");
  const initStartTime = Date.now();

  // Create a promise that resolves when initialization is complete
  initializationPromise = (async () => {
    try {
      // Initialize primary
      if (PRIMARY_REDIS_URL && (!primaryClient || primaryClient.status !== "ready")) {
        console.log("Initializing primary client...");
        primaryClient = await createRedisClient(PRIMARY_REDIS_URL);
        primaryHealthy = await checkConnection(primaryClient, "Primary");
        console.log(`Primary Redis initialized, healthy: ${primaryHealthy}`);
      } else if (primaryClient) {
        console.log(`Primary client already exists (Status: ${primaryClient.status}), checking health...`);
        primaryHealthy = await checkConnection(primaryClient, "Primary");
        console.log(`Primary health check result: ${primaryHealthy}`);
      } else {
         console.log("Primary Redis URL not configured.");
      }

      // Initialize all replicas
      console.log(`Found ${REPLICA_URLS.length} replica URLs to initialize.`);
      const replicaInitPromises: Promise<void>[] = [];

      for (const url of REPLICA_URLS) {
        // Add promise to array to run in parallel
        replicaInitPromises.push(
          (async () => {
            // Check if already initialized and healthy
            if (replicaClients.has(url)) {
                const existingClient = replicaClients.get(url)!;
                console.log(`Replica ${getRedisName(url)} already in map (Status: ${existingClient.status}), checking health...`);
                if (await checkConnection(existingClient, getRedisName(url))) {
                    console.log(`Replica ${getRedisName(url)} is healthy.`);
                    return; // Skip re-initialization if healthy
                } else {
                    console.log(`Replica ${getRedisName(url)} found but unhealthy, attempting re-initialization.`);
                    // Optionally disconnect the old client first
                    existingClient.disconnect();
                }
            }

            try {
              console.log(`Initializing replica ${getRedisName(url)}...`);
              const client = await createRedisClient(url);
              const isHealthy = await checkConnection(client, getRedisName(url));
              if (isHealthy) {
                replicaClients.set(url, client); // Add to map *only if healthy*
                console.log(`Replica ${getRedisName(url)} initialized successfully and added to map.`);
              } else {
                 console.warn(`Replica ${getRedisName(url)} initialized but failed health check.`);
                 // Optionally disconnect if unhealthy after creation
                 client.disconnect();
              }
            } catch (error) {
              console.error(`Failed to initialize replica ${getRedisName(url)}:`, error);
            }
          })()
        );
      }

      // Wait for all replica initializations to complete
      await Promise.allSettled(replicaInitPromises);

      console.log(`Initialization attempt finished. Current replica map size: ${replicaClients.size}. Time taken: ${Date.now() - initStartTime}ms`);

    } catch (error) {
      console.error("CRITICAL Error during client initialization process:", error);
      // Reset promise on critical failure to allow retry
      initializationPromise = null;
      throw error; // Re-throw if needed
    } finally {
       // Keep the promise reference after success, but maybe reset after some time?
       // For now, keep it to prevent re-running unnecessarily.
       // If you suspect clients disconnect often, you might want to clear this promise
       // periodically or on errors to force re-initialization attempts.
    }
  })(); // Immediately invoke the async IIFE

  return initializationPromise;
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
 * Returns the client and its connection URL.
 */
export async function getRedisClient(): Promise<{ client: Redis; url: string }> {
  // Ensure initialization has been attempted at least once
  if (!initializationPromise) {
      console.log("[getRedisClient] Initialization promise not found, triggering initialization...");
      await initializeAllClients(); // Await the first initialization attempt
  } else {
      // Optional: Await if already running, prevents race conditions on first load
      // await initializationPromise;
  }


  // Try primary client first if it's considered healthy
  if (primaryHealthy && primaryClient && primaryClient.status === "ready") {
    // Check connection just in case before returning
    if (await checkConnection(primaryClient, "Primary")) {
        return { client: primaryClient, url: PRIMARY_REDIS_URL! }; // <-- Return URL
    } else {
        console.warn("Primary client status was ready but ping failed. Marking unhealthy.");
        primaryHealthy = false;
        primaryFailedChecks++;
        // Fall through to replica logic
    }
  }

  // --- Replica Logic ---
  console.log(`[getRedisClient] Primary unhealthy or unavailable. Checking replicas. Current map size: ${replicaClients.size}`);

  // If the map is empty, maybe initialization failed or hasn't run? Try again.
  // This adds robustness but might hide underlying init issues if called repeatedly.
  if (replicaClients.size === 0 && REPLICA_URLS.length > 0) {
      console.warn("[getRedisClient] Replica map is empty, attempting re-initialization...");
      await initializeAllClients(); // Await re-initialization attempt
      console.log(`[getRedisClient] Re-initialization finished. New map size: ${replicaClients.size}`);
  }


  // Primary is unhealthy, try to use the active replica if we have one
  if (activeReplicaUrl && replicaClients.has(activeReplicaUrl)) {
    const activeReplica = replicaClients.get(activeReplicaUrl)!;
    if (activeReplica.status === "ready" && await checkConnection(activeReplica, getRedisName(activeReplicaUrl))) {
      console.log(`Using active replica: ${getRedisName(activeReplicaUrl)}`);
      lastUsedReplica = activeReplicaUrl; // Track that we used this replica
      return { client: activeReplica, url: activeReplicaUrl }; // <-- Return URL
    }
  }

  // No active replica, try replicas in order (using the potentially updated map)
  console.log(`[getRedisClient] No active replica. Iterating through ${replicaClients.size} clients in map...`);
  // Iterate through the *map* instead of the URL list first
  for (const [url, client] of replicaClients.entries()) {
      const clientName = getRedisName(url);
      console.log(`[getRedisClient] Checking client from map: ${clientName} (Status: ${client.status})`);
      if (client.status === "ready" && await checkConnection(client, clientName)) {
          console.log(`[getRedisClient] Using healthy client from map: ${clientName}`);
          activeReplicaUrl = url;
          lastUsedReplica = url;
          // Promotion logic remains the same
          if (primaryFailedChecks >= REPLICA_PROMOTION_THRESHOLD) {
             console.log(`Promoting ${getRedisName(url)} to primary after ${primaryFailedChecks} failed checks`);
             primaryClient = client; // The client instance is now considered primary
             primaryHealthy = true;
             primaryFailedChecks = 0;
             // Note: PRIMARY_REDIS_URL still points to the original primary config.
             // The 'url' returned here is the replica's URL, which is correct for identifying the *current* primary instance.
          }
          return { client: client, url: url };
      } else {
          console.log(`[getRedisClient] Client ${clientName} from map is not ready or failed check.`);
      }
  }

  // If no client in the map worked, fall back to trying URLs again (covers cases where a client wasn't added to map)
  console.log(`[getRedisClient] No suitable client found in map. Falling back to iterating through REPLICA_URLS (${REPLICA_URLS.length})...`);
  for (const url of REPLICA_URLS) {
    const clientName = getRedisName(url);
    try {
      let client = replicaClients.get(url);
      // If client exists but wasn't ready above, try creating a new one
      if (!client || client.status !== "ready") {
        console.log(`[getRedisClient] Client ${clientName} not in map or not ready. Attempting connection...`);
        client = await createRedisClient(url);
        // Add to map immediately upon successful creation attempt, check health next
        replicaClients.set(url, client);
        console.log(`[getRedisClient] Added/updated client ${clientName} in map.`);
      }

      if (await checkConnection(client, clientName)) {
        console.log(`[getRedisClient] Successfully connected/verified replica: ${clientName}`);
        activeReplicaUrl = url;
        lastUsedReplica = url;
        // Promotion logic remains the same
        if (primaryFailedChecks >= REPLICA_PROMOTION_THRESHOLD) {
           console.log(`Promoting ${getRedisName(url)} to primary after ${primaryFailedChecks} failed checks`);
           primaryClient = client; // The client instance is now considered primary
           primaryHealthy = true;
           primaryFailedChecks = 0;
           // Note: PRIMARY_REDIS_URL still points to the original primary config.
           // The 'url' returned here is the replica's URL, which is correct for identifying the *current* primary instance.
        }
        return { client: client, url: url };
      } else {
         console.log(`[getRedisClient] Health check failed for ${clientName} after connection attempt.`);
         // Optionally remove from map if health check fails immediately after creation?
         // replicaClients.delete(url);
      }
    } catch (err) {
      console.error(`[getRedisClient] Failed to connect to replica ${clientName}:`, err);
      // Remove from map if connection failed
      replicaClients.delete(url);
    }
  }

  // If all else fails, try one more time with primary
  console.warn("All Redis connections failed, making last attempt with primary");
  // Ensure primaryClient is re-initialized if it failed earlier
  if (!primaryClient || primaryClient.status !== 'connecting' && primaryClient.status !== 'ready') {
      try {
          primaryClient = await createRedisClient(PRIMARY_REDIS_URL!);
      } catch (err) {
          console.error("Fatal: Failed to re-initialize primary Redis on last attempt:", err);
          throw new Error("Could not establish any Redis connection."); // Throw if even last attempt fails
      }
  }
  // Even if creation succeeded, we return it, subsequent operations might fail but we need to return *something*
  return { client: primaryClient, url: PRIMARY_REDIS_URL! }; // <-- Return URL
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
  const regularKey = feedId; // Key for the non-compressed version
  const compressedKey = `${feedId}:compressed`; // Key for the compressed version

  try {
    const { client: redis, url: activeUrl } = await getRedisClient();
    const clientName = getRedisName(activeUrl);

    // --- 1. Store the non-compressed version ALWAYS ---
    console.log(`[storeFeedMapping] Attempting initial SET for regular key ${regularKey} to ${clientName}`);
    await redis.set(regularKey, stringValue, "EX", DEFAULT_CACHE_TTL);
    console.log(`[storeFeedMapping] SUCCESS: Stored regular mapping for feed ${feedId} to ${clientName}`);

    // Replicate the non-compressed version
    console.log(`[storeFeedMapping] Calling ensurePrimaryAndReplicate for regular key ${regularKey} (source: ${clientName})`);
    await ensurePrimaryAndReplicate(activeUrl, regularKey, stringValue, DEFAULT_CACHE_TTL);


    // --- 2. Store the compressed version IF needed ---
    if (shouldCompress(stringValue)) {
      console.log(`[storeFeedMapping] Compressing large feed mapping for ${feedId} (${Buffer.byteLength(stringValue, 'utf8')} bytes)`);
      const compressed = await gzip(stringValue);
      const base64Compressed = compressed.toString('base64');

      console.log(`[storeFeedMapping] Attempting initial SET for compressed key ${compressedKey} to ${clientName}`);
      await redis.set(compressedKey, base64Compressed, "EX", DEFAULT_CACHE_TTL);
      console.log(`[storeFeedMapping] SUCCESS: Stored compressed mapping (${base64Compressed.length} bytes) to ${clientName}`);

      // Replicate the compressed version
      console.log(`[storeFeedMapping] Calling ensurePrimaryAndReplicate for compressed key ${compressedKey} (source: ${clientName})`);
      await ensurePrimaryAndReplicate(activeUrl, compressedKey, base64Compressed, DEFAULT_CACHE_TTL);

    } else {
      console.log(`[storeFeedMapping] Skipping compressed storage for ${feedId} (data size below threshold).`);
      // Optional: If a compressed version might exist from a previous larger save, delete it
      // console.log(`[storeFeedMapping] Attempting to delete potentially stale compressed key ${compressedKey} on ${clientName}`);
      // await redis.del(compressedKey).catch(err => console.warn(`Failed to delete stale compressed key ${compressedKey}:`, err));
      // // Also replicate the deletion
      // console.log(`[storeFeedMapping] Calling ensurePrimaryAndReplicate for DELETE of compressed key ${compressedKey}`);
      // await ensurePrimaryAndReplicate(activeUrl, compressedKey, '', 0); // Use TTL 0 or a specific marker for deletion if needed
    }

    console.log(`[storeFeedMapping] Successfully processed storage and replication for feed ${feedId} (both versions if applicable)`);

  } catch (error) {
    // Log the specific error during the initial write attempt
    // Note: Error could happen during either set operation or replication call
    console.error(`[storeFeedMapping] CRITICAL ERROR storing feed mapping for ${feedId}:`, error);
    throw error; // Re-throw the error after logging
  }
}

/**
 * Retrieve a feed mapping from Redis with automatic failover
 */
export async function getFeedMapping(
  feedId: string
): Promise<FeedMapping | null> {
  console.log(`[getFeedMapping] Attempting to get mapping for feedId: ${feedId}`);
  try {
    // Try primary first
    const { client, url: clientUrl } = await getRedisClient();
    const clientName = getRedisName(clientUrl);
    console.log(`[getFeedMapping] Using client: ${clientName} (${clientUrl})`);

    // Check for compressed version first
    const compressedKey = `${feedId}:compressed`;
    console.log(`[getFeedMapping] Checking for compressed key: ${compressedKey} on ${clientName}`);
    const compressedData = await client.get(compressedKey); // This is the base64 string

    if (compressedData) {
      console.log(`[getFeedMapping] SUCCESS: Found compressed data for ${feedId} on ${clientName}`);
      try {
        // Decompress and parse
        const buffer = Buffer.from(compressedData, 'base64');
        const decompressed = await gunzip(buffer);
        const data = JSON.parse(decompressed.toString());

        // --- Add back direct expire on the source client ---
        console.log(`[getFeedMapping] Resetting TTL directly on source ${clientName} for compressed key ${compressedKey}`);
        client.expire(compressedKey, DEFAULT_CACHE_TTL)
            .catch(err => console.warn(`[getFeedMapping] Failed direct TTL reset on ${clientName} for ${compressedKey}:`, err));
        // --- End Add back ---

        // Replicate the COMPRESSED data using ensurePrimaryAndReplicate
        console.log(`[getFeedMapping] Triggering DATA replication for compressed key ${compressedKey}`);
        ensurePrimaryAndReplicate(clientUrl, compressedKey, compressedData, DEFAULT_CACHE_TTL)
            .catch(err => console.error(`[getFeedMapping] Error during background DATA replication for ${compressedKey}:`, err));

        return {
          slugs: data.slugs,
          lang: data.lang
        };
      } catch (error) {
        console.error(`[getFeedMapping] Error decompressing data for ${feedId} from ${clientName}:`, error);
        // Fall through to try uncompressed version
      }
    } else {
        console.log(`[getFeedMapping] No compressed key found for ${feedId} on ${clientName}.`);
    }

    // If no compressed version, try regular key
    const regularKey = feedId;
    console.log(`[getFeedMapping] Checking for regular key: ${regularKey} on ${clientName}`);
    let jsonString = await client.get(regularKey); // This is the JSON string

    // Variables to track source if found on replica
    let foundOnReplica = false;
    let replicaUrlSource: string | null = null;
    let replicaClientSource: Redis | null = null; // Store the replica client instance
    let valueFromReplica: string | null = null; // Store value found on replica
    let isValueFromReplicaCompressed = false; // Track if replica value was compressed

    if (jsonString) {
        console.log(`[getFeedMapping] SUCCESS: Found regular key ${regularKey} on ${clientName}`);
    }

    // If not found in the current client AND the client was the primary, check replicas
    if (!jsonString && REPLICA_URLS.length > 0 && client === primaryClient) {
      console.log(`[getFeedMapping] Key ${regularKey} not found on PRIMARY, checking replicas...`);

      // Try each replica
      for (const [replicaUrl, replicaClient] of replicaClients.entries()) {
         const replicaName = getRedisName(replicaUrl);
        if (replicaClient.status === "ready") {
          try {
            // Check compressed key on replica first
            const replicaCompressedData = await replicaClient.get(compressedKey); // Base64 string
            if (replicaCompressedData) {
                console.log(`[getFeedMapping] SUCCESS: Found COMPRESSED key ${compressedKey} on REPLICA ${replicaName}`);
                 try {
                    // Decompress for return value
                    const buffer = Buffer.from(replicaCompressedData, 'base64');
                    const decompressed = await gunzip(buffer);
                    const data = JSON.parse(decompressed.toString());

                    // --- Add back direct expire on the source replica client ---
                    console.log(`[getFeedMapping] Resetting TTL directly on source ${replicaName} for compressed key ${compressedKey}`);
                    replicaClient.expire(compressedKey, DEFAULT_CACHE_TTL)
                       .catch(err => console.warn(`[getFeedMapping] Failed direct TTL reset on ${replicaName} for ${compressedKey}:`, err));
                    // --- End Add back ---

                    // Replicate the COMPRESSED data found on replica
                    console.log(`[getFeedMapping] Triggering DATA replication for compressed key ${compressedKey} (found on replica ${replicaName})`);
                    ensurePrimaryAndReplicate(replicaUrl, compressedKey, replicaCompressedData, DEFAULT_CACHE_TTL)
                         .catch(err => console.error(`[getFeedMapping] Error during background DATA replication for ${compressedKey}:`, err));

                    return { slugs: data.slugs, lang: data.lang };
                 } catch (error) {
                    console.error(`[getFeedMapping] Error decompressing data for ${feedId} from REPLICA ${replicaName}:`, error);
                 }
            } else {
                 // Check regular key on replica
                 const replicaJsonString = await replicaClient.get(regularKey); // JSON string
                 if (replicaJsonString) {
                   console.log(`[getFeedMapping] SUCCESS: Found REGULAR key ${regularKey} on REPLICA ${replicaName}`);
                   foundOnReplica = true;
                   replicaUrlSource = replicaUrl;
                   replicaClientSource = replicaClient; // Store the client instance
                   valueFromReplica = replicaJsonString; // Store the value found
                   isValueFromReplicaCompressed = false; // Mark as not compressed
                   jsonString = replicaJsonString; // Use this value going forward
                   break; // Found on this replica, stop checking others
                 } else {
                    console.log(`[getFeedMapping] No regular key found on replica ${replicaName}.`);
                 }
            }

          } catch (error) {
            console.error(`[getFeedMapping] Error checking replica ${replicaName} for ${feedId}:`, error);
          }
        } else {
            console.log(`[getFeedMapping] Skipping replica ${replicaName} (status: ${replicaClient.status})`);
        }
      }
    }

    // If jsonString is still null/empty after checks, the key wasn't found
    if (!jsonString) {
        console.log(`[getFeedMapping] Key ${feedId} (and compressed variant) not found on any checked instance.`);
        return null;
    }

    // --- Add back direct expire on the source client (primary or replica) ---
    const sourceClientForExpire = foundOnReplica ? replicaClientSource! : client;
    const sourceClientNameForExpire = foundOnReplica ? getRedisName(replicaUrlSource!) : clientName;
    console.log(`[getFeedMapping] Resetting TTL directly on source ${sourceClientNameForExpire} for regular key ${regularKey}`);
    sourceClientForExpire.expire(regularKey, DEFAULT_CACHE_TTL)
        .catch(err => console.warn(`[getFeedMapping] Failed direct TTL reset on ${sourceClientNameForExpire} for ${regularKey}:`, err));
    // --- End Add back ---

    // Replicate the REGULAR data using ensurePrimaryAndReplicate
    console.log(`[getFeedMapping] Triggering DATA replication for regular key ${regularKey}`);
    const sourceUrlForReplication = foundOnReplica ? replicaUrlSource! : clientUrl;
    ensurePrimaryAndReplicate(sourceUrlForReplication, regularKey, jsonString, DEFAULT_CACHE_TTL)
        .catch(err => console.error(`[getFeedMapping] Error during background DATA replication for ${regularKey}:`, err));

    // Parse the result
    try {
        const data = JSON.parse(jsonString);
        return {
          slugs: data.slugs,
          lang: data.lang
        };
    } catch (parseError) {
        console.error(`[getFeedMapping] CRITICAL ERROR parsing feed mapping JSON for ${feedId}:`, parseError, `JSON String: ${jsonString}`);
        return null; // Return null if parsing fails
    }

  } catch (error) {
    console.error(`[getFeedMapping] CRITICAL ERROR retrieving feed mapping for ${feedId}:`, error);
    return null;
  }
}

/**
 * Pre-warm the chapter cache for better performance
 * This function checks cache status and uses the getChaptersForSlugs function from api.ts
 * to fetch and cache data in the background, processing only a limited batch at a time.
 */
export async function warmChapterCache(
  slugs: string[],
  lang: string
): Promise<void> {
  const BATCH_SIZE = 10; // Define the maximum number of slugs to process per run

  try {
    console.log(`[warmChapterCache] Received request to warm cache for ${slugs.length} comics in ${lang}`);
    const { client } = await getRedisClient(); // This already handles failover

    // Validate slugs
    const validSlugs = slugs.filter(slug =>
      slug && typeof slug === 'string' && slug.match(/^[a-z0-9-]+$/));

    if (validSlugs.length !== slugs.length) {
      console.warn(`[warmChapterCache] Filtered out ${slugs.length - validSlugs.length} invalid slugs`);
    }
    if (validSlugs.length === 0) {
        console.log("[warmChapterCache] No valid slugs provided.");
        return;
    }

    // Check which slugs are already in cache
    const pipeline = client.pipeline();
    const cacheKeys = validSlugs.map(slug => `chapters:${slug}:${lang}`);

    cacheKeys.forEach(key => {
      pipeline.exists(key);
    });

    const results = await pipeline.exec();
    let slugsMissingFromCache: string[] = []; // Renamed for clarity

    results?.forEach(([err, exists], index) => {
      if (err) {
        console.error(`[warmChapterCache] Error checking cache for ${cacheKeys[index]}:`, err);
        // Optionally decide if you still want to try fetching on error
        // slugsMissingFromCache.push(validSlugs[index]);
      } else if (!exists) {
        slugsMissingFromCache.push(validSlugs[index]);
      }
    });

    if (slugsMissingFromCache.length === 0) {
      console.log('[warmChapterCache] All requested chapters already in cache, no warming needed.');
      return;
    }

    // --- Batching Logic ---
    const slugsToProcessNow = slugsMissingFromCache.slice(0, BATCH_SIZE);
    const remainingSlugs = slugsMissingFromCache.length - slugsToProcessNow.length;

    console.log(`[warmChapterCache] Cache miss for ${slugsMissingFromCache.length} comics. Processing batch of ${slugsToProcessNow.length}. Remaining: ${remainingSlugs}`);
    // --- End Batching Logic ---


    // To avoid circular dependencies, we'll import getChaptersForSlugs dynamically
    const { getChaptersForSlugs } = await import('./api');

    // Start fetching in the background *only for the current batch* without waiting for the result
    getChaptersForSlugs(slugsToProcessNow, lang) // Use the batched list
      .then(chapters => {
        // Note: chapters.length might not equal slugsToProcessNow.length if some fetches failed internally
        console.log(`[warmChapterCache] Background cache warming initiated for ${slugsToProcessNow.length} slugs. Successfully fetched data for ${chapters.length} chapters.`);
      })
      .catch(error => {
        console.error('[warmChapterCache] Error during background chapter cache warming:', error);
      });

  } catch (error) {
    console.error('[warmChapterCache] Error in warmChapterCache:', error);
  }
}

// Add a new function for handling large feed mappings with compression
export async function storeLargeFeedMapping(
  feedId: string,
  slugs: string[],
  lang: string
): Promise<void> {
   // This function now essentially calls storeFeedMapping which handles compression logic.
   // We can simplify this or keep it as a specific entry point.
   // For consistency, let's just call the main function.
   console.log(`Using storeLargeFeedMapping for ${feedId}, deferring to storeFeedMapping.`);
   await storeFeedMapping(feedId, slugs, lang);

  /* // Original logic updated with ensurePrimaryAndReplicate:
  const mapping = {
    slugs,
    lang,
    created_at: new Date().toISOString()
  };

  const jsonString = JSON.stringify(mapping);
  let keyToStore = feedId;
  let valueToStore = jsonString;
  let ttl = DEFAULT_CACHE_TTL;

  try {
    const redis = await getRedisClient();
    const activeUrl = redis.options.url || `${redis.options.host}:${redis.options.port}`;

    // Use compression for large mappings
    if (shouldCompress(jsonString)) {
      const compressed = await gzip(jsonString);
      const base64Compressed = compressed.toString('base64');

      keyToStore = `${feedId}:compressed`;
      valueToStore = base64Compressed;

      // Store with compression flag
      await redis.set(keyToStore, valueToStore, "EX", ttl);
      console.log(`Stored compressed mapping for feed ${feedId} to ${getRedisName(activeUrl)} (${jsonString.length} → ${valueToStore.length} bytes)`);

    } else {
      // Use normal storage for small mappings
      await redis.set(keyToStore, jsonString, "EX", ttl);
      console.log(`Stored mapping for feed ${feedId} to ${getRedisName(activeUrl)}`);
    }

    // Ensure data is on primary and replicate to others
    await ensurePrimaryAndReplicate(activeUrl, keyToStore, valueToStore, ttl);

    console.log(`Successfully processed storage and replication for large feed ${feedId}`);

  } catch (error) {
    console.error(`Error storing large feed mapping for ${feedId}:`, error);
    throw error;
  }
  */
}

// Batch get multiple feed mappings at once
export async function getBatchFeedMappings(
  feedIds: string[]
): Promise<Record<string, FeedMapping | null>> {
  if (!feedIds.length) return {};
  
  try {
    const { client } = await getRedisClient();
    const pipeline = client.pipeline();
    
    // Check regular keys first
    feedIds.forEach(id => {
      pipeline.get(id);
    });
    
    const results = await pipeline.exec();
    if (!results) return {};
    
    // Process results
    const mappings: Record<string, FeedMapping | null> = {};
    const ttlUpdates = client.pipeline();
    const compressedChecks = client.pipeline();
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
        const compressedFetches = client.pipeline();
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
                  client.expire(`${id}:compressed`, DEFAULT_CACHE_TTL).catch(() => {});
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

/**
 * Ensures data is written to the primary (if not the source) and replicated.
 * Handles SET operations. For DEL, a separate function or modification might be needed.
 */
async function ensurePrimaryAndReplicate(
  sourceUrl: string,
  key: string,
  value: string, // Value to set
  ttl: number // TTL for SET, use > 0
): Promise<void> {
  const replicationTasks: Promise<any>[] = [];
  const sourceName = getRedisName(sourceUrl);
  const primaryUrl = PRIMARY_REDIS_URL;
  const primaryName = getRedisName(primaryUrl!);

  // Check if operation is a delete based on TTL (simple approach)
  const isDelete = ttl <= 0;
  const operationType = isDelete ? 'DELETE' : 'SET';

  console.log(`[ensurePrimaryAndReplicate] Starting sync for ${operationType} on key ${key}. Source: ${sourceName}`);

  // 1. Sync to Primary (if source wasn't primary and primary exists/is healthy)
  if (primaryClient && sourceUrl !== primaryUrl) {
    const primaryStatus = primaryClient.status;
    console.log(`[ensurePrimaryAndReplicate] Checking primary (${primaryName}) status: ${primaryStatus}`);
    let primaryIsReady = primaryStatus === 'ready';

    if (!primaryIsReady) {
        try {
            await primaryClient.ping();
            primaryIsReady = true;
            console.log(`[ensurePrimaryAndReplicate] Primary (${primaryName}) ping successful after status check.`);
        } catch (pingErr) {
            console.warn(`[ensurePrimaryAndReplicate] Primary (${primaryName}) ping failed, skipping sync attempt. Status: ${primaryStatus}`, pingErr);
        }
    }

    if (primaryIsReady) {
      console.log(`[ensurePrimaryAndReplicate] Attempting sync ${operationType} to PRIMARY (${primaryName}) for key ${key}`);
      const task = isDelete
        ? primaryClient.del(key)
        : primaryClient.set(key, value, "EX", ttl);

      replicationTasks.push(
        task
          .then(() => console.log(`[ensurePrimaryAndReplicate] SUCCESS: Synced ${operationType} key ${key} to PRIMARY (${primaryName})`))
          .catch(err => console.error(`[ensurePrimaryAndReplicate] FAILED: Sync ${operationType} key ${key} to PRIMARY (${primaryName})`, err))
      );
    } else {
       console.log(`[ensurePrimaryAndReplicate] SKIPPED: Sync ${operationType} to PRIMARY (${primaryName}) because it's not ready (Status: ${primaryStatus}).`);
    }
  } else if (sourceUrl === primaryUrl) {
      console.log(`[ensurePrimaryAndReplicate] Source was PRIMARY (${primaryName}), no primary sync needed for ${operationType} on key ${key}.`);
  } else {
      console.log(`[ensurePrimaryAndReplicate] Primary client not available, cannot sync ${operationType} key ${key} to primary.`);
  }

  // 2. Replicate to other available replicas
  console.log(`[ensurePrimaryAndReplicate] Current replicaClients map size: ${replicaClients.size}, Keys: ${Array.from(replicaClients.keys())}`);
  console.log(`[ensurePrimaryAndReplicate] Checking ${replicaClients.size} replicas for ${operationType} on key ${key}`);
  for (const [replicaUrl, replicaClient] of replicaClients.entries()) {
    const replicaName = getRedisName(replicaUrl);
    // Don't replicate back to the source or to the primary (if primary sync was attempted above)
    if (replicaUrl !== sourceUrl && replicaUrl !== primaryUrl) {
       const replicaStatus = replicaClient.status;
       console.log(`[ensurePrimaryAndReplicate] Checking replica ${replicaName} status: ${replicaStatus}`);
      if (replicaStatus === 'ready') {
        console.log(`[ensurePrimaryAndReplicate] Attempting replication ${operationType} to REPLICA (${replicaName}) for key ${key}`);
         const task = isDelete
            ? replicaClient.del(key)
            : replicaClient.set(key, value, "EX", ttl);
        replicationTasks.push(
          task
            .then(() => console.log(`[ensurePrimaryAndReplicate] SUCCESS: Replicated ${operationType} key ${key} to REPLICA (${replicaName})`))
            .catch(err => console.error(`[ensurePrimaryAndReplicate] FAILED: Replicate ${operationType} key ${key} to REPLICA (${replicaName})`, err))
        );
      } else {
         console.log(`[ensurePrimaryAndReplicate] SKIPPED: Replication ${operationType} to REPLICA (${replicaName}) because it's not ready (Status: ${replicaStatus}).`);
      }
    } else {
        console.log(`[ensurePrimaryAndReplicate] SKIPPED: Replication ${operationType} to ${replicaName} (Source or Primary) for key ${key}.`);
    }
  }

  // Wait for all sync/replication attempts to settle
  if (replicationTasks.length > 0) {
    console.log(`[ensurePrimaryAndReplicate] Waiting for ${replicationTasks.length} sync/replication tasks for ${operationType} on key ${key}...`);
    const results = await Promise.allSettled(replicationTasks);
    console.log(`[ensurePrimaryAndReplicate] Sync/replication tasks settled for ${operationType} on key ${key}. Results:`, results.map(r => r.status));
  } else {
     console.log(`[ensurePrimaryAndReplicate] No sync/replication tasks needed for ${operationType} on key ${key}.`);
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

// Initialize connections eagerly to establish connections as soon as possible
if (!import.meta.env.SSR) {
  // Trigger initialization but don't block module loading
  initializeAllClients()
    .then(() => console.log("Initial background Redis client initialization attempt complete."))
    .catch(err => console.error("Initial background Redis client initialization failed:", err));
}

// Initialize connections lazily as backup
console.log("Redis will connect on first use (or relies on background initialization).");
