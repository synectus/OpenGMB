import { describe, expect, it } from "vitest";
import { OPTIONAL_PACKS, POST_LANGUAGES, POST_LIMITS } from "@opengmb/core";
import {
  CTA_OPTIONS,
  ctaOptionLabel,
  checkBadge,
  counter,
  editingLine,
  initialForm,
  languageGroups,
  legacyPostView,
  packLabel,
  packsLine,
  parseLibrarySection,
  parsePostView,
  postViewTabs,
  postsHref,
  previewCta,
  previewPlace,
  previewWhen,
  selectedText,
  sendTimeInstant,
  sendTimeProblem,
  sentBackLine,
  toContent,
} from "./posts";
import { tEn } from "./posts-test-t";

describe("view tabs", () => {
  it("has four tabs, All posts first, with ?view= hrefs and no Compose or queue tab", () => {
    const tabs = postViewTabs(tEn, "list", { ws: "w1" });
    expect(tabs.map((t) => t.label)).toEqual(["All posts", "Calendar", "On Google", "Library"]);
    expect(tabs[0]).toMatchObject({ href: "/posts?ws=w1", current: true });
    expect(tabs[1]).toMatchObject({ href: "/posts?view=calendar&ws=w1", current: false });
    expect(postViewTabs(tEn, "compose", {}).some((t) => t.current)).toBe(false);
  });

  it("parses ?view=; Compose stays a page, anything else unknown is All posts", () => {
    expect(parsePostView("calendar")).toBe("calendar");
    expect(parsePostView("compose")).toBe("compose");
    expect(parsePostView("import")).toBe("import");
    expect(parsePostView("library")).toBe("library");
    expect(parsePostView(undefined)).toBe("list");
    expect(parsePostView("all")).toBe("list");
    expect(parsePostView("nope")).toBe("list");
  });

  it("maps the old Media library and Templates tabs to the Library sections", () => {
    expect(legacyPostView("media")).toEqual({ view: "library", section: "media" });
    expect(legacyPostView("templates")).toEqual({ view: "library", section: "templates" });
    expect(legacyPostView("list")).toBeNull();
    expect(postsHref("library", "w1", "templates")).toBe("/posts?view=library&section=templates&ws=w1");
    expect(postsHref("library", "w1", "media")).toBe("/posts?view=library&ws=w1");
    expect(parseLibrarySection("templates")).toBe("templates");
    expect(parseLibrarySection("x")).toBe("media");
  });
});

describe("compose form", () => {
  const base = initialForm(undefined, "es");

  it("starts blank, in the workspace's language", () => {
    expect(base).toMatchObject({
      topicType: "STANDARD",
      language: "es",
      summary: "",
      ctaType: "none",
      image: null,
    });
  });

  it("seeds from a saved post", () => {
    const f = initialForm(
      {
        topicType: "OFFER",
        language: "fr",
        summary: "S",
        cta: { actionType: "BOOK", url: "https://x.example/book" },
        event: { title: "T", startDate: "2026-10-21", endDate: "2026-10-31" },
        offer: { couponCode: "POSTURE15" },
        media: [{ sourceUrl: "https://img.example/a.jpg" }],
      },
      "en",
    );
    expect(f).toMatchObject({
      topicType: "OFFER",
      language: "fr",
      ctaType: "BOOK",
      ctaUrl: "https://x.example/book",
      title: "T",
      startTime: "",
      couponCode: "POSTURE15",
      image: { sourceUrl: "https://img.example/a.jpg" },
    });
  });

  it("an Alert sends no image, event or offer, even when the form still holds them", () => {
    const f = {
      ...base,
      topicType: "ALERT" as const,
      summary: "Masks at the front desk.",
      title: "T",
      startDate: "2026-11-14",
      endDate: "2026-11-14",
      couponCode: "C",
      image: { sourceUrl: "https://img.example/a.jpg" },
    };
    expect(toContent(f)).toMatchObject({
      topicType: "ALERT",
      alertType: "COVID_19",
      event: null,
      offer: null,
      media: [],
    });
  });

  it("Standard drops event and offer; Call takes no URL; blanks are left out", () => {
    const f = {
      ...base,
      summary: "Hi",
      ctaType: "CALL",
      ctaUrl: "https://x.example",
      title: "T",
      image: { sourceUrl: " https://img.example/a.jpg " },
    };
    expect(toContent(f)).toEqual({
      topicType: "STANDARD",
      alertType: null,
      summary: "Hi",
      cta: { actionType: "CALL" },
      event: null,
      offer: null,
      media: [{ sourceUrl: "https://img.example/a.jpg" }],
    });
    expect(toContent({ ...f, ctaType: "BOOK", ctaUrl: " " }).cta).toEqual({ actionType: "BOOK" });
    expect(toContent({ ...f, ctaType: "none" }).cta).toBeNull();
  });

  it("an Offer keeps its dates and offer fields; empty times are left out", () => {
    const c = toContent({
      ...base,
      topicType: "OFFER",
      title: "Free posture screening",
      startDate: "2026-10-21",
      endDate: "2026-10-31",
      couponCode: "POSTURE15",
    });
    expect(c.event).toEqual({
      title: "Free posture screening",
      startDate: "2026-10-21",
      endDate: "2026-10-31",
    });
    expect(c.offer).toEqual({ couponCode: "POSTURE15" });
  });
});

