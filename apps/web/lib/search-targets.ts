// U6 (⌘K search): the parts of the search that are not data. Client-safe.
import { sectionId } from "./section-id";

/**
 * Every editor section on a location's Profile page (the EditorSection labels), with extra words people
 * type for it. profile-editor.tsx, profile/attributes-section.tsx and profile/section.tsx own the labels; search-targets.test.ts
 * fails when one is added or renamed there and not here.
 */
export const PROFILE_SECTIONS: { label: string; words: string }[] = [
  { label: "Name", words: "business name title" },
  { label: "Description", words: "about summary" },
  { label: "Categories", words: "category primary additional" },
  { label: "Regular hours", words: "opening hours open close" },
  { label: "Special hours", words: "holiday closed exception" },
  { label: "Services", words: "service prices menu" },
  { label: "Attributes", words: "amenities features" },
  { label: "Social profiles", words: "facebook instagram links" },
  { label: "Service area", words: "area serve places" },
  { label: "Website, phone and opening date", words: "contact website phone url opened" },
  { label: "Address and store code", words: "address location store code" },
];

export const profileSectionHref = (locationId: string, label: string) =>
  `/locations/${locationId}/profile#${sectionId(label)}`;

/** The review opens in the Reviews inbox with the review selected. */
export const reviewHref = (id: string) => `/reviews?review=${id}`;
export const postHref = (id: string) => `/posts?post=${id}`;
export const locationHref = (id: string) => `/locations/${id}`;

/** Searches shorter than this are not sent (one character matches almost every location). */
export const SEARCH_MIN_CHARS = 2;
