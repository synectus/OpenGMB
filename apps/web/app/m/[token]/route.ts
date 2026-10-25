import { getPublicPostImage } from "@opengmb/core";
import { getDb } from "../../../lib/auth";

/**
 * Public bytes of a post library image. Google fetches a post's image from this URL when the post
 * is sent, so there is no session. The 48-hex token is the capability; anything else is a plain 404
 * that reveals nothing. Only the content type core validated is served, with nosniff.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const img = await getPublicPostImage(getDb(), token);
  if (!img) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(img.bytes), {
    status: 200,
    headers: {
      "content-type": img.contentType,
      "content-length": String(img.bytes.length),
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}
