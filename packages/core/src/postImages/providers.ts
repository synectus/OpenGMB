import { AI_IMAGE_PROMPT_GUARD, AI_IMAGES, STOCK_PHOTOS } from "../config/post-image-sources";
import { CoreError } from "../errors";
import { integrationEnv } from "../integrations";

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;
let override: { fetch?: Fetch; env?: Env } = {};
/** Tests only: a fake fetch and/or an injected env. Pass {} to restore. No test makes a live call. */
export function setImageProviderOverrides(o: { fetch?: Fetch; env?: Env }): void {
  override = o;
  searchCache.clear();
}
const env = (): Env => override.env ?? integrationEnv();
const doFetch: Fetch = (...a) => (override.fetch ?? fetch)(...a);

export const STOCK_NOT_SET_UP = "Stock photos are not set up on this server";
export const AI_IMAGES_NOT_SET_UP = "AI images are not set up on this server";

export const stockKey = () => env().PIXABAY_API_KEY?.trim() || null;
export const aiImageKey = () => env().OPENAI_API_KEY?.trim() || null;

/** The documented Pixabay hit object (only the fields we read). */
export type PixabayHit = {
  id: number;
  pageURL: string;
  tags?: string;
  webformatURL: string;
  largeImageURL: string;
  imageWidth: number;
  imageHeight: number;
  user: string;
  user_id: number;
};

export type StockResult = {
  id: string;
  thumbUrl: string;
  width: number;
  height: number;
  alt: string;
  creditName: string;
  creditUrl: string;
};

