// apps/web/lib/scope.test.ts
import { describe, expect, it } from "vitest";
import {
  afterScopeChangeHref,
  autoApproveIds,
  displayedScope,
  formatScope,
  narrowNote,
  parseScope,
  resolveScope,
  scopeFilter,
  SCOPE_EMBED_MAX,
  SCOPE_PAGE_SIZE,
  scopeOptionFor,
  scopeOptions,
  searchScopeOptions,
  shellScopeOptions,
  urlScopeValue,
  type ScopeData,
} from "./scope";

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const W9 = "99999999-9999-4999-8999-999999999999"; // not visible to the user
const G1 = "33333333-3333-4333-8333-333333333333";
const GX = "44444444-4444-4444-8444-444444444444";
const L1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const L2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const L3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const L4 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";

const data: ScopeData = {
  workspaces: [
    { id: W1, name: "Rivermoor Pain Clinic" },
    { id: W2, name: "Northside Chiro" },
  ],
  groups: [
    { id: G1, workspaceId: W1, name: "South Rivermoor", locationIds: [L1, L3] },
    { id: GX, workspaceId: W9, name: "Hidden", locationIds: [L4] },
  ],
  locations: [
    { id: L1, workspaceId: W1, name: "rivermoor-main", title: "Rivermoor Main St", status: "active" },
    { id: L2, workspaceId: W1, name: "rivermoor-north", title: null, status: "active" },
    { id: L3, workspaceId: W1, name: "rivermoor-old", title: "Rivermoor Old", status: "inactive" },
    { id: L4, workspaceId: W2, name: "katy", title: "Northside Katy", status: "active" },
  ],
};

describe("parseScope / formatScope", () => {
  it("accepts all, w:, g:, l: with a uuid, lower-cased", () => {
    expect(parseScope("all")).toEqual({ kind: "all" });
    expect(parseScope(`w:${W1}`)).toEqual({ kind: "w", id: W1 });
    expect(parseScope(`g:${G1.toUpperCase()}`)).toEqual({ kind: "g", id: G1 });
    expect(parseScope(`l:${L1}`)).toEqual({ kind: "l", id: L1 });
    expect(formatScope({ kind: "l", id: L1 })).toBe(`l:${L1}`);
    expect(formatScope({ kind: "all" })).toBe("all");
  });
  it("canary: rejects anything else", () => {
    for (const v of [undefined, null, "", "x:1", `w:${W1};drop`, "w:not-a-uuid", "All"]) {
      expect(parseScope(v), String(v)).toBeNull();
    }
  });
});

describe("resolveScope", () => {
  it("defaults to All clients with active counts", () => {
    const s = resolveScope(data, {});
    expect(s).toMatchObject({
      value: "all",
      kind: "all",
      label: "All clients",
      meta: "2 clients · 3 locations",
      workspaceId: null,
      onlyWorkspaceId: null,
      activeLocations: 3,
      source: "default",
      urlWs: undefined,
    });
    expect(s.locationIds).toEqual([L1, L2, L4]);
  });

  it("a cookie workspace is used when visible", () => {
    expect(resolveScope(data, { cookie: `w:${W1}` })).toMatchObject({
      value: `w:${W1}`,
      kind: "workspace",
      label: "Rivermoor Pain Clinic",
      meta: "2 locations",
      workspaceId: W1,
      workspaceName: "Rivermoor Pain Clinic",
      onlyWorkspaceId: W1,
      locationIds: [L1, L2],
      activeLocations: 2,
      source: "cookie",
    });
  });

  it("the URL ws wins over the cookie and is carried in links", () => {
    expect(resolveScope(data, { url: W2, cookie: `w:${W1}` })).toMatchObject({
      workspaceId: W2,
      source: "url",
      urlWs: W2,
    });
    expect(resolveScope(data, { url: `l:${L4}`, cookie: `w:${W1}` })).toMatchObject({
      kind: "location",
      locationId: L4,
      source: "url",
      urlWs: `l:${L4}`,
    });
    expect(resolveScope(data, { url: "all", cookie: `w:${W1}` })).toMatchObject({
      kind: "all",
      source: "url",
      urlWs: "all",
    });
  });

  it("an unusable URL falls back to the cookie, an unusable cookie to the default", () => {
    expect(resolveScope(data, { url: "nope", cookie: `w:${W1}` }).source).toBe("cookie");
    expect(resolveScope(data, { url: W9, cookie: `w:${W1}` }).workspaceId).toBe(W1);
    expect(resolveScope(data, { cookie: `w:${W9}` })).toMatchObject({ kind: "all", source: "default" });
    expect(resolveScope(data, { cookie: "garbage" }).source).toBe("default");
  });

  it("a group counts its active members and belongs to its workspace", () => {
    expect(resolveScope(data, { cookie: `g:${G1}` })).toMatchObject({
      kind: "group",
      label: "Group: South Rivermoor",
      meta: "1 location",
      workspaceId: W1,
      groupId: G1,
      onlyWorkspaceId: W1,
      locationIds: [L1],
      activeLocations: 1,
    });
  });

  it("canary: a group in a workspace the user cannot see falls back", () => {
    expect(resolveScope(data, { cookie: `g:${GX}` }).kind).toBe("all");
  });

  it("a location is labelled by title (or name) with its workspace as meta; inactive ones fall back", () => {
    expect(resolveScope(data, { cookie: `l:${L4}` })).toMatchObject({
      kind: "location",
      label: "Northside Katy",
      meta: "Northside Chiro",
      workspaceId: W2,
      locationId: L4,
      locationIds: [L4],
      activeLocations: 1,
    });
    expect(resolveScope(data, { cookie: `l:${L2}` }).label).toBe("rivermoor-north");
    expect(resolveScope(data, { cookie: `l:${L3}` }).kind).toBe("all");
  });

  it("with one workspace, All clients still knows the workspace to work in", () => {
    const one: ScopeData = { workspaces: [data.workspaces[0]!], groups: [], locations: [data.locations[0]!] };
    expect(resolveScope(one, {})).toMatchObject({
      meta: "1 client · 1 location",
      workspaceId: null,
      onlyWorkspaceId: W1,
    });
  });

  it("no data at all is All clients with zero locations", () => {
    expect(resolveScope({ workspaces: [], groups: [], locations: [] }, { cookie: `w:${W1}` })).toMatchObject({
      kind: "all",
      meta: "0 clients · 0 locations",
      activeLocations: 0,
    });
  });
});

