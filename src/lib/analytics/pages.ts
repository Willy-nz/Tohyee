import { ValidationError } from "@/lib/errors";
import { hexColour } from "@/lib/analytics/chart-format";

/**
 * Report pages (#376 phase 3, decision 753; Power BI's report pages,
 * Looker Studio's pages). A report with no pages is one page, as every
 * report was before; its tiles have no page. With pages, each tile names
 * the page it's on, and a tile whose page has gone lands on the first.
 */

export const PAGE_WIDTHS = ["full", "wide", "narrow"] as const;
export type PageWidth = (typeof PAGE_WIDTHS)[number];
export const PAGE_WIDTH_LABELS: Record<PageWidth, string> = {
  full: "Fit the screen",
  wide: "Wide (up to 1,280 pixels)",
  narrow: "Narrow, like a document (up to 960 pixels)",
};
/** The widest each page width draws, in pixels (none for "full"). */
export const PAGE_MAX_WIDTHS: Record<PageWidth, number | null> = { full: null, wide: 1280, narrow: 960 };

export type ReportPage = {
  id: string;
  name: string;
  /** Left out: fits the screen. */
  width?: PageWidth;
  /** Behind the page's tiles: shaded, or any colour (it gets a dark version like other chosen colours). Left out, the theme's. */
  background?: "tinted" | string;
  /** Not in the page tabs: reached only by drill-through or a button (Power BI's hidden pages). */
  hidden?: boolean;
  /** Other pages' groups can be drilled through to it, showing it filtered to the group (decision 756). */
  drillThrough?: boolean;
};

export const MAX_PAGES = 12;
const ID = /^[a-z0-9-]{1,40}$/;

/** The report's pages; a report without pages has one, unnamed in the list ("Page 1"). */
export function reportPages(pages: ReportPage[] | undefined): ReportPage[] {
  return pages?.length ? pages : [{ id: FIRST_PAGE, name: "Page 1" }];
}
/** The id the single page of a report without pages answers to. */
export const FIRST_PAGE = "page-1";

/** Checks the pages a report is saved with (unknown settings dropped, wrong ones refused). */
export function parsePages(input: unknown): ReportPage[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) throw new ValidationError("The pages aren't set up properly.");
  if (input.length > MAX_PAGES) throw new ValidationError(`A report can have up to ${MAX_PAGES} pages.`);
  const seen = new Set<string>();
  const pages = input.map((entry, index): ReportPage => {
    const raw = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const id = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : "";
    if (!id || seen.has(id)) throw new ValidationError(`Page ${index + 1} needs its own id.`);
    seen.add(id);
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name || name.length > 40) throw new ValidationError(`Page ${index + 1}: give it a name (up to 40 characters).`);
    if (raw.width !== undefined && raw.width !== null && !PAGE_WIDTHS.includes(raw.width as PageWidth)) throw new ValidationError(`${name}: choose the page's width from the list.`);
    const width = raw.width && raw.width !== "full" ? (raw.width as PageWidth) : undefined;
    const background = raw.background === undefined || raw.background === null || raw.background === "" ? undefined : raw.background === "tinted" ? "tinted" : hexColour(raw.background, `${name} background`);
    return { id, name, ...(width ? { width } : {}), ...(background ? { background } : {}), ...(raw.hidden === true ? { hidden: true } : {}), ...(raw.drillThrough === true ? { drillThrough: true } : {}) };
  });
  if (pages.length && pages.every((page) => page.hidden)) throw new ValidationError("At least one page has to show in the page tabs.");
  // One page with nothing set is the same as no pages.
  if (pages.length === 1 && !pages[0].width && !pages[0].background && !pages[0].drillThrough && pages[0].name === "Page 1") return undefined;
  return pages.length ? pages : undefined;
}

/** The page a tile is on: its own, if the report has it, or the first. */
export function tilePage(tile: { page?: string }, pages: ReportPage[] | undefined): string {
  const list = reportPages(pages);
  return tile.page && list.some((page) => page.id === tile.page) ? tile.page : list[0].id;
}

