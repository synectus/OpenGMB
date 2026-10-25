import { randomUUID } from "node:crypto";
import { DATAFORSEO_ENDPOINTS } from "../../config/geogrid";
import { haversineM } from "../math";

/**
 * Deterministic fake providers. No network. Everything a "collect" needs is derived from the
 * request (carried in the task id / request body), so a task submitted by one process can be
 * collected by another, exactly like the real thing.
 */

function hash01(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join("|")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0xffffffff;
}

const PREFIX = [
  "Prime",
  "Summit",
  "Harbor",
  "Oak",
  "Cedar",
  "Bright",
  "Metro",
  "Valley",
  "Pioneer",
  "Anchor",
];
const SUFFIX = ["Care", "Group", "Studio", "Works", "Partners", "Clinic"];
const UNIVERSE = 30;

export type FixtureBusiness = { placeId: string; title: string; rating: number; votes: number; address: string };

/** Sample categories as DataForSEO returns them: a display name, extra names, and ids. */
const FIXTURE_CATEGORIES = [
  { category: "Dentist", additional: ["Cosmetic dentist", "Emergency dental service"], ids: ["dentist", "cosmetic_dentist", "emergency_dental_service"] },
  { category: "Dental clinic", additional: ["Dentist"], ids: ["dental_clinic", "dentist"] },
  { category: "Cosmetic dentist", additional: [], ids: ["cosmetic_dentist"] },
];

function business(keyword: string, i: number): FixtureBusiness {
  return {
    placeId: `ChIJfixture${String(i).padStart(3, "0")}`,
    title:
      `${PREFIX[i % PREFIX.length]} ${SUFFIX[Math.floor(i / PREFIX.length) % SUFFIX.length]} ${keyword.split(" ")[0] ?? ""}`.trim(),
    rating: Math.round((3.4 + hash01(keyword, i, "r") * 1.6) * 10) / 10,
    votes: 5 + Math.floor(hash01(keyword, i, "v") * 400),
    address: `${100 + i} Sample Street`,
  };
}

type Pt = { lat: number; lng: number };
const offset = (c: Pt, northM: number, eastM: number): Pt => ({
  lat: c.lat + (northM / 6_371_008.8) * (180 / Math.PI),
  lng: c.lng + (eastM / (6_371_008.8 * Math.cos((c.lat * Math.PI) / 180))) * (180 / Math.PI),
});

export type FixtureTarget = { name: string; placeId: string | null };

/** Distance-driven ordering (what a Maps rank looks like): the target sits ~250 m north of the centre. */
export function mapsFixtureOrder(p: {
  keyword: string;
  centre: Pt;
  point: Pt;
  target: FixtureTarget;
}): FixtureBusiness[] {
  const scored = Array.from({ length: UNIVERSE }, (_, i) => {
    const b = business(p.keyword, i);
    const angle = hash01(p.keyword, i, "a") * 2 * Math.PI;
    const radius = 600 + hash01(p.keyword, i, "d") * 5000;
    const anchor = offset(p.centre, Math.cos(angle) * radius, Math.sin(angle) * radius);
    return {
      b,
      score: haversineM(p.point, anchor) + hash01(p.keyword, i, p.point.lat, p.point.lng) * 400,
    };
  });
  const targetBiz: FixtureBusiness = {
    placeId: p.target.placeId ?? "ChIJfixtureTarget",
    title: p.target.name,
    rating: 4.6,
    votes: 120,
    address: "1 Sample Street",
  };
  scored.push({
    b: targetBiz,
    score:
      haversineM(p.point, offset(p.centre, 250, 0)) +
      hash01(p.keyword, "target", p.point.lat, p.point.lng) * 400,
  });
  return scored.sort((a, b) => a.score - b.score).map((s) => s.b);
}

