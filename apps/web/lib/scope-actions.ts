"use server";
import { scopeData } from "./scope-server";
import { scopeOptionFor, searchScopeOptions, type ScopeOption } from "./scope";

/** The scope switcher's list for a long account: one page of options matching `query` (H4). */
export async function findScopeOptions(query: string, offset: number): Promise<{ options: ScopeOption[]; more: boolean }> {
  const data = await scopeData();
  const from = Math.max(0, Math.floor(Number(offset)) || 0);
  return searchScopeOptions(data, String(query).slice(0, 100), from);
}

/** One option for a `?ws=` value the shell did not send (a group or location link on a long account). */
export async function scopeOptionForValue(value: string): Promise<ScopeOption | null> {
  return scopeOptionFor(await scopeData(), String(value).slice(0, 100));
}
