import type { TimeFormat } from "./time-format";
export type Profile = "general" | "healthcare" | "legal";

export const PROFILE_LABEL: Record<Profile, string> = {
  general: "General",
  healthcare: "Healthcare",
  legal: "Legal",
};

export type WorkspaceRow = {
  id: string;
  name: string;
  locations: number;
  profile: string;
  /** Members whose membership belongs to this workspace (client roles); null when the caller cannot list members. */
  people: number | null;
  /** The workspace's own date format and zone. */
  created: string;
};

const countBy = (rows: { workspaceId: string | null }[]) => {
  const m = new Map<string, number>();
  for (const r of rows) if (r.workspaceId) m.set(r.workspaceId, (m.get(r.workspaceId) ?? 0) + 1);
  return m;
};

/** The /workspaces table, built from workspaces.list, locations.list, members.list and each workspace's reply profile. */
export function workspaceRows(input: {
  workspaces: { id: string; name: string; createdAt: string }[];
  locations: { workspaceId: string }[];
  members: { workspaceId: string | null }[] | null;
  profiles: Partial<Record<string, Profile>>;
  tf: TimeFormat;
}): WorkspaceRow[] {
  const locs = countBy(input.locations);
  const people = input.members ? countBy(input.members) : null;
  return input.workspaces.map((w) => {
    const p = input.profiles[w.id];
    return {
      id: w.id,
      name: w.name,
      locations: locs.get(w.id) ?? 0,
      profile: p ? PROFILE_LABEL[p] : "Not available",
      people: people ? (people.get(w.id) ?? 0) : null,
      created: input.tf.date(w.createdAt, w.id),
    };
  });
}
