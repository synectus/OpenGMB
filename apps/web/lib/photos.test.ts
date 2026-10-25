import { describe, expect, it } from "vitest";
import { makeTimeFormat } from "./time-format";
import {
  addedLabel,
  categoryChip,
  categoryPills,
  failureLine,
  fileProblem,
  fileSize,
  filterPhotos,
  helpText,
  openOps,
  opSettlement,
  opText,
  opTone,
  patchItem,
  photoActions,
  queueItem,
  sendable,
  sizeLabel,
  skippedNote,
  sortPhotos,
  statusText,
  uploadLabel,
  type Limits,
  resultsSettled,
  type OpLike,
  type PhotoLike,
} from "./photos";

const LIMITS: Limits = {
  minBytes: 10_240,
  maxBytes: 5 * 1024 * 1024,
  minShortEdgePx: 250,
  minimumsExempt: ["COVER", "PROFILE"],
};
const photo = (over: Partial<PhotoLike> = {}): PhotoLike => ({
  name: "accounts/1/locations/2/media/a",
  category: "EXTERIOR",
  createTime: "2026-08-21T10:00:00Z",
  widthPixels: 1080,
  heightPixels: 720,
  sourceUrl: null,
  googleUrl: "https://lh3.example/a",
  ...over,
});
const op = (over: Partial<OpLike> = {}): OpLike => ({
  id: "o1",
  kind: "add",
  status: "pending",
  error: null,
  payload: { category: "EXTERIOR" },
  ...over,
});
const MB = 1024 * 1024;


const utc = makeTimeFormat({ zones: [{ id: "w", timeZone: "UTC", dateFormat: "YYYY-MM-DD" }], workspaceId: "w" });
const ist = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });

describe("labels", () => {
  it("chips use plain words, the logo is named, null is No category", () => {
    expect(categoryChip("COVER")).toBe("Cover photo");
    expect(categoryChip("PROFILE")).toBe("Logo");
    expect(categoryChip("AT_WORK")).toBe("At work");
    expect(categoryChip(null)).toBe("No category");
  });
  it("size and added date, empty when Google gave none", () => {
    expect(sizeLabel(1080, 720)).toBe("1080 x 720");
    expect(sizeLabel(null, 720)).toBe("");
    expect(addedLabel("2026-09-07T23:59:00Z", utc)).toBe("Added 2026-09-07");
    expect(addedLabel("2026-09-07T23:59:00Z", ist)).toBe("Added 08/09/2026");
    // A missing createTime stored as the Unix epoch must not read "Added 1970-01-01".
    expect(addedLabel("1970-01-01T00:00:00Z", utc)).toBe("");
    expect(utc.date("1970-01-01T00:00:00Z")).toBe("Unknown date");
    expect(utc.dateTime("1970-01-01T00:00:00.000Z")).toBe("Unknown date");
    expect(addedLabel(null, utc)).toBe("");
  });
  it("file sizes read like the canvas", () => {
    expect(fileSize(5 * MB)).toBe("5 MB");
    expect(fileSize(6.2 * MB)).toBe("6.2 MB");
    expect(fileSize(340 * 1024)).toBe("340 KB");
    expect(fileSize(10_240)).toBe("10 KB");
  });
  it("help text takes its numbers from the limits", () => {
    expect(helpText(LIMITS)).toBe(
      "JPG or PNG, 10 KB to 5 MB, at least 250 px on the short edge. Cover and logo replace the current one and skip the size minimums.",
    );
    expect(helpText({ ...LIMITS, minShortEdgePx: 300 })).toContain("at least 300 px");
  });
});

