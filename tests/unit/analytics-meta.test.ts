import { describe, expect, it } from "vitest";
import {
  META_TABLES,
  isMetaTable,
  metaAdsRow,
  metaAuthorisationUrl,
  metaBreakdown,
  metaChunks,
  metaCount,
  metaDayOfEndTime,
  metaInstagramDayRow,
  metaInstagramPostRow,
  metaMediaMetrics,
  metaMediaType,
  metaMidnight,
  metaMoney,
  metaMonthsBefore,
  metaPageDailyRows,
  metaPagePostRow,
  metaPermissions,
  metaPostedDay,
  metaProblemKind,
  metaProblemText,
  metaReadAllPages,
  metaResultType,
  metaTable,
  metaTableColumns,
  metaToday,
  metaTotal,
  metaWindow,
  missingPagePermissions,
  type MetaFailure,
  type MetaInsight,
} from "@/lib/analytics/meta-reports";
import { combineFreshness, loadKeyOf, mayChangeSql } from "@/lib/analytics/freshness";
import { freshnessText } from "@/components/analytics/report-freshness";
import { buildTemplate } from "@/lib/analytics/templates";
import { tableDescription, tableLabel } from "@/lib/analytics/labels";
import { parseTileQuery } from "@/lib/analytics/query";
import { parseChartFormat } from "@/lib/analytics/chart-format";

const columns = (name: string) => metaTable(name).columns.map((column) => column.name);
const asRecord = (name: string, row: Array<string | null>) => Object.fromEntries(columns(name).map((column, index) => [column, row[index]]));

/** Examples META1-META10 in docs/ACCOUNTING-EXAMPLES.md (Meta, as Looker Studio's and Power BI's Meta connectors do, not yet reviewed). Made-up figures. */
describe("Meta sign-in (decisions 1192, 1194)", () => {
  it("META1 asks only for read permissions, or uses the app's Facebook Login for Business configuration", () => {
    const url = new URL(metaAuthorisationUrl({ appId: "123456789", redirectUri: "https://tohyee.test/api/analytics/meta/callback", state: "org.abc", configId: null, withAds: false }));
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "123456789",
      redirect_uri: "https://tohyee.test/api/analytics/meta/callback",
      state: "org.abc",
      response_type: "code",
      scope: "pages_show_list,pages_read_engagement,read_insights,instagram_basic,instagram_manage_insights",
    });
    expect(new URL(metaAuthorisationUrl({ appId: "1", redirectUri: "r", state: "s", configId: null, withAds: true })).searchParams.get("scope")).toMatch(/,ads_read$/);
    const configured = new URL(metaAuthorisationUrl({ appId: "1", redirectUri: "r", state: "s", configId: "987654321", withAds: true })).searchParams;
    expect([configured.get("config_id"), configured.get("scope")]).toEqual(["987654321", null]);
    // Nothing that writes is ever asked for.
    expect(url.searchParams.get("scope")).not.toMatch(/manage_posts|publish|ads_management|business_management|pages_manage/);
  });

  it("META1 reads what was allowed and what wasn't", () => {
    const read = metaPermissions([
      { permission: "pages_show_list", status: "granted" },
      { permission: "read_insights", status: "declined" },
      { permission: "instagram_basic", status: "granted" },
      { permission: "public_profile", status: "granted" },
      { permission: "bad name!", status: "granted" },
    ]);
    expect(read).toEqual({ granted: ["instagram_basic", "pages_show_list", "public_profile"], declined: ["read_insights"] });
    expect(missingPagePermissions(read.granted)).toEqual(["pages_read_engagement", "read_insights"]);
  });
});

