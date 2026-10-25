import { NextResponse, type NextRequest } from "next/server";
import { isLikelyBot, openReviewRequestLink } from "@opengmb/core";
import { getDb } from "../../../lib/auth";

// Public, no login, never cached. The personal link in a review request email: it counts a real click
// (link scanners are redirected but not counted) and sends everyone to the same Google review form.
export const dynamic = "force-dynamic";
const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" };

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const to = await openReviewRequestLink(getDb(), token, { isBot: isLikelyBot(request.headers.get("user-agent")) });
  if (!to) return new NextResponse("This link does not exist.", { status: 404, headers: HEADERS });
  return NextResponse.redirect(to, { status: 302, headers: HEADERS });
}
