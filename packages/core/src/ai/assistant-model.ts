import { AI_DEFAULTS, type AiModelId } from "../config/ai-models";
import { CoreError } from "../errors";
import { aiEnv } from "./model";

/** A content block as the Messages API sends and expects it (text, tool_use, tool_result, thinking ...). */
export type ChatBlock = { type: string; [k: string]: unknown };
export type ChatMessage = { role: "user" | "assistant"; content: string | ChatBlock[] };
export type ChatTool = { name: string; description: string; input_schema: Record<string, unknown> };

export type ChatRequest = {
  model: AiModelId;
  system: string;
  messages: ChatMessage[];
  tools: ChatTool[];
  maxTokens: number;
  /** Per-call timeout, ms. */
  timeoutMs: number;
};
export type ChatResponse = {
  /** The assistant's content blocks exactly as returned: they are sent back unchanged on the next call. */
  content: ChatBlock[];
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
};
export type AiChatModel = (req: ChatRequest) => Promise<ChatResponse>;

let testModel: AiChatModel | null = null;
/** Tests only: a fake chat model. Pass null to restore. */
export function setAssistantTestModel(m: AiChatModel | null): void {
  testModel = m;
}

/** The chat model, or null when this server has no key. Never logs or returns the key. */
export function getAssistantModel(env: Record<string, string | undefined> = aiEnv()): AiChatModel | null {
  if (testModel) return testModel;
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key ? (req) => callAnthropicChat(key, req) : null;
}

/**
 * Anthropic Messages API with tools, over fetch (same approach as ai/model.ts). Errors carry the HTTP
 * status only, never the body. Effort is low: this is chat plus tool routing, not hard reasoning.
 */
async function callAnthropicChat(key: string, req: ChatRequest): Promise<ChatResponse> {
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
        messages: req.messages,
        tools: req.tools,
        tool_choice: { type: "auto" },
        output_config: { effort: "low" },
      }),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch {
    throw new CoreError("CONFLICT", "The AI service could not be reached. Try again.");
  }
  if (!res.ok) {
    throw new CoreError("CONFLICT", `The AI service answered with an error (HTTP ${res.status}).`);
  }
  const body = (await res.json()) as {
    content?: ChatBlock[];
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  return {
    content: body.content ?? [],
    stopReason: body.stop_reason ?? null,
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
  };
}
