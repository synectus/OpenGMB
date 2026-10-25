import "server-only";
import { executeAction, loadActor, type Branding } from "@opengmb/core";
import { getDb } from "./auth";

type Logos = { orgLogoFileId: string | null; workspaceLogos: { workspaceId: string; fileId: string }[] };

/** Where a stored file is served. The route checks the session and the tenant. */
export const fileSrc = (fileId: string) => `/api/files/${fileId}`;

/**
 * The caller's organization branding through branding.get; null when it cannot be loaded. An
 * uploaded agency logo replaces `logoUrl` (a same-origin path), and `clientLogoUrl` is the logo of
 * the caller's client when they are scoped to one (the portal).
 */
export async function brandingFor(userId: string): Promise<(Branding & { clientLogoUrl: string | null }) | null> {
  try {
    const db = getDb();
    const actor = await loadActor(db, { userId, surface: "ui", actorType: "user" });
    const out = (await executeAction(db, actor, "branding.get", {})) as { branding: Branding };
    const logos = (await executeAction(db, actor, "branding.logos", {})) as Logos;
    const client = actor.workspaceIds !== "all" && logos.workspaceLogos.length === 1 ? logos.workspaceLogos[0]! : null;
    return {
      ...out.branding,
      logoUrl: logos.orgLogoFileId ? fileSrc(logos.orgLogoFileId) : out.branding.logoUrl,
      clientLogoUrl: client ? fileSrc(client.fileId) : null,
    };
  } catch (e) {
    console.warn("[web] branding unavailable", e instanceof Error ? e.message : e);
    return null;
  }
}
