import {
  DATAFORSEO_ENDPOINTS,
  DFS_ERROR_CLASSES,
  GEOGRID_DEFAULTS,
  GEOGRID_DRIVER_LABELS,
  GEOGRID_SERP,
  GEOGRID_SPEEDS,
  type GridSpeed,
} from "../../config/geogrid";
import { roundUpUsd } from "../cost";
import {
  fixtureDataForSeoTransport,
  type DataForSeoTransport,
  type DfsProduct,
  type DfsTag,
  type DfsTaskGetResponse,
} from "./fixtures";
import { DfsAccountError, DfsNotReadyError } from "./errors";
import type { GridDriver, RankedResult, SubmitResult } from "./types";

/** DataForSEO "task ok" / "task created" status codes (public API docs). */
const OK = 20000;
const CREATED = 20100;

/** The task of a finished success. Throws on a task that is not ready (DfsNotReadyError) or failed. */
function finishedTask(res: DfsTaskGetResponse) {
  const task = res.tasks?.[0];
  if (!task) throw new Error("DataForSEO task_get: no task in response");
  if ((DFS_ERROR_CLASSES.notReady as readonly number[]).includes(task.status_code)) {
    throw new DfsNotReadyError(task.status_code);
  }
  if (task.status_code !== OK) {
    throw new Error(`DataForSEO task ${task.id}: ${task.status_code} ${task.status_message}`);
  }
  return task;
}

/** Turn a task_get response into ranked results. Throws on a task that is not a finished success. */
export function parseDataForSeoTaskGet(res: DfsTaskGetResponse): RankedResult[] {
  const items = finishedTask(res).result?.[0]?.items ?? [];
  return items
    .flatMap((i) => (i.type === "maps_search" ? [i] : []))
    .map((i) => ({
      rank: i.rank_group,
      rankAbsolute: i.rank_absolute ?? null,
      title: i.title ?? null,
      placeId: i.place_id ?? null,
      cid: i.cid ?? null,
      rating: i.rating?.value ?? null,
      address: i.address ?? null,
      reviewCount: i.rating?.votes_count ?? null,
      category: i.category ?? null,
      additionalCategories: i.additional_categories ?? [],
      categoryIds: i.category_ids ?? [],
    }));
}

/**
 * Google Organic task_get (keyword rank): the local pack and the organic results of one results page.
 * Field names per https://docs.dataforseo.com/v3/serp/google/organic/task_get/advanced/ (verified 2026-10-24).
 * Local pack items carry no place id, so they are matched by domain or title.
 */
export function parseSerpTaskGet(res: DfsTaskGetResponse): RankedResult[] {
  const items = finishedTask(res).result?.[0]?.items ?? [];
  const out: RankedResult[] = [];
  for (const i of items) {
    if (i.type === "local_pack") {
      out.push({
        kind: "local_pack",
        rank: i.rank_group,
        rankAbsolute: i.rank_absolute ?? null,
        title: i.title ?? null,
        placeId: null,
        cid: i.cid ?? null,
        rating: i.rating?.value ?? null,
        reviewCount: i.rating?.votes_count ?? null,
        domain: i.domain ?? null,
        url: i.url ?? null,
      });
    } else if (i.type === "organic") {
      out.push({
        kind: "organic",
        rank: i.rank_group,
        rankAbsolute: i.rank_absolute ?? null,
        title: i.title ?? null,
        placeId: null,
        cid: null,
        rating: null,
        domain: i.domain ?? null,
        url: i.url ?? null,
      });
    }
  }
  return out;
}

/** The request tag, with the target name cut so the JSON stays within DataForSEO's tag limit. Matching never reads the name from the tag live. */
function boundedTag(tag: DfsTag): DfsTag {
  let n = tag.n;
  while (n.length > 0 && JSON.stringify({ ...tag, n }).length > DATAFORSEO_ENDPOINTS.maxTagChars) n = n.slice(0, -1);
  return { ...tag, n };
}

