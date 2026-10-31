import { gaNumber } from "@/lib/analytics/google-analytics-reports";
import { gscAddDays, gscDays } from "@/lib/analytics/search-console-reports";
import { isoDateAt } from "@/lib/dates";
import { ValidationError } from "@/lib/errors";
import { add, cmp, dec, roundHalfUp, toFixedString, toPlainString } from "@/lib/money/decimal";

/**
 * Meta (a Facebook Page, its Instagram professional account and,
 * optionally, an ad account) in Analytics (#516, decisions 1190-1209,
 * examples META1-META10): which questions are asked of Meta's Graph API,
 * over which days, and how each answer becomes rows of a `meta_*` table.
 * Pure, so it can be tested without Meta.
 *
 * From Meta's developer pages, read 31 October 2026:
 * - Graph API v26.0 is the newest (29 Jul 2026; v25.0 runs to Jul 2028).
 * - Instagram account insights (Instagram API with Facebook Login, on
 *   graph.facebook.com): reach, views, accounts_engaged,
 *   total_interactions, likes, comments, saves, shares,
 *   profile_links_taps (metric_type total_value) and follows_and_unfollows
 *   (breakdown follow_type). `impressions` ended on 21 Apr 2025;
 *   profile_views, website_clicks and follower_count are no longer listed.
 *   Account data is kept for 90 days and can be 48 hours late.
 * - Instagram media insights: reach, views, saved, shares,
 *   total_interactions (feed posts and reels), profile_visits and follows
 *   (feed posts); `plays`, `impressions` and `video_views` are gone.
 *   Kept for 2 years. No insights inside a carousel's own items.
 * - Page insights: page_follows, page_daily_follows_unique,
 *   page_daily_unfollows_unique, page_media_view,
 *   page_total_media_view_unique, page_post_engagements (period day); at
 *   most 90 days per question, 2 years kept. page_fans, page_impressions
 *   (Nov 2025) and page_impressions_unique and its kin (removed for every
 *   version when v26.0 came out) are gone; their replacements are the
 *   media_view metrics. Post insights: post_media_view,
 *   post_total_media_view_unique, post_clicks, post_reactions_by_type_total,
 *   post_activity_by_action_type (lifetime).
 * - Ads Insights: level=campaign, time_increment=1, time_range; spend comes
 *   as text in the ad account's currency; start dates up to 37 months back.
 *
 * Browser-safe.
 */

/** Where Meta sends the browser back after signing in: paste it into the Meta app. */
export const META_CALLBACK_PATH = "/api/analytics/meta/callback";

export const META_GRAPH_VERSION = "v26.0";
export const META_GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
export const META_DIALOG = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;

/** Every Meta table starts with this; other sources can't use it. */
export const META_TABLE_PREFIX = "meta_";
/** How a Meta load is recorded in the load history. */
export const META_LOAD_TABLE_NAME = "meta_*";
export const META_SOURCE_NAME = "Meta (Facebook and Instagram)";
/** Meta's insight days end at midnight Pacific time. */
export const META_TIME_ZONE = "America/Los_Angeles";

/** Read-only permissions asked for (Facebook Login): list Pages, read their posts and insights, and the linked Instagram account's. */
export const META_PERMISSIONS = ["pages_show_list", "pages_read_engagement", "read_insights", "instagram_basic", "instagram_manage_insights"] as const;
/** Only when the admin ticks "Also load ads". */
export const META_ADS_PERMISSION = "ads_read";
/** Without these there's nothing to load. */
export const META_PAGE_PERMISSIONS = ["pages_show_list", "pages_read_engagement", "read_insights"];
export const META_INSTAGRAM_PERMISSIONS = ["instagram_basic", "instagram_manage_insights"];

/** What each permission lets Tohyee do, in plain words. */
export const META_PERMISSION_TEXT: Record<string, string> = {
  pages_show_list: "see the list of Pages you manage",
  pages_read_engagement: "read your Page's posts and followers",
  read_insights: "read your Page's insights",
  instagram_basic: "see the Instagram account linked to the Page",
  instagram_manage_insights: "read that Instagram account's insights",
  ads_read: "read your ad accounts' results",
};

