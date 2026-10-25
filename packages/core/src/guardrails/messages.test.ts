import { describe, expect, it } from "vitest";
import { runGuardrails } from "./engine";
import { allRules } from "./packs";
import type { ContentType, GuardrailContext, PackId, PostFields } from "./types";

const POST: PostFields = {
  topicType: "STANDARD",
  alertType: null,
  cta: { actionType: "BOOK", url: "https://riverside.example.com/book" },
  event: null,
  offer: null,
  media: [],
};

/** A context of `type` that runs every pack, so a rule fires if its text matches. */
function ctx(type: ContentType, text: string): GuardrailContext {
  const packs: PackId[] = type === "profile" ? [] : ["hipaa", "legal_ethics"];
  return {
    ...(type === "reply" ? {} : { contentType: type }),
    ...(type === "post" ? { post: POST } : {}),
    ...(type === "profile" ? { profile: { description: text } } : {}),
    reply: text,
    review: { rating: 5, text: null, reviewerDisplayName: null },
    location: { name: "Riverside Family Clinic", phone: "(713) 555-0142" },
    workspace: { profile: "general", packs, skipPositiveReviews: false, staffNames: ["Rosa Diaz"] },
    recentReplies: [],
  };
}

/** Text that fires the rule (and only rules whose message is irrelevant here). */
const TRIGGER: Record<string, string> = {
  "U7.url": "See www.riverside.example.com for more.",
  "U7.email": "Write to frontdesk@riverside.example.com any time.",
  "U7.hashtag": "We love our neighbours #Riverside",
  "U8.style": "Spring check-ups are open — book a time that suits you.",
  H1: "Thanks for visiting us!",
  "H2.provider": "Ask Dr. Ramos about our new team.",
  "H2.staff": "Rosa Diaz leads our front desk.",
  "LE3.guarantee": "We guarantee the best results.",
  "LE4.testimonial": "Tell your friends about our team.",
};

const STYLE_MESSAGE =
  "Contains 1 wording the writing style bans (an em dash, stock or AI-sounding words); reword in plain words.";

/** The approved or planned wording, by rule and content type. Reply text is the shipped text. */
const EXPECTED: Record<string, Partial<Record<ContentType, string>>> = {
  "U7.url": {
    reply: "Reply contains a URL or web address.",
    post: "Links are not allowed in the text. Use the button URL.",
    profile: "The description contains a URL or web address.",
  },
  "U7.email": {
    reply: "Reply contains an email address.",
    post: "The post contains an email address.",
    profile: "The description contains an email address.",
  },
  "U7.hashtag": {
    reply: "Reply contains a hashtag.",
    post: "The post contains a hashtag.",
    profile: "The description contains a hashtag.",
  },
  "U8.style": {
    reply:
      "Contains 1 wording the writing style bans (an em dash, stock or AI-sounding words); reword in plain words.",
    post: "The post contains 1 wording the writing style bans (an em dash, stock or AI-sounding words); reword in plain words.",
    profile: STYLE_MESSAGE,
  },
  H1: {
    reply: "Reply confirms or implies a care relationship with the reviewer.",
    post: "The post confirms or implies a care relationship with the reader.",
  },
  "H2.provider": { reply: "Reply names a provider.", post: "The post names a provider." },
  "H2.staff": { reply: "Reply names a staff member.", post: "The post names a staff member." },
  "LE3.guarantee": {
    reply: "Reply guarantees or promises results.",
    post: "The post guarantees or promises results.",
  },
  "LE4.testimonial": {
    reply: "Reply uses testimonial or endorsement wording.",
    post: "The post uses testimonial or endorsement wording.",
  },
};

function messageOf(ruleId: string, type: ContentType): string | undefined {
  const r = runGuardrails(ctx(type, TRIGGER[ruleId]!));
  return r.violations.find((v) => v.ruleId === ruleId)?.message;
}

describe("guardrail messages per content type", () => {
  for (const [ruleId, byType] of Object.entries(EXPECTED)) {
    for (const [type, message] of Object.entries(byType)) {
      it(`${ruleId} on a ${type}: "${message}"`, () => {
        expect(messageOf(ruleId, type as ContentType)).toBe(message);
      });
    }
  }

  it("every rule shared by replies and another content type has its own wording there", () => {
    // Canary: these 9 rules are the shared ones today; a new shared rule must be added above.
    const shared = allRules().filter(
      (r) => (r.contentTypes ?? ["reply"]).includes("reply") && (r.contentTypes ?? []).length > 1,
    );
    expect(shared.map((r) => r.id).sort()).toEqual(Object.keys(EXPECTED).sort());
    let checked = 0;
    for (const rule of shared) {
      for (const type of rule.contentTypes!) {
        if (type === "reply") continue;
        const message = messageOf(rule.id, type);
        expect(message, `${rule.id} did not fire on a ${type}`).toBeDefined();
        expect(message!.startsWith("Reply"), `${rule.id} on a ${type}: ${message}`).toBe(false);
        checked++;
      }
    }
    console.log(`shared rules: ${shared.length}, non-reply messages checked: ${checked}`);
    expect(checked).toBe(13); // 3 U7 rules x (post, profile) + 5 HIPAA/legal rules x post + U8.style x (post, profile)
  });
});
