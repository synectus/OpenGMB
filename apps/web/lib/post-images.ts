import { statusText, type T } from "./posts-lists";
// Pure logic for the Media library and the image field. Client-safe: no runtime import from core.
export type UsedIn = { postId: string; status: string; title: string };
export type LibraryImage = {
  id: string;
  name: string;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  source: "upload" | "stock" | "ai";
  creditName: string | null;
  creditUrl: string | null;
  aiGenerated: boolean;
  url: string;
  createdAt: string;
  createdByName: string;
  usedIn: UsedIn[];
  templateCount: number;
  canDelete: boolean;
  deleteBlockedBy: "scheduled" | "waiting" | null;
};

const MB = 1024 * 1024;
export function sizeLabel(bytes: number): string {
  return bytes >= 0.95 * MB
    ? `${(Math.floor((bytes / MB) * 10) / 10).toFixed(1)} MB`
    : bytes >= 0.7 * MB
      ? `${(Math.round((bytes / MB) * 10) / 10).toFixed(1)} MB`
      : `${Math.round(bytes / 1024)} KB`;
}

/** Browser pre-check with the board copy. The real check is core's, on the bytes. */
export function checkImageFile(
  t: T,
  f: { name: string; size: number; type: string },
  maxBytes: number,
): string | null {
  const okType = f.type ? /^image\/(jpeg|png)$/.test(f.type) : /\.(jpe?g|png)$/i.test(f.name);
  if (!okType) return t("img.onlyJpgPng", { name: f.name });
  if (f.size > maxBytes) {
    return t("img.tooBig", { size: (f.size / MB).toFixed(1), limit: Math.round(maxBytes / MB) });
  }
  return null;
}

export const usageLabel = (t: T, i: LibraryImage) =>
  i.usedIn.length === 0 ? t("img.usageNone") : t("img.usageIn", { count: i.usedIn.length });

export const usedInLabel = (t: T, u: UsedIn) => t("img.usedInLabel", { title: u.title, status: statusText(t, u.status) });

export function deleteReason(t: T, i: LibraryImage): string | null {
  if (i.canDelete) return null;
  const who = i.deleteBlockedBy === "waiting" ? t("img.deleteWaiting") : t("img.deleteScheduled");
  return t("img.deleteReason", { who });
}

export type LibraryView = { show: "all" | "used" | "unused"; q: string; sort: "newest" | "used" | "name" };

export function filterImages(list: LibraryImage[], v: LibraryView): LibraryImage[] {
  const q = v.q.trim().toLowerCase();
  const out = list.filter(
    (i) =>
      (v.show === "all" || (v.show === "used" ? i.usedIn.length > 0 : i.usedIn.length === 0)) &&
      (!q || i.name.toLowerCase().includes(q)),
  );
  const by: Record<LibraryView["sort"], (a: LibraryImage, b: LibraryImage) => number> = {
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
    used: (a, b) => b.usedIn.length - a.usedIn.length || b.createdAt.localeCompare(a.createdAt),
    name: (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  };
  return out.sort(by[v.sort]);
}
