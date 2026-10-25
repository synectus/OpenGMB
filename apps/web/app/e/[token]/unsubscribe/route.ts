import { NextResponse } from "next/server";
import { unsubscribeInfo, unsubscribeReviewRequest } from "@opengmb/core";
import { getDb } from "../../../../lib/auth";

// Public, no login. GET only shows a page with one button (mail scanners open links, so a GET must not
// unsubscribe anyone). POST unsubscribes: the button, and the RFC 8058 one-click request that mail
// apps send for the List-Unsubscribe-Post header. English only: this page has no signed-in locale.
export const dynamic = "force-dynamic";
const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex", "content-type": "text/html; charset=utf-8" };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const page = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences</title></head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px">${body}</body></html>`;

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const info = await unsubscribeInfo(getDb(), token);
  if (!info) return new NextResponse(page("<p>This link does not exist.</p>"), { status: 404, headers: HEADERS });
  const body = info.alreadyOptedOut
    ? `<h1>You are unsubscribed</h1><p>${esc(info.business)} will not email you again.</p>`
    : `<h1>Stop emails from ${esc(info.business)}?</h1><p>You will not get any more review requests from ${esc(info.business)}.</p><form method="post"><button type="submit" style="padding:10px 16px;font-size:16px">Unsubscribe</button></form>`;
  return new NextResponse(page(body), { headers: HEADERS });
}

export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const res = await unsubscribeReviewRequest(getDb(), token);
  if (res === "invalid") return new NextResponse(page("<p>This link does not exist.</p>"), { status: 404, headers: HEADERS });
  return new NextResponse(page("<h1>You are unsubscribed</h1><p>You will not get any more review requests.</p>"), { headers: HEADERS });
}
