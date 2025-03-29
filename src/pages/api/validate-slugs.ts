import type { APIRoute } from "astro";
import { validateSlugs } from "../../lib/api";

export const POST: APIRoute = async ({ request }) => {
  try {
    const { slugs } = await request.json();
    const validSlugs = await validateSlugs(slugs);
    
    return new Response(JSON.stringify({ validSlugs }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Validation error:', error);
    return new Response("Validation failed", { status: 500 });
  }
}; 