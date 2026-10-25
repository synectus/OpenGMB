export type OrgDomain = { host: string | null; senderEmail: string | null; senderVerified: boolean; dnsTarget: string | null };

/** Community edition: one address, set by the person who runs the server. */
export async function getOrgDomain(): Promise<OrgDomain | null> {
  return null;
}
