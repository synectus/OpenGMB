import { describe, expect, it } from "vitest";
import { prefillFromTemplate, templateCheckPayload, templateMeta, type TemplateView } from "./post-templates";
import { tEn } from "./posts-test-t";

const langs = [{ code: "en", label: "English" }, { code: "es", label: "Spanish" }];
const t = (o: Partial<TemplateView> = {}): TemplateView => ({
  id: "t1", workspaceId: "w1", name: "Saturday hours (Spanish)", topicType: "STANDARD", language: "es",
  summary: "Abrimos los sábados.", cta: { actionType: "CALL" }, eventTitle: null, offer: null,
  image: { id: "i1", name: "spanish-staff-banner.png", url: "https://app.example/m/" + "a".repeat(48) },
  updatedAt: "2026-10-12T09:00:00.000Z", updatedByName: "Priya", ...o,
});

describe("templateMeta", () => {
  it("reads like the board without the use count", () => {
    expect(templateMeta(tEn, t(), langs)).toBe("Spanish (es) · Call · image");
    expect(templateMeta(tEn, t({ language: "en", cta: { actionType: "LEARN_MORE", url: "https://x.example" }, image: null }), langs)).toBe("English (en) · Learn more · no image");
    expect(templateMeta(tEn, t({ topicType: "OFFER", cta: null, offer: { couponCode: "A" } }), langs)).toBe("Spanish (es) · coupon and terms · image");
  });
});

describe("templateCheckPayload", () => {
  it("gives EVENT and OFFER a placeholder event so only content rules are reported", () => {
    const p = templateCheckPayload(t({ topicType: "EVENT", eventTitle: "Health talk" }));
    expect(p.event).toEqual({ title: "Health talk", startDate: "2099-01-01", endDate: "2099-01-01" });
    expect(templateCheckPayload(t({ topicType: "EVENT", eventTitle: null })).event?.title).toBe("Saturday hours (Spanish)");
    expect(templateCheckPayload(t()).event).toBeNull();
    expect(templateCheckPayload(t()).media).toEqual([{ sourceUrl: t().image!.url }]);
    expect(templateCheckPayload(t({ image: null })).media).toEqual([]);
    expect(templateCheckPayload(t({ topicType: "OFFER", offer: { couponCode: "A" } })).offer).toEqual({ couponCode: "A" });
    expect(templateCheckPayload(t()).offer).toBeNull();
  });
});

describe("prefillFromTemplate", () => {
  it("maps to the composer form values, with empty strings for absent fields", () => {
    expect(prefillFromTemplate(t({ topicType: "OFFER", offer: { couponCode: "SAVE", termsConditions: "Terms" }, eventTitle: "Free consult", cta: { actionType: "BOOK", url: "https://b.example" } }))).toEqual({
      topicType: "OFFER", language: "es", summary: "Abrimos los sábados.", ctaType: "BOOK", ctaUrl: "https://b.example",
      title: "Free consult", couponCode: "SAVE", redeemOnlineUrl: "", termsConditions: "Terms", image: t().image!.url,
    });
    expect(prefillFromTemplate(t({ cta: null, image: null }))).toMatchObject({ ctaType: "none", ctaUrl: "", image: "" });
  });
});
