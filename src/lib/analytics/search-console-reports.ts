import { gaNumber } from "@/lib/analytics/google-analytics-reports";
import { isoDateAt } from "@/lib/dates";
import { ValidationError } from "@/lib/errors";
import { dec, roundHalfUp, toFixedString, toPlainString } from "@/lib/money/decimal";

/**
 * Google Search Console website search data in Analytics (#512, decisions
 * 1180-1189, examples GSC1-GSC9): which questions are asked of the Search
 * Console API's `searchanalytics.query`, over which days, and how each
 * answer becomes rows of a table in the organisation's analytics copy.
 * Pure, so it can be tested without Google.
 *
 * From Google's Search Console API pages (read 31 Oct 2026): dates are
 * Google's own days in Pacific time (America/Los_Angeles); `rowLimit` is 1
 * to 25,000 and `startRow` pages through the rest; at most 50,000 rows a
 * day per search type are given; `dataState: "all"` includes days still
 * being counted, and, grouped by date, says from which day
 * (`metadata.firstIncompleteDate`) values may still change; data usually
 * arrives 2-3 days late and Google keeps 16 months. Grouping by query or
 * page is the costly kind of question, and the cost grows with the dates
 * asked for, so those are asked one day at a time (Google's "Getting all
 * your data" guide).
 *
 * Browser-safe.
 */

/** Every Search Console table starts with this; other sources can't use it. */
export const GSC_TABLE_PREFIX = "google_search_console_";
/** How a Search Console load is recorded in the load history. */
export const GSC_LOAD_TABLE_NAME = "google_search_console_*";
export const GSC_SOURCE_NAME = "Google Search Console";

/** Google keeps 16 months of Search Console data. */
export const GSC_HISTORY_MONTHS = 16;
/** Today and the three days before it are fetched again on every load, as Google may still be counting them. */
export const GSC_SETTLE_DAYS = 3;
/** Rows asked for in one request: Google's most. */
export const GSC_ROW_LIMIT = 25_000;
/** Google gives at most 50,000 rows a day, so a day never needs more than a few pages; this stops a runaway. */
export const GSC_MAX_PAGES = 40;
/** Google's days are Pacific time. */
export const GSC_TIME_ZONE = "America/Los_Angeles";

export const GSC_SEARCH_TYPES = [
  { id: "web", label: "Web (the usual Google results)" },
  { id: "image", label: "Images" },
  { id: "video", label: "Videos" },
  { id: "news", label: "News tab" },
] as const;
export type GscSearchType = (typeof GSC_SEARCH_TYPES)[number]["id"];

export type GscColumnType = "DATE" | "VARCHAR" | "BIGINT" | "DECIMAL(18,2)" | "DECIMAL(18,6)" | "BOOLEAN";
export type GscColumn = {
  name: string;
  type: GscColumnType;
  /** Where the value comes from: a dimension's key (by position), a metric, or worked out. */
  from: "date" | "key" | "page_path" | "country" | "country_code" | "device" | "clicks" | "impressions" | "ctr" | "position" | "changing";
};
export type GscTable = {
  table: string;
  label: string;
  noun: string;
  description: string;
  /** Google's dimensions, date first. */
  dimensions: string[];
  /** Asked for one day at a time (queries and pages are the costly questions), or for the whole span at once. */
  perDay: boolean;
  columns: GscColumn[];
};

const date: GscColumn = { name: "date", type: "DATE", from: "date" };
const metrics: GscColumn[] = [
  { name: "clicks", type: "BIGINT", from: "clicks" },
  { name: "impressions", type: "BIGINT", from: "impressions" },
  { name: "click_rate", type: "DECIMAL(18,6)", from: "ctr" },
  { name: "average_position", type: "DECIMAL(18,2)", from: "position" },
  { name: "may_still_change", type: "BOOLEAN", from: "changing" },
];

/** What "average position" means, in plain words (Google's Performance report help). */
export const GSC_POSITION_TEXT =
  "Average position is where the site's highest link sat in Google's results, averaged over every time it was shown: 1 is the top result, 10 is usually the bottom of the first page. Lower is better.";
const COMMON = `Google's days (Pacific time). Impressions: times a link to the site was shown in Google's results; clicks: times someone clicked it; click rate: clicks divided by impressions. ${GSC_POSITION_TEXT} The newest days may still change.`;
const SAME = "Clicks, impressions, click rate and average position as in Website search by day.";