/** Instagram account figures are kept by Meta for 90 days; the first load asks for the last 89. */
export const META_INSTAGRAM_HISTORY_DAYS = 89;
/** Page figures and post figures are kept for 2 years; the first load stays just inside. */
export const META_PAGE_HISTORY_DAYS = 728;
/** Ads: the first load goes back 13 months (Meta keeps 37). */
export const META_ADS_HISTORY_MONTHS = 13;
/** Today and the two days before may still change (Meta's figures can be 48 hours late). */
export const META_SETTLE_DAYS = 2;
/** Posts from the last 28 days are read again each load: their totals still grow. */
export const META_POST_REFRESH_DAYS = 28;
/** Ads results are counted for 7 days after a click (Meta's default attribution), so the last 7 days are read again. */
export const META_ADS_SETTLE_DAYS = 7;
/** Page insights: at most 90 days per question. */
export const META_PAGE_CHUNK_DAYS = 90;
/** Ads: a month per question keeps each answer small. */
export const META_ADS_CHUNK_DAYS = 30;
/** Posts read at most in one load, per platform. */
export const META_MAX_POSTS = 1000;
/** Pages of one list read at most. */
export const META_MAX_PAGES = 200;

export type MetaColumnType = "DATE" | "TIMESTAMP" | "VARCHAR" | "BIGINT" | "DECIMAL(18,2)" | "BOOLEAN";
export type MetaColumn = { name: string; type: MetaColumnType };
export type MetaPart = "facebook" | "instagram" | "ads";
export type MetaTable = { table: string; part: MetaPart; label: string; noun: string; description: string; columns: MetaColumn[]; dated: "day" | "posted" | "snapshot" };

const c = (name: string, type: MetaColumnType = "BIGINT"): MetaColumn => ({ name, type });
const changing = c("may_still_change", "BOOLEAN");
const date = c("date", "DATE");

const LATE = "Meta's days are Pacific time; the newest two days may still change.";
const POSTS = "Each post's totals so far, by the day it was posted. Posts from the last 28 days are read again each load, as their totals still grow; older posts keep the totals from when they were last read.";

/** The tables loaded. */
export const META_TABLES: MetaTable[] = [
  {
    table: "meta_facebook_daily",
    part: "facebook",
    label: "Facebook Page by day",
    noun: "days",
    description: `The Page each day: followers (the total that day), new and lost followers, views (times the Page's posts and stories were seen), reach (people who saw them, which Meta now counts as viewers) and engagements. ${LATE}`,
    columns: [date, c("page", "VARCHAR"), c("followers"), c("new_followers"), c("lost_followers"), c("views"), c("reach"), c("engagements"), changing],
    dated: "day",
  },
  {
    table: "meta_facebook_posts",
    part: "facebook",
    label: "Facebook posts",
    noun: "posts",
    description: `The Page's posts: reactions, comments, shares, clicks, views and reach. ${POSTS}`,
    columns: [date, c("post_id", "VARCHAR"), c("posted_at", "TIMESTAMP"), c("type", "VARCHAR"), c("message", "VARCHAR"), c("link", "VARCHAR"), c("reactions"), c("comments"), c("shares"), c("clicks"), c("views"), c("reach"), changing],
    dated: "posted",
  },
  {
    table: "meta_instagram_daily",
    part: "instagram",
    label: "Instagram by day",
    noun: "days",
    description: `The Instagram account each day: reach (accounts that saw its content), views, accounts engaged, interactions, likes, comments, saves, shares, taps on the profile's links, and follows and unfollows. Meta keeps these for 90 days; Tohyee keeps every day it has loaded. Follows need 100 followers or more. ${LATE}`,
    columns: [
      date,
      c("account", "VARCHAR"),
      c("reach"),
      c("views"),
      c("accounts_engaged"),
      c("interactions"),
      c("likes"),
      c("comments"),
      c("saves"),
      c("shares"),
      c("profile_link_taps"),
      c("follows"),
      c("unfollows"),
      changing,
    ],
    dated: "day",
  },
  {
    table: "meta_instagram_followers",
    part: "instagram",
    label: "Instagram followers",
    noun: "days",
    description: "How many followers the Instagram account had, noted on each day Tohyee loaded it. Meta doesn't give past follower totals, so this starts on the first load.",
    columns: [date, c("account", "VARCHAR"), c("followers")],
    dated: "snapshot",
  },
  {
    table: "meta_instagram_posts",
    part: "instagram",
    label: "Instagram posts",
    noun: "posts",
    description: `The Instagram account's posts and reels: likes, comments, saves, shares, reach, views, interactions, and (for posts) profile visits and follows from them. Stories aren't loaded: Meta keeps their figures for only 24 hours. ${POSTS}`,
    columns: [
      date,
      c("post_id", "VARCHAR"),
      c("posted_at", "TIMESTAMP"),
      c("type", "VARCHAR"),
      c("caption", "VARCHAR"),
      c("link", "VARCHAR"),
      c("likes"),
      c("comments"),
      c("saves"),
      c("shares"),
      c("reach"),
      c("views"),
      c("interactions"),
      c("profile_visits"),
      c("follows"),
      changing,
    ],
    dated: "posted",
  },
  {
    table: "meta_ads_daily",
    part: "ads",
    label: "Meta ads by campaign and day",
    noun: "campaign days",
    description:
      "Each campaign each day, in the ad account's currency and time zone: spend, impressions, reach, clicks, link clicks and results (what the campaign was set to get, such as link clicks or purchases, under Meta's default attribution: 7 days after a click or 1 day after a view). Reach is people, so adding days together counts someone twice. The last 7 days may still change.",
    columns: [date, c("campaign_id", "VARCHAR"), c("campaign", "VARCHAR"), c("currency", "VARCHAR"), c("spend", "DECIMAL(18,2)"), c("impressions"), c("reach"), c("clicks"), c("link_clicks"), c("results", "DECIMAL(18,2)"), c("result_type", "VARCHAR"), changing],
    dated: "day",
  },
];

