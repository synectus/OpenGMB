// Ported from OpenSEO (https://github.com/every-app/open-seo) at 4fa42c879fd26657aec3472dcf44f08226816df3
// Source: src/server/features/keywords/services/research/helpers.ts (interleaveRows)
// Copyright (c) 2026 Ben Senescu. MIT License; see THIRD_PARTY_NOTICES.md. Modified for OpenGMB.
export function interleaveRows<T extends { keyword: string }>(first: T[], second: T[], limit: number): T[] {
  const rows: T[] = [];
  const seen = new Set<string>();
  const longest = Math.max(first.length, second.length);
  for (let i = 0; i < longest && rows.length < limit; i++) {
    for (const source of [first, second]) {
      const row = source[i];
      if (!row || seen.has(row.keyword) || rows.length >= limit) continue;
      seen.add(row.keyword);
      rows.push(row);
    }
  }
  return rows;
}