/** The tables loaded, one row per day and value. */
export const GSC_TABLES: GscTable[] = [
  {
    table: "google_search_console_daily",
    label: "Website search by day",
    noun: "days",
    description: `How the website did in Google search each day. ${COMMON}`,
    dimensions: ["date"],
    perDay: false,
    columns: [date, ...metrics],
  },
  {
    table: "google_search_console_queries",
    label: "Website search queries",
    noun: "query rows",
    description: `What people searched for when the site was shown, each day. Google leaves out searches made by very few people, to protect their privacy, so these add up to less than the daily totals. ${SAME}`,
    dimensions: ["date", "query"],
    perDay: true,
    columns: [date, { name: "query", type: "VARCHAR", from: "key" }, ...metrics],
  },
  {
    table: "google_search_console_pages",
    label: "Website search pages",
    noun: "page rows",
    description: `Which pages of the site were shown and clicked, each day (the full address, and its path for charts). Counted per page, so a search that showed two pages counts for both, and these can add up to more than the daily totals. ${SAME}`,
    dimensions: ["date", "page"],
    perDay: true,
    columns: [date, { name: "page", type: "VARCHAR", from: "key" }, { name: "page_path", type: "VARCHAR", from: "page_path" }, ...metrics],
  },
  {
    table: "google_search_console_countries",
    label: "Website search countries",
    noun: "country rows",
    description: `Where the people searching were, each day. ${SAME}`,
    dimensions: ["date", "country"],
    perDay: true,
    columns: [date, { name: "country", type: "VARCHAR", from: "country" }, { name: "country_code", type: "VARCHAR", from: "country_code" }, ...metrics],
  },
  {
    table: "google_search_console_devices",
    label: "Website search devices",
    noun: "device rows",
    description: `Whether people searched on a computer, phone or tablet, each day. ${SAME}`,
    dimensions: ["date", "device"],
    perDay: true,
    columns: [date, { name: "device", type: "VARCHAR", from: "device" }, ...metrics],
  },
];

/** Whether a table is one of Search Console's own. */
export function isGscTable(name: string): boolean {
  return name.startsWith(GSC_TABLE_PREFIX);
}

/** The table's columns as DuckDB types, for loading. */
export function gscTableColumns(table: GscTable): Array<{ name: string; type: string }> {
  return table.columns.map((column) => ({ name: column.name, type: column.type }));
}

// Days --------------------------------------------------------------------------------------

function parts(day: string): [number, number, number] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ValidationError(`"${day.slice(0, 20)}" isn't a date.`);
  return day.split("-").map(Number) as [number, number, number];
}

function iso(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** The day `count` days after (or before, negative) `day`. */
export function gscAddDays(day: string, count: number): string {
  const [year, month, dayOfMonth] = parts(day);
  return iso(new Date(Date.UTC(year, month - 1, dayOfMonth + count)));
}

/** Today in Google's Search Console days (Pacific time). */
export function gscToday(now = new Date()): string {
  return isoDateAt(now, GSC_TIME_ZONE);
}

/**
 * The first day Google still has: 16 months before today, the day of the
 * month kept where the month has it (31 Oct 2026 gives 30 Jun 2025).
 */
export function gscHistoryStart(today: string): string {
  const [year, month, day] = parts(today);
  const first = new Date(Date.UTC(year, month - 1 - GSC_HISTORY_MONTHS, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, last));
  return iso(first);
}

/** Every day from `from` to `to`, both included. */
export function gscDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = gscAddDays(day, 1)) days.push(day);
  return days;
}

/**
 * The first day that may still change: today and the three days before
 * it, or from the day Google says is still being counted, whichever is
 * earlier (decision 1183).
 */
export function gscChangingFrom(today: string, firstIncompleteDate: string | null | undefined): string {
  const settled = gscAddDays(today, -GSC_SETTLE_DAYS);
  if (firstIncompleteDate && /^\d{4}-\d{2}-\d{2}$/.test(firstIncompleteDate) && firstIncompleteDate < settled) return firstIncompleteDate;
  return settled;
}

export type GscLoaded = { loadedThrough: string | null; changingFrom: string | null; tablesPresent: boolean };

/**
 * Which days a load asks Google for (decision 1182). The first load, or
 * one after the tables went missing, goes back as far as Google keeps
 * (16 months); after that only the days not loaded yet, and again the days
 * that might have changed since. Never before what Google still has.
 */
