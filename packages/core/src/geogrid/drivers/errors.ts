/** Errors a DataForSEO transport throws. None of them carries a credential. */

/** A non-2xx HTTP answer (other than 401/402, which are account errors). */
export class DfsHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "DfsHttpError";
  }
}

/** The account itself is the problem (not authorised, no funds, paused, cost limit, IP not whitelisted). Retrying cannot fix it. */
export class DfsAccountError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`DataForSEO ${code} ${message}`.trim());
    this.name = "DfsAccountError";
  }
}

/** Rate limit or a temporary DataForSEO fault: worth retrying (task_get only; task_post is never retried). */
export class DfsRetryableError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`DataForSEO ${code} ${message}`.trim());
    this.name = "DfsRetryableError";
  }
}

/** The task exists but has no result yet (40601 handed, 40602 in queue). Not a failure. */
export class DfsNotReadyError extends Error {
  constructor(readonly code: number) {
    super(`DataForSEO task not ready (${code})`);
    this.name = "DfsNotReadyError";
  }
}