/** Relevance ordering: mostly unrelated to geography, which is the point of the "not Maps rank" label. */
export function relevanceFixtureOrder(p: {
  keyword: string;
  point: Pt;
  targetPlaceId: string;
}): string[] {
  const ids = Array.from({ length: UNIVERSE }, (_, i) => business(p.keyword, i).placeId);
  ids.push(p.targetPlaceId);
  return ids
    .map((id) => ({
      id,
      s: hash01(p.keyword, id, Math.round(p.point.lat * 500), Math.round(p.point.lng * 500)),
    }))
    .sort((a, b) => a.s - b.s)
    .map((x) => x.id);
}

/**
 * One Google results page for keyword rank: a local pack of 3 and 20 organic results. The target sits at a
 * position derived from the keyword, so a fixture run is repeatable. A keyword starting with "zzz" is one the
 * target does not rank for (tests).
 */
export function serpFixtureItems(p: { keyword: string; target: FixtureTarget & { domain: string | null } }): DfsSerpItem[] {
  const absent = p.keyword.toLowerCase().startsWith("zzz");
  const packAt = Math.floor(hash01(p.keyword, "pack") * 3);
  const organicAt = Math.floor(hash01(p.keyword, "organic") * 12);
  const items: DfsSerpItem[] = [];
  for (let i = 0; i < 3; i++) {
    const hit = !absent && i === packAt;
    const b = business(p.keyword, i);
    items.push({
      type: "local_pack",
      rank_group: i + 1,
      rank_absolute: i + 1,
      title: hit ? p.target.name : b.title,
      domain: hit ? p.target.domain : `${b.title.toLowerCase().replace(/[^a-z0-9]+/g, "")}.example`,
      url: null,
      cid: String(2000000 + i),
      rating: { rating_type: "Max5", value: b.rating, votes_count: b.votes, rating_max: 5 },
    });
  }
  for (let i = 0; i < 20; i++) {
    const hit = !absent && i === organicAt && p.target.domain !== null;
    const domain = hit ? p.target.domain! : `site${i}-${Math.floor(hash01(p.keyword, i) * 900 + 100)}.example`;
    items.push({
      type: "organic",
      rank_group: i + 1,
      rank_absolute: i + 4,
      title: hit ? p.target.name : `Result ${i + 1} for ${p.keyword}`,
      domain,
      url: `https://${domain}/${hit ? "services" : `page-${i}`}`,
    });
  }
  return items;
}

// --- DataForSEO SERP Google Maps, Standard queue (shapes per the public API docs) -------------

export type DfsTaskPostItem = {
  keyword: string;
  location_coordinate: string; // "lat,lng,zoomz"
  language_code: string;
  device: "desktop" | "mobile";
  depth: number;
  /** false = do not restrict results to the zoom viewport (DataForSEO defaults to true). */
  search_this_area?: boolean;
  pingback_url?: string;
  /** 2 = high priority (extra charge). Omitted for the Standard queue (default 1). */
  priority?: number;
  /** User-defined identifier, returned verbatim by DataForSEO. */
  tag?: string;
};

export type DfsTaskPostResponse = {
  version: string;
  status_code: number;
  status_message: string;
  cost: number;
  tasks_count: number;
  tasks: { id: string; status_code: number; status_message: string; cost: number; result: null }[];
};

export type DfsMapsItem = {
  type: "maps_search";
  rank_group: number;
  rank_absolute: number;
  title: string;
  domain: string | null;
  place_id: string | null;
  cid: string | null;
  feature_id: string | null;
  address?: string | null;
  /** Documented at https://docs.dataforseo.com/v3/serp/google/maps/task_get/advanced/ (verified 2026-10-24). All optional. */
  category?: string | null;
  additional_categories?: string[] | null;
  category_ids?: string[] | null;
  rating: { rating_type: string; value: number; votes_count: number; rating_max: number } | null;
};

/** Google Organic task_get/advanced items (https://docs.dataforseo.com/v3/serp/google/organic/task_get/advanced/, verified 2026-10-24). */
export type DfsSerpItem =
  | {
      type: "local_pack";
      rank_group: number;
      rank_absolute: number;
      title: string;
      domain: string | null;
      url: string | null;
      cid: string | null;
      rating: { rating_type: string; value: number; votes_count: number; rating_max: number } | null;
    }
  | {
      type: "organic";
      rank_group: number;
      rank_absolute: number;
      title: string;
      domain: string;
      url: string;
    };

