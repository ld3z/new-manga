import { defineConfig } from "astro/config";
import vercel from "@astrojs/vercel";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  site: process.env.ASTRO_SITE || 'https://manga-ldez.vercel.app',
  output: "server",
  adapter: vercel(),
  image: {
    remotePatterns: [{ protocol: "https" }],
  },
  integrations: [tailwind()],
  vite: {
    define: {
      'process.env.PRIMARY_REDIS_URL': JSON.stringify(process.env.PRIMARY_REDIS_URL || process.env.REDIS_URL),
      'process.env.REPLICA_REDIS_URL_1': JSON.stringify(process.env.REPLICA_REDIS_URL_1 || process.env.REPLICA_REDIS_URL),
      'process.env.REPLICA_REDIS_URL_2': JSON.stringify(process.env.REPLICA_REDIS_URL_2),
      'process.env.REPLICA_REDIS_URL_3': JSON.stringify(process.env.REPLICA_REDIS_URL_3),
      'process.env.SCRAPE_API_BASE_URL': JSON.stringify(process.env.SCRAPE_API_BASE_URL)
    }
  }
});