/** Whether a table is one of Meta's own. */
export function isMetaTable(name: string): boolean {
  return name.startsWith(META_TABLE_PREFIX);
}

/** The Meta tables with a "may still change" column (for a report's freshness line). */
export function metaTableChanges(name: string): boolean {
  return META_TABLES.some((table) => table.table === name && table.columns.some((column) => column.name === "may_still_change"));
}

export function metaTableColumns(table: MetaTable): Array<{ name: string; type: string }> {
  return table.columns.map((column) => ({ name: column.name, type: column.type }));
}

export function metaTable(name: string): MetaTable {
  return META_TABLES.find((table) => table.table === name)!;
}

// Signing in ---------------------------------------------------------------------------------

/**
 * Meta's sign-in address (the manual Facebook Login flow, response_type
 * code). With a Facebook Login for Business configuration ID the
 * permissions are the configuration's; without, Tohyee names them.
 */
export function metaAuthorisationUrl(input: { appId: string; redirectUri: string; state: string; configId: string | null; withAds: boolean }): string {
  const params = new URLSearchParams({ client_id: input.appId, redirect_uri: input.redirectUri, state: input.state, response_type: "code" });
  if (input.configId) params.set("config_id", input.configId);
  else params.set("scope", [...META_PERMISSIONS, ...(input.withAds ? [META_ADS_PERMISSION] : [])].join(","));
  return `${META_DIALOG}?${params}`;
}

export type MetaPermissionRow = { permission?: string; status?: string };

/** Meta's `/me/permissions` answer as granted and declined lists. */
export function metaPermissions(rows: MetaPermissionRow[]): { granted: string[]; declined: string[] } {
  const granted = new Set<string>();
  const declined = new Set<string>();
  for (const row of rows) {
    if (typeof row.permission !== "string" || !/^[a-z_]{1,64}$/.test(row.permission)) continue;
    if (row.status === "granted") granted.add(row.permission);
    else declined.add(row.permission);
  }
  return { granted: [...granted].sort(), declined: [...declined].filter((name) => !granted.has(name)).sort() };
}

/** The Page permissions not granted (nothing loads without them). */
export function missingPagePermissions(granted: readonly string[]): string[] {
  return META_PAGE_PERMISSIONS.filter((name) => !granted.includes(name));
}

// Days ---------------------------------------------------------------------------------------