describe("labels and lines", () => {
  it("has a label for every Google call to action type, in config order", () => {
    expect(CTA_OPTIONS.map((o) => o.value)).toEqual(["none", ...POST_LIMITS.ctaActionTypes]);
    expect(CTA_OPTIONS.map((o) => ctaOptionLabel(tEn, o.value))).toEqual([
      "None",
      "Book",
      "Order",
      "Shop",
      "Learn more",
      "Sign up",
      "Call",
    ]);
  });

  it("names every guardrail pack and writes the board's packs line", () => {
    for (const p of [...OPTIONAL_PACKS, "post", "universal"]) expect(packLabel(tEn, p)).not.toBe(p);
    expect(packsLine(tEn, ["universal", "post", "hipaa"], "Rivermoor Pain Clinic")).toBe(
      "Rules checked: Posts, Universal and Healthcare (HIPAA) packs, for Rivermoor Pain Clinic.",
    );
    expect(packsLine(tEn, ["universal", "post"], "Bayou Physio")).toBe(
      "Rules checked: Posts and Universal packs, for Bayou Physio.",
    );
  });

  it("counts code points against the limit", () => {
    expect(counter("ééé", 1500)).toEqual({ text: "3 / 1500", over: false });
    expect(counter("a".repeat(1612), 1500)).toEqual({ text: "1612 / 1500", over: true });
  });

  it("badges blocks first, then warnings, nothing when clean", () => {
    const v = (severity: "block" | "warn") => ({ severity });
    expect(checkBadge(tEn, { violations: [v("block"), v("warn")] })).toEqual({
      tone: "bad",
      text: "1 blocks publishing",
    });
    expect(checkBadge(tEn, { violations: [v("block"), v("block")] })?.text).toBe("2 block publishing");
    expect(checkBadge(tEn, { violations: [v("warn")] })).toEqual({ tone: "warn", text: "1 warning" });
    expect(checkBadge(tEn, { violations: [] })).toBeNull();
  });

  it("status lines read as words", () => {
    expect(editingLine(tEn, "pending_approval")).toBe("Editing a pending approval post.");
    expect(editingLine(tEn, "draft")).toBe("Editing a draft post.");
    expect(sentBackLine(tEn, "Dr. Ramos", "Wait")).toBe("Sent back by Dr. Ramos: Wait");
    expect(sentBackLine(tEn, null, "Wait")).toBe("Sent back by an approver: Wait");
    expect(selectedText(tEn, 3, 6)).toBe("3 of 6 selected");
  });

  it("puts English and Spanish first, every other language under Other languages", () => {
    const g = languageGroups(POST_LANGUAGES);
    expect(g.main.map((l) => l.label)).toEqual(["English (en)", "Spanish (es)"]);
    expect(g.other).toHaveLength(POST_LANGUAGES.length - 2);
  });

  it("preview text: place, button, dates", () => {
    expect(previewPlace(tEn, [])).toBe("No location picked");
    expect(previewPlace(tEn, ["Rivermoor Main St"])).toBe("Rivermoor Main St");
    expect(previewPlace(tEn, ["Rivermoor Main St", "Rivermoor North", "Orchard"])).toBe(
      "Rivermoor Main St and 2 more",
    );
    const f = initialForm(undefined, "en");
    expect(previewCta(tEn, { ...f, ctaType: "BOOK" })).toBe("Book");
    expect(previewCta(tEn, { ...f, ctaType: "none" })).toBeNull();
    expect(previewCta(tEn, { ...f, topicType: "OFFER", ctaType: "BOOK" })).toBeNull(); // Google ignores it
    expect(
      previewWhen(tEn, {
        ...f,
        topicType: "EVENT",
        startDate: "2026-11-14",
        startTime: "10:00",
        endDate: "2026-11-14",
        endTime: "11:30",
      }),
    ).toBe("2026-11-14 10:00 to 2026-11-14 11:30");
    expect(previewWhen(tEn, { ...f, startDate: "2026-11-14", endDate: "2026-11-14" })).toBeNull();
  });
});

describe("the send time picked in Compose", () => {
  const chicago = "America/Chicago";
  const seed = {
    topicType: "STANDARD" as const,
    language: "en" as const,
    summary: "S",
    cta: null,
    event: null,
    offer: null,
    media: [],
  };
  it("reads the picked wall time in the client's zone, across a daylight-saving change", () => {
    expect(sendTimeInstant("2027-11-06T09:30", chicago)).toBe("2027-11-06T14:30:00.000Z"); // CDT, UTC-5
    expect(sendTimeInstant("2027-11-08T09:30", chicago)).toBe("2027-11-08T15:30:00.000Z"); // CST, UTC-6
    expect(sendTimeInstant("2027-11-08T09:30", "Asia/Kolkata")).toBe("2027-11-08T04:00:00.000Z");
    expect(sendTimeInstant("", chicago)).toBeNull();
    expect(sendTimeInstant("2027-13-40T99:99", chicago)).toBeNull();
  });
  it("blocks a time that has passed, in the client's zone, and accepts the next minute", () => {
    const now = Date.parse("2027-11-06T14:30:00Z"); // 09:30 in Chicago
    expect(sendTimeProblem(tEn, "2027-11-06T09:00", chicago, now)).toMatch(/already passed/);
    expect(sendTimeProblem(tEn, "2027-11-06T09:31", chicago, now)).toBeNull();
    expect(sendTimeProblem(tEn, "", chicago, now)).toBeNull();
    expect(sendTimeProblem(tEn, "nonsense", chicago, now)).toMatch(/date and a time/);
  });
  it("fills the picker from a saved draft, back in the client's zone", () => {
    const f = initialForm({ ...seed, scheduledFor: "2027-11-06T14:30:00.000Z" }, "en", chicago);
    expect(f.sendAt).toBe("2027-11-06T09:30");
    expect(initialForm(seed, "en", chicago).sendAt).toBe("");
  });
});
