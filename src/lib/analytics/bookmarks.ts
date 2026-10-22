import { ValidationError } from "@/lib/errors";
import { isDatePreset, type DatePreset } from "@/lib/analytics/date-ranges";
import { parseRanges, type SlicerRange } from "@/lib/analytics/slicers";

/**
 * Bookmarks (#376 phase 3, decision 759; Power BI's bookmarks): a saved
 * page, dates, slicer choices and hidden tiles, opened from the bookmark
 * list or a button. A bookmark only sets what a reader could choose
 * themselves: its slicer values are kept only for the report's own slicers,
 * and they go through the same server checks as any choice (decision 756),
 * so a bookmark can't show a report viewer anything more.
 */

export type BookmarkState = {
  page: string;
  from: string | null;
  to: string | null;
  preset: DatePreset | null;
  values: Record<string, string[]>;
  ranges: Record<string, SlicerRange>;
  /** Tiles hidden while the bookmark is open (visibility, not access). */
  hidden?: string[];
};
export type Bookmark = { id: string; name: string; state: BookmarkState };
export const MAX_BOOKMARKS = 20;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9-]{1,40}$/;

type Allowed = { pageIds: Set<string>; tileIds: Set<string>; valueFields: Set<string>; rangeFields: Set<string> };

export function parseBookmarks(input: unknown, allowed: Allowed): Bookmark[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) throw new ValidationError("The bookmarks aren't set up properly.");
  if (input.length > MAX_BOOKMARKS) throw new ValidationError(`A report can have up to ${MAX_BOOKMARKS} bookmarks.`);
  const seen = new Set<string>();
  const bookmarks = input.map((entry, index): Bookmark => {
    const raw = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const id = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : "";
    if (!id || seen.has(id)) throw new ValidationError(`Bookmark ${index + 1} needs its own id.`);
    seen.add(id);
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name || name.length > 60) throw new ValidationError(`Bookmark ${index + 1}: give it a name (up to 60 characters).`);
    return { id, name, state: parseBookmarkState(raw.state, allowed, name) };
  });
  return bookmarks.length ? bookmarks : undefined;
}

export function parseBookmarkState(input: unknown, allowed: Allowed, name: string): BookmarkState {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const page = typeof raw.page === "string" && allowed.pageIds.has(raw.page) ? raw.page : [...allowed.pageIds][0];
  const date = (value: unknown, label: string) => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !DATE.test(value)) throw new ValidationError(`${name}: ${label} is YYYY-MM-DD.`);
    return value;
  };
  const values: Record<string, string[]> = {};
  if (raw.values && typeof raw.values === "object") {
    for (const [field, list] of Object.entries(raw.values as Record<string, unknown>)) {
      // Only the report's own slicers: a bookmark can't filter by another column.
      if (!allowed.valueFields.has(field) || !Array.isArray(list) || list.length === 0) continue;
      values[field] = list.slice(0, 200).map(String);
    }
  }
  const ranges = Object.fromEntries(Object.entries(parseRanges(raw.ranges)).filter(([field]) => allowed.rangeFields.has(field)));
  const hidden = Array.isArray(raw.hidden) ? [...new Set(raw.hidden.map(String))].filter((id) => allowed.tileIds.has(id)) : [];
  return {
    page,
    from: date(raw.from, "its From date"),
    to: date(raw.to, "its To date"),
    preset: isDatePreset(raw.preset) ? raw.preset : null,
    values,
    ranges,
    ...(hidden.length ? { hidden } : {}),
  };
}

/** A bookmark's name that isn't taken yet: "Bookmark 1", "Bookmark 2"… */
export function bookmarkName(bookmarks: Bookmark[] | undefined): string {
  const names = new Set((bookmarks ?? []).map((bookmark) => bookmark.name));
  let number = (bookmarks?.length ?? 0) + 1;
  while (names.has(`Bookmark ${number}`)) number += 1;
  return `Bookmark ${number}`;
}