describe("Meta days (decision 1196)", () => {
  it("META3 uses Meta's Pacific-time days, with daylight saving", () => {
    // 9am 1 Nov in New Zealand is still 31 Oct in California.
    expect(metaToday(new Date("2026-10-31T20:00:00Z"))).toBe("2026-10-31");
    // Midnight 31 Oct (daylight time, UTC-7) and 2 Nov (after the change, UTC-8).
    expect(metaMidnight("2026-10-31")).toBe(Date.parse("2026-10-31T07:00:00Z") / 1000);
    expect(metaMidnight("2026-11-02")).toBe(Date.parse("2026-11-02T08:00:00Z") / 1000);
    // A value whose end_time is midnight starting 1 Nov is for 31 Oct.
    expect(metaDayOfEndTime("2026-11-01T07:00:00+0000")).toBe("2026-10-31");
    expect(metaDayOfEndTime("2026-11-03T08:00:00+0000")).toBe("2026-11-02");
    expect(metaPostedDay("2026-10-28T03:15:00+0000")).toEqual({ day: "2026-10-27", at: "2026-10-28 03:15:00" });
    expect(metaMonthsBefore("2026-10-31", 13)).toBe("2025-09-30");
  });

  it("META3 the first load goes back to the start; META4 later ones the days still marked as changing and the new ones", () => {
    expect(metaWindow("2026-10-31", "2026-08-03", null, false, 2)).toEqual({ from: "2026-08-03", to: "2026-10-31", first: true });
    expect(metaWindow("2026-10-31", "2026-08-03", "2026-10-30", false, 2).first).toBe(true);
    // Loaded to 31 Oct, with 29-31 Oct marked: those are read once more, then 1 Nov.
    expect(metaWindow("2026-11-01", "2026-08-04", "2026-10-31", true, 2)).toEqual({ from: "2026-10-29", to: "2026-11-01", first: false });
    // A part that failed for a week carries on from where it stopped.
    expect(metaWindow("2026-11-08", "2026-08-11", "2026-10-31", true, 2)).toEqual({ from: "2026-10-29", to: "2026-11-08", first: false });
    // Loaded again the same day: the changing days only.
    expect(metaWindow("2026-10-31", "2026-08-03", "2026-10-31", true, 2)).toEqual({ from: "2026-10-29", to: "2026-10-31", first: false });
    // Never before what Meta still has.
    expect(metaWindow("2027-03-01", "2026-12-02", "2026-10-31", true, 2).from).toBe("2026-12-02");
    expect(metaChunks("2026-01-01", "2026-04-15", 90)).toEqual([
      { from: "2026-01-01", to: "2026-03-31" },
      { from: "2026-04-01", to: "2026-04-15" },
    ]);
  });
});

describe("Meta paging", () => {
  it("META3 follows the after cursor while Meta gives a next page, and stops at older posts", async () => {
    const pages: Record<string, { data: number[]; paging?: { cursors: { after: string }; next?: string } }> = {
      start: { data: [1, 2], paging: { cursors: { after: "c1" }, next: "https://graph.facebook.com/next" } },
      c1: { data: [3, 4], paging: { cursors: { after: "c2" }, next: "https://graph.facebook.com/next" } },
      c2: { data: [5], paging: { cursors: { after: "c3" } } },
    };
    const asked: Array<string | null> = [];
    const fetchPage = async (after: string | null) => {
      asked.push(after);
      return pages[after ?? "start"];
    };
    expect(await metaReadAllPages(fetchPage)).toEqual([1, 2, 3, 4, 5]);
    expect(asked).toEqual([null, "c1", "c2"]);
    expect(await metaReadAllPages(fetchPage, (item) => item > 3)).toEqual([1, 2, 3]);
    expect(await metaReadAllPages(fetchPage, () => false, 2)).toEqual([1, 2]);
    await expect(metaReadAllPages(async () => ({ data: [1], paging: { cursors: { after: "same" }, next: "x" } }))).rejects.toThrow("more pages than it should");
  });
});