/** A tile's page as it's saved: left out on the first page of a report, so older reports keep working unchanged. */
export function pageForSaving(page: unknown, pages: ReportPage[] | undefined): string | undefined {
  if (!pages?.length || typeof page !== "string") return undefined;
  return pages.some((entry) => entry.id === page) && page !== pages[0].id ? page : undefined;
}

export function tilesOnPage<T extends { page?: string }>(tiles: T[], pages: ReportPage[] | undefined, pageId: string): T[] {
  return tiles.filter((tile) => tilePage(tile, pages) === pageId);
}

/** The page to open: the one asked for (e.g. from the address), if it exists, otherwise the first that shows in the tabs. */
export function openingPage(pages: ReportPage[] | undefined, wanted: string | null | undefined): ReportPage {
  const list = reportPages(pages);
  return list.find((page) => page.id === wanted) ?? list.find((page) => !page.hidden) ?? list[0];
}

/** A new page's id and name, not used by any page yet. */
export function newPage(pages: ReportPage[] | undefined, id: string): ReportPage {
  const list = reportPages(pages);
  const names = new Set(list.map((page) => page.name));
  let number = list.length + 1;
  while (names.has(`Page ${number}`)) number += 1;
  return { id, name: `Page ${number}` };
}

export type PagesChange<T> = { pages: ReportPage[] | undefined; tiles: T[] };

/** Adds a page after the others. The report's first page keeps its id, so its tiles stay put. */
export function addPage<T extends { page?: string }>(pages: ReportPage[] | undefined, tiles: T[], id: string): PagesChange<T> {
  const list = reportPages(pages);
  if (list.length >= MAX_PAGES) throw new ValidationError(`A report can have up to ${MAX_PAGES} pages.`);
  return { pages: [...list, newPage(pages, id)], tiles };
}

/**
 * Removes a page and the tiles on it (the report must keep a page). The
 * first page's tiles are saved without a page, so removing the first page
 * gives its place to the next one: their tiles are moved onto it by id.
 */
export function removePage<T extends { page?: string }>(pages: ReportPage[] | undefined, tiles: T[], pageId: string): PagesChange<T> {
  const list = reportPages(pages);
  if (list.length <= 1) throw new ValidationError("A report keeps at least one page.");
  const left = list.filter((page) => page.id !== pageId);
  if (left.every((page) => page.hidden)) left[0] = { ...left[0], hidden: undefined };
  const kept = tiles.filter((tile) => tilePage(tile, list) !== pageId).map((tile) => withPage(tile, tilePage(tile, list), left));
  return { pages: left.length === 1 && left[0].name === "Page 1" && !left[0].width && !left[0].background ? undefined : left, tiles: kept };
}

/** Moves a page earlier or later; tiles keep their pages. */
export function movePage<T extends { page?: string }>(pages: ReportPage[] | undefined, tiles: T[], pageId: string, by: -1 | 1): PagesChange<T> {
  const list = reportPages(pages);
  const from = list.findIndex((page) => page.id === pageId);
  const to = from + by;
  if (from < 0 || to < 0 || to >= list.length) return { pages, tiles };
  const next = [...list];
  [next[from], next[to]] = [next[to], next[from]];
  // Pages are named on tiles by id, except the first page's (none): give those its id first.
  const named = tiles.map((tile) => ({ ...tile, page: tilePage(tile, list) }));
  return { pages: next, tiles: named.map((tile) => withPage(tile, tile.page, next)) };
}

/** A tile on a page, saved as `pageForSaving` would. */
export function withPage<T extends { page?: string }>(tile: T, pageId: string, pages: ReportPage[] | undefined): T {
  const copy = { ...tile };
  delete copy.page;
  const page = pageForSaving(pageId, pages);
  return page ? { ...copy, page } : copy;
}
