/**
 * Legal batch B: who a review request email is from. The business's legal name and postal address
 * are required before the first send (CAN-SPAM, CASL, Spam Act; legal review Q20). Pure.
 */
export type SenderIdentity = {
  legalName: string | null;
  postalAddress: string | null;
  /** Company or ABN number, where the business has one. */
  companyNumber: string | null;
  phone: string | null;
  website: string | null;
};

export type WorkspaceSendingFacts = {
  id: string;
  senderLegalName: string | null;
  senderPostalAddress: string | null;
  senderCompanyNumber: string | null;
  senderPhone: string | null;
  senderWebsite: string | null;
  hipaaCoveredEntity: boolean;
};

export const settingsPath = (workspaceId: string) => `/settings/workspace?ws=${workspaceId}`;

export const identityOf = (w: WorkspaceSendingFacts): SenderIdentity => ({
  legalName: w.senderLegalName,
  postalAddress: w.senderPostalAddress,
  companyNumber: w.senderCompanyNumber,
  phone: w.senderPhone,
  website: w.senderWebsite,
});

export const identityComplete = (i: SenderIdentity) => Boolean(i.legalName?.trim() && i.postalAddress?.trim());

/** Why this client cannot send review requests, in plain words with the page to fix it, or null when it can. */
export function sendingBlock(w: WorkspaceSendingFacts): { reason: "hipaa" | "identity"; message: string } | null {
  if (w.hipaaCoveredEntity) {
    return {
      reason: "hipaa",
      message: `Review requests are not available for a HIPAA covered entity, because a patient list would be protected health information. Change this under "HIPAA covered entity" at ${settingsPath(w.id)} if it is not correct.`,
    };
  }
  if (!identityComplete(identityOf(w))) {
    return {
      reason: "identity",
      message: `Add the business's legal name and postal address before sending review requests. They appear in every email. Set them at ${settingsPath(w.id)}`,
    };
  }
  return null;
}

/** Reply auto-approve is never available to a HIPAA covered entity (legal review Q38). */
export const autoApproveAllowed = (w: { hipaaCoveredEntity: boolean }) => !w.hipaaCoveredEntity;