describe("Meta figures (decisions 1193-1195)", () => {
  it("META5 counts are whole, missing is empty not 0, and money is exact to the cent", () => {
    expect([metaCount(12), metaCount("1204"), metaCount(null), metaCount(undefined)]).toEqual(["12", "1204", null, null]);
    expect([metaMoney("100.50"), metaMoney("0.1"), metaMoney("1234"), metaMoney(undefined)]).toEqual(["100.50", "0.10", "1234.00", null]);
    expect(() => metaMoney("12.345")).toThrow("more than 2 decimal places");
    expect(() => metaCount({})).toThrow("can't read");
  });

  it("META5 Page insights become one row a day, with the newest days marked", () => {
    const value = (day: string, amount: number) => ({ value: amount, end_time: `${day}T07:00:00+0000` });
    const data: MetaInsight[] = [
      { name: "page_follows", period: "day", values: [value("2026-10-30", 612), value("2026-10-31", 615), value("2026-11-01", 615)] },
      { name: "page_daily_follows_unique", period: "day", values: [value("2026-10-30", 4), value("2026-10-31", 3)] },
      { name: "page_total_media_view_unique", period: "day", values: [value("2026-10-30", 240)] },
      { name: "page_media_view", period: "week", values: [value("2026-10-30", 9999)] },
    ];
    const rows = metaPageDailyRows(data, "Paw Prints NZ", "2026-10-29", "2026-10-31", "2026-10-29").map((row) => asRecord("meta_facebook_daily", row));
    expect(rows).toEqual([
      { date: "2026-10-29", page: "Paw Prints NZ", followers: "612", new_followers: "4", lost_followers: null, views: null, reach: "240", engagements: null, may_still_change: "true" },
      { date: "2026-10-30", page: "Paw Prints NZ", followers: "615", new_followers: "3", lost_followers: null, views: null, reach: null, engagements: null, may_still_change: "true" },
      { date: "2026-10-31", page: "Paw Prints NZ", followers: "615", new_followers: null, lost_followers: null, views: null, reach: null, engagements: null, may_still_change: "true" },
    ]);
  });

  it("META5 a Page post's reactions are added up, and comments and shares come from its activity", () => {
    const row = asRecord(
      "meta_facebook_posts",
      metaPagePostRow(
        {
          id: "1111_501",
          created_time: "2026-10-28T03:15:00+0000",
          message: "New  nose print\nnecklaces are here",
          permalink_url: "https://www.facebook.com/1111/posts/501",
          status_type: "added_photos",
          insights: {
            data: [
              { name: "post_reactions_by_type_total", values: [{ value: { like: 40, love: 12, wow: 1 } }] },
              { name: "post_activity_by_action_type", values: [{ value: { comment: 7, share: 3, like: 53 } }] },
              { name: "post_clicks", values: [{ value: 88 }] },
              { name: "post_media_view", values: [{ value: 1500 }] },
              { name: "post_total_media_view_unique", values: [{ value: 1180 }] },
            ],
          },
        },
        "2026-10-04",
      ),
    );
    expect(row).toEqual({
      date: "2026-10-27",
      post_id: "1111_501",
      posted_at: "2026-10-28 03:15:00",
      type: "Photo",
      message: "New nose print necklaces are here",
      link: "https://www.facebook.com/1111/posts/501",
      reactions: "53",
      comments: "7",
      shares: "3",
      clicks: "88",
      views: "1500",
      reach: "1180",
      may_still_change: "true",
    });
  });

  it("META5 Instagram days read total values and follows by type; nothing sent stays empty", () => {
    const totals: MetaInsight[] = [
      { name: "reach", total_value: { value: 420 } },
      { name: "views", total_value: { value: 1310 } },
      { name: "profile_links_taps", total_value: { value: 9 } },
    ];
    const follows: MetaInsight[] = [
      { name: "follows_and_unfollows", total_value: { breakdowns: [{ dimension_keys: ["follow_type"], results: [{ dimension_values: ["FOLLOWER"], value: 6 }, { dimension_values: ["NON_FOLLOWER"], value: 2 }] }] } },
    ];
    const row = asRecord("meta_instagram_daily", metaInstagramDayRow("2026-10-30", "@pawprints.nz", totals, follows, "2026-10-29"));
    expect(row).toMatchObject({ date: "2026-10-30", account: "@pawprints.nz", reach: "420", views: "1310", profile_link_taps: "9", likes: null, follows: "6", unfollows: "2", may_still_change: "true" });
    // Under 100 followers Meta sends no follows at all: empty, not 0.
    expect(asRecord("meta_instagram_daily", metaInstagramDayRow("2026-10-01", "@x", totals, [], "2026-10-29"))).toMatchObject({ follows: null, unfollows: null, may_still_change: "false" });
    const onlyFollows: MetaInsight[] = [{ name: "follows_and_unfollows", total_value: { breakdowns: [{ results: [{ dimension_values: ["FOLLOWER"], value: 2 }] }] } }];
    expect(metaBreakdown(onlyFollows, "follows_and_unfollows", "NON_FOLLOWER", ["FOLLOWER", "NON_FOLLOWER"])).toBe("0");
    // Values Tohyee doesn't know (Meta renamed them): empty, not a wrong 0.
    const renamed: MetaInsight[] = [{ name: "follows_and_unfollows", total_value: { breakdowns: [{ results: [{ dimension_values: ["NEW_NAME"], value: 2 }] }] } }];
    expect(metaBreakdown(renamed, "follows_and_unfollows", "FOLLOWER", ["FOLLOWER", "NON_FOLLOWER"])).toBeNull();
    expect(metaTotal([{ name: "reach", values: [{ value: 5 }] }], "reach")).toBe("5");
  });

  it("META5 Instagram posts ask only for what their kind has, and one without insights keeps its likes", () => {
    expect(metaMediaMetrics({ media_product_type: "REELS" })).toEqual(["reach", "views", "saved", "shares", "total_interactions"]);
    expect(metaMediaMetrics({ media_product_type: "FEED", media_type: "CAROUSEL_ALBUM" })).toContain("profile_visits");
    expect(metaMediaMetrics({ media_product_type: "FEED" }).join(",")).not.toMatch(/impressions|plays|video_views/);
    expect([metaMediaType({ media_product_type: "REELS", media_type: "VIDEO" }), metaMediaType({ media_type: "CAROUSEL_ALBUM" }), metaMediaType({ media_type: "IMAGE" })]).toEqual(["Reel", "Carousel", "Photo"]);
    const media = { id: "1790001", caption: "Kobe's paw print pendant", media_type: "IMAGE", media_product_type: "FEED", timestamp: "2026-10-29T21:00:00+0000", permalink: "https://www.instagram.com/p/abc/", like_count: 51, comments_count: 4 };
    const insights: MetaInsight[] = [
      { name: "reach", values: [{ value: 700 }] },
      { name: "saved", values: [{ value: 12 }] },
      { name: "follows", values: [{ value: 2 }] },
    ];
    expect(asRecord("meta_instagram_posts", metaInstagramPostRow(media, insights, "2026-10-04"))).toMatchObject({ date: "2026-10-29", type: "Photo", likes: "51", comments: "4", reach: "700", saves: "12", follows: "2", views: null });
    expect(asRecord("meta_instagram_posts", metaInstagramPostRow(media, null, "2026-10-04"))).toMatchObject({ likes: "51", comments: "4", reach: null, saves: null });
  });

  it("META5 ads by campaign and day: spend exact in the account's currency, results added up", () => {
    const row = asRecord(
      "meta_ads_daily",
      metaAdsRow(
        {
          campaign_id: "120200000000001",
          campaign_name: "Spring nose prints",
          account_currency: "NZD",
          spend: "12.34",
          impressions: "2150",
          reach: "1600",
          clicks: "41",
          inline_link_clicks: "30",
          results: [{ indicator: "actions:link_click", values: [{ value: "30" }] }],
          date_start: "2026-10-30",
        },
        "2026-10-24",
      ),
    );
    expect(row).toEqual({
      date: "2026-10-30",
      campaign_id: "120200000000001",
      campaign: "Spring nose prints",
      currency: "NZD",
      spend: "12.34",
      impressions: "2150",
      reach: "1600",
      clicks: "41",
      link_clicks: "30",
      results: "30.00",
      result_type: "Link click",
      may_still_change: "true",
    });
    expect(metaResultType("actions:offsite_conversion.fb_pixel_purchase")).toBe("Purchase");
    expect(() => metaAdsRow({ campaign_id: "1", date_start: "31/10/2026" }, "2026-10-24")).toThrow("can't read");
  });
});

