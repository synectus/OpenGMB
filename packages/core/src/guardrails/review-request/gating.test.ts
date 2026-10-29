import { describe, expect, it } from "vitest";
import { GATING_RULES, REVIEW_REQUEST_POLICY, checkReviewRequest } from "./gating";

// One failing sentence per rule, taken from wording businesses really send. Every rule must be hit by at least one fixture.
const FAIL: [string, string][] = [
  ["GATE.conditional", "If you had a great experience, please leave us a Google review: {review link}"],
  ["GATE.conditional", "If you're happy with the work, would you post a review?"],
  ["GATE.conditional", "If you were satisfied we'd love a review."],
  ["GATE.conditional", "If you loved your visit, tell Google."],
  ["GATE.conditional", "Only if you're happy, please review us."],
  ["GATE.rate-first", "How would you rate your visit today? Reply 1 to 5, then we will send a link."],
  ["GATE.rate-first", "Take our quick survey and we will send the review page."],
  ["GATE.rate-first", "Please leave private feedback with us."],
  ["GATE.discourage-negative", "Before you leave a negative review, call us."],
  ["GATE.discourage-negative", "Give us a chance to make it right instead of posting a bad review."],
  ["GATE.discourage-negative", "If you're not happy, contact us first."],
  ["GATE.discourage-negative", "Please don't post a bad review."],
  ["GATE.incentive", "Leave a review and get 10% off your next visit."],
  ["GATE.incentive", "Post a review for a chance to win a gift card."],
  ["GATE.incentive", "We will give you a free coffee in exchange for a review."],
  ["GATE.incentive", "Review us and get a coupon."],
  ["GATE.incentive", "Get $20 off when you review us."],
  ["GATE.stars", "Please give us 5 stars on Google."],
  ["GATE.stars", "We'd love a glowing review."],
];

// Wording that must pass: plain asks to everyone.
const PASS = [
  "Thanks for choosing us today. Would you leave an honest Google review? It takes a minute: {review link}",
  "Hi, it was good to work with you. If you have a minute, a Google review helps other neighbors find us: {review link}",
  "Please feel free to share your honest thoughts on Google, good or bad: {review link}",
  "Your review, whatever it says, helps us improve. Here is the link: {review link}",
  "We would value your honest feedback on Google. {review link}",
  "Thank you for your visit. If you have time, tell other people what it was like: {review link}",
  "A free estimate is how we start every job. If you have a minute, a Google review is welcome: {review link}",
  "We won the Best of the City award last year. Honest reviews help us keep improving: {review link}",
];

describe("review request wording check", () => {
  it("canary: the policy source carries a URL and a read date", () => {
    expect(REVIEW_REQUEST_POLICY.sourceUrl).toBe("https://support.google.com/contributionpolicy/answer/7400114");
    expect(REVIEW_REQUEST_POLICY.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(REVIEW_REQUEST_POLICY.lines.length).toBeGreaterThan(0);
  });

  it.each(FAIL)("%s fires on: %s", (ruleId, text) => {
    const r = checkReviewRequest(text);
    expect(r.violations.map((v) => v.ruleId), text).toContain(ruleId);
    const hit = r.violations.find((v) => v.ruleId === ruleId)!;
    expect(hit.matches.length).toBeGreaterThan(0);
    for (const m of hit.matches) expect(text.slice(m.start, m.end).length).toBeGreaterThan(0);
  });

  it("every rule has a failing fixture, and the block rules make the result not ok", () => {
    const covered = new Set(FAIL.map(([id]) => id));
    for (const r of GATING_RULES) expect(covered.has(r.id), r.id).toBe(true);
    expect(checkReviewRequest("If you had a great experience, review us.").ok).toBe(false);
    expect(checkReviewRequest("Please give us 5 stars.").ok).toBe(true); // a warning, not a block
  });

  it.each(PASS)("passes: %s", (text) => {
    const r = checkReviewRequest(text);
    expect(r.violations, text).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("matches ignore case, smart quotes and extra punctuation", () => {
    expect(checkReviewRequest("IF YOU’RE HAPPY, review us").violations.map((v) => v.ruleId)).toContain("GATE.conditional");
    expect(checkReviewRequest("if  you,  had a   great   experience").violations.map((v) => v.ruleId)).toContain("GATE.conditional");
  });

  it("every rule states its basis and what the visitor should do", () => {
    for (const r of GATING_RULES) {
      expect(r.basis.length, r.id).toBeGreaterThan(10);
      expect(r.message.length, r.id).toBeGreaterThan(20);
      expect(r.message, r.id).not.toMatch(/—/);
    }
  });
});
