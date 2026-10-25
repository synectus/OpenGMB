import { beforeEach, describe, expect, it } from "vitest";
import { resetMetadataCacheForTests, searchCategories } from "./metadata";

const locale = { regionCode: "US", languageCode: "en" };

function fakeReader() {
  const filters: (string | undefined)[] = [];
  const reader = {
    listCategories: async (opts: { filter?: string }) => {
      filters.push(opts.filter);
      return { categories: [] };
    },
    batchGetCategories: async () => ({ categories: [] }),
    listAttributeMetadata: async () => ({ attributeMetadata: [] }),
  };
  return { reader, filters };
}

describe("searchCategories filter", () => {
  beforeEach(() => resetMetadataCacheForTests());

  it("quotes a multi-word query (Google 400s on an unquoted one)", async () => {
    const { reader, filters } = fakeReader();
    await searchCategories(reader, { ...locale, query: "internet marketing" });
    expect(filters).toEqual(['displayName="internet marketing"']);
  });

  it("quotes a one-word query too", async () => {
    const { reader, filters } = fakeReader();
    await searchCategories(reader, { ...locale, query: "dentist" });
    expect(filters).toEqual(['displayName="dentist"']);
  });

  it("strips double quotes and backslashes before quoting", async () => {
    const { reader, filters } = fakeReader();
    await searchCategories(reader, { ...locale, query: 'a"b\\c d' });
    expect(filters).toEqual(['displayName="abc d"']);
  });

  it("makes no call when stripping leaves fewer than the minimum characters", async () => {
    const { reader, filters } = fakeReader();
    expect(await searchCategories(reader, { ...locale, query: 'a"\\' })).toEqual([]);
    expect(filters).toEqual([]);
  });
});
