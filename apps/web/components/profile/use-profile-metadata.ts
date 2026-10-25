"use client";
import { useEffect, useState } from "react";
import { profile_attributes_metadata, profile_categories_get } from "../../app/_generated/actions";
import type { AttributeMeta, CategoryMeta } from "../../lib/profile-pickers";
import { runCall } from "../post-card";

export type Metadata = {
  categories: CategoryMeta[];
  attributes: AttributeMeta[];
  source: "google" | "sample" | null;
  error: string | null;
  loading: boolean;
};
/** The last answer and the request it answered; loading is whatever has not been answered yet. */
type Result = Omit<Metadata, "loading"> & { key: string | null };

/** Google's details for the edited categories and the primary category's attributes; refetched when they change. */
export function useProfileMetadata(p: {
  locationId: string;
  regionCode: string;
  languageCode: string;
  primary: string;
  additional: string[];
}): Metadata {
  const [m, setM] = useState<Result>({
    key: null,
    categories: [],
    attributes: [],
    source: null,
    error: null,
  });
  const names = [p.primary, ...p.additional].filter(Boolean).slice(0, 10);
  const key = names.join(",");
  useEffect(() => {
    if (!p.primary) return;
    let stop = false;
    const locale = {
      locationId: p.locationId,
      regionCode: p.regionCode,
      languageCode: p.languageCode,
    };
    void Promise.all([
      runCall<{ categories: CategoryMeta[]; source: "google" | "sample" }>(() =>
        profile_categories_get({ ...locale, names: key.split(",") }),
      ),
      runCall<{ attributes: AttributeMeta[]; source: "google" | "sample" }>(() =>
        profile_attributes_metadata({ ...locale, categoryName: p.primary }),
      ),
    ]).then(([c, a]) => {
      if (stop) return;
      setM({
        key: `${p.locationId}|${p.regionCode}|${p.languageCode}|${key}`,
        categories: "data" in c ? c.data.categories : [],
        attributes: "data" in a ? a.data.attributes : [],
        source: "data" in c ? c.data.source : "data" in a ? a.data.source : null,
        error: "error" in c ? c.error : "error" in a ? a.error : null,
      });
    });
    return () => {
      stop = true;
    };
  }, [p.locationId, p.regionCode, p.languageCode, p.primary, key]);
  const { key: answered, ...rest } = m;
  const asked = `${p.locationId}|${p.regionCode}|${p.languageCode}|${key}`;
  return { ...rest, loading: Boolean(p.primary) && answered !== asked };
}