describe("Meta's errors (decisions 1197-1199)", () => {
  const failure = (code: number | null, extra: Partial<MetaFailure> = {}): MetaFailure => ({ status: 400, code, subcode: null, message: "", regainMinutes: null, ...extra });

  it("META6 a password change ends the sign-in, in plain words", () => {
    expect(metaProblemKind(failure(190, { subcode: 460 }))).toBe("signin");
    expect(metaProblemText(failure(190, { subcode: 460 }), "the Page")).toBe("Meta no longer accepts this sign-in (the Facebook password was changed). An admin needs to connect again.");
    expect(metaProblemText(failure(190, { subcode: 463 }), "the Page")).toContain("(it ran out)");
  });

  it("META7 rate limits, permissions, posts without insights and Meta being down are told apart", () => {
    expect(metaProblemKind(failure(80002))).toBe("limit");
    expect(metaProblemKind(failure(4))).toBe("limit");
    expect(metaProblemText(failure(80002, { regainMinutes: 30 }), "the Instagram account's insights")).toContain("Meta says to wait about 30 minutes");
    expect(metaProblemKind(failure(10))).toBe("permission");
    expect(metaProblemKind(failure(200))).toBe("permission");
    expect(metaProblemText(failure(10, { message: "(#10) Not enough permission" }), "the Page's insights")).toContain("Use Check setup");
    expect(metaProblemKind(failure(100, { subcode: 2108006 }))).toBe("no_insights");
    expect(metaProblemKind(failure(100))).toBe("other");
    expect(metaProblemKind(failure(2))).toBe("busy");
    expect(metaProblemKind(failure(null, { status: 503 }))).toBe("busy");
  });
});