/** Which DataForSEO endpoint pair a call uses: Google Maps (geo-grid) or Google Organic (keyword rank). */
export type DfsProduct = "maps" | "organic";

export type DfsTaskGetResponse = {
  version: string;
  status_code: number;
  status_message: string;
  tasks_count: number;
  tasks: {
    id: string;
    status_code: number;
    status_message: string;
    cost: number;
    result: { keyword: string; type: "maps" | "organic"; items_count: number; items: (DfsMapsItem | DfsSerpItem)[] }[] | null;
  }[];
};

/** DataForSEO API login + API password (HTTP Basic; the API password is not the account password). */
export type DfsCredentials = { login: string; password: string };

export type DfsCredentialCheck = {
  ok: boolean;
  message: string;
  /** USD left on the account (live user_data). */
  balanceUsd?: number;
  /** The account's daily cost limit in USD, when one is set in the DataForSEO dashboard. */
  dailyLimitUsd?: number | null;
};

export interface DataForSeoTransport {
  taskPost(items: DfsTaskPostItem[], product?: DfsProduct): Promise<DfsTaskPostResponse>;
  taskGet(id: string, product?: DfsProduct): Promise<DfsTaskGetResponse>;
  /** Live: GET /v3/appendix/user_data with Basic auth; 20000 = the credentials work. */
  checkCredentials?(): Promise<DfsCredentialCheck>;
}

/**
 * Fixture transport "authenticated" with a customer's credentials. It behaves exactly like the
 * default fixture; the only credential-dependent behaviour is checkCredentials, which rejects a
 * login ending in "@invalid.test" so the failure path is testable. No network.
 */
export function fixtureByoTransport(creds: DfsCredentials): DataForSeoTransport {
  return {
    ...fixtureDataForSeoTransport(),
    async checkCredentials() {
      return creds.login.endsWith("@invalid.test")
        ? { ok: false, message: "Authorization failed (fixture): 40100" }
        : { ok: true, message: "Ok. (fixture)" };
    },
  };
}

type FixtureTaskId = {
  k: string;
  z: [number, number];
  c: [number, number];
  n: string;
  p: string | null;
  d?: string | null;
  /** Nonce: real task ids are unique per post, so the same point posted twice gets two ids. */
  u: string;
};
const encodeId = (x: FixtureTaskId) => `fx-${Buffer.from(JSON.stringify(x)).toString("base64url")}`;
const decodeId = (id: string): FixtureTaskId | null => {
  if (!id.startsWith("fx-")) return null;
  try {
    return JSON.parse(Buffer.from(id.slice(3), "base64url").toString("utf8")) as FixtureTaskId;
  } catch {
    return null;
  }
};

/** Request tag format used by the fixture to know the grid centre and target; harmless live. */
export type DfsTag = { c: [number, number]; n: string; p: string | null; d?: string | null };

