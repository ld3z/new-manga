import Redis from "ioredis";
import type { FeedMapping } from "./types";
import { getChaptersForSlugs } from "./api";

// Redis URLs
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

const IS_VERCEL = process.env.VERCEL || false;
const DEFAULT_CACHE_TTL = 60 * 60 * 24 * 30; // 30 days
const MAX_RETRIES = 3; // Reduced retries to avoid Vercel timeout
const BASE_DELAY_MS = 50; // Faster retries for serverless

// Singleton clients
let primaryClient: Redis | null = null;
let replicaClients: Map<string, Redis> = new Map();

// Redis instance naming for logging
const redisInstanceNames = new Map<string, string>();
function initializeRedisNames() {
  redisInstanceNames.set(PRIMARY_REDIS_URL!, "Primary");
  REPLICA_URLS.forEach((url, index) =>
    redisInstanceNames.set(url, `Replica ${index + 1}`)
  );
}
initializeRedisNames();
const getRedisName = (url: string) => redisInstanceNames.get(url) || "Unknown";

// Create Redis client with Vercel-optimized settings
async function createRedisClient(url: string): Promise<Redis> {
  if (!url) throw new Error("Redis URL not set");

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
    commandTimeout: 5000, // Align with Vercel’s Hobby tier timeout
    reconnectOnError: (err) =>
      ["READONLY", "ETIMEDOUT", "ECONNRESET"].some((e) =>
        err.message.includes(e)
      ),
  });

  client
    .on("ready", () => console.log(`${redisName} ready`))
    .on("error", (err) => console.error(`${redisName} error:`, err))
    .on("reconnecting", () => console.log(`${redisName} reconnecting`))
    .on("end", () => console.log(`${redisName} closed`));

  return client;
}

// Get or create a Redis client
async function getRedisClient(): Promise<Redis> {
  const checkConnection = async (client: Redis, name: string) => {
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
  };

  // Try primary client
  if (!primaryClient || primaryClient.status !== "ready") {
    primaryClient = await createRedisClient(PRIMARY_REDIS_URL!);
  }
  if (await checkConnection(primaryClient, "Primary")) return primaryClient;

  // Try replicas
  for (const url of REPLICA_URLS) {
    let client = replicaClients.get(url);
    if (!client || client.status !== "ready") {
      client = await createRedisClient(url);
      replicaClients.set(url, client);
    }
    if (await checkConnection(client, getRedisName(url))) return client;
  }

  // Fallback: Force new primary connection
  primaryClient = await createRedisClient(PRIMARY_REDIS_URL!);
  return primaryClient;
}

// Write to all Redis instances
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

  if (errors.length === clients.length) {
    throw new Error("All Redis writes failed");
  }
}

// Your existing functions (unchanged except for using getRedisClient/writeToAllRedis)
export async function storeFeedMapping(
  feedId: string,
  slugs: string[],
  lang: string
): Promise<void> {
  const mapping = { slugs, lang, created_at: new Date().toISOString() };
  await writeToAllRedis(async (redis) =>
    redis.set(feedId, JSON.stringify(mapping), "EX", DEFAULT_CACHE_TTL)
  );
}

export async function getFeedMapping(
  feedId: string
): Promise<FeedMapping | null> {
  const redis = await getRedisClient();
  const mapping = await redis.get(feedId);
  if (!mapping) return null;
  await redis.expire(feedId, DEFAULT_CACHE_TTL);
  const data = JSON.parse(mapping);
  return { slugs: data.slugs, lang: data.lang };
}

// Initialize connections lazily (no blocking startup)
console.log("Redis will connect on first use");
