import { describe, expect, it } from "vitest";
import {
  checkImageFile,
  deleteReason,
  filterImages,
  sizeLabel,
  usedInLabel,
  usageLabel,
  type LibraryImage,
} from "./post-images";
import { tEn } from "./posts-test-t";

const MAX = 5 * 1024 * 1024;
const img = (o: Partial<LibraryImage>): LibraryImage => ({
  id: "i", name: "a.jpg", contentType: "image/jpeg", byteSize: 1_887_437, width: 1200, height: 900,
  source: "upload", creditName: null, creditUrl: null, aiGenerated: false,
  url: "https://x/m/t", createdAt: "2026-10-14T10:12:00.000Z", createdByName: "Priya",
  usedIn: [], templateCount: 0, canDelete: true, deleteBlockedBy: null, ...o,
});

describe("checkImageFile", () => {
  it("uses the board copy for a wrong type and for a file over the limit", () => {
    expect(checkImageFile(tEn, { name: "clinic-tour.gif", size: 1000, type: "image/gif" }, MAX)).toBe(
      "clinic-tour.gif: only JPG or PNG can be uploaded.");
    expect(checkImageFile(tEn, { name: "clinic-xray-room.jpg", size: 7.2 * 1024 * 1024, type: "image/jpeg" }, MAX)).toBe(
      "File is 7.2 MB; the limit is 5 MB.");
    expect(checkImageFile(tEn, { name: "ok.PNG", size: 1000, type: "image/png" }, MAX)).toBeNull();
    expect(checkImageFile(tEn, { name: "ok.jpeg", size: 1000, type: "" }, MAX)).toBeNull(); // type unknown: core decides
  });
});

describe("labels", () => {
  it("formats sizes and use", () => {
    expect(sizeLabel(1_887_437)).toBe("1.8 MB");
    expect(sizeLabel(900_000)).toBe("0.9 MB");
    expect(sizeLabel(640 * 1024)).toBe("640 KB");
    expect(usageLabel(tEn, img({}))).toBe("Not used");
    expect(usageLabel(tEn, img({ usedIn: [{ postId: "p", status: "draft", title: "t" }] }))).toBe("In 1 post");
    expect(usageLabel(tEn, img({ usedIn: [{ postId: "p", status: "draft", title: "t" }, { postId: "q", status: "draft", title: "u" }] }))).toBe("In 2 posts");
    expect(usedInLabel(tEn, { postId: "p", status: "pending_approval", title: "Holiday hours" })).toBe("Holiday hours (pending approval)");
  });
  it("explains why delete is off, with the board copy", () => {
    expect(deleteReason(tEn, img({}))).toBeNull();
    expect(deleteReason(tEn, img({ canDelete: false, deleteBlockedBy: "scheduled" }))).toBe(
      "Delete is off while a scheduled post uses this image. Posts already on Google keep their copy.");
    expect(deleteReason(tEn, img({ canDelete: false, deleteBlockedBy: "waiting" }))).toBe(
      "Delete is off while a post waiting for approval uses this image. Posts already on Google keep their copy.");
  });
});

describe("filterImages", () => {
  const a = img({ id: "a", name: "zeta.jpg", createdAt: "2026-10-10T00:00:00.000Z", usedIn: [{ postId: "1", status: "draft", title: "x" }] });
  const b = img({ id: "b", name: "alpha.png", createdAt: "2026-10-12T00:00:00.000Z" });
  const c = img({ id: "c", name: "Mid.jpg", createdAt: "2026-10-11T00:00:00.000Z", usedIn: [1, 2, 3].map((n) => ({ postId: String(n), status: "published", title: "x" })) });
  const ids = (l: LibraryImage[]) => l.map((i) => i.id);
  it("shows all, used, unused", () => {
    expect(ids(filterImages([a, b, c], { show: "all", q: "", sort: "newest" }))).toEqual(["b", "c", "a"]);
    expect(ids(filterImages([a, b, c], { show: "used", q: "", sort: "newest" }))).toEqual(["c", "a"]);
    expect(ids(filterImages([a, b, c], { show: "unused", q: "", sort: "newest" }))).toEqual(["b"]);
  });
  it("searches names ignoring case and sorts by most used and by name", () => {
    expect(ids(filterImages([a, b, c], { show: "all", q: "ALPHA", sort: "newest" }))).toEqual(["b"]);
    expect(ids(filterImages([a, b, c], { show: "all", q: "", sort: "used" }))).toEqual(["c", "a", "b"]);
    expect(ids(filterImages([a, b, c], { show: "all", q: "", sort: "name" }))).toEqual(["b", "c", "a"]);
  });
});
