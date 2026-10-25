import { HEALTHCHECK_CONFIG as CFG } from "../config/healthcheck";
import { PROFILE_LIMITS } from "../config/profile-limits";
import type {
  GoogleAttribute,
  GoogleDate,
  GoogleLocalPost,
  GoogleLocation,
  GoogleMediaItem,
  GooglePlaceActionLink,
  GoogleVoiceOfMerchantState,
} from "../google/client";
import { describeVoiceOfMerchant } from "../verification/state";
import { missingCompetitorCategories, ownCategoryKeys, shareUsing, type CompetitorCats } from "./categories";
import { descriptionProblems, keywordsCovered, looksDuplicate, type ListingId } from "./similarity";

export type Importance = "necessary" | "important" | "nice";
/** evaluateHealth never returns "skipped"; checksWithSkips sets it. */
export type CheckStatus = "pass" | "fail" | "unknown" | "skipped";
export type Check = {
  id: string;
  title: string;
  importance: Importance;
  status: CheckStatus;
  /** Plain language: what we found. */
  detail: string;
  /** An in-app route that fixes it, or null when nothing in the app can. */
  fix: { label: string; href: string } | null;
};

/** Every check id, in the order evaluateHealth builds them. evaluate.test.ts pins the two together. */
export const CHECK_IDS = [
  "description",
  "description_quality",
  "description_keywords",
  "primary_category",
  "additional_categories",
  "category_fit",
  "regular_hours",
  "special_hours",
  "phone",
  "website",
  "website_utm",
  "service_items",
  "photo_count",
  "recent_photo",
  "logo_photo",
  "cover_photo",
  "recent_post",
  "unreplied_reviews",
  "average_rating",
  "new_reviews",
  "verification",
  "place_action_link",
  "attributes",
  "duplicate_listing",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** One Google read: its value, or `ok: false` when it could not be fetched. */
export type Src<T> = { ok: true; value: T } | { ok: false; limited?: string };

export type HealthInput = {
  locationId: string;
  location: Src<GoogleLocation>;
  media: Src<GoogleMediaItem[]>;
  posts: Src<GoogleLocalPost[]>;
  voice: Src<GoogleVoiceOfMerchantState>;
  links: Src<GooglePlaceActionLink[]>;
  attributes: Src<GoogleAttribute[]>;
  /** Top search terms from our stored Performance data, most searched first; empty when none are stored. */
  keywords: string[];
  /** This location as we store it, and the org's other active locations visible to the caller. */
  listing: ListingId;
  others: (ListingId & { id: string })[];
  /** Categories of the top competitors from stored K2 profiles; `rows` is empty when none are stored. */
  competitors: { dataSource: "fixture" | "sandbox" | "live" | null; rows: CompetitorCats[] };
  /** From our synced reviews table. `avgRating` is null when no review has a star rating. */
  reviews: { unreplied: number; waitingToPublish: number; total: number; avgRating: number | null; newInWindow: number };
};

const DAY_MS = 86_400_000;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Whole days between an ISO time and now, or null when unparseable. */
const ageDays = (iso: string | undefined, now: Date) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : (now.getTime() - t) / DAY_MS;
};

/** Links in a description (Help: "No links of any type are allowed"): a scheme, www., or a bare common-TLD domain. */
const LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|info|biz|io|co|us|uk|au|in|ca)\b/i;

const dateOnly = (d: GoogleDate | undefined) =>
  d?.year && d.month && d.day ? Date.UTC(d.year, d.month - 1, d.day) : null;

