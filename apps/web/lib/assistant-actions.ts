"use server";
import { headers } from "next/headers";
import {
  CoreError,
  loadActor,
  requireAuthenticatedUser,
  runAssistantTurn,
  type AssistantMessage,
  type AssistantResult,
} from "@opengmb/core";
import { getAuth, getDb } from "./auth";

export type AskResponse =
  { ok: true; data: AssistantResult } | { ok: false; error: { code: string; message: string } };

/**
 * "Ask SynGMB": one chat turn for the signed-in person. A hand-written server action (Next checks the
 * request origin), not a registry action, so it is not an MCP tool and no transaction spans a model call.
 * The conversation lives in the browser and is sent whole; nothing is stored here.
 */
export async function askSynGMB(workspaceId: string, messages: AssistantMessage[]): Promise<AskResponse> {
  try {
    const session = await getAuth().api.getSession({ headers: await headers() });
    const { userId } = requireAuthenticatedUser(session);
    const db = getDb();
    const actor = await loadActor(db, { userId, surface: "ui", actorType: "user" });
    return { ok: true, data: await runAssistantTurn(db, actor, { workspaceId, messages }) };
  } catch (e) {
    if (e instanceof CoreError) return { ok: false, error: { code: e.code, message: e.message } };
    console.error("[web] ask failed");
    return { ok: false, error: { code: "INTERNAL", message: "Internal error" } };
  }
}
