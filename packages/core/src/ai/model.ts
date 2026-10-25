import { AI_DEFAULTS, type AiModelId } from "../config/ai-models";
import { CoreError } from "../errors";
import { integrationEnv } from "../integrations";

export type AiRequest = {
  model: AiModelId;
  system: string;
  user: string;
  maxTokens: number;
};
export type AiResponse = { text: string; inputTokens: number; outputTokens: number };
export type AiModel = (req: AiRequest) => Promise<AiResponse>;

export const AI_NOT_SET_UP = "AI is not set up on this server";

type Env = Record<string, string | undefined>;
let override: { model?: AiModel; env?: Env } = {};
/** Tests only: a fake model and/or an injected env (cap, key). Pass {} to restore. */
export function setAiTestOverrides(o: { model?: AiModel; env?: Env }): void {
  override = o;
}
/** The env the AI code reads: injected in tests, otherwise process.env with in-app integration keys filled in. */
export function aiEnv(): Env {
  return override.env ?? integrationEnv();
}

/**
 * The model to call, or null when this server has no key. Never logs or returns the key; prompts and
 * outputs are never logged or placed in error messages.
 */
export function getAiModel(env: Env = aiEnv()): AiModel | null {
  if (override.model) return override.model;
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  return (req) => callAnthropic(key, req);
}

export function aiIsOn(env: Env = aiEnv()): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

/** Anthropic Messages API over fetch. Errors carry the HTTP status only, never the body. */
async function callAnthropic(key: string, req: AiRequest): Promise<AiResponse> {
  let res: Response;
  try {
    res = await fetch(AI_DEFAULTS.apiUrl, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": AI_DEFAULTS.anthropicVersion,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: { effort: "low" },
      }),
      signal: AbortSignal.timeout(AI_DEFAULTS.requestTimeoutMs),
    });
  } catch {
    throw new CoreError("CONFLICT", "The AI service could not be reached. Try again.");
  }
  if (!res.ok) {
    throw new CoreError("CONFLICT", `The AI service answered with an error (HTTP ${res.status}).`);
  }
  const body = (await res.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const inputTokens = body.usage?.input_tokens ?? 0;
  const outputTokens = body.usage?.output_tokens ?? 0;
  // A refusal has no text: it is metered, then the empty draft is blocked by the guardrails (U.empty).
  const text = (body.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  return { text, inputTokens, outputTokens };
}