const clean = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const imageHosts: readonly string[] = STOCK_PHOTOS.imageHosts;
/** An https url on one of Pixabay's image hosts, or null. */
const imageUrl = (s: unknown): string | null => {
  try {
    const u = new URL(String(s));
    return u.protocol === "https:" && imageHosts.includes(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
};
/** The image's page on pixabay.com, or null. */
const pageUrl = (s: unknown): string | null => {
  try {
    const u = new URL(String(s));
    return u.protocol === "https:" && u.hostname === "pixabay.com" ? u.toString() : null;
  } catch {
    return null;
  }
};

/** Our shape from a Pixabay hit; null if it lacks what the credit and download need. */
export function toStockResult(p: PixabayHit): StockResult | null {
  const thumb = imageUrl(p.webformatURL);
  const page = pageUrl(p.pageURL);
  const name = clean(p.user, STOCK_PHOTOS.creditNameMax);
  if (!thumb || !page || !name || !imageUrl(p.largeImageURL)) return null;
  return {
    id: String(p.id),
    thumbUrl: thumb,
    width: p.imageWidth,
    height: p.imageHeight,
    alt: clean(p.tags, 200),
    creditName: name,
    creditUrl: page,
  };
}

async function pixabayGet(params: Record<string, string>): Promise<{ total?: number; totalHits?: number; hits?: PixabayHit[] }> {
  const key = stockKey();
  if (!key) throw new CoreError("NOT_CONFIGURED", STOCK_NOT_SET_UP);
  const u = new URL(STOCK_PHOTOS.searchUrl);
  u.searchParams.set("key", key);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let res: Response;
  try {
    res = await doFetch(u.toString(), { signal: AbortSignal.timeout(20_000) });
  } catch {
    // The url carries the key, so the error text is fixed and never echoes it.
    throw new CoreError("CONFLICT", "The stock photo service could not be reached. Try again.");
  }
  if (res.status === 429) throw new CoreError("CONFLICT", "The stock photo service is busy. Try again in a while.");
  if (!res.ok) throw new CoreError("CONFLICT", `The stock photo service answered with an error (HTTP ${res.status}).`);
  return res.json();
}

type SearchOut = { results: StockResult[]; hasMore: boolean };
/** Pixabay requires search responses to be cached for 24 hours. In memory, per process. */
const searchCache = new Map<string, { at: number; out: SearchOut }>();

/** True when this search is answered from the 24-hour cache (no call to Pixabay). */
export function stockSearchCached(query: string, page: number): boolean {
  const hit = searchCache.get(`${query.toLowerCase()}|${page}`);
  return Boolean(hit && Date.now() - hit.at < STOCK_PHOTOS.cacheTtlMs);
}

export async function searchStock(query: string, page: number): Promise<SearchOut> {
  const cacheKey = `${query.toLowerCase()}|${page}`;
  const hit = searchCache.get(cacheKey);
  if (hit && Date.now() - hit.at < STOCK_PHOTOS.cacheTtlMs) return hit.out;
  const body = await pixabayGet({
    q: query,
    image_type: STOCK_PHOTOS.imageType,
    orientation: STOCK_PHOTOS.orientation,
    safesearch: STOCK_PHOTOS.safesearch,
    per_page: String(STOCK_PHOTOS.perPage),
    page: String(page),
  });
  const results = (body.hits ?? []).flatMap((p) => {
    const r = toStockResult(p);
    return r ? [r] : [];
  });
  const out = { results, hasMore: page * STOCK_PHOTOS.perPage < Math.min(body.totalHits ?? 0, STOCK_PHOTOS.maxResults) };
  if (searchCache.size >= STOCK_PHOTOS.cacheMaxEntries) searchCache.delete(searchCache.keys().next().value!);
  searchCache.set(cacheKey, { at: Date.now(), out });
  return out;
}

/** One photo by id, with its credit as Pixabay states it, plus the bytes of the saved size. */
export async function fetchStockPhoto(id: string): Promise<{ photo: StockResult; bytes: Uint8Array }> {
  const p = (await pixabayGet({ id })).hits?.[0];
  if (!p) throw new CoreError("NOT_FOUND", "Photo not found");
  const photo = toStockResult(p);
  const src = imageUrl(p[STOCK_PHOTOS.downloadField]);
  if (!photo || !src) throw new CoreError("CONFLICT", "The stock photo service sent an unusable photo.");
  let res: Response;
  try {
    res = await doFetch(src, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  } catch {
    throw new CoreError("CONFLICT", "The photo could not be downloaded. Try again.");
  }
  if (!res.ok) throw new CoreError("CONFLICT", `The photo could not be downloaded (HTTP ${res.status}).`);
  return { photo, bytes: new Uint8Array(await res.arrayBuffer()) };
}

export type GeneratedImage = { bytes: Uint8Array; inputTokens: number | null; outputTokens: number | null };

/** The prompt actually sent: the guard first, then the person's subject. */
export const guardedPrompt = (subject: string) => AI_IMAGE_PROMPT_GUARD + subject;

/** OpenAI Images API. Errors carry the HTTP status only; the prompt is never logged. */
export async function generateImage(subject: string): Promise<GeneratedImage> {
  const key = aiImageKey();
  if (!key) throw new CoreError("NOT_CONFIGURED", AI_IMAGES_NOT_SET_UP);
  let res: Response;
  try {
    res = await doFetch(AI_IMAGES.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: AI_IMAGES.model,
        prompt: guardedPrompt(subject),
        n: 1,
        size: AI_IMAGES.size,
        quality: AI_IMAGES.quality,
        output_format: AI_IMAGES.outputFormat,
      }),
      signal: AbortSignal.timeout(AI_IMAGES.requestTimeoutMs),
    });
  } catch {
    throw new CoreError("CONFLICT", "The AI image service could not be reached. Try again.");
  }
  if (res.status === 400) {
    throw new CoreError("INVALID_INPUT", "The AI image service refused this description. Try different wording.");
  }
  if (!res.ok) throw new CoreError("CONFLICT", `The AI image service answered with an error (HTTP ${res.status}).`);
  const body = (await res.json()) as {
    data?: { b64_json?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new CoreError("CONFLICT", "The AI image service sent no image.");
  return {
    bytes: new Uint8Array(Buffer.from(b64, "base64")),
    inputTokens: body.usage?.input_tokens ?? null,
    outputTokens: body.usage?.output_tokens ?? null,
  };
}
