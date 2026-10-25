import { describe, expect, it } from "vitest";
import { assertPassed, guardrailSubject, runGuardrails } from "./engine";
import { allRules } from "./packs";
import type { GuardrailContext, PostFields } from "./types";

const POST: PostFields = {
  topicType: "STANDARD",
  alertType: null,
  cta: { actionType: "BOOK", url: "https://riverside.example.com/book" },
  event: null,
  offer: null,
  media: [{ sourceUrl: "https://cdn.example.com/a.jpg" }],
};

function ctx(
  over: Partial<GuardrailContext> = {},
  post: Partial<PostFields> = {},
): GuardrailContext {
  return {
    contentType: "post",
    post: { ...POST, ...post },
    reply: "Book online via the button below.",
    review: { rating: null, text: null, reviewerDisplayName: null },
    location: { name: "Riverside Family Clinic", phone: "(713) 555-0142" },
    workspace: { profile: "general", packs: [], skipPositiveReviews: false, staffNames: [] },
    recentReplies: [],
    ...over,
  };
}

describe("content type dimension", () => {
  it("replies still ignore the post pack, even if a workspace lists it", () => {
    const reply: GuardrailContext = {
      ...ctx(),
      contentType: undefined,
      post: undefined,
      workspace: {
        profile: "general",
        packs: ["post"],
        skipPositiveReviews: false,
        staffNames: [],
      },
    };
    delete reply.contentType;
    const r = runGuardrails({ ...reply, reply: "Call 713-555-0142" });
    expect(r.packs).toEqual(["universal"]);
    expect(r.violations).toEqual([]);
  });

  it("an explicit contentType 'reply' behaves like none", () => {
    const base: GuardrailContext = { ...ctx(), post: undefined, reply: "See www.example.com" };
    delete base.post;
    expect(runGuardrails({ ...base, contentType: "reply" })).toEqual(
      runGuardrails({ ...base, contentType: undefined }),
    );
  });

  it("posts never run R6, U4, U7.offer, U.length, H4, H2.echo or H.skip-positive", () => {
    const c = ctx({
      reply: "Thrilled to hear it. Free consultation, 20% off. Unrelated.",
      recentReplies: ["Thrilled to hear it. Free consultation, 20% off. Unrelated."],
      workspace: {
        profile: "healthcare",
        packs: ["hipaa"],
        skipPositiveReviews: true,
        staffNames: [],
      },
      review: { rating: 1, text: "back pain", reviewerDisplayName: "Jordan Lee" },
    });
    expect(runGuardrails(c).violations).toEqual([]);
  });

  it("every post-capable rule is declared; reply-only is the default for all others", () => {
    const post = allRules()
      .filter((r) => r.contentTypes?.includes("post"))
      .map((r) => r.id)
      .sort();
    expect(post).toEqual(
      [
        "H1",
        "H2.provider",
        "H2.staff",
        "LE3.guarantee",
        "LE4.testimonial",
        "P.alert",
        "P.cta",
        "P.event",
        "P.images",
        "P.length",
        "P.phone",
        "P.summary",
        "U7.email",
        "U7.hashtag",
        "U7.url",
        "U8.style",
      ].sort(),
    );
  });

  it("the packs that ran include post", () => {
    expect(runGuardrails(ctx()).packs).toEqual(["universal", "post"]);
  });
});

describe("assertPassed for posts binds to every field that is sent", () => {
  it("passes for the checked content", () => {
    const c = ctx();
    expect(() => assertPassed(runGuardrails(c), guardrailSubject(c))).not.toThrow();
  });

  it.each([
    ["CTA url", { cta: { actionType: "BOOK", url: "https://evil.example.com" } }],
    ["media url", { media: [{ sourceUrl: "https://cdn.example.com/other.jpg" }] }],
    ["topic type", { topicType: "OFFER" as const }],
    ["offer terms", { offer: { termsConditions: "anything" } }],
  ])("throws when the %s changes after the check", (_n, change) => {
    const checked = ctx();
    const result = runGuardrails(checked);
    const sent = ctx({}, change as Partial<PostFields>);
    expect(() => assertPassed(result, guardrailSubject(sent))).toThrow(/differs/);
  });

  it("throws when the summary changes after the check", () => {
    const checked = ctx();
    const result = runGuardrails(checked);
    expect(() => assertPassed(result, guardrailSubject(ctx({ reply: "Different." })))).toThrow(
      /differs/,
    );
  });

  it("a blocked post cannot be asserted", () => {
    const c = ctx({ reply: "Call 713-555-0142" });
    expect(() => assertPassed(runGuardrails(c), guardrailSubject(c))).toThrow(/blocked/);
  });
});
