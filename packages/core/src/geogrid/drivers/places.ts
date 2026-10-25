import { randomUUID } from "node:crypto";
import { GEOGRID_DEFAULTS, GEOGRID_DRIVER_LABELS, GEOGRID_PRICING } from "../../config/geogrid";
import { CoreError } from "../../errors";
import { roundUpUsd } from "../cost";
import { fixturePlacesTransport, type PlacesTransport } from "./fixtures";
import type { GridDriver, RankedResult } from "./types";

/**
 * Google Places API (New) Text Search, IDs-only field mask. This is relevance, NOT Google Maps
 * rank: an accuracy test on 2026-10-12 matched 0 of 81 points against real Maps rank. Kept only as
 * a free sanity check and labelled as such everywhere (`isMapsRank: false`).
 * Results are matched to the target by place id only (titles are not fetched), so a target place
 * id is required.
 */
export function createPlacesRelevanceDriver(
  transport: PlacesTransport = fixturePlacesTransport(),
): GridDriver {
  const unit = GEOGRID_PRICING.places_relevance.perTaskUsd;
  // Immediate driver: submit does the work, collect hands the stored answer back (same process).
  const pending = new Map<string, RankedResult[]>();
  return {
    id: "places_relevance",
    label: GEOGRID_DRIVER_LABELS.places_relevance,
    isMapsRank: false,
    completion: "immediate",
    estimateCost: (points, keywordCount) => roundUpUsd(points * keywordCount * unit),
    async submit(points, keyword, target) {
      if (!target.placeId) {
        throw new CoreError(
          "INVALID_INPUT",
          "The relevance check needs the target's Google place id",
        );
      }
      const refs = [];
      for (const p of points) {
        const res = await transport.searchText({
          textQuery: keyword,
          maxResultCount: GEOGRID_DEFAULTS.depth,
          locationBias: { circle: { center: { latitude: p.lat, longitude: p.lng }, radius: 500 } },
          targetPlaceId: target.placeId,
        });
        const ref = `places-${randomUUID()}`;
        pending.set(
          ref,
          res.places.map((pl, i) => ({
            rank: i + 1,
            rankAbsolute: i + 1,
            title: null,
            placeId: pl.id,
            cid: null,
            rating: null,
          })),
        );
        refs.push({ row: p.row, col: p.col, ref });
      }
      return { refs, failed: [], providerCostUsd: 0 };
    },
    async collect(task) {
      const r = pending.get(task.ref);
      if (!r) throw new Error(`Unknown relevance-check task ${task.ref}`);
      pending.delete(task.ref);
      return r;
    },
  };
}
