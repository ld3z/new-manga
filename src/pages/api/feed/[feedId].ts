import type { APIRoute } from "astro";
import { getFeedMapping } from '../../../lib/db';

export const GET: APIRoute = async ({ params }) => {
  const { feedId } = params;
  
  if (!feedId) {
    return new Response("Feed ID not provided", { status: 400 });
  }

  try {
    console.log(`Fetching feed mapping for ID: ${feedId}`);
    const mapping = await getFeedMapping(feedId);
    
    if (!mapping) {
      console.error(`Feed not found for ID: ${feedId}`);
      return new Response(`Feed with ID "${feedId}" not found`, { status: 404 });
    }

    // Validate mapping structure before returning
    if (!Array.isArray(mapping.slugs)) {
      console.error(`Invalid slugs in feed mapping for ID: ${feedId}`, mapping);
      return new Response(`Feed data corruption: invalid slugs format`, { 
        status: 500 
      });
    }

    // Ensure consistent response format
    const response = {
      slugs: mapping.slugs.filter(slug => typeof slug === 'string' && slug.trim()),
      lang: typeof mapping.lang === 'string' ? mapping.lang : 'en'
    };

    console.log(`Successfully retrieved feed mapping for ID: ${feedId}`, response);
    
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error(`Error fetching feed ${feedId}:`, error);
    
    const errorMessage = error instanceof Error 
      ? `Internal server error: ${error.message}` 
      : "Internal server error";
    
    // Add specific error codes for better client-side handling
    let statusCode = 500;
    let friendlyMessage = errorMessage;
    
    if (error instanceof Error) {
      if (error.message.includes('ETIMEDOUT')) {
        friendlyMessage = `Database connection timeout. This is often temporary, especially after server idle periods. Please try again in a few seconds.`;
      } else if (error.message.includes('ECONNREFUSED')) {
        friendlyMessage = `Database connection refused. The service may be temporarily unavailable.`;
      } else if (error.message.includes('ENOTFOUND')) {
        friendlyMessage = `Database host not found. There may be a configuration issue.`;
      }
    }
      
    return new Response(friendlyMessage, { status: statusCode });
  }
};