export function gscLoadWindow(today: string, loaded: GscLoaded): { from: string; to: string; first: boolean } {
  const start = gscHistoryStart(today);
  if (!loaded.loadedThrough || !loaded.tablesPresent) return { from: start, to: today, first: true };
  const next = gscAddDays(loaded.loadedThrough, 1);
  let from = loaded.changingFrom && loaded.changingFrom < next ? loaded.changingFrom : next;
  if (from < start) from = start;
  // Always at least today, so a second load on the same day still refreshes the changing days.
  if (from > today) from = today;
  return { from, to: today, first: false };
}

// Asking Google -----------------------------------------------------------------------------

/** The body of one `searchanalytics.query` request: a page of one table, for some days. */
export function gscRequestBody(table: GscTable, startDate: string, endDate: string, startRow: number, searchType: GscSearchType = "web") {
  return {
    startDate,
    endDate,
    dimensions: table.dimensions,
    type: searchType,
    dataState: "all",
    aggregationType: "auto",
    rowLimit: GSC_ROW_LIMIT,
    startRow,
  };
}

export type GscResponse = {
  rows?: Array<{ keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }>;
  responseAggregationType?: string;
  metadata?: { firstIncompleteDate?: string; firstIncompleteHour?: string };
};

/**
 * Every page of one question: `startRow` moves on by what came, and a page
 * with fewer rows than asked for is the last (decision 1182).
 */
export async function gscReadAllPages(fetchPage: (startRow: number) => Promise<GscResponse>): Promise<{ rows: NonNullable<GscResponse["rows"]>; firstIncompleteDate: string | null }> {
  const rows: NonNullable<GscResponse["rows"]> = [];
  let firstIncompleteDate: string | null = null;
  for (let page = 0, startRow = 0; ; page += 1) {
    if (page >= GSC_MAX_PAGES) throw new ValidationError("Google Search Console kept sending more pages than it should. The data already loaded is kept.");
    const answer = await fetchPage(startRow);
    const got = Array.isArray(answer.rows) ? answer.rows : [];
    const incomplete = answer.metadata?.firstIncompleteDate;
    if (typeof incomplete === "string" && (!firstIncompleteDate || incomplete < firstIncompleteDate)) firstIncompleteDate = incomplete;
    rows.push(...got);
    if (got.length < GSC_ROW_LIMIT) break;
    startRow += got.length;
  }
  return { rows, firstIncompleteDate };
}

// Turning answers into rows -----------------------------------------------------------------

/** Google's numbers arrive as JSON numbers; as text (the shortest form that's the same number) they become exact decimals. */
export function gscNumber(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(`Google Search Console sent a number Tohyee can't read: "${String(value).slice(0, 30)}".`);
  return gaNumber(String(value));
}

// ISO 3166-1: Google's three-letter country codes (lower case) and the two-letter codes names are found by.
const ALPHA3 =
  "abwAW afgAF agoAO aiaAI alaAX albAL andAD areAE argAR armAM asmAS ataAQ atfTF atgAG ausAU autAT azeAZ bdiBI belBE benBJ besBQ bfaBF bgdBD bgrBG bhrBH bhsBS bihBA blmBL blrBY blzBZ bmuBM bolBO braBR brbBB brnBN btnBT bvtBV bwaBW cafCF canCA cckCC cheCH chlCL chnCN civCI cmrCM codCD cogCG cokCK colCO comKM cpvCV criCR cubCU cuwCW cxrCX cymKY cypCY czeCZ deuDE djiDJ dmaDM dnkDK domDO dzaDZ ecuEC egyEG eriER eshEH espES estEE ethET finFI fjiFJ flkFK fraFR froFO fsmFM gabGA gbrGB geoGE ggyGG ghaGH gibGI ginGN glpGP gmbGM gnbGW gnqGQ grcGR grdGD grlGL gtmGT gufGF gumGU guyGY hkgHK hmdHM hndHN hrvHR htiHT hunHU idnID imnIM indIN iotIO irlIE irnIR irqIQ islIS isrIL itaIT jamJM jeyJE jorJO jpnJP kazKZ kenKE kgzKG khmKH kirKI knaKN korKR kwtKW laoLA lbnLB lbrLR lbyLY lcaLC lieLI lkaLK lsoLS ltuLT luxLU lvaLV macMO mafMF marMA mcoMC mdaMD mdgMG mdvMV mexMX mhlMH mkdMK mliML mltMT mmrMM mneME mngMN mnpMP mozMZ mrtMR msrMS mtqMQ musMU mwiMW mysMY mytYT namNA nclNC nerNE nfkNF ngaNG nicNI niuNU nldNL norNO nplNP nruNR nzlNZ omnOM pakPK panPA pcnPN perPE phlPH plwPW pngPG polPL priPR prkKP prtPT pryPY psePS pyfPF qatQA reuRE rouRO rusRU rwaRW sauSA sdnSD senSN sgpSG sgsGS shnSH sjmSJ slbSB sleSL slvSV smrSM somSO spmPM srbRS sspSS stpST surSR svkSK svnSI sweSE swzSZ sxmSX sycSC syrSY tcaTC tcdTD tgoTG thaTH tjkTJ tklTK tkmTM tlsTL tonTO ttoTT tunTN turTR tuvTV twnTW tzaTZ ugaUG ukrUA umiUM uryUY usaUS uzbUZ vatVA vctVC venVE vgbVG virVI vnmVN vutVU wlfWF wsmWS xkkXK yemYE zafZA zmbZM zweZW";