/** Today in Meta's days (Pacific time). */
export function metaToday(now = new Date()): string {
  return isoDateAt(now, META_TIME_ZONE);
}

export const metaAddDays = gscAddDays;
export const metaDays = gscDays;

function offsetMinutes(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - instant) / 60_000;
}

/** Midnight at the start of `day` in a time zone, as Unix seconds (what Meta's since and until take). */
export function metaMidnight(day: string, timeZone = META_TIME_ZONE): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ValidationError(`"${day.slice(0, 20)}" isn't a date.`);
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  const naive = Date.UTC(year, month - 1, dayOfMonth);
  let guess = naive - offsetMinutes(naive, timeZone) * 60_000;
  guess = naive - offsetMinutes(guess, timeZone) * 60_000;
  return Math.round(guess / 1000);
}

/** The day a daily value is for: Meta's `end_time` is the midnight that ends it, so the Pacific day of the second before. */
export function metaDayOfEndTime(endTime: string): string {
  const instant = Date.parse(endTime.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (!Number.isFinite(instant)) throw new ValidationError(`Meta sent a time Tohyee can't read: "${endTime.slice(0, 30)}".`);
  return isoDateAt(new Date(instant - 1000), META_TIME_ZONE);
}

/** The Pacific day a post was made, from Meta's time ("2026-10-28T03:15:00+0000"). */
export function metaPostedDay(time: string, timeZone = META_TIME_ZONE): { day: string; at: string } {
  const instant = Date.parse(time.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (!Number.isFinite(instant)) throw new ValidationError(`Meta sent a time Tohyee can't read: "${time.slice(0, 30)}".`);
  return { day: isoDateAt(new Date(instant), timeZone), at: new Date(instant).toISOString().slice(0, 19).replace("T", " ") };
}

/** The same day `months` months before, the day of the month kept where the month has it. */
export function metaMonthsBefore(today: string, months: number): string {
  const [year, month, day] = today.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 - months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, last));
  return first.toISOString().slice(0, 10);
}

export type MetaWindow = { from: string; to: string; first: boolean };

/**
 * Which days a part asks for (decision 1196). The first load (or one after
 * the tables went missing) goes back to `start`; after that from the first
 * day the last load marked as "may still change" (the last day loaded less
 * `settleDays`), so those are read once more and settle, to today, never
 * before `start`.
 */
export function metaWindow(today: string, start: string, loadedThrough: string | null, tablesPresent: boolean, settleDays: number): MetaWindow {
  if (!loadedThrough || !tablesPresent) return { from: start, to: today, first: true };
  let from = metaAddDays(loadedThrough, -settleDays);
  if (from < start) from = start;
  if (from > today) from = today;
  return { from, to: today, first: false };
}

/** The days split into runs of at most `size` days, oldest first. */
export function metaChunks(from: string, to: string, size: number): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  for (let start = from; start <= to; start = metaAddDays(start, size)) {
    const end = metaAddDays(start, size - 1);
    chunks.push({ from: start, to: end < to ? end : to });
  }
  return chunks;
}

// Paging -------------------------------------------------------------------------------------

export type MetaList<T> = { data?: T[]; paging?: { cursors?: { after?: string }; next?: string } };

/**
 * Every page of a list: the next page is asked for with the `after` cursor
 * while Meta gives a `next` link; `stop` ends early (posts older than
 * wanted). A runaway list is an error rather than a hang.
 */
export async function metaReadAllPages<T>(fetchPage: (after: string | null) => Promise<MetaList<T>>, stop: (item: T) => boolean = () => false, maxItems = Number.POSITIVE_INFINITY): Promise<T[]> {
  const items: T[] = [];
  let after: string | null = null;
  for (let page = 0; ; page += 1) {
    if (page >= META_MAX_PAGES) throw new ValidationError("Meta kept sending more pages than it should. The data already loaded is kept.");
    const answer = await fetchPage(after);
    const got = Array.isArray(answer.data) ? answer.data : [];
    for (const item of got) {
      if (stop(item)) return items;
      items.push(item);
      if (items.length >= maxItems) return items;
    }
    const cursor = answer.paging?.cursors?.after;
    if (!answer.paging?.next || !cursor || got.length === 0) return items;
    after = cursor;
  }
}