export function evaluateHealth(input: HealthInput, now: Date): Check[] {
  const id = input.locationId;
  const profile = { label: "Edit profile", href: `/locations/${id}/profile` };
  const photos = { label: "Add photos", href: `/locations/${id}/media` };
  const checks: Check[] = [];
  const add = (
    cid: string,
    title: string,
    importance: Importance,
    status: CheckStatus,
    detail: string,
    fix: Check["fix"],
  ) =>
    checks.push({
      id: cid,
      title,
      importance,
      status,
      detail,
      fix: status === "pass" ? null : fix,
    });
  // A read refused by our per-account Google limit says so (and when to retry), not "could not read".
  const unreadable = (what: string, src: { ok: false; limited?: string }) =>
    src.limited ?? `Could not read ${what} from Google`;

  // Location fields (one Google read feeds checks 1 to 4 and service items).
  const L = (
    cid: string,
    title: string,
    importance: Importance,
    fix: Check["fix"],
    judge: (l: GoogleLocation) => { pass: boolean; detail: string },
  ) => {
    if (!input.location.ok) {
      add(cid, title, importance, "unknown", unreadable("the profile", input.location), fix);
      return;
    }
    const r = judge(input.location.value);
    add(cid, title, importance, r.pass ? "pass" : "fail", r.detail, fix);
  };

  L(
    "description",
    "Business description",
    "necessary",
    { ...profile, label: "Edit description" },
    (l) => {
      const text = l.profile?.description?.trim() ?? "";
      if (!text) return { pass: false, detail: "No description set" };
      const len = [...text].length;
      const max = PROFILE_LIMITS.descriptionMaxChars.limit;
      const problems: string[] = [];
      if (len > max) problems.push(`${len} characters, the limit is ${max}`);
      if (LINK.test(text)) problems.push("contains a link, which Google does not allow");
      return problems.length
        ? { pass: false, detail: `Description ${problems.join("; ")}` }
        : { pass: true, detail: `${plural(len, "character")}, no links` };
    },
  );
  L(
    "description_quality",
    "Description quality",
    "important",
    { ...profile, label: "Edit description" },
    (l) => {
      const text = l.profile?.description?.trim() ?? "";
      if (!text) return { pass: false, detail: "No description to judge" };
      const problems = descriptionProblems(text);
      return problems.length
        ? { pass: false, detail: `Description: ${problems.join("; ")}` }
        : { pass: true, detail: "Long enough, no shouting, no repeated keywords" };
    },
  );
  {
    const fix = { ...profile, label: "Edit description" };
    const title = "Description uses your search keywords";
    if (!input.location.ok) add("description_keywords", title, "nice", "unknown", unreadable("the profile", input.location), fix);
    else if (input.keywords.length === 0)
      add("description_keywords", title, "nice", "unknown", "No search keyword data stored yet (Performance)", fix);
    else {
      const text = input.location.value.profile?.description ?? "";
      const top = input.keywords.slice(0, CFG.keywordTopN);
      const { covered, missing } = keywordsCovered(text, top);
      add(
        "description_keywords",
        title,
        "nice",
        covered.length / top.length >= CFG.minKeywordCoverage ? "pass" : "fail",
        `${covered.length} of your top ${top.length} search terms appear in the description` +
          (missing.length ? `; missing: ${missing.map((k) => `"${k}"`).join(", ")}` : "") +
          `, recommended at least ${Math.round(CFG.minKeywordCoverage * 100)}%`,
        fix,
      );
    }
  }
  L(
    "primary_category",
    "Primary category",
    "necessary",
    { ...profile, label: "Set category" },
    (l) => {
      const c = l.categories?.primaryCategory;
      return c?.name
        ? { pass: true, detail: c.displayName ?? c.name }
        : { pass: false, detail: "No primary category set" };
    },
  );
  L(
    "additional_categories",
    "Additional categories",
    "important",
    { ...profile, label: "Add categories" },
    (l) => {
      const n = l.categories?.additionalCategories?.length ?? 0;
      return n > 0
        ? { pass: true, detail: plural(n, "additional category", "additional categories") }
        : { pass: false, detail: "No additional categories, add at least one" };
    },
  );
  {
    const fix = { ...profile, label: "Review categories" };
    const title = "Categories match your competitors";
    const { dataSource, rows } = input.competitors;
    const primary = input.location.ok ? input.location.value.categories?.primaryCategory : undefined;
    if (!input.location.ok) add("category_fit", title, "important", "unknown", unreadable("the profile", input.location), fix);
    else if (!primary?.name) add("category_fit", title, "important", "unknown", "No primary category set to compare", fix);
    else if (dataSource !== "live" || rows.length < CFG.categoryFitMinCompetitors)
      add(
        "category_fit",
        title,
        "important",
        "unknown",
        dataSource === "live" || dataSource === null
          ? `Not enough competitor data stored yet (${plural(rows.length, "profiled competitor")}, at least ${CFG.categoryFitMinCompetitors} needed; turn on competitor refresh in Rankings)`
          : "Only sample competitor data is stored, so categories were not compared",
        fix,
      );
    else {
      const additional = input.location.value.categories?.additionalCategories ?? [];
      const { using, total } = shareUsing(ownCategoryKeys(primary), rows);
      const missing = missingCompetitorCategories({ primary, additional }, rows, CFG.categoryMissingMinShare);
      const problems: string[] = [];
      if (using / total < CFG.categoryPrimaryMinShare)
        problems.push(`your primary category is used by ${using} of ${total} top competitors, recommended at least ${Math.round(CFG.categoryPrimaryMinShare * 100)}%`);
      if (missing.length)
        problems.push(
          `missing ${missing.slice(0, 3).map((m) => `"${m.name}" (${m.competitors} of ${m.total})`).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}`,
        );
      add(
        "category_fit",
        title,
        "important",
        problems.length ? "fail" : "pass",
        problems.length ? `Compared with ${total} top competitors: ${problems.join("; ")}` : `Primary category used by ${using} of ${total} top competitors; no popular category missing`,
        fix,
      );
    }
  }
  // Proto3 JSON omits zero values (`{hours: 10}`, midnight as `{}`), so only the periods are read.
  L("regular_hours", "Opening hours", "necessary", { ...profile, label: "Set hours" }, (l) => {
    const n = l.regularHours?.periods?.length ?? 0;
    return n > 0
      ? { pass: true, detail: plural(n, "opening period") }
      : { pass: false, detail: "No regular opening hours set" };
  });
  L(
    "special_hours",
    "Special hours for upcoming dates",
    "nice",
    { ...profile, label: "Add special hours" },
    (l) => {
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const n = (l.specialHours?.specialHourPeriods ?? []).filter((p) => {
        const d = dateOnly(p.startDate);
        return d !== null && d >= today;
      }).length;
      return n > 0
        ? { pass: true, detail: plural(n, "upcoming special-hours date") }
        : { pass: false, detail: "No special hours set for upcoming dates (holidays, events)" };
    },
  );
  L("phone", "Phone number", "necessary", { ...profile, label: "Add phone" }, (l) =>
    l.phoneNumbers?.primaryPhone?.trim()
      ? { pass: true, detail: "Primary phone set" }
      : { pass: false, detail: "No primary phone number" },
  );
  L("website", "Website", "necessary", { ...profile, label: "Add website" }, (l) =>
    l.websiteUri?.trim()
      ? { pass: true, detail: l.websiteUri }
      : { pass: false, detail: "No website set" },
  );
  L(
    "website_utm",
    "Website link has UTM tracking",
    "nice",
    { ...profile, label: "Edit website link" },
    (l) => {
      if (!l.websiteUri?.trim()) return { pass: false, detail: "No website to track" };
      let utm = false;
      try {
        utm = [...new URL(l.websiteUri).searchParams.keys()].some((k) => k.startsWith("utm_"));
      } catch {
        /* unparseable: treated as no UTM */
      }
      return utm
        ? { pass: true, detail: "Website link carries utm_ parameters" }
        : {
            pass: false,
            detail:
              "Website link has no utm_ parameters, so Google traffic is not separable in analytics",
          };
    },
  );
  L("service_items", "Services listed", "nice", { ...profile, label: "Add services" }, (l) => {
    const n = l.serviceItems?.length ?? 0;
    return n > 0
      ? { pass: true, detail: plural(n, "service") }
      : { pass: false, detail: "No services listed" };
  });

  // Photos (one Google read feeds four checks).
  const M = (
    cid: string,
    title: string,
    importance: Importance,
    judge: (items: GoogleMediaItem[]) => { pass: boolean; detail: string },
  ) => {
    if (!input.media.ok) {
      add(cid, title, importance, "unknown", unreadable("photos", input.media), photos);
      return;
    }
    const r = judge(input.media.value.filter((m) => !m.mediaFormat || m.mediaFormat === "PHOTO"));
    add(cid, title, importance, r.pass ? "pass" : "fail", r.detail, photos);
  };
  M("photo_count", "Enough photos", "important", (items) => ({
    pass: items.length >= CFG.minPhotos,
    detail: `${plural(items.length, "photo")}, recommended at least ${CFG.minPhotos}`,
  }));
  M("recent_photo", "A recent photo", "important", (items) => {
    // The profile photo reports the epoch as createTime (see the mock), which is simply "old" here.
    const ages = items
      .map((m) => ageDays(m.createTime, now))
      .filter((a): a is number => a !== null);
    const newest = ages.length ? Math.min(...ages) : null;
    const pass = newest !== null && newest <= CFG.recentPhotoDays;
    return {
      pass,
      detail:
        newest === null
          ? `No photos, recommended one in the last ${CFG.recentPhotoDays} days`
          : `Newest photo is ${plural(Math.floor(newest), "day")} old, recommended within ${CFG.recentPhotoDays} days`,
    };
  });
  const hasCategory = (items: GoogleMediaItem[], c: string) =>
    items.some((m) => m.locationAssociation?.category === c);
  M("logo_photo", "Logo (profile photo)", "important", (items) => ({
    pass: hasCategory(items, "PROFILE"),
    detail: hasCategory(items, "PROFILE") ? "Logo set" : "No logo (profile photo) set",
  }));
  M("cover_photo", "Cover photo", "important", (items) => ({
    pass: hasCategory(items, "COVER"),
    detail: hasCategory(items, "COVER") ? "Cover photo set" : "No cover photo set",
  }));

  // Posts: the newest published post on the first page.
  {
    const fix = { label: "Write a post", href: "/posts?view=compose" };
    if (!input.posts.ok) {
      add("recent_post", "A recent Google post", "important", "unknown", unreadable("posts", input.posts), fix);
    } else {
      const ages = input.posts.value
        .filter((p) => !p.state || p.state === "LIVE")
        .map((p) => ageDays(p.createTime, now))
        .filter((a): a is number => a !== null);
      const newest = ages.length ? Math.min(...ages) : null;
      add(
        "recent_post",
        "A recent Google post",
        "important",
        newest !== null && newest <= CFG.recentPostDays ? "pass" : "fail",
        newest === null
          ? `No published posts, recommended one in the last ${CFG.recentPostDays} days`
          : `Last post ${plural(Math.floor(newest), "day")} ago, recommended within ${CFG.recentPostDays} days`,
        fix,
      );
    }
  }

  // Reviews, from our synced table.
  {
    const r = input.reviews;
    const win = CFG.reviewWindowDays;
    add(
      "unreplied_reviews",
      "No unreplied reviews",
      "necessary",
      r.unreplied === 0 ? "pass" : "fail",
      (r.unreplied === 0
        ? r.waitingToPublish > 0
          ? "No recent review needs a reply"
          : "Every recent review has a reply"
        : `${plural(r.unreplied, "review")} in the last ${win} days that need a reply`) +
        (r.waitingToPublish > 0 ? `; ${plural(r.waitingToPublish, "approved reply", "approved replies")} waiting to publish` : ""),
      { label: "Reply to reviews", href: `/reviews?replied=no&loc=${id}` },
    );
    const avg = r.avgRating;
    add(
      "average_rating",
      "Average rating",
      "important",
      avg === null ? "unknown" : avg >= CFG.minAverageRating ? "pass" : "fail",
      avg !== null
        ? `${avg.toFixed(1)} stars over ${plural(r.total, "review")}, recommended at least ${CFG.minAverageRating.toFixed(1)}`
        : "No rated reviews synced yet",
      { label: "Open reviews", href: `/reviews?loc=${id}` },
    );
    add(
      "new_reviews",
      "A new review recently",
      "nice",
      r.newInWindow > 0 ? "pass" : "fail",
      `${plural(r.newInWindow, "new review")} in the last ${win} days`,
      null,
    );
  }

  // Google-only reads.
  if (!input.voice.ok) {
    add(
      "verification",
      "Verified, in good standing",
      "necessary",
      "unknown",
      unreadable("verification", input.voice),
      profile,
    );
  } else {
    const s = describeVoiceOfMerchant(input.voice.value);
    add(
      "verification",
      "Verified, in good standing",
      "necessary",
      s.hasVoiceOfMerchant ? "pass" : "fail",
      s.hasVoiceOfMerchant
        ? "Google reports good standing"
        : `Not in good standing: Google asks for ${s.standing}`,
      { label: "See verification", href: `/locations/${id}/profile` },
    );
  }
  if (!input.links.ok) {
    add(
      "place_action_link",
      "Booking or ordering link",
      "nice",
      "unknown",
      unreadable("place action links", input.links),
      profile,
    );
  } else {
    const n = input.links.value.length;
    add(
      "place_action_link",
      "Booking or ordering link",
      "nice",
      n > 0 ? "pass" : "fail",
      n > 0 ? plural(n, "link") : "No booking or ordering link",
      { label: "Add a link", href: `/locations/${id}/profile` },
    );
  }
  if (!input.attributes.ok) {
    add("attributes", "Attributes set", "nice", "unknown", unreadable("attributes", input.attributes), profile);
  } else {
    const n = input.attributes.value.length;
    add(
      "attributes",
      "Attributes set",
      "nice",
      n > 0 ? "pass" : "fail",
      n > 0 ? plural(n, "attribute") : "No attributes set (parking, payments, accessibility ...)",
      { ...profile, label: "Set attributes" },
    );
  }
  {
    const dups = input.others.filter((o) => looksDuplicate(input.listing, o));
    add(
      "duplicate_listing",
      "No possible duplicate listing",
      "important",
      dups.length === 0 ? "pass" : "fail",
      dups.length === 0
        ? "No other location of yours has a near-identical name with the same address or phone"
        : `Looks like ${dups.slice(0, 3).map((d) => `"${d.name}"`).join(", ")}${dups.length > 3 ? ` and ${dups.length - 3} more` : ""}: similar name with the same address or phone`,
      dups[0] ? { label: "Compare listings", href: `/locations/${dups[0].id}/profile` } : null,
    );
  }
  return checks;
}

/** Unknown and skipped checks are left out of the total: a read that failed neither helps nor hurts the score. */
export function scoreOf(checks: Check[]) {
  const passed = checks.filter((c) => c.status === "pass").length;
  const total = checks.filter((c) => c.status === "pass" || c.status === "fail").length;
  return { passed, total, percent: total === 0 ? 0 : Math.round((passed / total) * 100) };
}