const COUNTRY_CODES = new Map(ALPHA3.split(" ").map((entry) => [entry.slice(0, 3), entry.slice(3)]));
let regionNames: Intl.DisplayNames | null | undefined;

/** Google's country code ("nzl") as the country's name ("New Zealand"); "zzz" (unknown) and anything else unknown as Unknown region. */
export function gscCountryName(code: string): string {
  const alpha2 = COUNTRY_CODES.get(code.toLowerCase());
  if (!alpha2) return "Unknown region";
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en-NZ"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  return regionNames?.of(alpha2) ?? alpha2;
}

/** A page's path ("/kitchens") from its full address, for short chart labels; anything that isn't an address as it came. */
export function gscPagePath(page: string): string {
  try {
    const url = new URL(page);
    return `${url.pathname}${url.search}` || "/";
  } catch {
    return page;
  }
}

/** Google's device ("MOBILE") in plain words ("Mobile"). */
export function gscDeviceName(device: string): string {
  const known: Record<string, string> = { DESKTOP: "Computer", MOBILE: "Mobile", TABLET: "Tablet" };
  return known[device.toUpperCase()] ?? (device ? device.charAt(0).toUpperCase() + device.slice(1).toLowerCase() : "Unknown");
}

function metric(column: GscColumn, value: unknown): string {
  const plain = gscNumber(value);
  if (column.type === "BIGINT") return toPlainString(roundHalfUp(dec(plain), 0));
  if (column.type === "DECIMAL(18,6)") return toFixedString(dec(plain), 6);
  return toFixedString(dec(plain), 2);
}

/**
 * One answer's rows as table rows, in the table's column order, with each
 * day on or after `changingFrom` marked as maybe still changing. A row
 * without the keys asked for is an error rather than a blank.
 */
export function gscRows(table: GscTable, rows: NonNullable<GscResponse["rows"]>, changingFrom: string): Array<Array<string | null>> {
  return rows.map((row) => {
    const keys = Array.isArray(row.keys) ? row.keys : [];
    if (keys.length !== table.dimensions.length || keys.some((key) => typeof key !== "string")) {
      throw new ValidationError(`Google Search Console sent a row Tohyee can't read for ${table.label.toLowerCase()}.`);
    }
    const day = keys[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || gscAddDays(day, 0) !== day) throw new ValidationError(`Google Search Console sent a date Tohyee can't read: "${day.slice(0, 20)}".`);
    return table.columns.map((column) => {
      switch (column.from) {
        case "date":
          return day;
        case "key":
          return keys[1].slice(0, 2000);
        case "page_path":
          return gscPagePath(keys[1]).slice(0, 2000);
        case "country":
          return gscCountryName(keys[1]);
        case "country_code":
          return keys[1].toLowerCase().slice(0, 3);
        case "device":
          return gscDeviceName(keys[1]);
        case "clicks":
          return metric(column, row.clicks ?? 0);
        case "impressions":
          return metric(column, row.impressions ?? 0);
        case "ctr":
          return metric(column, row.ctr ?? 0);
        case "position":
          return metric(column, row.position ?? 0);
        case "changing":
          return day >= changingFrom ? "true" : "false";
      }
    });
  });
}

/** A Search Console property's address as people read it: "sc-domain:example.com" is "example.com (whole domain)". */
export function gscSiteLabel(siteUrl: string): string {
  return siteUrl.startsWith("sc-domain:") ? `${siteUrl.slice("sc-domain:".length)} (whole domain)` : siteUrl;
}
