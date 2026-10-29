// apps/web/lib/scope-server.ts
import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import type { locationGroupsList, locationsList, workspacesList } from "@opengmb/core";
import { locationGroups_list, locations_list, workspaces_list } from "../app/_generated/actions";
import { SCOPE_COOKIE, resolveScope, type Scope, type ScopeData } from "./scope";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
const code = (e: { code: string; message: string }) => `${e.code}: ${e.message}`;

/**
 * The workspaces, groups and locations the user can see, read once per request (the layout and
 * the page share it). Never throws: runAction (lib/run-action.ts) turns every error into
 * { ok: false }, and a failed read leaves that list empty and sets `error`.
 */
export const scopeData = cache(async (): Promise<ScopeData & { error: string | null }> => {
  const [w, l, g] = await Promise.all([workspaces_list(), locations_list({}), locationGroups_list({})]);
  if (!w.ok) return { workspaces: [], groups: [], locations: [], error: code(w.error) };
  return {
    workspaces: (w.data as Handler<typeof workspacesList>).workspaces.map(({ id, name, timeZone, dateFormat }) => ({ id, name, timeZone, dateFormat })),
    locations: l.ok
      ? (l.data as Handler<typeof locationsList>).locations.map((x) => ({
          id: x.id,
          workspaceId: x.workspaceId,
          name: x.name,
          title: x.title,
          status: x.status,
          addressSummary: x.addressSummary,
          phone: x.phone,
        }))
      : [],
    groups: g.ok ? (g.data as Handler<typeof locationGroupsList>).groups : [],
    error: !l.ok ? code(l.error) : !g.ok ? code(g.error) : null,
  };
});

/**
 * The scope this request works in: the page's ?ws= (pass `sp.ws`), else the syngmb_scope cookie,
 * else All clients. Only ids the user can see are accepted. Layouts call it with no argument.
 */
export async function currentScope(urlWs?: string | string[]): Promise<Scope> {
  const [data, jar] = await Promise.all([scopeData(), cookies()]);
  return resolveScope(data, {
    url: Array.isArray(urlWs) ? urlWs[0] : urlWs,
    cookie: jar.get(SCOPE_COOKIE)?.value,
  });
}
