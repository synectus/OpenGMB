import { describe, expect, it } from "vitest";
import { AI_ENGINES, AI_VISIBILITY, checkCostUsd } from "../config/ai-visibility";
import { buildPrompts } from "./prompts";
import { answerOf, parseAnswer } from "./parse";
import { liveAiTransport, requestBody } from "./transport";

// Fixtures copied from the documented response shapes (docs.dataforseo.com, checked 2026-10-24).
const chatgpt = { items: [{ type: "chat_gpt_text", markdown: "1. Acme Dental is a top pick.\n2. Bright Smiles Clinic is also good.", sources: [{ title: "Yelp", domain: "www.yelp.com", url: "https://www.yelp.com/biz/acme" }] }] };
const gemini = { items: [{ type: "gemini_text", markdown: "Try Bright Smiles Clinic.", original_text: "Try Bright Smiles Clinic.", sources: [{ title: "x", domain: "example.org", url: "https://example.org/a" }] }] };
const perplexity = { model_name: "sonar", web_search: true, items: [{ type: "message", sections: [{ type: "text", text: "Acme Dental and City Dentists.", annotations: [{ title: "Doc", url: "https://docs.example.net/p", start_index: null, end_index: null, text: null }] }] }] };
const overview = {
  item_types: ["organic", "ai_overview"],
  items: [
    { type: "organic", title: "Not the overview", description: "Acme Dental appears here only" },
    { type: "ai_overview", items: [{ type: "ai_overview_element", text: "City Dentists are well reviewed." }], references: [{ source: "S", domain: "ref.example", url: "https://ref.example/x", title: "T", text: "ref text" }] },
  ],
};

describe("K5 cost", () => {
  it("is prompts x the sum of the engines' unit prices, read from config", () => {
    const unit = AI_ENGINES.reduce((s, e) => s + AI_VISIBILITY.engines[e].unitUsd, 0);
    expect(checkCostUsd(AI_ENGINES)).toBeCloseTo(AI_VISIBILITY.promptsPerCheck * unit, 10);
    expect(checkCostUsd(AI_ENGINES)).toBeCloseTo(0.0678, 4);
    expect(checkCostUsd(["chatgpt"], 1)).toBe(0.004);
  });
  it("every engine price carries a source url and a verified date", () => {
    for (const e of AI_ENGINES) {
      expect(AI_VISIBILITY.engines[e].sourceUrl).toMatch(/^https:\/\//);
      expect(AI_VISIBILITY.engines[e].verifiedOn).toBe("2026-10-24");
    }
  });
});

describe("K5 prompts", () => {
  it("starts with best <category> in <city>, then tracked keywords, without duplicates", () => {
    expect(buildPrompts({ category: "dentist", city: "Austin", keywords: ["emergency dentist", "dentist Austin"] })).toEqual([
      "best dentist in Austin",
      "best emergency dentist in Austin",
      "dentist Austin",
    ]);
  });
  it("falls back to extra phrasings and respects the limit", () => {
    expect(buildPrompts({ category: "dentist", city: "Austin", keywords: [] })).toHaveLength(3);
    expect(buildPrompts({ category: "dentist", city: "Austin", keywords: [] }, 1)).toEqual(["best dentist in Austin"]);
    expect(buildPrompts({ category: "", city: "", keywords: [] })).toEqual([]);
  });
});

describe("K5 parse", () => {
  const known = ["Bright Smiles Clinic", "City Dentists", "Other Place"];
  it("canary: the chatgpt fixture is read as mentioned, position 1, with the competitor and the cited domain", () => {
    const a = answerOf("chatgpt", chatgpt);
    expect(a.text).toContain("Acme Dental");
    const p = parseAnswer(a, "Acme Dental", known);
    expect(p).toMatchObject({ mentioned: true, position: 1, competitors: ["Bright Smiles Clinic"], sourceDomains: ["yelp.com"] });
  });
  it("position counts competitors named before the business", () => {
    const p = parseAnswer(answerOf("gemini", gemini), "Acme Dental", known);
    expect(p).toMatchObject({ mentioned: false, position: null, competitors: ["Bright Smiles Clinic"] });
    const q = parseAnswer({ text: "Bright Smiles Clinic first, then Acme Dental.", domains: [] }, "Acme Dental", known);
    expect(q).toMatchObject({ mentioned: true, position: 2 });
  });
  it("reads perplexity sections and annotation urls", () => {
    const p = parseAnswer(answerOf("perplexity", perplexity), "Acme Dental", known);
    expect(p).toMatchObject({ mentioned: true, competitors: ["City Dentists"], sourceDomains: ["docs.example.net"] });
  });
  it("reads only the ai_overview item of a SERP, not the organic results", () => {
    const a = answerOf("ai_overview", overview);
    expect(a.text).not.toContain("Acme Dental");
    expect(parseAnswer(a, "Acme Dental", known)).toMatchObject({ mentioned: false, competitors: ["City Dentists"] });
    expect(a.domains).toContain("ref.example");
  });
  it("matches names as whole words and ignores punctuation, and truncates the excerpt", () => {
    expect(parseAnswer({ text: "Acme-Dental, Inc.", domains: [] }, "Acme Dental", []).mentioned).toBe(true);
    expect(parseAnswer({ text: "Acme Dentalcare", domains: [] }, "Acme Dental", []).mentioned).toBe(false);
    expect(parseAnswer({ text: "x".repeat(5000), domains: [] }, "Acme", []).excerpt).toHaveLength(AI_VISIBILITY.excerptChars);
  });
  it("an empty answer is not a mention", () => {
    expect(answerOf("chatgpt", null)).toEqual({ text: "", domains: [] });
    expect(parseAnswer({ text: "", domains: [] }, "Acme Dental", known).mentioned).toBe(false);
  });
});

describe("K5 requests", () => {
  const ctx = { locationCode: 2356, countryIso: "IN", business: "Acme" };
  it("builds each engine's documented body", () => {
    expect(requestBody("chatgpt", "p", ctx)).toEqual({ keyword: "p", location_code: 2356, language_code: "en", force_web_search: true });
    expect(requestBody("gemini", "p", ctx)).toEqual({ keyword: "p", location_code: 2356, language_code: "en" });
    expect(requestBody("perplexity", "p", ctx)).toEqual({ user_prompt: "p", model_name: "sonar", web_search_country_iso_code: "IN" });
    expect(requestBody("ai_overview", "p", ctx)).toMatchObject({ keyword: "p", load_async_ai_overview: true, location_code: 2356 });
  });
  it("the live transport posts to the engine's path with Basic auth and reports the cost, never calling out in tests", async () => {
    const calls: { url: string; body: string; auth: string }[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body), auth: (init.headers as Record<string, string>).authorization! });
      return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, cost: 0.004, result: [chatgpt] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    process.env.DATAFORSEO_LOGIN = "login";
    process.env.DATAFORSEO_PASSWORD = "secret";
    const t = liveAiTransport({ fetch: fetchStub });
    const r = await t.ask("chatgpt", "best dentist in Austin", ctx);
    expect(r).toEqual({ result: chatgpt, costUsd: 0.004 });
    expect(calls[0]!.url).toContain(AI_VISIBILITY.engines.chatgpt.path);
    expect(calls[0]!.auth.startsWith("Basic ")).toBe(true);
  });
});
