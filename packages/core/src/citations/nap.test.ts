import { describe, expect, it } from "vitest";
import { compareNap, normalizeText, phoneKey } from "./nap";

const profile = {
  name: "Ace Dental & Co.",
  address: "1234 Main Street, Suite 5, Springfield, IL 62701, US",
  phone: "(217) 555-0142",
};

const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const page = (body: string, head = "") => `<!doctype html><html><head><title>Listing</title>${head}</head><body>${body}</body></html>`;

describe("normalisers", () => {
  it("names ignore case, punctuation, accents, apostrophes and ampersands", () => {
    expect(normalizeText("Joe’s  CAFÉ & Bar!")).toBe("joes cafe and bar");
    expect(normalizeText("Ace Dental &amp; Co.".replace("&amp;", "&"))).toBe(normalizeText("ACE DENTAL AND CO"));
  });
  it("phones compare on the last 9 digits so country codes and a leading 0 do not matter", () => {
    const keys = ["(217) 555-0142", "+1 217-555-0142", "1.217.555.0142", "217 555 0142"].map(phoneKey);
    expect(new Set(keys).size).toBe(1);
    expect(phoneKey("0412 345 678")).toBe(phoneKey("+61 412 345 678"));
    expect(phoneKey("020 7946 0958")).toBe(phoneKey("+44 20 7946 0958"));
    expect(phoneKey("+91 98765 43210")).toBe(phoneKey("098765 43210"));
    expect(phoneKey("12345")).toBeNull();
  });
});

describe("compareNap", () => {
  it("matches a plain text page whatever the formatting", () => {
    const html = page(`<h1>ACE DENTAL and Co</h1><p>1234 Main St., Ste 5<br>Springfield, IL 62701</p><a href="tel:+12175550142">Call</a>`);
    expect(compareNap(html, profile)).toEqual({ result: "match", fields: { name: "match", address: "match", phone: "match" } });
  });
  it("matches from json-ld, with entities", () => {
    const html = page("<p>Welcome</p>", ld({ "@context": "https://schema.org", "@type": "Dentist", name: "Ace Dental &amp; Co.", telephone: "+1-217-555-0142", address: { "@type": "PostalAddress", streetAddress: "1234 Main Street Suite 5", addressLocality: "Springfield", addressRegion: "IL", postalCode: "62701" } }));
    expect(compareNap(html, profile).result).toBe("match");
  });
  it("matches inside an @graph", () => {
    const html = page("", ld({ "@graph": [{ "@type": "WebSite", name: "Dirx" }, { "@type": "LocalBusiness", name: "Ace Dental & Co.", telephone: "217-555-0142", address: "1234 Main St Ste 5 Springfield IL 62701" }] }));
    expect(compareNap(html, profile).result).toBe("match");
  });
  it("flags a different phone as a mismatch of the phone only", () => {
    const html = page("<h1>Ace Dental and Co</h1><p>1234 Main St Ste 5 Springfield IL 62701</p>", ld({ "@type": "Dentist", name: "Ace Dental & Co.", telephone: "217-555-9999", address: "1234 Main St Ste 5 Springfield IL 62701" }));
    expect(compareNap(html, profile)).toEqual({ result: "mismatch", fields: { name: "match", address: "match", phone: "mismatch" } });
  });
  it("flags an old address and a different name", () => {
    const html = page("<h1>Ace Dentistry</h1><p>77 Oak Avenue, Springfield, IL 62704</p><p>217-555-0142</p>", ld({ "@type": "Dentist", name: "Ace Dentistry", telephone: "217-555-0142", address: "77 Oak Avenue Springfield IL 62704" }));
    const r = compareNap(html, profile);
    expect(r.result).toBe("mismatch");
    expect(r.fields).toEqual({ name: "mismatch", address: "mismatch", phone: "match" });
  });
  it("does not call a directory's own phone or address a mismatch (text only, no structured business)", () => {
    const html = page("<footer>Support 800-555-1111, 500 Market St, San Francisco, CA 94105</footer><p>Ace Dental and Co 217-555-0142 1234 Main St Ste 5 Springfield IL 62701</p>");
    expect(compareNap(html, profile).result).toBe("match");
    const other = page("<footer>Support 800-555-1111, 500 Market St, San Francisco, CA 94105</footer><p>Nothing here</p>");
    expect(compareNap(other, profile)).toEqual({ result: "not_found", fields: { name: "not_found", address: "not_found", phone: "not_found" } });
  });
  it("needs the street number and postcode together, not just the words", () => {
    const html = page("<p>Ace Dental and Co. Main Street Springfield IL. Phone 217-555-0142. Open 9 to 5. Zip 62701 is nearby, number 1234 elsewhere</p><div>" + "x ".repeat(40) + "</div>");
    expect(compareNap(html, profile).fields.address).toBe("not_found");
  });
  it("handles UK, Canadian and Indian shapes", () => {
    const uk = { name: "Thames Physio", address: "12 High Street, London, SW1A 1AA, GB", phone: "+44 20 7946 0958" };
    expect(compareNap(page("Thames Physio, 12 High St, London SW1A 1AA. Tel 020 7946 0958"), uk).result).toBe("match");
    const ca = { name: "Maple Dental", address: "55 Queen St W, Toronto, ON M5H 2M9, CA", phone: "+1 416-555-0100" };
    expect(compareNap(page("Maple Dental 55 Queen Street West Toronto ON M5H 2M9 (416) 555-0100"), ca).result).toBe("match");
    const inn = { name: "Bhopal Physio", address: "Shop 5, MG Road, Bhopal, MP 462001, IN", phone: "+91 98765 43210" };
    expect(compareNap(page("Bhopal Physio - Shop 5, MG Road, Bhopal 462001 - 098765 43210"), inn).result).toBe("match");
  });
  it("skips fields the profile does not have, and needs the name", () => {
    const nameOnly = { name: "Ace Dental & Co.", address: null, phone: null };
    expect(compareNap(page("Ace Dental and Co"), nameOnly)).toEqual({ result: "match", fields: { name: "match" } });
    expect(compareNap(page("217-555-0142 1234 Main St Ste 5 Springfield IL 62701"), profile).result).toBe("not_found");
  });
  it("survives broken json-ld and empty pages", () => {
    expect(compareNap(page("", `<script type="application/ld+json">{oops</script>`), profile).result).toBe("not_found");
    expect(compareNap("", profile).result).toBe("not_found");
  });
});
