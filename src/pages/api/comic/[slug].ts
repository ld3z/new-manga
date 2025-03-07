import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ params }) => {
  const { slug } = params;
  
  try {
    const response = await fetch(
      `https://api.comick.fun/comic/${encodeURIComponent(slug!)}/`
    );
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Comic fetch error:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch comic details' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
}; 