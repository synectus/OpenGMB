// Ported from OpenSEO (https://github.com/every-app/open-seo) at 4fa42c879fd26657aec3472dcf44f08226816df3
// Source: src/server/features/keywords/services/research/research-data.ts (mapKeywordDataItems, clickstream branch removed)
// Copyright (c) 2026 Ben Senescu. MIT License; see THIRD_PARTY_NOTICES.md. Modified for OpenGMB.
import { normalizeIntent, type KeywordIntent } from "./intent";
export type LabsItem = {
  keyword?: string | null;
  keyword_info?: { search_volume?: number | null; cpc?: number | null; competition?: number | null; monthly_searches?: { year?: number; month?: number; search_volume?: number | null }[] | null } | null;
  keyword_properties?: { keyword_difficulty?: number | null } | null;
  search_intent_info?: { main_intent?: string | null } | null;
};
export type LabsRow = {
  keyword: string; searchVolume: number | null; trend: { year: number; month: number; searchVolume: number }[];
  cpc: number | null; competition: number | null; keywordDifficulty: number | null; intent: KeywordIntent;
};
export function mapLabsItems(items: LabsItem[]): LabsRow[] {
  const rows: LabsRow[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.keyword) continue;
    const keyword = item.keyword.trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(keyword)) continue;
    seen.add(keyword);
    const info = item.keyword_info;
    rows.push({
      keyword,
      searchVolume: info?.search_volume ?? null,
      trend: (info?.monthly_searches ?? []).map((e) => ({ year: e.year ?? 0, month: e.month ?? 0, searchVolume: e.search_volume ?? 0 })),
      cpc: info?.cpc ?? null,
      competition: info?.competition ?? null,
      keywordDifficulty: item.keyword_properties?.keyword_difficulty ?? null,
      intent: normalizeIntent(item.search_intent_info?.main_intent),
    });
  }
  return rows;
}