/**
 * Default driver. One task per grid point (Standard queue, or High priority when speed is "fast"), results delivered by pingback.
 * `transport` defaults to the offline fixture; a live transport (our key, or the customer's key
 * for B1) implements the same two calls. `product` "organic" is the keyword-rank driver (K4): the same
 * queue, pingback and billing, but one Google Organic search per point (local pack + organic results).
 */
export function createDataForSeoDriver(
  transport: DataForSeoTransport = fixtureDataForSeoTransport(),
  speed: GridSpeed = "standard",
  product: DfsProduct = "maps",
): GridDriver {
  const serp = product === "organic";
  const unit = serp ? GEOGRID_SPEEDS[speed].perTaskUsd * GEOGRID_SERP.pages : GEOGRID_SPEEDS[speed].perTaskUsd;
  return {
    id: serp ? "dataforseo_serp" : "dataforseo_standard",
    label: serp ? GEOGRID_DRIVER_LABELS.dataforseo_serp : GEOGRID_DRIVER_LABELS.dataforseo_standard,
    isMapsRank: !serp,
    completion: "pingback",
    estimateCost: (points, keywordCount) => roundUpUsd(points * keywordCount * unit),
    async submit(points, keyword, target) {
      const out: SubmitResult = { refs: [], failed: [], providerCostUsd: 0 };
      if (points.length === 0) return out;
      const centre: [number, number] = [
        points.reduce((s, p) => s + p.lat, 0) / points.length,
        points.reduce((s, p) => s + p.lng, 0) / points.length,
      ];
      const tag = JSON.stringify(boundedTag({ c: centre, n: target.name, p: target.placeId, d: target.domain ?? null }));
      const size = DATAFORSEO_ENDPOINTS.maxTasksPerPost;
      for (let at = 0; at < points.length; at += size) {
        const chunk = points.slice(at, at + size);
        const failChunk = (error: string) => {
          for (const p of chunk) out.failed.push({ row: p.row, col: p.col, error });
        };
        // An account error would fail every later chunk the same way: stop instead of asking again.
        if (out.accountError) {
          failChunk(`task_post_failed: ${out.accountError.code} not attempted`);
          continue;
        }
        let res;
        try {
          res = await transport.taskPost(
            chunk.map((p) => ({
              keyword,
              location_coordinate: serp
                ? `${p.lat.toFixed(7)},${p.lng.toFixed(7)},${GEOGRID_SERP.coordinateRadius}`
                : `${p.lat.toFixed(7)},${p.lng.toFixed(7)},${GEOGRID_DEFAULTS.mapsZoom}z`,
              language_code: "en",
              device: "mobile" as const,
              depth: serp ? GEOGRID_SERP.depth : GEOGRID_DEFAULTS.depth,
              ...(serp ? {} : { search_this_area: GEOGRID_DEFAULTS.mapsSearchThisArea }),
              ...(p.pingbackUrl ? { pingback_url: p.pingbackUrl } : {}),
              // Only "fast" sends priority; Standard keeps DataForSEO's default (1).
              ...(speed === "fast" ? { priority: GEOGRID_SPEEDS.fast.priority } : {}),
              tag,
            })),
            product,
          );
        } catch (e) {
          if (e instanceof DfsAccountError) {
            // Nothing was bought yet: let the caller fail the whole run (and alert).
            if (out.refs.length === 0 && out.failed.length === 0) throw e;
            out.accountError = { code: e.code, message: e.message };
          }
          failChunk(`task_post_failed: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        if (res.status_code !== OK || res.tasks.length !== chunk.length) {
          failChunk(`task_post_failed: ${res.status_code} ${res.status_message}`);
          continue;
        }
        out.providerCostUsd += res.cost ?? 0;
        res.tasks.forEach((t, i) => {
          const p = chunk[i]!;
          if (t.status_code === CREATED) out.refs.push({ row: p.row, col: p.col, ref: t.id });
          else out.failed.push({ row: p.row, col: p.col, error: `task_post_item: ${t.status_code} ${t.status_message}` });
        });
      }
      return out;
    },
    async collect(task) {
      const res = await transport.taskGet(task.ref, product);
      return serp ? parseSerpTaskGet(res) : parseDataForSeoTaskGet(res);
    },
  };
}