export function fixtureDataForSeoTransport(): DataForSeoTransport {
  return {
    async checkCredentials() {
      return { ok: true, message: "Ok. (fixture)", balanceUsd: 1 };
    },
    async taskPost(items) {
      // The live API refuses more than 100 tasks in one POST (40006), and a tag over 255 characters (40501).
      if (items.length > DATAFORSEO_ENDPOINTS.maxTasksPerPost) {
        return {
          version: "0.1.20250526",
          status_code: 40006,
          status_message: "You can set only 100 tasks in one POST request.",
          cost: 0,
          tasks_count: 0,
          tasks: [],
        };
      }
      const tasks = items.map((it) => {
        if ((it.tag ?? "").length > DATAFORSEO_ENDPOINTS.maxTagChars) {
          return {
            id: "",
            status_code: 40501,
            status_message: "Invalid Field: 'tag'.",
            cost: 0,
            result: null,
          };
        }
        const tag = JSON.parse(it.tag ?? "null") as DfsTag;
        const [lat, lng] = it.location_coordinate.split(",").map(Number) as [number, number];
        return {
          id: encodeId({
            k: it.keyword,
            z: [lat, lng],
            c: tag.c,
            n: tag.n,
            p: tag.p,
            d: tag.d ?? null,
            u: randomUUID(),
          }),
          status_code: 20100,
          status_message: "Task Created.",
          cost: 0.0006,
          result: null,
        };
      });
      return {
        version: "0.1.20250526",
        status_code: 20000,
        status_message: "Ok.",
        cost: tasks.reduce((sum, t) => sum + t.cost, 0),
        tasks_count: tasks.length,
        tasks,
      };
    },
    async taskGet(id, product = "maps") {
      const t = decodeId(id);
      if (!t) {
        return {
          version: "0.1.20250526",
          status_code: 20000,
          status_message: "Ok.",
          tasks_count: 1,
          tasks: [
            { id, status_code: 40401, status_message: "Task Not Found.", cost: 0, result: null },
          ],
        };
      }
      if (product === "organic") {
        const items = serpFixtureItems({ keyword: t.k, target: { name: t.n, placeId: t.p, domain: t.d ?? null } });
        return {
          version: "0.1.20250526",
          status_code: 20000,
          status_message: "Ok.",
          tasks_count: 1,
          tasks: [
            {
              id,
              status_code: 20000,
              status_message: "Ok.",
              cost: 0.0012,
              result: [{ keyword: t.k, type: "organic", items_count: items.length, items }],
            },
          ],
        };
      }
      const order = mapsFixtureOrder({
        keyword: t.k,
        centre: { lat: t.c[0], lng: t.c[1] },
        point: { lat: t.z[0], lng: t.z[1] },
        target: { name: t.n, placeId: t.p },
      }).slice(0, 20);
      return {
        version: "0.1.20250526",
        status_code: 20000,
        status_message: "Ok.",
        tasks_count: 1,
        tasks: [
          {
            id,
            status_code: 20000,
            status_message: "Ok.",
            cost: 0.0006,
            result: [
              {
                keyword: t.k,
                type: "maps",
                items_count: order.length,
                items: order.map((b, i) => ({
                  type: "maps_search",
                  rank_group: i + 1,
                  rank_absolute: i + 1,
                  title: b.title,
                  domain: null,
                  place_id: b.placeId,
                  cid: String(1000000 + i),
                  feature_id: null,
                  address: b.address,
                  category: FIXTURE_CATEGORIES[i % FIXTURE_CATEGORIES.length]!.category,
                  additional_categories: FIXTURE_CATEGORIES[i % FIXTURE_CATEGORIES.length]!.additional,
                  category_ids: FIXTURE_CATEGORIES[i % FIXTURE_CATEGORIES.length]!.ids,
                  rating: {
                    rating_type: "Max5",
                    value: b.rating,
                    votes_count: b.votes,
                    rating_max: 5,
                  },
                })),
              },
            ],
          },
        ],
      };
    },
  };
}

// --- Google Places API (New) searchText, IDs-only field mask ----------------------------------

export type PlacesSearchRequest = {
  textQuery: string;
  maxResultCount: number;
  locationBias: { circle: { center: { latitude: number; longitude: number }; radius: number } };
  /** Fixture only: the real API cannot know which place we are ranking; used to seed the id list. */
  targetPlaceId: string;
};
export type PlacesSearchResponse = { places: { id: string }[] };

export interface PlacesTransport {
  searchText(req: PlacesSearchRequest): Promise<PlacesSearchResponse>;
}

export function fixturePlacesTransport(): PlacesTransport {
  return {
    async searchText(req) {
      const { latitude, longitude } = req.locationBias.circle.center;
      return {
        places: relevanceFixtureOrder({
          keyword: req.textQuery,
          point: { lat: latitude, lng: longitude },
          targetPlaceId: req.targetPlaceId,
        })
          .slice(0, req.maxResultCount)
          .map((id) => ({ id })),
      };
    },
  };
}
