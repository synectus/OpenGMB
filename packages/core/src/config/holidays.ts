import type { MarketCode } from "./writing-style";

/**
 * Occasions a post can hang on, per market (the market comes from the workspace time zone, as in
 * config/writing-style.ts). A short dated list on purpose: it is a prompt hint, not a calendar.
 *
 * Every date here is either fixed by rule (a calendar date, "Nth weekday of a month") or computed
 * (Easter, by the computus). The weekday rules were checked against the 2026 and 2027 calendars on
 * 2026-10-21. Lunar and lunisolar festivals (Diwali, Holi, Eid, Hanukkah ...) are NOT here: their
 * dates could not be confirmed from a published calendar when this was written. Add them from a
 * source with its URL once confirmed.
 * Sources: https://www.timeanddate.com/holidays/us/ , /australia/ , /india/ (official public-holiday
 * lists), US federal holidays https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/ .
 *
 * The list ends at HOLIDAYS_COVER_UNTIL. After that date the drafts simply get no occasion, so extend
 * the list before then.
 */
export const HOLIDAYS_COVER_UNTIL = "2027-05-31";
/** Only occasions in the next 60 days are offered (our choice: a post needs lead time, not a year). */
export const HOLIDAY_WINDOW_DAYS = 60;

export type Holiday = { date: string; name: string };

export const HOLIDAYS: Record<MarketCode, readonly Holiday[]> = {
  us: [
    { date: "2026-10-31", name: "Halloween" },
    { date: "2026-11-11", name: "Veterans Day" },
    { date: "2026-11-26", name: "Thanksgiving" },
    { date: "2026-11-27", name: "Black Friday" },
    { date: "2026-11-28", name: "Small Business Saturday" },
    { date: "2026-12-24", name: "Christmas Eve" },
    { date: "2026-12-25", name: "Christmas Day" },
    { date: "2026-12-31", name: "New Year's Eve" },
    { date: "2027-01-01", name: "New Year's Day" },
    { date: "2027-01-18", name: "Martin Luther King Jr. Day" },
    { date: "2027-02-14", name: "Valentine's Day" },
    { date: "2027-02-15", name: "Presidents' Day" },
    { date: "2027-03-17", name: "St Patrick's Day" },
    { date: "2027-03-28", name: "Easter Sunday" },
    { date: "2027-05-09", name: "Mother's Day" },
    { date: "2027-05-31", name: "Memorial Day" },
  ],
  au: [
    { date: "2026-11-03", name: "Melbourne Cup Day" },
    { date: "2026-11-11", name: "Remembrance Day" },
    { date: "2026-11-27", name: "Black Friday" },
    { date: "2026-12-24", name: "Christmas Eve" },
    { date: "2026-12-25", name: "Christmas Day" },
    { date: "2026-12-26", name: "Boxing Day" },
    { date: "2026-12-31", name: "New Year's Eve" },
    { date: "2027-01-01", name: "New Year's Day" },
    { date: "2027-01-26", name: "Australia Day" },
    { date: "2027-02-14", name: "Valentine's Day" },
    { date: "2027-03-26", name: "Good Friday" },
    { date: "2027-03-28", name: "Easter Sunday" },
    { date: "2027-03-29", name: "Easter Monday" },
    { date: "2027-04-25", name: "Anzac Day" },
    { date: "2027-05-09", name: "Mother's Day" },
  ],
  in: [
    { date: "2026-11-14", name: "Children's Day" },
    { date: "2026-12-25", name: "Christmas Day" },
    { date: "2026-12-31", name: "New Year's Eve" },
    { date: "2027-01-01", name: "New Year's Day" },
    { date: "2027-01-14", name: "Makar Sankranti" },
    { date: "2027-01-26", name: "Republic Day" },
    { date: "2027-02-14", name: "Valentine's Day" },
    { date: "2027-03-08", name: "International Women's Day" },
  ],
};

const DAY_MS = 86_400_000;

/**
 * The market's occasions from `today` (a YYYY-MM-DD in the workspace's time zone) up to and including
 * the 60th day after it, soonest first.
 */
export function upcomingHolidays(market: MarketCode, today: string, days = HOLIDAY_WINDOW_DAYS): Holiday[] {
  const start = Date.parse(`${today}T00:00:00Z`);
  return HOLIDAYS[market]
    .filter((h) => {
      const d = (Date.parse(`${h.date}T00:00:00Z`) - start) / DAY_MS;
      return d >= 0 && d <= days;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