describe("pills, filter and sort", () => {
  const items = [
    photo({ name: "c", category: "COVER" }),
    photo({ name: "p", category: "PROFILE" }),
    photo({ name: "e1" }),
    photo({ name: "e2" }),
    photo({ name: "n", category: null }),
  ];
  it("All first, then the categories present in Google's order, with counts", () => {
    expect(categoryPills(items).map((p) => p.label)).toEqual([
      "All (5)",
      "Cover (1)",
      "Logo (1)",
      "Exterior (2)",
      "No category (1)",
    ]);
    expect(categoryPills([])).toEqual([{ key: "all", label: "All (0)" }]);
  });
  it("filters by pill key", () => {
    expect(filterPhotos(items, "all")).toHaveLength(5);
    expect(filterPhotos(items, "EXTERIOR").map((i) => i.name)).toEqual(["e1", "e2"]);
    expect(filterPhotos(items, "NONE").map((i) => i.name)).toEqual(["n"]);
  });
  it("sorts by createTime both ways; photos without a time go last; ties keep their order", () => {
    const list = [
      photo({ name: "old", createTime: "2026-05-03T00:00:00Z" }),
      photo({ name: "none", createTime: null }),
      photo({ name: "new", createTime: "2026-09-07T00:00:00.5Z" }),
      photo({ name: "new2", createTime: "2026-09-07T00:00:00.5Z" }),
    ];
    expect(sortPhotos(list, "newest").map((i) => i.name)).toEqual(["new", "new2", "old", "none"]);
    expect(sortPhotos(list, "oldest").map((i) => i.name)).toEqual(["old", "new", "new2", "none"]);
  });
});

describe("card buttons", () => {
  it("cover and logo can be replaced but not deleted here", () => {
    expect(photoActions(photo({ category: "COVER" }))).toEqual({ cover: false, logo: true, remove: false });
    expect(photoActions(photo({ category: "PROFILE" }))).toEqual({ cover: true, logo: false, remove: false });
    expect(photoActions(photo())).toEqual({ cover: true, logo: true, remove: true });
  });
  it("without a source URL a photo cannot be re-added as cover or logo", () => {
    expect(photoActions(photo({ googleUrl: null, sourceUrl: null }))).toEqual({
      cover: false,
      logo: false,
      remove: true,
    });
  });
});

describe("pending operations", () => {
  it("pending reads queued, failed keeps the code", () => {
    expect(opText(op(), [])).toBe("Add exterior photo: queued");
    expect(
      opText(
        op({ kind: "delete", status: "failed", error: "google_writes_disabled", payload: { mediaName: "m1" } }),
        [photo({ name: "m1", category: "INTERIOR" })],
      ),
    ).toBe("Remove interior photo: failed (Google writes are turned off on this server)");
  });
  it("a delete whose photo is gone says photo", () => {
    expect(opText(op({ kind: "delete", payload: { mediaName: "gone" } }), [])).toBe("Remove photo: queued");
  });
  it("tones and the open list", () => {
    expect(opTone(op())).toBe("info");
    expect(opTone(op({ status: "failed" }))).toBe("bad");
    const ops = [op({ id: "a" }), op({ id: "b", status: "applied" }), op({ id: "c", status: "failed" })];
    expect(openOps(ops).map((o) => o.id)).toEqual(["a", "c"]);
  });
  it("a cancelled op is closed, not open", () => {
    expect(openOps([op({ id: "a", status: "scheduled" }), op({ id: "b", status: "cancelled" })]).map((o) => o.id)).toEqual(["a"]);
  });
  it("opSettlement maps every status explicitly", () => {
    expect(opSettlement(undefined)).toBe("working");
    expect(opSettlement({ status: "pending" })).toBe("working");
    expect(opSettlement({ status: "applied" })).toBe("applied");
    expect(opSettlement({ status: "failed" })).toBe("failed");
    expect(opSettlement({ status: "scheduled" })).toBe("scheduled");
    expect(opSettlement({ status: "cancelled" })).toBe("cancelled");
  });
  it("failureLine adds the label when there is one", () => {
    expect(failureLine("google_writes_disabled")).toBe(
      "google_writes_disabled: Google writes are turned off on this server",
    );
    expect(failureLine("google_http_400")).toBe("google_http_400");
  });
});