// Numbers ------------------------------------------------------------------------------------

/** A Meta count (a JSON number, or text for ads) as a whole number; missing is null, never 0. */
export function metaCount(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") throw new ValidationError(`Meta sent a number Tohyee can't read: "${String(value).slice(0, 30)}".`);
  if (typeof value === "number" && !Number.isFinite(value)) throw new ValidationError(`Meta sent a number Tohyee can't read: "${String(value).slice(0, 30)}".`);
  return toPlainString(roundHalfUp(dec(gaNumber(String(value))), 0));
}

/**
 * Money from Meta (text, e.g. "100.50") to 2 places, exactly: a value with
 * more places than that isn't rounded away silently.
 */
export function metaMoney(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") throw new ValidationError(`Meta sent an amount Tohyee can't read: "${String(value).slice(0, 30)}".`);
  const plain = gaNumber(String(value));
  const fixed = toFixedString(dec(plain), 2);
  if (cmp(dec(fixed), dec(plain)) !== 0) throw new ValidationError(`Meta sent an amount with more than 2 decimal places: "${String(value).slice(0, 30)}".`);
  return fixed;
}

function metaDecimal(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return toFixedString(dec(gaNumber(String(value))), 2);
}

// Insights answers ---------------------------------------------------------------------------

export type MetaInsight = {
  name?: string;
  period?: string;
  values?: Array<{ value?: unknown; end_time?: string }>;
  total_value?: { value?: unknown; breakdowns?: Array<{ dimension_keys?: string[]; results?: Array<{ dimension_values?: string[]; value?: unknown }> }> };
};

/** A total_value metric's value (Instagram), or null when Meta sent nothing for it (it sends nothing rather than 0). */
export function metaTotal(data: MetaInsight[] | undefined, name: string): string | null {
  const entry = (data ?? []).find((item) => item.name === name);
  if (!entry) return null;
  if (entry.total_value && "value" in entry.total_value) return metaCount(entry.total_value.value);
  // A time_series answer for a single day.
  const values = entry.values ?? [];
  return values.length ? metaCount(values[values.length - 1]?.value) : null;
}

/**
 * One breakdown value of a total_value metric (follows_and_unfollows by
 * follow_type), null when not sent. Missing from an answer that has the
 * other `known` values is 0; an answer with none of them (Meta renamed
 * them) is empty rather than a wrong 0.
 */
export function metaBreakdown(data: MetaInsight[] | undefined, name: string, dimension: string, known: readonly string[] = [dimension]): string | null {
  const entry = (data ?? []).find((item) => item.name === name);
  const results = entry?.total_value?.breakdowns?.[0]?.results;
  if (!Array.isArray(results)) return null;
  const valueOf = (result: { dimension_values?: string[] }) => (Array.isArray(result.dimension_values) ? result.dimension_values[0] : undefined);
  const found = results.find((result) => valueOf(result) === dimension);
  if (found) return metaCount(found.value);
  return results.some((result) => known.includes(valueOf(result) ?? "")) ? "0" : null;
}

const FOLLOW_TYPES = ["FOLLOWER", "NON_FOLLOWER"];

/** A lifetime metric's value (posts). Objects (reactions by type, activity by action) are added up, or one key taken. */
export function metaLifetime(data: MetaInsight[] | undefined, name: string, key?: string): string | null {
  const entry = (data ?? []).find((item) => item.name === name);
  const value = entry?.values?.[0]?.value;
  if (value === undefined || value === null) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (key) return metaCount(record[key] ?? 0);
    let total = dec("0");
    for (const part of Object.values(record)) total = add(total, dec(metaCount(part) ?? "0"));
    return toPlainString(total);
  }
  return metaCount(value);
}

// Facebook Page ------------------------------------------------------------------------------

export const META_PAGE_METRICS = ["page_follows", "page_daily_follows_unique", "page_daily_unfollows_unique", "page_media_view", "page_total_media_view_unique", "page_post_engagements"];
const PAGE_COLUMN: Record<string, string> = {
  page_follows: "followers",
  page_daily_follows_unique: "new_followers",
  page_daily_unfollows_unique: "lost_followers",
  page_media_view: "views",
  page_total_media_view_unique: "reach",
  page_post_engagements: "engagements",
};

