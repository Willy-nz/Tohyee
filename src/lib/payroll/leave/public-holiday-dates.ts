/**
 * New Zealand public holiday dates as dated data with their sources
 * (decision 22), like IRD's rates in P2. Holidays Act 2003 s 44(1) lists
 * them; s 45 and s 45A move Christmas, Boxing Day, New Year's Day,
 * 2 January, Waitangi Day and ANZAC Day off a weekend for an employee for
 * whom that weekend day wouldn't otherwise be a working day (worked out per
 * employee in public-holidays.ts). Anniversary days are as Employment NZ
 * publishes them as observed. Add each new year when Employment NZ
 * publishes it; a pay period touching a year that isn't here is refused.
 * Browser-safe.
 */

export const ANNIVERSARY_REGIONS = [
  "auckland",
  "taranaki",
  "hawkes_bay",
  "wellington",
  "marlborough",
  "nelson",
  "canterbury",
  "canterbury_south",
  "westland",
  "otago",
  "southland",
  "chatham_islands",
] as const;
export type AnniversaryRegion = (typeof ANNIVERSARY_REGIONS)[number];

export const ANNIVERSARY_REGION_LABELS: Record<AnniversaryRegion, string> = {
  auckland: "Auckland",
  taranaki: "Taranaki",
  hawkes_bay: "Hawke's Bay",
  wellington: "Wellington",
  marlborough: "Marlborough",
  nelson: "Nelson",
  canterbury: "Canterbury",
  canterbury_south: "Canterbury (South)",
  westland: "Westland",
  otago: "Otago",
  southland: "Southland",
  chatham_islands: "Chatham Islands",
};

/** How a holiday moves off a weekend: s 45 (Christmas to 2 January) or s 45A (Waitangi and ANZAC Day). */
export type Transfer = "s45" | "s45A" | null;

export type NationalHoliday = { key: string; name: string; date: string; transfer: Transfer };

export type PublicHolidayYear = {
  year: number;
  source: string;
  national: NationalHoliday[];
  anniversary: Record<AnniversaryRegion, string>;
};

const EMPLOYMENT_NZ = "https://www.employment.govt.nz/leave-and-holidays/public-holidays/public-holidays-and-anniversary-dates";
const EMPLOYMENT_NZ_PREVIOUS = "https://www.employment.govt.nz/leave-and-holidays/public-holidays/previous-years-public-holidays-and-anniversary-dates";

function national(year: number, easter: { goodFriday: string; easterMonday: string }, sovereign: string, matariki: string, labour: string): NationalHoliday[] {
  return [
    { key: "new_years_day", name: "New Year's Day", date: `${year}-01-01`, transfer: "s45" },
    { key: "day_after_new_years_day", name: "Day after New Year's Day", date: `${year}-01-02`, transfer: "s45" },
    { key: "waitangi_day", name: "Waitangi Day", date: `${year}-02-06`, transfer: "s45A" },
    { key: "good_friday", name: "Good Friday", date: easter.goodFriday, transfer: null },
    { key: "easter_monday", name: "Easter Monday", date: easter.easterMonday, transfer: null },
    { key: "anzac_day", name: "ANZAC Day", date: `${year}-04-25`, transfer: "s45A" },
    { key: "sovereigns_birthday", name: "King's Birthday", date: sovereign, transfer: null },
    { key: "matariki", name: "Matariki", date: matariki, transfer: null },
    { key: "labour_day", name: "Labour Day", date: labour, transfer: null },
    { key: "christmas_day", name: "Christmas Day", date: `${year}-12-25`, transfer: "s45" },
    { key: "boxing_day", name: "Boxing Day", date: `${year}-12-26`, transfer: "s45" },
  ];
}

/**
 * Read 2 Oct 2026 from Employment NZ's "Public holidays and anniversary
 * dates" (last modified 25 Sep 2026; 2026 and 2027) and "Previous years"
 * (2025) pages, through a summarising fetch tool, so check the pages; the
 * Matariki dates agree with Te Papa's list of the dates in Schedule 1 of
 * the Te Kāhui o Matariki Public Holiday Act 2022 (2025 20 Jun, 2026 10 Jul,
 * 2027 25 Jun).
 */
export const PUBLIC_HOLIDAY_YEARS: readonly PublicHolidayYear[] = [
  {
    year: 2025,
    source: EMPLOYMENT_NZ_PREVIOUS,
    national: national(2025, { goodFriday: "2025-04-18", easterMonday: "2025-04-21" }, "2025-06-02", "2025-06-20", "2025-10-27"),
    anniversary: {
      auckland: "2025-01-27",
      taranaki: "2025-03-10",
      hawkes_bay: "2025-10-24",
      wellington: "2025-01-20",
      marlborough: "2025-11-03",
      nelson: "2025-02-03",
      canterbury: "2025-11-14",
      canterbury_south: "2025-09-22",
      westland: "2025-12-01",
      otago: "2025-03-24",
      southland: "2025-04-22",
      chatham_islands: "2025-12-01",
    },
  },
  {
    year: 2026,
    source: EMPLOYMENT_NZ,
    national: national(2026, { goodFriday: "2026-04-03", easterMonday: "2026-04-06" }, "2026-06-01", "2026-07-10", "2026-10-26"),
    anniversary: {
      auckland: "2026-01-26",
      taranaki: "2026-03-09",
      hawkes_bay: "2026-10-23",
      wellington: "2026-01-19",
      marlborough: "2026-11-02",
      nelson: "2026-02-02",
      canterbury: "2026-11-13",
      canterbury_south: "2026-09-28",
      westland: "2026-11-30",
      otago: "2026-03-23",
      southland: "2026-04-07",
      chatham_islands: "2026-11-30",
    },
  },
  {
    year: 2027,
    source: EMPLOYMENT_NZ,
    national: national(2027, { goodFriday: "2027-03-26", easterMonday: "2027-03-29" }, "2027-06-07", "2027-06-25", "2027-10-25"),
    anniversary: {
      auckland: "2027-02-01",
      taranaki: "2027-03-08",
      hawkes_bay: "2027-10-22",
      wellington: "2027-01-25",
      marlborough: "2027-11-01",
      nelson: "2027-02-01",
      canterbury: "2027-11-12",
      canterbury_south: "2027-09-27",
      westland: "2027-11-29",
      otago: "2027-03-22",
      southland: "2027-03-30",
      chatham_islands: "2027-11-29",
    },
  },
];

export function publicHolidayYear(year: number): PublicHolidayYear | null {
  return PUBLIC_HOLIDAY_YEARS.find((entry) => entry.year === year) ?? null;
}

export function coveredYears(): string {
  const years = PUBLIC_HOLIDAY_YEARS.map((entry) => entry.year);
  return `${Math.min(...years)} to ${Math.max(...years)}`;
}