describe("Meta tables and the Social media report (decisions 1193, 1203)", () => {
  const tables = META_TABLES.map((table) => ({ name: table.table, columns: metaTableColumns(table) }));

  it("META5 the tables have plain names and their own prefix", () => {
    expect(META_TABLES.every((table) => isMetaTable(table.table))).toBe(true);
    for (const table of META_TABLES) for (const column of table.columns) expect(column.name).toMatch(/^[a-z][a-z_]*$/);
    expect(tableLabel("meta_instagram_daily")).toBe("Instagram by day");
    expect(tableDescription("meta_ads_daily")).toContain("ad account's currency");
    expect(loadKeyOf("meta_facebook_posts")).toEqual({ tableName: "meta_*", sourceless: true });
    expect(mayChangeSql("meta_facebook_daily")).toBe('select cast(min("date") as VARCHAR) as changing from "meta_facebook_daily" where "may_still_change"');
    // The follower snapshots never change once noted.
    expect(mayChangeSql("meta_instagram_followers")).toBeNull();
    const report = combineFreshness(
      [{ name: "Meta (Facebook and Instagram)", tables: ["meta_facebook_daily"], refreshedAt: "2026-10-31T20:05:00Z", failedAt: null, running: false }],
      new Map([["meta_facebook_daily", "2026-10-31"]]),
      new Map([["meta_facebook_daily", "2026-10-29"]]),
    );
    expect(freshnessText(report.sources[0])).toMatch(/data up to 31 Oct 2026\. Meta may still change the days from 29 Oct 2026\.$/);
  });

  it("META9 the Social media template is offered with the Page loaded; Instagram and ads tiles only when they are", () => {
    const pageOnly = tables.filter((table) => table.name.startsWith("meta_facebook_"));
    expect(buildTemplate("social", tables.filter((table) => table.name === "meta_facebook_daily"), "2026-10-31")).toBeNull();
    const small = buildTemplate("social", pageOnly, "2026-10-31")!;
    expect(small.tiles.map((tile) => tile.title)).toEqual([
      "Social media",
      "Facebook followers",
      "Facebook reach",
      "Facebook followers over time",
      "Facebook reach and engagement by week",
      "Top Facebook posts",
    ]);
    const full = buildTemplate("social", tables, "2026-10-31")!;
    expect(full.tiles.map((tile) => tile.title)).toEqual(expect.arrayContaining(["Instagram followers", "Top Instagram posts", "Ad spend", "Cost per click", "Ad spend against clicks by week", "Spend by campaign"]));
    const known = new Map(tables.map((table) => [table.name, table.columns.map((column) => ({ name: column.name, type: column.type }))]));
    for (const tile of full.tiles) {
      if (tile.query) expect(() => parseTileQuery(tile.query, known)).not.toThrow();
      if (tile.format) expect(() => parseChartFormat(tile.format)).not.toThrow();
    }
    const spend = full.tiles.find((tile) => tile.title === "Ad spend")!.query!.measures[0];
    expect(spend).toMatchObject({ field: "spend", currencyField: "currency" });
    const followers = full.tiles.find((tile) => tile.title === "Instagram followers")!.query!.measures[0];
    expect(followers).toMatchObject({ snapshot: {}, where: [{ field: "followers", op: "not_blank" }] });
  });
});
