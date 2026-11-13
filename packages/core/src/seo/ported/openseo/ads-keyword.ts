// Ported from OpenSEO (https://github.com/every-app/open-seo) at 4fa42c879fd26657aec3472dcf44f08226816df3
// Source: src/server/lib/dataforseo/google-ads.ts (ADS_INVALID_KEYWORD_CHARS, isAdsKeyword)
// Copyright (c) 2026 Ben Senescu. MIT License; see THIRD_PARTY_NOTICES.md. Modified for OpenGMB.
// Google Ads fails the whole search_volume task when one keyword has one of these symbols or an emoji,
// is longer than 80 characters, or has more than 10 words.
const ADS_INVALID_KEYWORD_CHARS = /[!@%,*(){}<>|^~;=?`]|\p{Extended_Pictographic}/u;
export function isAdsKeyword(keyword: string): boolean {
  return keyword.length <= 80 && keyword.split(/\s+/).length <= 10 && !ADS_INVALID_KEYWORD_CHARS.test(keyword);
}
