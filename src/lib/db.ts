import Redis from "ioredis";
import type { FeedMapping } from "./types";
import { getChaptersForSlugs } from "./api";

// Configuration constants
const DEFAULT_CACHE_TTL = 60 * 60 * 24 * 30; // 30 days
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 50;
const IS_VERCEL = process.env.VERCEL || false;

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

// Singleton clients
let primaryClient: Redis | null = null;
let replicaClients: Map<string, Redis> = new Map();

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
    .on("ready", () => console.log(`${redisName} ready`))
    .on("error", (err) => console.error(`${redisName} error:`, err))
    .on("reconnecting", () => console.log(`${redisName} reconnecting`))
    .on("end", () => console.log(`${redisName} closed`));

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
 */
async function getRedisClient(): Promise<Redis> {
  // Try primary client
  if (!primaryClient || primaryClient.status !== "ready") {
    primaryClient = await createRedisClient(PRIMARY_REDIS_URL!);
  }
  
  if (await checkConnection(primaryClient, "Primary")) {
    return primaryClient;
  }

  // Try replicas
  for (const url of REPLICA_URLS) {
    let client = replicaClients.get(url);
    if (!client || client.status !== "ready") {
      client = await createRedisClient(url);
      replicaClients.set(url, client);
    }
    
    if (await checkConnection(client, getRedisName(url))) {
      return client;
    }
  }

  // Fallback: Force new primary connection
  primaryClient = await createRedisClient(PRIMARY_REDIS_URL!);
  return primaryClient;
}

/**
 * Write data to all available Redis instances
 */
async function writeToAllRedis(
  operation: (redis: Redis) => Promise<any>
): Promise<void> {
  const clients = [
    primaryClient,
    ...Array.from(replicaClients.values()),
  ].filter(Boolean) as Redis[];
  
  const errors: Error[] = [];

  for (const client of clients) {
    try {
      if (client.status === "ready") {
        await operation(client);
      }
    } catch (err) {
      errors.push(err as Error);
      console.error(
        `Write failed for ${getRedisName(client.options.host || "")}:`,
        err
      );
    }
  }

  if (errors.length === clients.length && clients.length > 0) {
    throw new Error("All Redis writes failed");
  }
}

/**
 * Store a feed mapping in Redis
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
  
  await writeToAllRedis(async (redis) =>
    redis.set(feedId, JSON.stringify(mapping), "EX", DEFAULT_CACHE_TTL)
  );
}

/**
 * Retrieve a feed mapping from Redis
 */
export async function getFeedMapping(
  feedId: string
): Promise<FeedMapping | null> {
  try {
    const redis = await getRedisClient();
    const mapping = await redis.get(feedId);
    
    if (!mapping) return null;
    
    // Reset expiration on access
    await redis.expire(feedId, DEFAULT_CACHE_TTL);
    
    const data = JSON.parse(mapping);
    return { 
      slugs: data.slugs, 
      lang: data.lang 
    };
  } catch (error) {
    console.error(`Error retrieving feed mapping for ${feedId}:`, error);
    return null;
  }
}

// Initialize connections lazily
console.log("Redis will connect on first use");
