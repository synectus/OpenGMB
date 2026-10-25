/**
 * Evidence checklist a new suspension case starts with. The first four items are the evidence
 * Google's appeal tool names ("Official business registration, a business license, tax
 * certificates, utility bills ... check that the business name and address match the profile").
 * The rest are our additions (photos, video, website consistency); Google does not list them there.
 * Appeals are manual (project spec section 4) and Google allows ONE per decision ("Appeals can
 * only be submitted once"), so a case moves open -> appealed -> reinstated | closed_lost with no
 * second appeal. Nothing here submits anything to Google.
 * Source: https://support.google.com/business/answer/4569145 (verified 2026-10-13).
 */
export const SUSPENSION_CHECKLIST = [
  { key: "business_registration", label: "Official business registration" },
  { key: "business_license", label: "Business licence" },
  { key: "tax_certificate", label: "Tax certificate" },
  {
    key: "utility_bill",
    label: "Utility bill for the business (name and address match the profile)",
  },
  { key: "storefront_photo", label: "Storefront photo (exterior, address visible)" },
  { key: "signage_photo", label: "Signage photo (business name visible)" },
  { key: "interior_photo", label: "Interior or reception photo" },
  { key: "video_walkthrough", label: "Video walkthrough of the premises" },
  { key: "website_match", label: "Website shows the same name, address and phone" },
  {
    key: "profile_matches_guidelines",
    label: "Profile name, categories and hours checked against the guidelines",
  },
] as const;

/**
 * Where "Google's reinstatement form" points. Google's help page for suspended profiles, which
 * describes the appeal and links the reinstatement request. Re-open it and bump `verifiedOn`;
 * replace `url` if Google publishes a direct form URL.
 * Source: https://support.google.com/business/answer/4569145 (verified 2026-10-13, as the checklist above).
 */
export const SUSPENSION_APPEAL = {
  url: "https://support.google.com/business/answer/4569145",
  verifiedOn: "2026-10-13",
} as const;
