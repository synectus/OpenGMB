/**
 * A8 post images: where stock photos and AI images come from. Provider facts carry the page they came
 * from and the date they were read; our own choices say so. Logic reads this file and holds no literal
 * price, limit, model id or URL.
 */

/**
 * Stock photos (free). Pixabay was chosen instead of Pexels on 2026-10-24. Facts below are from
 * https://pixabay.com/api/docs/ read on 2026-10-24.
 */
export const STOCK_PHOTOS = {
  provider: "pixabay",
  label: "Pixabay",
  /** GET with `key`, `q` (or `id`), `image_type`, `orientation`, `per_page`, `page`, `safesearch`. */
  searchUrl: "https://pixabay.com/api/",
  siteUrl: "https://pixabay.com/",
  /**
   * Only these hosts are ever downloaded from. The docs say webformat and large urls are served from
   * pixabay.com/get/ and previews from cdn.pixabay.com.
   */
  imageHosts: ["pixabay.com", "cdn.pixabay.com"],
  /** Which hit field is saved into the library (largeImageURL is 1280px wide) and which is shown in results. */
  downloadField: "largeImageURL",
  thumbField: "webformatURL",
  imageType: "photo",
  orientation: "horizontal",
  safesearch: "true",
  /** Documented range 3 to 200, default 20. */
  perPage: 24,
  queryMaxChars: 100,
  /** The API stops at 500 results per query (`totalHits`). */
  maxResults: 500,
  /** Default limit: 100 requests per 60 seconds per API key; over it answers HTTP 429. */
  rateLimit: { requests: 100, perSeconds: 60 },
  /** "Requests must be cached for 24 hours." Searches are cached in memory for this long. */
  cacheTtlMs: 24 * 60 * 60 * 1000,
  cacheMaxEntries: 500,
  /**
   * Permanent hotlinking is not allowed, so a chosen image is downloaded and re-served from our own
   * library; search results only show Pixabay urls temporarily. Pixabay asks that users be shown where
   * the images come from whenever results are displayed.
   */
  attribution: "Image by {name} from Pixabay",
  creditNameMax: 120,
  sourceUrl: "https://pixabay.com/api/docs/",
  verifiedOn: "2026-10-24",
} as const;

/**
 * AI images. Model id is an exact choice (2026-10-24); OpenAI's model page
 * (developers.openai.com/api/docs/models/gpt-image-2.5-sunburst) lists it as the default snapshot of
 * `gpt-image-2.5-sunburst`. OpenAI prices images per token, not per image, so a flat per-image price
 * is output tokens x the image-output rate. `estimatedOutputTokens` is OUR ESTIMATE for the size and
 * quality below: OpenAI publishes no per-image table for this model. To confirm against a real bill.
 */
export const AI_IMAGES = {
  provider: "openai",
  model: "gpt-image-2.5-sunburst-2026-09-08",
  endpoint: "https://api.openai.com/v1/images/generations",
  /** 4:3 like POST_IMAGE_SIZE (1200x900); multiples of 16 within the documented limits. */
  size: "1280x960",
  quality: "medium",
  outputFormat: "jpeg",
  /** Image output, standard tier, USD 30 per 1M tokens, in micro-USD. */
  imageOutputPerMTokMicroUsd: 30_000_000,
  estimatedOutputTokens: 1_600,
  promptMaxChars: 500,
  requestTimeoutMs: 120_000,
  /** Our label for the picture, shown in the app and saved with the image. */
  label: "AI-made image",
  pricingSourceUrl: "https://developers.openai.com/api/docs/pricing",
  modelSourceUrl: "https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst",
  verifiedOn: "2026-10-24",
} as const;

/**
 * Google's post rules ask for real photos of the business. The guard is added to every prompt so an
 * AI image is an illustration and never passes as a photo of the premises, staff or customers.
 */
export const AI_IMAGE_PROMPT_GUARD =
  "Style: a clean flat illustration or simple graphic, clearly not a photograph. Do not depict a real storefront, building interior, real people, faces, logos, brand names, readable text, prices or claims. Subject: ";