/** Page insights (period day) as one row a day from `from` to `to`, oldest first; a day Meta sent nothing for has empty figures. */
export function metaPageDailyRows(data: MetaInsight[], page: string, from: string, to: string, changingFrom: string): Array<Array<string | null>> {
  const byDay = new Map<string, Record<string, string | null>>();
  for (const entry of data) {
    const column = entry.name ? PAGE_COLUMN[entry.name] : undefined;
    if (!column || (entry.period && entry.period !== "day")) continue;
    for (const value of entry.values ?? []) {
      if (typeof value.end_time !== "string") continue;
      const day = metaDayOfEndTime(value.end_time);
      if (day < from || day > to) continue;
      const row = byDay.get(day) ?? {};
      row[column] = metaCount(value.value);
      byDay.set(day, row);
    }
  }
  const table = metaTable("meta_facebook_daily");
  return metaDays(from, to).map((day) => {
    const row = byDay.get(day) ?? {};
    return table.columns.map((column) =>
      column.name === "date" ? day : column.name === "page" ? page.slice(0, 200) : column.name === "may_still_change" ? String(day >= changingFrom) : (row[column.name] ?? null),
    );
  });
}

export const META_POST_METRICS = ["post_media_view", "post_total_media_view_unique", "post_clicks", "post_reactions_by_type_total", "post_activity_by_action_type"];

const STATUS_TYPES: Record<string, string> = {
  added_photos: "Photo",
  added_video: "Video",
  shared_story: "Shared link",
  mobile_status_update: "Status",
  wall_post: "Status",
  created_event: "Event",
  created_note: "Note",
  approved_friend: "Status",
  tagged_in_photo: "Photo",
  published_story: "Story",
};

export type MetaPagePost = { id?: string; created_time?: string; message?: string; permalink_url?: string; status_type?: string; insights?: { data?: MetaInsight[] } };

/** A Page post as a row of `meta_facebook_posts`. */
export function metaPagePostRow(post: MetaPagePost, changingFrom: string): Array<string | null> {
  if (typeof post.id !== "string" || typeof post.created_time !== "string") throw new ValidationError("Meta sent a Facebook post Tohyee can't read.");
  const { day, at } = metaPostedDay(post.created_time);
  const data = post.insights?.data;
  const values: Record<string, string | null> = {
    date: day,
    post_id: post.id.slice(0, 100),
    posted_at: at,
    type: STATUS_TYPES[post.status_type ?? ""] ?? (post.status_type ? "Other" : "Post"),
    message: typeof post.message === "string" ? post.message.replace(/\s+/g, " ").trim().slice(0, 300) : null,
    link: typeof post.permalink_url === "string" ? post.permalink_url.slice(0, 2000) : null,
    reactions: metaLifetime(data, "post_reactions_by_type_total"),
    comments: metaLifetime(data, "post_activity_by_action_type", "comment"),
    shares: metaLifetime(data, "post_activity_by_action_type", "share"),
    clicks: metaLifetime(data, "post_clicks"),
    views: metaLifetime(data, "post_media_view"),
    reach: metaLifetime(data, "post_total_media_view_unique"),
    may_still_change: String(day >= changingFrom),
  };
  return metaTable("meta_facebook_posts").columns.map((column) => values[column.name] ?? null);
}

// Instagram ----------------------------------------------------------------------------------

/** Account metrics asked for with metric_type=total_value, one day at a time. */
export const META_INSTAGRAM_METRICS = ["reach", "views", "accounts_engaged", "total_interactions", "likes", "comments", "saves", "shares", "profile_links_taps"];
/** Asked for on its own, broken down by follow_type. */
export const META_INSTAGRAM_FOLLOWS = "follows_and_unfollows";

