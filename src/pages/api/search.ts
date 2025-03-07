import type { APIRoute } from "astro";

export const POST: APIRoute = async ({ request }) => {
  const { query } = await request.json();
  
  try {
    const response = await fetch(
      `https://api.comick.io/v1.0/search/?page=1&limit=5&q=${encodeURIComponent(query)}`
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
    console.error('Search error:', error);
    return new Response(JSON.stringify({ error: 'Failed to search comics' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
}; 