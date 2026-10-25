/**
 * Externally-owned numbers and facts for Business Profile edits. Logic must read these, never
 * repeat the literals. Re-verify against the source URL and bump `verifiedOn`.
 */
export const PROFILE_LIMITS = {
  /**
   * Business description length. 750 characters is the figure Synectus works to (the long-standing
   * Business Profile limit). NOT confirmed by either source fetched on 2026-10-13: the v1 `Profile`
   * schema says only "Required. Description of the location in your own voice" and the Help page
   * states no count. Counted in Unicode code points. If Google documents a different number, change it here.
   * Sources: https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations#Profile
   *          https://support.google.com/business/answer/3038177
   */
  descriptionMaxChars: {
    limit: 750,
    sourceUrl: "https://support.google.com/business/answer/3038177",
    verifiedOn: "2026-10-24",
  },
  /**
   * Description content: Help says "No links of any type are allowed" and that descriptions should
   * not focus on promotions, prices or sales. So U7.url (and email/hashtag) run on descriptions.
   * Source: https://support.google.com/business/answer/3038177
   */
  descriptionNoLinks: {
    sourceUrl: "https://support.google.com/business/answer/3038177",
    verifiedOn: "2026-10-24",
  },
  /**
   * PhoneNumbers: primary phone required, "up to two" additional phones; international format
   * preferred (e.g. "+1 415 555 0132"). Both fields must be sent together on update.
   * Source: https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations#PhoneNumbers
   */
  additionalPhonesMax: {
    limit: 2,
    sourceUrl:
      "https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations#PhoneNumbers",
    verifiedOn: "2026-10-13",
  },
  /**
   * ServiceItem description length (structured and free-form). 1000 is the figure `fields.ts` already
   * enforced; Google's ServiceItem page was not re-fetched when this was moved here.
   * Source: https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations#ServiceItem
   */
  serviceDescriptionMaxChars: {
    limit: 1000,
    sourceUrl:
      "https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations#ServiceItem",
    verifiedOn: "2026-10-19",
  },
  /** E.164: at most 15 digits. Lower bound is ours (shortest real national numbers are about 7). */
  phoneDigits: { min: 7, max: 15 },
  /**
   * SpecialHourPeriod must span less than 24 hours; endDate is at most 1 day after startDate; a
   * closed period ignores times. TimePeriod: close must be after open (same day or a later day);
   * valid times 00:00-24:00. Special hours cannot be set without regular hours.
   * Source: https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations#SpecialHourPeriod
   */
  hours: {
    maxSpecialSpanMinutes: 24 * 60,
    sourceUrl:
      "https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations#SpecialHourPeriod",
    verifiedOn: "2026-10-13",
  },
  /** ServiceAreaBusiness.places.placeInfos: "Limited to a maximum of 20 places." */
  serviceAreaMaxPlaces: {
    limit: 20,
    sourceUrl:
      "https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations#Places",
    verifiedOn: "2026-10-13",
  },
  /**
   * Top-level Location fields marked "Output only" that `getGoogleUpdated` can still name in its
   * diffMask. Observed live on 2026-10-18: diffMask "metadata,serviceItems" on an unchanged profile.
   * They are never consumer suggestions, so the watch ignores them.
   */
  outputOnlyDiffMaskFields: {
    list: ["metadata"],
    sourceUrl:
      "https://developers.google.com/my-business/reference/businessinformation/rest/v1/accounts.locations#Location",
    verifiedOn: "2026-10-18",
  },
  /** Fields requested from locations.get for a profile snapshot. */
  readMask:
    "name,title,profile,categories,regularHours,specialHours,serviceItems,serviceArea,websiteUri,openInfo,phoneNumbers,storeCode,storefrontAddress",
} as const;

/**
 * Most locations one profile change (profile.preview, profile.propose) may cover. Our own choice,
 * not a Google limit: a preview reads each location's profile live from Google and an apply writes
 * each one, so a change is kept to a batch the per-minute quotas can carry. Bigger selections are
 * made as several changes (the web picks the first batch and says so).
 */
export const PROFILE_BATCH_MAX_LOCATIONS = 100;
