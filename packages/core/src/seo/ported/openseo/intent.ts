// Ported from OpenSEO (https://github.com/every-app/open-seo) at 4fa42c879fd26657aec3472dcf44f08226816df3
// Source: src/server/features/keywords/services/research/helpers.ts (normalizeIntent)
// Copyright (c) 2026 Ben Senescu. MIT License; see THIRD_PARTY_NOTICES.md. Modified for OpenGMB.
export type KeywordIntent = "informational" | "commercial" | "transactional" | "navigational" | "unknown";
export function normalizeIntent(raw: string | null | undefined): KeywordIntent {
  if (!raw) return "unknown";
  const value = raw.toLowerCase();
  if (value.includes("inform")) return "informational";
  if (value.includes("commerc")) return "commercial";
  if (value.includes("transact")) return "transactional";
  if (value.includes("navig")) return "navigational";
  return "unknown";
}
