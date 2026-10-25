import "server-only";
import { cache } from "react";
import { makeTimeFormat, type TimeFormatData } from "./time-format";
import { currentScope, scopeData } from "./scope-server";

/** The zones and the page's client for this request (also what the layout hands to the client provider). */
export const timeFormatData = cache(async (urlWs?: string): Promise<TimeFormatData> => {
  const [data, scope] = await Promise.all([scopeData(), currentScope(urlWs)]);
  return {
    zones: data.workspaces.map((w) => ({ id: w.id, timeZone: w.timeZone ?? "UTC", dateFormat: w.dateFormat ?? "YYYY-MM-DD" })),
    workspaceId: scope.workspaceId ?? scope.onlyWorkspaceId,
  };
});

/** The formatter for this request. Pass the page's `sp.ws` when it takes one, like currentScope. */
export async function getTimeFormat(urlWs?: string) {
  return makeTimeFormat(await timeFormatData(urlWs));
}
