import type { GridPoint } from "../math";

/** The business being ranked. Matched by place id when known, else by exact title (case-insensitive). */
export type GridTarget = {
  name: string;
  placeId: string | null;
  /** Keyword rank (K4): the business's website domain, matched against organic results. */
  domain?: string | null;
};

/** A grid point handed to a driver; `pingbackUrl` is set only for drivers with completion "pingback". */
export type SubmitPoint = GridPoint & { pingbackUrl: string | null };

/** The driver's handle for one submitted point. `ref` is the provider task id. */
export type TaskRef = { row: number; col: number; ref: string };

/** One result at one point, in the provider's order. */
export type RankedResult = {
  /** 1-based position within the returned list (DataForSEO rank_group). */
  rank: number;
  rankAbsolute: number | null;
  title: string | null;
  placeId: string | null;
  cid: string | null;
  rating: number | null;
  /** Optional: the relevance check and older tests do not have it. */
  address?: string | null;
  /** Number of Google reviews. Optional for the same reason. */
  reviewCount?: number | null;
  /** Maps results only (K2c): Google categories of the business, free with every Maps result. */
  category?: string | null;
  additionalCategories?: string[];
  categoryIds?: string[];
  /** Keyword rank (K4) only. "local_pack" and "organic" items of one Google results page; absent for Maps results. */
  kind?: "local_pack" | "organic";
  domain?: string | null;
  url?: string | null;
};

/** What a driver's submit achieved: tasks that exist, points that could not be submitted, and what the provider charged. */
export type SubmitResult = {
  refs: TaskRef[];
  failed: { row: number; col: number; error: string }[];
  /** USD the provider reported for the tasks it created (0 for free drivers). */
  providerCostUsd: number;
  /** Set when the provider refused because of the account (stops later chunks). */
  accountError?: { code: number; message: string };
};

/**
 * A swappable data source for geo-grid rank checks. The default is DataForSEO Standard queue
 * (resold with a markup). A bring-your-own-key DataForSEO driver (B1) is a new GridDriver built
 * from the same DataForSeoTransport with the customer's credentials; nothing else changes.
 */
export interface GridDriver {
  readonly id: "dataforseo_standard" | "places_relevance" | "dataforseo_serp";
  /** Shown everywhere results from this driver appear. */
  readonly label: string;
  /** false = these positions are NOT Google Maps rank and must be labelled as such. */
  readonly isMapsRank: boolean;
  /** pingback: results arrive later via webhook. immediate: collect right after submit. */
  readonly completion: "pingback" | "immediate";
  /** Provider cost in USD before our markup. */
  estimateCost(points: number, keywordCount: number): number;
  submit(points: SubmitPoint[], keyword: string, target: GridTarget): Promise<SubmitResult>;
  collect(task: TaskRef): Promise<RankedResult[]>;
}
