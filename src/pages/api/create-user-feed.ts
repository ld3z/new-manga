import type { APIRoute } from "astro";
import { createHash } from 'crypto';
import { storeUserFeedMapping } from '../../lib/db';

export const POST: APIRoute = async ({ request }) => {
  try {
    const { userId } = await request.json();

    if (!userId || typeof userId !== 'string') {
      return new Response("Invalid user ID", { status: 400 });
    }

    // Create a unique hash based on userId
    const hash = createHash('md5').update(userId).digest('hex').slice(0, 8);

    // Store the mapping in Redis
    await storeUserFeedMapping(hash, userId);

    return new Response(JSON.stringify({ feedId: hash }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    return new Response("Internal server error", { status: 500 });
  }
};