/** One Instagram day as a row of `meta_instagram_daily`. */
export function metaInstagramDayRow(day: string, account: string, totals: MetaInsight[] | undefined, follows: MetaInsight[] | undefined, changingFrom: string): Array<string | null> {
  const values: Record<string, string | null> = {
    date: day,
    account: account.slice(0, 200),
    reach: metaTotal(totals, "reach"),
    views: metaTotal(totals, "views"),
    accounts_engaged: metaTotal(totals, "accounts_engaged"),
    interactions: metaTotal(totals, "total_interactions"),
    likes: metaTotal(totals, "likes"),
    comments: metaTotal(totals, "comments"),
    saves: metaTotal(totals, "saves"),
    shares: metaTotal(totals, "shares"),
    profile_link_taps: metaTotal(totals, "profile_links_taps"),
    follows: metaBreakdown(follows, META_INSTAGRAM_FOLLOWS, "FOLLOWER", FOLLOW_TYPES),
    unfollows: metaBreakdown(follows, META_INSTAGRAM_FOLLOWS, "NON_FOLLOWER", FOLLOW_TYPES),
    may_still_change: String(day >= changingFrom),
  };
  return metaTable("meta_instagram_daily").columns.map((column) => values[column.name] ?? null);
}

export type MetaMedia = {
  id?: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  timestamp?: string;
  permalink?: string;
  like_count?: unknown;
  comments_count?: unknown;
};

/** Which insights a post can be asked for (Meta's media insights table): reels have no profile visits or follows; stories aren't loaded. */
export function metaMediaMetrics(media: MetaMedia): string[] {
  if (media.media_product_type === "REELS") return ["reach", "views", "saved", "shares", "total_interactions"];
  return ["reach", "views", "saved", "shares", "total_interactions", "profile_visits", "follows"];
}

/** A post's kind in plain words. */
export function metaMediaType(media: MetaMedia): string {
  if (media.media_product_type === "REELS") return "Reel";
  if (media.media_product_type === "STORY") return "Story";
  if (media.media_type === "CAROUSEL_ALBUM") return "Carousel";
  if (media.media_type === "VIDEO") return "Video";
  if (media.media_type === "IMAGE") return "Photo";
  return "Post";
}

/** An Instagram post as a row of `meta_instagram_posts`; `insights` is null when Meta has none for it (e.g. posted before it was a professional account). */
export function metaInstagramPostRow(media: MetaMedia, insights: MetaInsight[] | null, changingFrom: string): Array<string | null> {
  if (typeof media.id !== "string" || typeof media.timestamp !== "string") throw new ValidationError("Meta sent an Instagram post Tohyee can't read.");
  const { day, at } = metaPostedDay(media.timestamp);
  const value = (name: string) => (insights ? metaLifetime(insights, name) : null);
  const values: Record<string, string | null> = {
    date: day,
    post_id: media.id.slice(0, 100),
    posted_at: at,
    type: metaMediaType(media),
    caption: typeof media.caption === "string" ? media.caption.replace(/\s+/g, " ").trim().slice(0, 300) : null,
    link: typeof media.permalink === "string" ? media.permalink.slice(0, 2000) : null,
    likes: metaCount(media.like_count),
    comments: metaCount(media.comments_count),
    saves: value("saved"),
    shares: value("shares"),
    reach: value("reach"),
    views: value("views"),
    interactions: value("total_interactions"),
    profile_visits: value("profile_visits"),
    follows: value("follows"),
    may_still_change: String(day >= changingFrom),
  };
  return metaTable("meta_instagram_posts").columns.map((column) => values[column.name] ?? null);
}

// Ads ----------------------------------------------------------------------------------------

export const META_ADS_FIELDS = ["campaign_id", "campaign_name", "account_currency", "spend", "impressions", "reach", "clicks", "inline_link_clicks", "results", "date_start", "date_stop"];

export type MetaAdsRow = {
  campaign_id?: string;
  campaign_name?: string;
  account_currency?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  inline_link_clicks?: string;
  results?: Array<{ indicator?: string; values?: Array<{ value?: unknown }> }>;
  date_start?: string;
};

/** A result's kind from Meta's indicator ("actions:link_click") in plain words ("Link click"). */
export function metaResultType(indicator: string | undefined): string | null {
  if (!indicator) return null;
  const last = indicator.split(":").pop()!.replace(/^(offsite_conversion\.fb_pixel_|onsite_conversion\.|omni_)/, "").replace(/[._]+/g, " ").trim();
  return last ? `${last.charAt(0).toUpperCase()}${last.slice(1)}`.slice(0, 100) : null;
}

