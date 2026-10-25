import { describe, expect, it } from "vitest";
import { makeTimeFormat } from "./time-format";
import { workspaceRows } from "./workspaces-table";

const utc = makeTimeFormat({ zones: [{ id: "a", timeZone: "UTC", dateFormat: "YYYY-MM-DD" }, { id: "b", timeZone: "UTC", dateFormat: "YYYY-MM-DD" }], workspaceId: null });

const ws = (id: string, name: string, createdAt = "2026-10-12T08:00:00.000Z") => ({ id, name, createdAt });

describe("workspaceRows", () => {
  const workspaces = [ws("a", "Rivermoor Pain Clinic"), ws("b", "Gulf Law Group", "2026-10-01T23:59:00.000Z")];
  const locations = [{ workspaceId: "a" }, { workspaceId: "a" }, { workspaceId: "b" }, { workspaceId: "zzz" }];
  const members = [
    { workspaceId: null },
    { workspaceId: "a" },
    { workspaceId: "a" },
    { workspaceId: "b" },
  ];

  it("counts locations and workspace members, labels the profile, dates in UTC", () => {
    expect(workspaceRows({ workspaces, locations, members, profiles: { a: "healthcare", b: "legal" }, tf: utc })).toEqual([
      { id: "a", name: "Rivermoor Pain Clinic", locations: 2, profile: "Healthcare", people: 2, created: "2026-10-12" },
      { id: "b", name: "Gulf Law Group", locations: 1, profile: "Legal", people: 1, created: "2026-10-01" },
    ]);
  });

  it("leaves people null when the caller may not list members, and says when a profile is unknown", () => {
    const rows = workspaceRows({ workspaces, locations: [], members: null, profiles: { a: "general" }, tf: utc });
    expect(rows.map((r) => [r.people, r.profile, r.locations])).toEqual([
      [null, "General", 0],
      [null, "Not available", 0],
    ]);
  });

  it("canary: an organization-wide member is never counted against a workspace", () => {
    const rows = workspaceRows({ workspaces, locations: [], members: [{ workspaceId: null }], profiles: {}, tf: utc });
    expect(rows.every((r) => r.people === 0)).toBe(true);
  });
});
