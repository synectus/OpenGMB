import { DFS_ERROR_CLASSES } from "../config/geogrid";
import { AI_VISIBILITY, type AiEngine } from "../config/ai-visibility";
import { DfsAccountError, DfsHttpError, DfsRetryableError } from "../geogrid/drivers/errors";
import { dataForSeoBaseUrl, platformDataForSeoCredentials } from "../geogrid/drivers/source";

export type AskContext = { locationCode: number; countryIso: string; business: string };
export type Asked = { result: unknown; costUsd: number };

/** One prompt to one engine. Throws DfsAccountError (our account) or DfsRetryableError; an unusable answer comes back with result null. */
export type AiTransport = {
  ask(engine: AiEngine, prompt: string, ctx: AskContext): Promise<Asked>;
};

const OK = 20000;

/** The request body per engine (field names per the docs in AI_VISIBILITY.engines[*].docsUrl, checked 2026-10-24). */
export function requestBody(engine: AiEngine, prompt: string, ctx: AskContext): Record<string, unknown> {
  const lang = AI_VISIBILITY.languageCode;
  switch (engine) {
    case "chatgpt":
      return { keyword: prompt, location_code: ctx.locationCode, language_code: lang, force_web_search: true };
    case "gemini":
      return { keyword: prompt, location_code: ctx.locationCode, language_code: lang };
    case "perplexity":
      return { user_prompt: prompt, model_name: AI_VISIBILITY.engines.perplexity.model, web_search_country_iso_code: ctx.countryIso };
    case "ai_overview":
      return { keyword: prompt, location_code: ctx.locationCode, language_code: lang, device: "mobile", depth: 10, load_async_ai_overview: true };
  }
}

/** Live transport on our DataForSEO key. Credentials never reach a message or a log. */
export function liveAiTransport(opts: { fetch?: typeof fetch } = {}): AiTransport {
  const doFetch = opts.fetch ?? globalThis.fetch;
  return {
    async ask(engine, prompt, ctx) {
      const creds = await platformDataForSeoCredentials();
      if (!creds) throw new Error("DataForSEO login and password are not set");
      const res = await doFetch(`${dataForSeoBaseUrl()}${AI_VISIBILITY.engines[engine].path}`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${creds.login}:${creds.password}`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify([requestBody(engine, prompt, ctx)]),
        signal: AbortSignal.timeout(AI_VISIBILITY.timeoutMs),
      });
      const json = (await res.json().catch(() => null)) as {
        status_code?: number;
        status_message?: string;
        tasks?: { status_code?: number; cost?: number; result?: unknown[] | null }[];
      } | null;
      if (res.status === 401 || res.status === 402) throw new DfsAccountError(res.status, json?.status_message ?? "");
      if (!res.ok) throw new DfsHttpError(res.status);
      const code = json?.status_code;
      if (typeof code === "number" && (DFS_ERROR_CLASSES.account as readonly number[]).includes(code)) throw new DfsAccountError(code, json?.status_message ?? "");
      if (typeof code === "number" && (DFS_ERROR_CLASSES.retryable as readonly number[]).includes(code)) throw new DfsRetryableError(code, json?.status_message ?? "");
      const task = json?.tasks?.[0];
      const cost = typeof task?.cost === "number" ? task.cost : 0;
      return { result: task?.status_code === OK ? (task.result?.[0] ?? null) : null, costUsd: cost };
    },
  };
}

/**
 * Offline transport (no key set, and every test): answers in the documented response shapes. The answer to a prompt names
 * the business for one prompt in three and always names two sample competitors, so the trend and the competitor list have data.
 */
/** The sample competitors the offline transport names; the runner counts them as known only for fixture data. */
export const FIXTURE_COMPETITORS = ["Sample Competitor One", "Sample Competitor Two"] as const;

export function fixtureAiTransport(): AiTransport {
  return {
    async ask(engine, prompt, ctx) {
      const named = [...prompt].reduce((s, c) => s + c.charCodeAt(0), 0) % 3 !== 0;
      const names = named ? [ctx.business, ...FIXTURE_COMPETITORS] : [...FIXTURE_COMPETITORS];
      const text = `Top picks: ${names.map((n, i) => `${i + 1}. ${n}`).join("; ")}.`;
      const sources = [{ title: "Sample Directory", domain: "directory.example", url: "https://directory.example/best" }];
      switch (engine) {
        case "chatgpt":
        case "gemini":
          return { costUsd: 0, result: { items: [{ type: `${engine === "chatgpt" ? "chat_gpt" : "gemini"}_text`, markdown: text, sources }] } };
        case "perplexity":
          return {
            costUsd: 0,
            result: { model_name: "sonar", web_search: true, items: [{ type: "message", sections: [{ type: "text", text, annotations: sources.map((s) => ({ title: s.title, url: s.url })) }] }] },
          };
        case "ai_overview":
          return {
            costUsd: 0,
            result: { item_types: ["ai_overview"], items: [{ type: "ai_overview", items: [{ type: "ai_overview_element", text }], references: sources.map((s) => ({ source: s.title, domain: s.domain, url: s.url, title: s.title })) }] },
          };
      }
    },
  };
}