/** One campaign-day of Ads Insights as a row of `meta_ads_daily`, amounts exact in the account's currency. */
export function metaAdsRow(row: MetaAdsRow, changingFrom: string): Array<string | null> {
  const day = row.date_start;
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof row.campaign_id !== "string") throw new ValidationError("Meta sent an ads row Tohyee can't read.");
  const result = Array.isArray(row.results) ? row.results[0] : undefined;
  let results: string | null = null;
  if (result && Array.isArray(result.values)) {
    let total = dec("0");
    for (const entry of result.values) total = add(total, dec(metaDecimal(entry?.value) ?? "0"));
    results = toFixedString(total, 2);
  }
  const values: Record<string, string | null> = {
    date: day,
    campaign_id: row.campaign_id.slice(0, 100),
    campaign: typeof row.campaign_name === "string" ? row.campaign_name.slice(0, 300) : null,
    currency: typeof row.account_currency === "string" ? row.account_currency.slice(0, 10) : null,
    spend: metaMoney(row.spend ?? "0"),
    impressions: metaCount(row.impressions),
    reach: metaCount(row.reach),
    clicks: metaCount(row.clicks),
    link_clicks: metaCount(row.inline_link_clicks),
    results,
    result_type: metaResultType(result?.indicator),
    may_still_change: String(day >= changingFrom),
  };
  return metaTable("meta_ads_daily").columns.map((column) => values[column.name] ?? null);
}

// Meta's errors ------------------------------------------------------------------------------

export type MetaFailure = { status: number; code: number | null; subcode: number | null; message: string; regainMinutes: number | null };
export type MetaProblemKind = "signin" | "permission" | "limit" | "busy" | "no_insights" | "other";

const RATE_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);

/** What kind of trouble an error is (Meta's error codes page and rate limits page). */
export function metaProblemKind(failure: MetaFailure): MetaProblemKind {
  if (failure.code === 190 || failure.code === 102) return "signin";
  if (failure.code !== null && RATE_CODES.has(failure.code)) return "limit";
  if (failure.code === 10 || failure.code === 3 || (failure.code !== null && failure.code >= 200 && failure.code <= 299)) return "permission";
  // Media from before the account was a professional one, or too new: no insights for it.
  if (failure.code === 100 && (failure.subcode === 2108006 || failure.subcode === 33)) return "no_insights";
  if (failure.code === 1 || failure.code === 2 || failure.status >= 500) return "busy";
  return "other";
}

/** Why Meta ended a sign-in, from error 190's subcode, in plain words. */
export function metaReconnectReason(subcode: number | null): string {
  switch (subcode) {
    case 458:
      return "Tohyee's Meta app was removed from the Facebook account";
    case 459:
      return "Facebook needs the account to log in on facebook.com first";
    case 460:
      return "the Facebook password was changed";
    case 463:
      return "it ran out";
    case 464:
      return "the Facebook account isn't confirmed";
    default:
      return "it ended or was withdrawn";
  }
}

/** An error in words an admin can act on. */
export function metaProblemText(failure: MetaFailure, what: string): string {
  const meta = failure.message ? ` Meta said: ${failure.message.slice(0, 300)}` : "";
  switch (metaProblemKind(failure)) {
    case "signin":
      return `Meta no longer accepts this sign-in (${metaReconnectReason(failure.subcode)}). An admin needs to connect again.`;
    case "limit":
      return `Meta's limit for ${what} is used up for now${failure.regainMinutes ? ` (Meta says to wait about ${failure.regainMinutes} minutes)` : ""}. The data already loaded is kept. Tohyee tries again at the next nightly load, or use Refresh now later.`;
    case "permission":
      return `Meta says this sign-in isn't allowed to read ${what}.${meta} Use Check setup to see what's missing, then connect again and allow everything Tohyee asks for.`;
    case "busy":
      return `Meta isn't answering just now. The data already loaded is kept; try again later.${meta}`;
    default:
      return `Meta refused the request for ${what} (${failure.code ?? failure.status}).${meta}`;
  }
}
