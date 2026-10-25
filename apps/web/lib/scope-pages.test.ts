import { describe, expect, it } from "vitest";
import { resolveScope, type ScopeData } from "./scope";
import {
  PERFORMANCE_MAX_LOCATIONS,
  narrowArgs,
  narrowLocationIds,
  performanceTarget,
  refreshLocationId,
  reportStart,
  showGroupFacet,
} from "./scope-pages";

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const G1 = "33333333-3333-4333-8333-333333333333";
const loc = (n: number, workspaceId: string) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  workspaceId,
  name: `L${n}`,
  title: `Location ${n}`,
  status: "active",
});
const make = (locations: ScopeData["locations"], groups: ScopeData["groups"] = []): ScopeData => ({
  workspaces: [{ id: W1, name: "One" }, { id: W2, name: "Two" }],
  groups,
  locations,
});
const small = make([loc(1, W1), loc(2, W2)], [{ id: G1, workspaceId: W1, name: "Downtown", locationIds: [loc(1, W1).id] }]);
const at = (data: ScopeData, cookie: string) => resolveScope(data, { cookie });

describe("narrowLocationIds", () => {
  it("is set for a group or location scope only", () => {
    expect(narrowLocationIds(at(small, "all"))).toBeUndefined();
    expect(narrowLocationIds(at(small, `w:${W1}`))).toBeUndefined();
    expect(narrowLocationIds(at(small, `g:${G1}`))).toEqual([loc(1, W1).id]);
    expect(narrowLocationIds(at(small, `l:${loc(2, W2).id}`))).toEqual([loc(2, W2).id]);
  });
});

describe("narrowArgs", () => {
  it("a group goes by its id (the server resolves it, whatever its size), a location by its one id, anything wider by nothing", () => {
    expect(narrowArgs(at(small, "all"))).toEqual({});
    expect(narrowArgs(at(small, `w:${W1}`))).toEqual({});
    expect(narrowArgs(at(small, `g:${G1}`))).toEqual({ groupId: G1 });
    expect(narrowArgs(at(small, `l:${loc(2, W2).id}`))).toEqual({ locationIds: [loc(2, W2).id] });
    const members = Array.from({ length: 1000 }, (_, i) => loc(i + 1, W1));
    const big = make(members, [{ id: G1, workspaceId: W1, name: "All of them", locationIds: members.map((m) => m.id) }]);
    expect(narrowArgs(at(big, `g:${G1}`))).toEqual({ groupId: G1 });
  });
});

describe("performanceTarget", () => {
  it("All clients with several clients reads across them instead of asking", () => {
    expect(performanceTarget(at(small, "all"))).toEqual({ kind: "locations", locationIds: [loc(1, W1).id, loc(2, W2).id] });
  });
  it("a client reads by workspace; a group or location by its locations", () => {
    expect(performanceTarget(at(small, `w:${W1}`))).toEqual({ kind: "workspace", workspaceId: W1 });
    expect(performanceTarget(at(small, `g:${G1}`))).toEqual({ kind: "locations", locationIds: [loc(1, W1).id] });
    expect(performanceTarget(at(small, `l:${loc(2, W2).id}`))).toEqual({ kind: "locations", locationIds: [loc(2, W2).id] });
  });
  it("asks for a client only when All clients holds more locations than one call takes", () => {
    const many = make(Array.from({ length: PERFORMANCE_MAX_LOCATIONS + 1 }, (_, i) => loc(i + 1, i % 2 ? W1 : W2)));
    expect(performanceTarget(at(many, "all"))).toEqual({ kind: "pick" });
    expect(performanceTarget(at(make([]), "all"))).toEqual({ kind: "empty" });
  });
  it("the only client is read by workspace under All clients", () => {
    const one: ScopeData = { workspaces: [{ id: W1, name: "One" }], groups: [], locations: [loc(1, W1)] };
    expect(performanceTarget(at(one, "all"))).toEqual({ kind: "workspace", workspaceId: W1 });
  });
});

describe("refreshLocationId", () => {
  it("is the one location when the scope holds exactly one, even for a whole client", () => {
    const one: ScopeData = { workspaces: [{ id: W1, name: "One" }], groups: [], locations: [loc(1, W1)] };
    expect(refreshLocationId(at(one, `w:${W1}`))).toBe(loc(1, W1).id);
    expect(refreshLocationId(at(one, "all"))).toBe(loc(1, W1).id);
    expect(refreshLocationId(at(small, `l:${loc(2, W2).id}`))).toBe(loc(2, W2).id);
  });
  it("is null with several locations", () => {
    expect(refreshLocationId(at(small, "all"))).toBeNull();
  });
});

describe("showGroupFacet", () => {
  it("hides under a group scope only", () => {
    expect(showGroupFacet(at(small, `g:${G1}`))).toBe(false);
    expect(showGroupFacet(at(small, "all"))).toBe(true);
    expect(showGroupFacet(at(small, `w:${W1}`))).toBe(true);
  });
});

describe("reportStart", () => {
  const ids = [W1, W2];
  it("follows the scope's client", () => {
    expect(reportStart(at(small, `w:${W2}`), ids).workspaceId).toBe(W2);
    expect(reportStart(at(small, `l:${loc(2, W2).id}`), ids)).toMatchObject({ workspaceId: W2, scope: "locations", locationIds: [loc(2, W2).id] });
    expect(reportStart(at(small, `g:${G1}`), ids)).toMatchObject({ workspaceId: W1, scope: "group", groupId: G1 });
  });
  it("starts at the first client under All clients with several, and with none when there are none", () => {
    expect(reportStart(at(small, "all"), ids)).toMatchObject({ workspaceId: W1, scope: "workspace" });
    expect(reportStart(at(small, "all"), []).workspaceId).toBe("");
  });
});
