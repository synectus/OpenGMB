import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sectionId } from "../components/profile/section";
import { PROFILE_SECTIONS, postHref, profileSectionHref, reviewHref } from "./search-targets";

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

describe("search targets", () => {
  it("lists every EditorSection label of the Profile page", () => {
    const files = ["components/profile-editor.tsx", "components/profile/attributes-section.tsx", "components/profile/address-section.tsx"];
    const labels = files.flatMap((f) => [...read(f).matchAll(/<EditorSection\s+label="([^"]+)"/g)].map((m) => m[1]!));
    // Canary: the extractor must find the sections it is checking against.
    expect(labels).toContain("Categories");
    console.log(`[search-targets] ${labels.length} EditorSection labels in ${files.length} files, ${PROFILE_SECTIONS.length} listed`);
    expect(PROFILE_SECTIONS.map((s) => s.label).sort()).toEqual([...labels].sort());
  });

  it("links to the section anchor the editor renders", () => {
    expect(profileSectionHref("abc", "Categories")).toBe(`/locations/abc/profile#${sectionId("Categories")}`);
    expect(profileSectionHref("abc", "Categories")).toContain("#section-categories");
  });

  it("opens a review and a post by id", () => {
    expect(reviewHref("r1")).toBe("/reviews?review=r1");
    expect(postHref("p1")).toBe("/posts?post=p1");
  });
});
