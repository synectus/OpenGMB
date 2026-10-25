import { describe, expect, it } from "vitest";
import { OPERATOR_LEGAL_ENTITY, OPERATOR_REGISTERED_OFFICE } from "../config/operator";
import { LIST_SOURCES } from "../config/review-requests";
import { autoApproveAllowed, identityComplete, sendingBlock } from "./identity";
import { buildReviewRequestEmail, gatingProblem, inSendWindow, parseRecipientsCsv } from "./pure";

const SENDER = { legalName: "Acme Dental Pty Ltd", postalAddress: "1 Main St, <Springfield>", companyNumber: null, phone: null, website: null };

describe("review request helpers", () => {
  it("canary: the CSV reader finds the email column by header, with quotes and a BOM", () => {
    const r = parseRecipientsCsv('﻿First name,E-mail\r\n"Ann, B",Ann@Example.com\r\n');
    expect(r.rows).toEqual([{ email: "ann@example.com", name: "Ann, B" }]);
  });
  it("without a header, column 1 is the email and column 2 the name; counts bad and repeated rows", () => {
    const r = parseRecipientsCsv("a@x.co,Al\nA@x.co,Al\nnope,Bo\n");
    expect(r).toMatchObject({ rows: [{ email: "a@x.co", name: "Al" }], duplicates: 1, invalid: 1, tooMany: false });
  });
  it("flags wording that gates or asks for ratings", () => {
    for (const t of ["How was your visit?", "Rate us 5 stars", "Take our survey", "Tell us how we did", "Share your feedback"]) expect(gatingProblem(t), t).not.toBeNull();
    expect(gatingProblem("Thank you for choosing Clinic. We would be grateful if you left us a review on Google.")).toBeNull();
  });
  it("sending window is 08:00 to 21:00 local", () => {
    const d = (h: number) => new Date(Date.UTC(2031, 0, 5, h));
    expect([7, 8, 20, 21].map((h) => inSendWindow(d(h), "UTC"))).toEqual([false, true, true, false]);
  });
  it("the email has one review button, an unsubscribe link and the headers", () => {
    const m = buildReviewRequestEmail({ subject: "Hello {business}", body: "Hi {name},\n\nPlease review {business}.", business: "Acme <Dental>", sender: SENDER, recipientName: "Dana W", brand: { logoUrl: null, primaryColor: null }, clickUrl: "https://a.test/e/T", unsubscribeUrl: "https://a.test/e/T/unsubscribe", reminder: true });
    expect(m.subject).toBe("Reminder: Hello Acme <Dental>");
    expect(m.html).toContain("Acme &lt;Dental&gt;");
    expect(m.html).toContain('href="https://a.test/e/T/unsubscribe"');
    expect(m.text).toContain("Hi Dana,");
    expect(m.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
  it("the footer follows the legal wording, with the number only when the business has one", () => {
    const base = { subject: "S", body: "Hi", business: "Acme", recipientName: null, brand: { logoUrl: null, primaryColor: null }, clickUrl: "https://a.test/e/T", unsubscribeUrl: "https://a.test/e/T/unsubscribe", reminder: false, listPhrase: LIST_SOURCES.purchase.phrase, listDate: new Date(Date.UTC(2031, 0, 5)) };
    const withNum = buildReviewRequestEmail({ ...base, sender: { ...SENDER, companyNumber: "ABN 12 345 678 901", phone: "+61 2 5550 0100", website: null } });
    expect(withNum.text).toContain("You are receiving this from Acme Dental Pty Ltd (ABN 12 345 678 901) because you bought from Acme within the 24 months before January 2031.");
    expect(withNum.text).toContain("1 Main St, <Springfield> \u00b7 +61 2 5550 0100. Unsubscribe from Acme's review requests: https://a.test/e/T/unsubscribe (one click, no sign-in).");
    expect(withNum.text).toContain(`Sent by OpenGMB for Acme; OpenGMB is operated by ${OPERATOR_LEGAL_ENTITY}, ${OPERATOR_REGISTERED_OFFICE}.`);
    expect(withNum.html).toContain("1 Main St, &lt;Springfield&gt;");
    expect(withNum.html).toContain("<a href=\"https://a.test/e/T/unsubscribe\">Unsubscribe from Acme's review requests</a>");
    const without = buildReviewRequestEmail({ ...base, sender: SENDER });
    expect(without.text).toContain("from Acme Dental Pty Ltd because you");
    expect(without.text).not.toContain("()");
    expect(without.text).toContain("1 Main St, <Springfield>. Unsubscribe");
  });
  it("carries the RFC 8058 one-click headers", () => {
    const m = buildReviewRequestEmail({ subject: "S", body: "Hi", business: "Acme", sender: SENDER, recipientName: null, brand: { logoUrl: null, primaryColor: null }, clickUrl: "https://a.test/e/T", unsubscribeUrl: "https://a.test/e/T/unsubscribe", reminder: false });
    expect(m.headers).toEqual({ "List-Unsubscribe": "<https://a.test/e/T/unsubscribe>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  });
});

describe("sender identity and healthcare", () => {
  const ws = { id: "w1", senderLegalName: "Acme Pty Ltd", senderPostalAddress: "1 Main St", senderCompanyNumber: null, senderPhone: null, senderWebsite: null, hipaaCoveredEntity: false };
  it("needs both a legal name and a postal address; the message links to the setting", () => {
    expect(sendingBlock(ws)).toBeNull();
    for (const bad of [{ senderLegalName: null }, { senderPostalAddress: null }, { senderLegalName: "  " }]) {
      const b = sendingBlock({ ...ws, ...bad });
      expect(b?.reason).toBe("identity");
      expect(b?.message).toContain("/settings/workspace?ws=w1");
    }
    expect(identityComplete({ legalName: "A", postalAddress: null, companyNumber: null, phone: null, website: null })).toBe(false);
  });
  it("a HIPAA covered entity cannot send and cannot auto-approve", () => {
    expect(sendingBlock({ ...ws, hipaaCoveredEntity: true })?.reason).toBe("hipaa");
    expect(autoApproveAllowed({ hipaaCoveredEntity: true })).toBe(false);
    expect(autoApproveAllowed({ hipaaCoveredEntity: false })).toBe(true);
  });
});