describe("file checks (canvas copy, numbers from the limits)", () => {
  const f = (name: string, type: string, size: number) => ({ name, type, size });
  it("canary: each problem gives its message", () => {
    expect(fileProblem(f("staff-list.pdf", "application/pdf", 340 * 1024), "ADDITIONAL", LIMITS, null)).toBe(
      "Only JPG or PNG files can be uploaded.",
    );
    expect(fileProblem(f("b.jpg", "image/jpeg", 6.2 * MB), "ADDITIONAL", LIMITS, 800)).toBe(
      "This file is 6.2 MB. The limit is 5 MB.",
    );
    expect(fileProblem(f("s.jpg", "image/jpeg", 2 * MB), "ADDITIONAL", LIMITS, 180)).toBe(
      "This image is 180 px on its short edge. Google needs at least 250 px.",
    );
    expect(fileProblem(f("t.jpg", "image/jpeg", 2048), "ADDITIONAL", LIMITS, 800)).toBe(
      "This file is 2 KB. Google needs at least 10 KB.",
    );
    expect(fileProblem(f("IMG_1.HEIC", "image/heic", 2 * MB), "ADDITIONAL", LIMITS, null)).toMatch(
      /HEIC/,
    );
  });
  it("a good file, and cover or logo skip the minimums but not the maximum", () => {
    expect(fileProblem(f("a.png", "image/png", 2 * MB), "EXTERIOR", LIMITS, 800)).toBeNull();
    expect(fileProblem(f("a.jpg", "", 2 * MB), "EXTERIOR", LIMITS, null)).toBeNull();
    expect(fileProblem(f("s.jpg", "image/jpeg", 2048), "COVER", LIMITS, 100)).toBeNull();
    expect(fileProblem(f("b.jpg", "image/jpeg", 6.2 * MB), "PROFILE", LIMITS, 800)).toMatch(/limit/);
  });
});

describe("upload queue", () => {
  const good = queueItem("k1", { name: "front-entrance.jpg", type: "image/jpeg", size: 1.8 * MB }, 1080);
  const small = queueItem("k2", { name: "side-door.jpg", type: "image/jpeg", size: 1 * MB }, 180);
  const big = queueItem("k3", { name: "brochure.jpg", type: "image/jpeg", size: 6.2 * MB }, 1080);
  it("new items are ready, in ADDITIONAL", () => {
    expect(good).toMatchObject({ phase: "ready", category: "ADDITIONAL", percent: 0, error: null });
  });
  it("only items without a problem are sent, failed ones again", () => {
    const failed = { ...good, key: "k4", phase: "failed" as const, error: "INVALID_INPUT: x" };
    const done = { ...good, key: "k5", phase: "applied" as const };
    expect(sendable([good, small, big, failed, done], LIMITS).map((q) => q.key)).toEqual(["k1", "k4"]);
  });
  it("switching a small photo to COVER makes it sendable", () => {
    const cover = patchItem([small], "k2", { category: "COVER" });
    expect(sendable(cover, LIMITS).map((q) => q.key)).toEqual(["k2"]);
  });
  it("button label and skipped note", () => {
    expect(uploadLabel(3)).toBe("Upload 3 photos");
    expect(uploadLabel(1)).toBe("Upload 1 photo");
    expect(skippedNote([good, small], LIMITS)).toBe("The file with a problem is skipped.");
    expect(skippedNote([good, small, big], LIMITS)).toBe("The 2 files with a problem are skipped.");
    expect(skippedNote([good], LIMITS)).toBeNull();
  });
  it("status text per phase", () => {
    expect(statusText(good, LIMITS)).toBe("Ready to upload");
    expect(statusText(small, LIMITS)).toBe(
      "This image is 180 px on its short edge. Google needs at least 250 px.",
    );
    expect(statusText({ ...good, phase: "uploading", percent: 62 }, LIMITS)).toBe("62%");
    expect(statusText({ ...good, phase: "queued" }, LIMITS)).toBe("Queued: Google is processing the photo.");
    expect(statusText({ ...good, phase: "applied" }, LIMITS)).toBe("Done: the photo is on Google.");
    expect(statusText({ ...good, phase: "failed", error: "INVALID_INPUT: Google could not read the image file." }, LIMITS)).toBe(
      "Upload failed: INVALID_INPUT: Google could not read the image file.",
    );
  });
});

describe("scheduled photos and per-location results", () => {
  it("a scheduled op is open and reads as info", () => {
    const o = op({ status: "scheduled" });
    expect(opTone(o)).toBe("info");
    expect(openOps([o])).toHaveLength(1);
  });
  it("results are settled once none is still queued at Google", () => {
    const r = (status: "scheduled" | "pending" | "applied" | "failed") => ({ locationId: "l", status, error: null });
    expect(resultsSettled([r("applied"), r("pending")])).toBe(false);
    expect(resultsSettled([r("applied"), r("failed"), r("scheduled")])).toBe(true);
  });
});
