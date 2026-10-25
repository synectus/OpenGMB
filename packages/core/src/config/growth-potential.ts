/**
 * Externally-owned numbers behind the "Growth potential" estimate on a rank-tracking run (K6).
 * Logic reads these, never repeats the literals. Re-verify against the source and bump `verifiedOn`.
 *
 * Shares are percentages of ALL clicks on a results page, by Local Pack position, from one study:
 * BrightLocal "Local Services Ads click study", published 2018-10-19, 5,500+ testers recruited on
 * Amazon Mechanical Turk, half saw the page without Local Services Ads (the "without LSAs" column,
 * the closer match to a normal search).
 * https://www.brightlocal.com/research/local-services-ads-click-study/ (fetched 2026-10-24)
 *
 * Caveats we accept and show in the UI ("Estimate, not a promise"):
 * - Paid testers, one study, 2018, five business types. It is the only primary source we found that
 *   reports per-position local pack clicks. Secondary sources disagree (a 2026 compilation gives
 *   about 17.6 / 15.4 / 15.1 for positions 1 to 3; unverified, not used).
 * - It reports nothing below position 3. Clicks on "More places" (the Local Finder) are roughly 8%
 *   in one unverified secondary compilation with no per-position split, so ranks 4 and worse (and
 *   "not found") count as 0 here: the pack is the only place we have a measured share.
 * - The estimate multiplies the gap by the location's own actions from ALL searches, not by the
 *   actions this one keyword could drive. The location's actions already include the share it has
 *   today, so the true pool is larger than its actions (that pushes the estimate down), while
 *   one keyword is only part of its searches (that pushes it up). We cannot size either, so the
 *   result is a wide range and is labelled an estimate.
 * - SOCi's claim that the 3-pack gets 126% more traffic and 93% more actions than positions 4 to 10
 *   is vendor marketing; we could not open the primary report, so it is not used.
 * - Local Falcon's SoLV counts how often a business is in the top 3 across the grid and gives no
 *   traffic or call estimate (https://www.localfalcon.com/knowledge-base/kb32-what-is-solv-how-to-interpret-and-use-the-metric,
 *   page updated 2025-11-20), so there is no vendor formula to copy: we anchor on the location's own
 *   stored Performance API numbers instead of an invented search volume.
 */
const SOURCE_URL = "https://www.brightlocal.com/research/local-services-ads-click-study/";
const VERIFIED_ON = "2026-10-24";

export const GROWTH_POTENTIAL_CONFIG = {
  /** Share of all result-page clicks, in percent, by Local Pack position (without Local Services Ads). */
  packClickSharePercent: {
    1: { value: 17.3, sourceUrl: SOURCE_URL, verifiedOn: VERIFIED_ON },
    2: { value: 12.0, sourceUrl: SOURCE_URL, verifiedOn: VERIFIED_ON },
    3: { value: 2.9, sourceUrl: SOURCE_URL, verifiedOn: VERIFIED_ON },
  },
  /**
   * Share for rank 4 or worse and for "not found". Our own conservative choice (the study reports
   * no position past 3), so there is no source URL.
   */
  outsidePackSharePercent: 0,
  /** Days of stored Performance API data the estimate is anchored on (one month). */
  periodDays: 30,
} as const;
