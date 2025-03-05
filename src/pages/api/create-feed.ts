import type { APIRoute } from "astro";
import { createHash } from 'crypto';
import { storeFeedMapping } from '../../lib/db';

// In-memory storage (replace with database in production)
const feedMappings = new Map<string, { slugs: string[], lang: string }>();

export const POST: APIRoute = async ({ request }) => {
  try {
    console.log("Handling create-feed API request");
    
    if (!request.body) {
      console.error("Request has no body");
      return new Response("Request body is required", { status: 400 });
    }

    let body;
    try {
      body = await request.json();
    } catch (parseError) {
      console.error("Failed to parse request JSON:", parseError);
      return new Response("Invalid JSON in request body", { status: 400 });
    }

    const { slugs, lang } = body;

    if (!Array.isArray(slugs) || slugs.length === 0) {
      console.error("Invalid slugs array:", slugs);
      return new Response("Invalid slugs array", { status: 400 });
    }

    if (!lang) {
      console.error("Language not specified");
      return new Response("Language is required", { status: 400 });
    }

    console.log(`Creating feed for ${slugs.length} slugs in language: ${lang}`);

    // Create a unique hash based on slugs and language
    const dataString = `${slugs.sort().join(',')}:${lang}`;
    const hash = createHash('md5').update(dataString).digest('hex').slice(0, 8);

    try {
      // Store the mapping in Redis
      await storeFeedMapping(hash, slugs, lang);
      console.log(`Successfully created feed with ID: ${hash}`);
    } catch (dbError: any) {
      console.error("Database error while storing feed mapping:", dbError);
      return new Response(`Database error: ${dbError.message || "Unknown error"}`, { 
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }

    return new Response(JSON.stringify({ feedId: hash }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error: any) {
    console.error('Unexpected error creating feed:', error);
    return new Response(JSON.stringify({ 
      error: "Internal server error", 
      message: error.message || "Unknown error",
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    }), { 
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
};

// Export the mappings for use in other files
export { feedMappings }; 