describe("scopeOptions", () => {
  it("All first, then each client with its groups and active locations, in list order", () => {
    const o = scopeOptions(data);
    expect(o.map((x) => [x.value, x.label, x.meta, x.depth])).toEqual([
      ["all", "All clients", "3 locations", 0],
      [`w:${W1}`, "Rivermoor Pain Clinic", "2 locations", 1],
      [`g:${G1}`, "Group: South Rivermoor", "1 location", 2],
      [`l:${L1}`, "Rivermoor Main St", "location", 2],
      [`l:${L2}`, "rivermoor-north", "location", 2],
      [`w:${W2}`, "Northside Chiro", "1 location", 1],
      [`l:${L4}`, "Northside Katy", "location", 2],
    ]);
    expect(o[0]!.trigger).toBe("2 clients · 3 locations");
    expect(o.find((x) => x.value === `l:${L4}`)!.trigger).toBe("Northside Chiro");
    expect(new Set(o.map((x) => x.search)).size).toBe(o.length); // cmdk values must be unique
  });
});

describe("displayedScope", () => {
  const o = scopeOptions(data);
  it("shows a known ws from the URL, else the server's value", () => {
    expect(displayedScope(o, W2, `w:${W1}`)).toBe(`w:${W2}`);
    expect(displayedScope(o, W2.toUpperCase(), "all")).toBe(`w:${W2}`);
    expect(displayedScope(o, "all", `w:${W1}`)).toBe("all");
    expect(displayedScope(o, W9, `w:${W1}`)).toBe(`w:${W1}`);
    expect(displayedScope(o, null, `g:${G1}`)).toBe(`g:${G1}`);
    expect(displayedScope(o, `g:${G1}`, "all")).toBe(`g:${G1}`);
  });
});

describe("afterScopeChangeHref", () => {
  it("keeps view-type params and drops the ones that name things", () => {
    expect(afterScopeChangeHref("/reviews", `ws=${W1}&review=${L1}&replied=no&rating=1&rating=2&cursor=x`)).toBe(
      "/reviews?replied=no&rating=1&rating=2",
    );
    expect(afterScopeChangeHref("/posts", "view=calendar&month=2026-10&edit=abc")).toBe(
      "/posts?view=calendar&month=2026-10",
    );
    expect(afterScopeChangeHref("/approvals", `tab=reply&item=reply:${L1}`)).toBe("/approvals?tab=reply");
    expect(afterScopeChangeHref("/locations", `ws=${W1}`)).toBe("/locations");
  });
});

