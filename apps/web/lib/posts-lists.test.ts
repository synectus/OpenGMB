import { describe, expect, it } from "vitest";
import {
  DAY_VISIBLE,
  KIND,
  cardState,
  ctaLine,
  dayCells,
  describeSchedule,
  scheduleInput,
  entryAria,
  googleHeadline,
  googlePostTitle,
  googleNote,
  googleState,
  languageLine,
  locationsCell,
  locationsLine,
  nextSendCell,
  parseStatus,
  parseType,
  postsHref,
  sendNumber,
  targetRows,
  typePills,
  type CalendarEntry,
  type GooglePost,
  type PostView,
} from "./posts-lists";
import { tEn } from "./posts-test-t";
import { makeTimeFormat } from "./time-format";

const utc = makeTimeFormat({ zones: [{ id: "w1", timeZone: "UTC", dateFormat: "YYYY-MM-DD" }], workspaceId: "w1" });
const ist = makeTimeFormat({ zones: [{ id: "w1", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w1" });

const target = (o: Partial<PostView["targets"][number]> = {}): PostView["targets"][number] => ({
  id: "t1",
  locationId: "l1",
  locationName: "Rivermoor Main St",
  occurrence: 0,
  status: "pending",
  googlePostName: null,
  publishedAt: null,
  error: null,
  ...o,
});
const post = (o: Partial<PostView> = {}): PostView =>
  ({
    id: "p1",
    workspaceId: "w1",
    topicType: "STANDARD",
    alertType: null,
    summary: "Our Saturday clinic is back",
    cta: null,
    event: null,
    offer: null,
    media: [],
    status: "draft",
    createdBy: "u1",
    createdByName: "Priya",
    approvedByName: null,
    rejectedByName: null,
    cancelledByName: null,
    createdSurface: "ui",
    scheduledFor: null,
    recurrence: null,
    occurrence: 0,
    submittedAt: "2026-10-18T09:55:00.000Z",
    approvedAt: null,
    rejectedAt: null,
    rejectReason: null,
    cancelledAt: null,
    guardrail: null,
    warningsAcknowledged: false,
    targets: [target()],
    createdAt: "2026-10-18T08:40:00.000Z",
    updatedAt: "2026-10-18T08:40:00.000Z",
    can: {
      edit: true,
      submit: true,
      approve: false,
      reject: false,
      schedule: false,
      cancel: true,
      deletePublished: false,
    },
    ...o,
  }) as PostView;

describe("queue and list helpers", () => {
  it("type pills count over the whole list and mark the current one", () => {
    const ps = [{ topicType: "STANDARD" }, { topicType: "EVENT" }, { topicType: "OFFER" }];
    expect(typePills(tEn, ps, undefined).map((p) => p.label)).toEqual([
      "All 3",
      "Standard 1",
      "Event 1",
      "Offer 1",
      "Alert 0",
    ]);
    expect(typePills(tEn, ps, "EVENT").find((p) => p.current)?.key).toBe("EVENT");
    expect(parseType("OFFER")).toBe("OFFER");
    expect(parseType("nope")).toBeUndefined();
    expect(parseStatus("scheduled")).toBe("scheduled");
    expect(parseStatus("x")).toBeUndefined();
  });
  it("hrefs carry only what is set, view first", () => {
    expect(postsHref({ view: "queue", type: "OFFER" })).toBe("/posts?view=queue&type=OFFER");
    expect(postsHref({ view: "list", ws: "w1", status: "draft", q: "flu shot", post: "p1" })).toBe(
      "/posts?view=list&ws=w1&status=draft&q=flu+shot&post=p1",
    );
  });
  it("next send, locations and send number cells", () => {
    expect(nextSendCell(tEn, post({ status: "approved" }), utc)).toBe("Not scheduled");
    expect(nextSendCell(tEn, post({ status: "pending_approval" }), utc)).toBe("After approval");
    expect(nextSendCell(tEn, post({ status: "publishing" }), utc)).toBe("Sending now");
    expect(nextSendCell(tEn, post({ status: "draft" }), utc)).toBe("·");
    expect(
      nextSendCell(tEn, post({ status: "scheduled", scheduledFor: "2026-10-20T14:00:00.000Z" }), utc),
    ).toBe("2026-10-20 14:00");
    expect(
      nextSendCell(tEn,
        post({
          status: "published",
          targets: [target({ status: "published", publishedAt: "2026-10-02T15:00:03.000Z" })],
        }),
        utc,
      ),
    ).toBe("Sent 2026-10-02");
    const two = post({
      targets: [target(), target({ id: "t2", locationId: "l2", locationName: "Rivermoor North" })],
    });
    expect(locationsCell(tEn, two, 6)).toBe("2 of 6");
    expect(locationsCell(tEn, two)).toBe("2");
    expect(locationsLine(two)).toBe("Rivermoor Main St, Rivermoor North · 2 locations");
    expect(sendNumber(tEn, post())).toBeNull();
    const rec = { freq: "weekly", interval: 1, count: 6, anchor: "2026-10-06T14:00:00.000Z" } as const;
    expect(sendNumber(tEn, post({ recurrence: rec, occurrence: 2 }))).toBe("send 3 of 6");
    expect(
      sendNumber(tEn, post({ recurrence: { ...rec, count: undefined, until: "2026-12-01T00:00:00.000Z" }, occurrence: 2 })),
    ).toBe("send 3");
  });
  it("button and language lines", () => {
    expect(ctaLine(post({ cta: { actionType: "BOOK", url: "https://x.example/book" } }))).toBe(
      "Book · https://x.example/book",
    );
    expect(
      ctaLine(post({ topicType: "OFFER", cta: { actionType: "BOOK", url: "https://x.example" } })),
    ).toBe("Book: kept, but Google will not show it on an offer");
    expect(ctaLine(post({ cta: { actionType: "CALL" } }))).toBe("Call · uses the location's phone");
    expect(ctaLine(post())).toBe("No button");
    expect(languageLine("en")).toBe("English (en)");
    expect(languageLine(null)).toBeNull();
  });
});

describe("targetRows", () => {
  it("a pending target of a publishing post reads publishing; occurrences are 1-based", () => {
    const p = post({
      status: "publishing",
      targets: [
        target({ status: "published", googlePostName: "g/1", publishedAt: "2026-10-06T14:00:05.000Z" }),
        target({ id: "t2", locationId: "l2", status: "pending" }),
        target({ id: "t3", locationId: "l3", status: "failed", error: "connection_removed" }),
      ],
    });
    const rows = targetRows(p, utc);
    expect(rows.map((r) => r.status)).toEqual(["published", "publishing", "failed"]);
    expect(rows[0]!.occurrence).toBe("1 · 2026-10-06 14:00");
    expect(rows[0]!.googleHref).toBe("/posts?view=google&loc=l1");
    expect(rows[2]!.reason).toBe("Reconnect Google in Settings");
    expect(rows[1]!.googleHref).toBeNull();
  });
});

describe("cardState: every state on the PostStates board", () => {
  const ok = (p: PostView) => cardState(tEn, p, utc);
  it("1 and 2 draft, human and agent", () => {
    expect(ok(post())).toMatchObject({
      provenance: { text: "Drafted by Priya · 2026-10-18 08:40", tone: "plain" },
      foot: "Not sent for approval yet",
    });
    expect(ok(post({ createdSurface: "mcp" }))).toMatchObject({
      provenance: { text: "Drafted by Claude via MCP · 2026-10-18 08:40", tone: "agent" },
      foot: "Check and submit it like any draft",
    });
  });
  it("3 blocked", () => {
    expect(ok(post({ status: "blocked" }))).toMatchObject({
      note: { text: "Blocked by guardrails: edit the post to fix the violations.", tone: "bad" },
      foot: "No Approve while blocked",
    });
  });
  it("4 to 6 pending approval, with and without the right to decide", () => {
    const s = ok(post({ status: "pending_approval", can: { ...post().can, approve: true, reject: true } }));
    expect(s.provenance?.text).toBe("Drafted by Priya · submitted 2026-10-18 09:55");
    expect(s.note).toBeNull();
    expect(ok(post({ status: "pending_approval" })).note).toEqual({
      text: "You can read this post. Approving needs the client approver role.",
      tone: "neutral",
    });
  });
  it("7 sent back to draft", () => {
    expect(
      ok(post({ rejectReason: "Wait for the hours.", rejectedByName: "Dr. Ramos", rejectedAt: "2026-10-18T10:00:00.000Z" })),
    ).toMatchObject({
      provenance: { text: "Rejected by Dr. Ramos: Wait for the hours.", tone: "warn" },
      foot: "Fix it and submit again",
    });
  });
  it("8 and 9 approved", () => {
    const base = { status: "approved" as const, approvedByName: "Dr. Ramos", approvedAt: "2026-10-18T11:02:00.000Z" };
    expect(ok(post({ ...base, can: { ...post().can, schedule: true } }))).toMatchObject({
      provenance: { text: "Approved by Dr. Ramos · 2026-10-18 11:02", tone: "good" },
      schedule: true,
    });
    expect(ok(post(base))).toMatchObject({
      schedule: false,
      note: { text: "Approved. A manager at Synectus sends or schedules it.", tone: "neutral" },
    });
  });
  it("10 and 11 scheduled, once and recurring", () => {
    const once = ok(post({ status: "scheduled", scheduledFor: "2026-10-24T15:00:00.000Z" }));
    expect(once.meta).toBe("next send 2026-10-24 15:00");
    expect(once.foot).toBe("Sent within a minute of that time");
    const rec = ok(
      post({
        status: "scheduled",
        scheduledFor: "2026-10-20T14:00:00.000Z",
        occurrence: 2,
        recurrence: { freq: "weekly", interval: 1, count: 6, anchor: "2026-10-06T14:00:00.000Z" },
      }),
    );
    expect(rec.meta).toBe("next send 2026-10-20 14:00 · repeats weekly every 1 · send 3 of 6");
    expect(rec.foot).toBe("Cancel stops the series");
  });
  it("12 publishing", () => {
    expect(ok(post({ status: "publishing" })).note).toEqual({
      text: "Sending: waiting for the worker.",
      tone: "info",
    });
  });
  it("13 and 14 published everywhere and at some locations", () => {
    const pub = (id: string, loc: string) =>
      target({ id, locationId: loc, status: "published", googlePostName: `g/${id}`, publishedAt: "2026-10-16T15:00:02.000Z" });
    expect(ok(post({ status: "published", targets: [pub("a", "l1"), pub("b", "l2")] })).meta).toBe(
      "Sent 2026-10-16 15:00",
    );
    const some = ok(
      post({
        status: "published",
        targets: [
          pub("a", "l1"),
          pub("b", "l2"),
          target({ id: "c", locationId: "l3", locationName: "Rivermoor South", status: "failed", error: "connection_removed" }),
        ],
      }),
    );
    expect(some.meta).toBe("Sent 2026-10-16 15:00 · 2 of 3 published");
    expect(some.foot).toBe("Reconnect Rivermoor South in Settings");
  });
  it("15 and 16 failed: the scope case and the writes-off case; failed is final", () => {
    const failed = (error: string) =>
      post({
        status: "failed",
        targets: [target({ status: "failed", error }), target({ id: "t2", locationId: "l2", status: "failed", error })],
      });
    expect(ok(failed("missing_scope")).note).toEqual({
      text: "Google did not grant the business.manage scope. Reconnect Google, then write the post again.",
      tone: "bad",
    });
    expect(ok(failed("google_writes_disabled"))).toMatchObject({
      note: { text: "Google writes are turned off on this server. Nothing was sent to Google.", tone: "warn" },
      foot: "A failed post cannot be sent again. Write a new post once the cause is fixed.",
      schedule: false,
    });
    expect(ok(failed("google_http_403")).note?.text).toBe(
      "Google did not accept this post. The reason for each location is in the table.",
    );
  });
  it("18 cancelled", () => {
    expect(
      ok(post({ status: "cancelled", cancelledByName: "Perry", cancelledAt: "2026-10-16T13:10:00.000Z", recurrence: { freq: "weekly", interval: 1, count: 4, anchor: "2026-10-06T14:00:00.000Z" } })).provenance,
    ).toEqual({ text: "Cancelled by Perry · 2026-10-16 13:10. The series stopped.", tone: "neutral" });
  });
});

describe("describeSchedule", () => {
  const base = { mode: "recurring", at: "2026-11-07T15:00", freq: "weekly", interval: 1, ends: "count", count: 8, until: "", locations: 3 } as const;
  it("the board's sentence", () => {
    expect(describeSchedule(tEn, base, utc)).toBe(
      "8 sends: every Saturday at 15:00 UTC, 2026-11-07 to 2026-12-26, to 3 locations. A send can be up to a minute late.",
    );
  });
  it("the same series in Asia/Kolkata reads the wall time in that zone and its date format", () => {
    expect(describeSchedule(tEn, { ...base, at: "2026-11-07T09:00" }, ist, "w1")).toBe(
      "8 sends: every Saturday at 09:00 IST, 07/11/2026 to 26/12/2026, to 3 locations. A send can be up to a minute late.",
    );
    expect(describeSchedule(tEn, { ...base, at: "2026-11-07T09:00", freq: "monthly", count: 4 }, ist, "w1")).toContain("monthly on day 7 at 09:00 IST");
  });
  it("every other week, until a date, monthly, one location, once, now", () => {
    expect(describeSchedule(tEn, { ...base, interval: 2, count: 3 }, utc)).toBe(
      "3 sends: every 2 weeks on Saturday at 15:00 UTC, 2026-11-07 to 2026-12-05, to 3 locations. A send can be up to a minute late.",
    );
    expect(describeSchedule(tEn, { ...base, ends: "until", until: "2026-12-01" }, utc)).toBe(
      "Every Saturday at 15:00 UTC, 2026-11-07 to 2026-12-01 (inclusive), to 3 locations. A send can be up to a minute late.",
    );
    expect(describeSchedule(tEn, { ...base, freq: "monthly", count: 4, locations: 1 }, utc)).toBe(
      "4 sends: monthly on day 7 at 15:00 UTC, starting 2026-11-07, to 1 location. A send can be up to a minute late.",
    );
    expect(describeSchedule(tEn, { ...base, mode: "at" }, utc)).toBe(
      "Sends 2026-11-07 15:00 UTC to 3 locations. A send can be up to a minute late.",
    );
    expect(describeSchedule(tEn, { ...base, mode: "now" }, utc)).toBe(
      "Sends as soon as the worker picks it up, to 3 locations. A send can be up to a minute late.",
    );
    expect(describeSchedule(tEn, { ...base, at: "" }, utc)).toBeNull();
  });
});

describe("calendar", () => {
  const e = (day: number, kind: CalendarEntry["kind"], n = 0): CalendarEntry => ({
    postId: `p${day}-${n}`,
    workspaceId: "w1",
    occurrence: 0,
    at: `2026-10-${String(day).padStart(2, "0")}T${String(9 + n).padStart(2, "0")}:00:00.000Z`,
    kind,
    postStatus: "scheduled",
    topicType: "STANDARD",
    summaryPreview: "Weekly back-care tip",
    locationIds: [],
    counts: { published: 0, failed: 0, skipped: 0, deleted: 0 },
  });
  it("canary: six kinds, each with its own glyph and label", () => {
    expect(Object.keys(KIND)).toEqual(["scheduled", "projected", "published", "failed", "skipped", "google"]);
    expect(new Set(Object.values(KIND).map((k) => k.glyph)).size).toBe(6);
    expect(tEn("kind.google")).toBe("Made on Google");
    expect(tEn("kind.projected")).toBe("Recurring, projected");
  });
  it("Monday-first weeks, outside days labelled with their month, at most 3 entries then +N", () => {
    const start = "2026-09-28"; // Monday
    const weeks = dayCells(tEn, [e(1, "skipped"), e(15, "published", 0), e(15, "published", 1), e(15, "published", 2), e(15, "failed", 3), e(15, "scheduled", 4)], start, 5, "2026-10", utc, "w1");
    expect(weeks).toHaveLength(5);
    expect(weeks[0]!.map((d) => d.num)).toEqual(["Sep 28", "Sep 29", "Sep 30", "1", "2", "3", "4"]);
    const fifteenth = weeks.flat().find((d) => d.key === "2026-10-15")!;
    expect(fifteenth.visible).toHaveLength(DAY_VISIBLE);
    expect(fifteenth.rest).toHaveLength(2);
    expect(weeks.flat().find((d) => d.key === "2026-10-01")!.visible).toHaveLength(1);
    expect(weeks[4]!.at(-1)!.num).toBe("Nov 1");
  });
  it("aria text names time, type, kind and what it is", () => {
    expect(entryAria(tEn, e(20, "projected", 5), utc, "w1")).toBe(
      "14:00, Standard, recurring, projected: Weekly back-care tip",
    );
    expect(entryAria(tEn, e(20, "google"), utc, "w1")).toBe("09:00, Standard, Made on Google: Weekly back-care tip");
  });
  it("buckets entries into days of the client's zone, not UTC", () => {
    // 2026-10-19 22:00Z is already 20 October 03:30 in Kolkata.
    const late = { ...e(19, "scheduled"), at: "2026-10-19T22:00:00.000Z" };
    const weeks = dayCells(tEn, [late], "2026-10-19", 1, "2026-10", ist, "w1");
    expect(weeks[0]!.find((d) => d.key === "2026-10-19")!.visible).toHaveLength(0);
    expect(weeks[0]!.find((d) => d.key === "2026-10-20")!.visible).toHaveLength(1);
    expect(entryAria(tEn, late, ist, "w1")).toContain("03:30,");
  });
  it("across clients (no workspace given) each entry uses its own client's zone", () => {
    const two = makeTimeFormat({
      zones: [
        { id: "w1", timeZone: "UTC", dateFormat: "YYYY-MM-DD" },
        { id: "w2", timeZone: "Asia/Kolkata", dateFormat: "YYYY-MM-DD" },
      ],
      workspaceId: "w1",
    });
    const late = { ...e(19, "scheduled"), at: "2026-10-19T22:00:00.000Z", workspaceId: "w2" };
    const weeks = dayCells(tEn, [late], "2026-10-19", 1, "2026-10", two);
    expect(weeks[0]!.find((d) => d.key === "2026-10-20")!.visible).toHaveLength(1);
    expect(entryAria(tEn, late, two)).toContain("03:30,");
    expect(entryAria(tEn, { ...late, workspaceId: "w1" }, two)).toContain("22:00,");
  });
  it("a post made on Google is titled by its event title, else its text, cut", () => {
    expect(googlePostTitle(tEn, { eventTitle: "Open day", summary: "x" })).toBe("Open day");
    expect(googlePostTitle(tEn, { eventTitle: null, summary: "a".repeat(100) })).toHaveLength(70);
    expect(googlePostTitle(tEn, { eventTitle: null, summary: "" })).toBe("(no text)");
  });
});

describe("On Google", () => {
  const g = (o: Partial<GooglePost> = {}): GooglePost => ({
    name: "n",
    topicType: "STANDARD",
    state: "LIVE",
    summary: "s",
    callToAction: null,
    eventTitle: null,
    mediaUrl: null,
    searchUrl: null,
    createTime: "2026-10-16T10:00:00Z",
    updateTime: null,
    managedHere: true,
    ...o,
  });
  it("states, notes and the headline", () => {
    expect(googleState(tEn, g())).toEqual({ label: "published", tone: "good" });
    expect(googleState(tEn, g({ state: "PROCESSING" }))).toEqual({ label: "processing", tone: "info" });
    expect(googleState(tEn, g({ state: "REJECTED" }))).toEqual({ label: "rejected", tone: "bad" });
    expect(googleNote(tEn, g({ state: "PROCESSING" }))).toEqual({ text: "Google is still processing this post.", tone: "muted" });
    expect(googleNote(tEn, g({ managedHere: false }))).toEqual({ text: "Made outside OpenGMB, in Google or another tool.", tone: "muted" });
    expect(googleNote(tEn, g({ state: "REJECTED", managedHere: false }))).toEqual({ text: "Google rejected this post. Made outside OpenGMB.", tone: "bad" });
    expect(googleNote(tEn, g())).toBeNull();
    expect(googleHeadline(tEn, 100, "Rivermoor Main St", true)).toBe(
      "100 posts live on Google for Rivermoor Main St (showing the newest; more exist).",
    );
    expect(googleHeadline(tEn, 1, "Orchard", false)).toBe("1 post live on Google for Orchard.");
  });
});

describe("scheduleInput (the composer's fields to the action input)", () => {
  const f = { mode: "at", at: "2026-10-19T09:00", freq: "weekly", interval: 1, ends: "count", count: 4, until: "" } as const;
  it("reads the datetime-local value as wall time in the post's zone", () => {
    expect(scheduleInput(tEn, f, "p1", "Asia/Kolkata")).toEqual({ input: { id: "p1", scheduledFor: "2026-10-19T03:30:00.000Z" } });
    expect(scheduleInput(tEn, f, "p1", "UTC")).toEqual({ input: { id: "p1", scheduledFor: "2026-10-19T09:00:00.000Z" } });
  });
  it("a series' last day is the end of that local day", () => {
    const r = scheduleInput(tEn, { ...f, mode: "recurring", ends: "until", until: "2026-12-01" }, "p1", "Asia/Kolkata");
    expect(r).toEqual({
      input: {
        id: "p1",
        scheduledFor: "2026-10-19T03:30:00.000Z",
        recurrence: { freq: "weekly", interval: 1, until: "2026-12-01T18:29:59.000Z" },
      },
    });
  });
  it("now needs no time; a missing start or end date is an error", () => {
    expect(scheduleInput(tEn, { ...f, mode: "now", at: "" }, "p1", "UTC")).toEqual({ input: { id: "p1" } });
    expect(scheduleInput(tEn, { ...f, at: "" }, "p1", "UTC")).toEqual({ error: "Pick a start date and time." });
    expect(scheduleInput(tEn, { ...f, mode: "recurring", ends: "until" }, "p1", "UTC")).toEqual({ error: "Pick an end date." });
  });
});
