import { DATAFORSEO_ENDPOINTS, DFS_ERROR_CLASSES } from "../../config/geogrid";
import { DfsAccountError, DfsHttpError, DfsRetryableError } from "./errors";
import type {
  DataForSeoTransport,
  DfsCredentialCheck,
  DfsProduct,
  DfsCredentials,
  DfsTaskGetResponse,
  DfsTaskPostResponse,
} from "./fixtures";

export type LiveDataForSeoOptions = {
  baseUrl: string;
  /** Resolved on every call, so a key entered or cleared while the server runs applies at once. */
  credentials: () => Promise<DfsCredentials | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const basic = (c: DfsCredentials) => `Basic ${Buffer.from(`${c.login}:${c.password}`).toString("base64")}`;

/** Map an HTTP or top-level DataForSEO error to a typed error; a good answer is returned as it came. */
function checked({ status, json }: { status: number; json: unknown }): unknown {
  const j = json as { status_code?: number; status_message?: string } | null;
  if (status === 401 || status === 402) throw new DfsAccountError(status, j?.status_message ?? "");
  if (status < 200 || status >= 300) throw new DfsHttpError(status);
  const code = j?.status_code;
  if (typeof code === "number") {
    if ((DFS_ERROR_CLASSES.account as readonly number[]).includes(code)) throw new DfsAccountError(code, j?.status_message ?? "");
    if ((DFS_ERROR_CLASSES.retryable as readonly number[]).includes(code)) throw new DfsRetryableError(code, j?.status_message ?? "");
  }
  return json;
}

/**
 * Live DataForSEO transport. Never puts the login or password in a message or a log: errors carry
 * the DataForSEO status code and text only.
 */
export function liveDataForSeoTransport(opts: LiveDataForSeoOptions): DataForSeoTransport {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const creds = await opts.credentials();
    if (!creds) throw new Error("DataForSEO login and password are not set");
    const res = await doFetch(`${opts.baseUrl}${path}`, {
      method,
      headers: {
        authorization: basic(creds),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  return {
    async checkCredentials(): Promise<DfsCredentialCheck> {
      try {
        const { status, json } = await call("GET", DATAFORSEO_ENDPOINTS.userData);
        const j = json as {
          status_code?: number;
          status_message?: string;
          tasks?: { status_code?: number; status_message?: string; result?: { money?: { balance?: number; limits?: { day?: { total_serp?: number; total?: number } } } }[] }[];
        } | null;
        if (status >= 400) return { ok: false, message: `DataForSEO answered HTTP ${status}` };
        const code = j?.tasks?.[0]?.status_code ?? j?.status_code;
        if (code !== 20000) {
          return { ok: false, message: `DataForSEO refused the credentials: ${code ?? "no status"} ${j?.tasks?.[0]?.status_message ?? j?.status_message ?? ""}`.trim() };
        }
        const money = j?.tasks?.[0]?.result?.[0]?.money;
        const day = money?.limits?.day;
        return {
          ok: true,
          message: "Ok.",
          balanceUsd: money?.balance,
          dailyLimitUsd: typeof day?.total === "number" ? day.total : null,
        };
      } catch (e) {
        return { ok: false, message: `DataForSEO could not be reached: ${e instanceof Error ? e.name : "error"}` };
      }
    },
    async taskPost(items, product: DfsProduct = "maps"): Promise<DfsTaskPostResponse> {
      const path = product === "organic" ? DATAFORSEO_ENDPOINTS.serpTaskPost : DATAFORSEO_ENDPOINTS.taskPost;
      return checked(await call("POST", path, items)) as DfsTaskPostResponse;
    },
    async taskGet(id, product: DfsProduct = "maps"): Promise<DfsTaskGetResponse> {
      const path = product === "organic" ? DATAFORSEO_ENDPOINTS.serpTaskGet : DATAFORSEO_ENDPOINTS.taskGet;
      return checked(await call("GET", `${path}${encodeURIComponent(id)}`)) as DfsTaskGetResponse;
    },
  };
}