describe("adapters", () => {
  it("scopeFilter gives the narrowest list filter per kind", () => {
    expect(scopeFilter(resolveScope(data, {}))).toEqual({});
    expect(scopeFilter(resolveScope(data, { cookie: `w:${W1}` }))).toEqual({ workspaceId: W1 });
    expect(scopeFilter(resolveScope(data, { cookie: `g:${G1}` }))).toEqual({ groupId: G1 });
    expect(scopeFilter(resolveScope(data, { cookie: `l:${L1}` }))).toEqual({ locationIds: [L1] });
  });
  it("autoApproveIds: the scope's workspace, else every workspace", () => {
    expect(autoApproveIds(resolveScope(data, { cookie: `g:${G1}` }), data.workspaces)).toEqual([W1]);
    expect(autoApproveIds(resolveScope(data, {}), data.workspaces)).toEqual([W1, W2]);
  });
  it("narrowNote only for group and location scopes", () => {
    expect(narrowNote(resolveScope(data, { cookie: `w:${W1}` }), "Approvals")).toBeNull();
    expect(narrowNote(resolveScope(data, { cookie: `l:${L1}` }), "Approvals")).toBe(
      "Showing all of Rivermoor Pain Clinic. Approvals cannot be narrowed to a group or location yet.",
    );
  });
});

describe("the scope switcher on a long account (H4)", () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const big: ScopeData = {
    workspaces: Array.from({ length: 40 }, (_, i) => ({ id: uuid(i + 1), name: `Client ${String(i + 1).padStart(2, "0")}` })),
    groups: [{ id: uuid(900), workspaceId: uuid(1), name: "East side", locationIds: [uuid(1001)] }],
    locations: Array.from({ length: 1000 }, (_, i) => ({
      id: uuid(1001 + i), workspaceId: uuid((i % 40) + 1), name: `Clinic ${String(i + 1).padStart(4, "0")}`, title: null, status: "active",
    })),
  };

  it("a short account still sends the whole list", () => {
    const s = shellScopeOptions(data, `w:${W1}`);
    expect(s.complete).toBe(true);
    expect(s.options).toEqual(scopeOptions(data));
    expect(s.current.value).toBe(`w:${W1}`);
  });

  it("a long account sends All clients and the clients, never a location, and a payload that does not grow with locations", () => {
    const s = shellScopeOptions(big, "all");
    expect(s.complete).toBe(false);
    expect(s.options.length).toBeLessThanOrEqual(SCOPE_EMBED_MAX + 1);
    expect(s.options.every((o) => o.depth < 2)).toBe(true);
    const bytes = JSON.stringify(s).length;
    const bigger = { ...big, locations: [...big.locations, ...big.locations.map((l, i) => ({ ...l, id: uuid(5000 + i), name: `More ${i}` }))] };
    expect(JSON.stringify(shellScopeOptions(bigger, "all")).length).toBe(bytes);
    expect(bytes).toBeLessThan(10_000);
  });

  it("the trigger option for a cookie scope that is a location is sent even though the list is not", () => {
    const s = shellScopeOptions(big, `l:${uuid(1005)}`);
    expect(s.current).toMatchObject({ value: `l:${uuid(1005)}`, label: "Clinic 0005", depth: 2 });
    expect(s.options.some((o) => o.value === s.current.value)).toBe(false);
  });

  it("search matches every word, pages by SCOPE_PAGE_SIZE and says when more follows", () => {
    const first = searchScopeOptions(big, "", 0);
    expect(first.options).toHaveLength(SCOPE_PAGE_SIZE);
    expect(first.more).toBe(true);
    const second = searchScopeOptions(big, "", SCOPE_PAGE_SIZE);
    expect(second.options[0]!.value).not.toBe(first.options[0]!.value);
    const one = searchScopeOptions(big, "clinic 0042", 0);
    expect(one.options.map((o) => o.value)).toEqual([`l:${uuid(1042)}`]);
    expect(one.more).toBe(false);
    expect(searchScopeOptions(big, "east side", 0).options.map((o) => o.value)).toEqual([`g:${uuid(900)}`]);
    expect(searchScopeOptions(big, "no such place", 0)).toEqual({ options: [], more: false });
  });

  it("scopeOptionFor and urlScopeValue name a ?ws= value; unknown or hidden values are null", () => {
    expect(scopeOptionFor(big, `w:${uuid(3)}`)).toMatchObject({ label: "Client 03", depth: 1 });
    expect(scopeOptionFor(big, `w:${uuid(77)}`)).toBeNull();
    expect(scopeOptionFor(big, "nonsense")).toBeNull();
    expect(urlScopeValue(uuid(3).toUpperCase())).toBe(`w:${uuid(3)}`);
    expect(urlScopeValue(`g:${uuid(900)}`)).toBe(`g:${uuid(900)}`);
    expect(urlScopeValue("x")).toBeNull();
    expect(urlScopeValue(null)).toBeNull();
  });
});
