import { ValidationError } from "@/lib/errors";
import { columnKind } from "@/lib/analytics/filters";
import type { Filter } from "@/lib/analytics/query";

/**
 * Slicer styles (#376 phase 3, decision 757; Power BI's slicer styles and
 * Looker Studio's controls). Every style filters by the slicer's own column
 * only. Number and date ranges become ordinary filters on the server, and
 * only for the report's own range slicers, so a reader can't filter by
 * anything else (decision 756).
 */

export const SLICER_STYLES = ["list", "dropdown", "single", "search", "range", "dates", "relative", "hierarchy"] as const;
export type SlicerStyle = (typeof SLICER_STYLES)[number];
export const SLICER_STYLE_LABELS: Record<SlicerStyle, string> = {
  list: "Tick boxes in a menu (several)",
  dropdown: "Drop-down list (one)",
  single: "Buttons (one at a time)",
  search: "Search and tick (several)",
  range: "Number range (between)",
  dates: "Date range (between)",
  relative: "Relative dates (the last days or months)",
  hierarchy: "Two levels (e.g. region, then town)",
};

/** Which styles suit a column: lists for text and Yes/No, ranges for numbers, dates for dates. */
export function stylesFor(type: string): SlicerStyle[] {
  const kind = columnKind(type);
  if (kind === "number") return ["range", "list", "dropdown", "single", "search"];
  if (kind === "date") return ["dates", "relative"];
  return ["list", "dropdown", "single", "search", "hierarchy"];
}

export type SlicerLook = { size?: "small" | "large"; width?: "wide" };

export type SlicerSetting = {
  table: string;
  field: string;
  label: string;
  /** Left out: tick boxes in a menu, as slicers always were. */
  style?: SlicerStyle;
  /** The second level of a hierarchy slicer: a column of the same table. */
  child?: string;
  /** The pages it shows on and filters; left out, every page (synced, decision 757). */
  pages?: string[];
  look?: SlicerLook;
};

/** A range slicer's choice: between two numbers or dates, or the last so many days or months. */
export type SlicerRange = { min?: string; max?: string; last?: { count: number; unit: "days" | "months" } };

const NUMBER = /^-?\d{1,15}(\.\d{1,6})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isRangeStyle(style: SlicerStyle | undefined): boolean {
  return style === "range" || style === "dates" || style === "relative";
}

/** Checks a slicer's style, levels, pages and look as it's saved. */
export function parseSlicerExtras(raw: Record<string, unknown>, type: string, columns: Map<string, string>, pageIds: Set<string>, label: string): Omit<SlicerSetting, "table" | "field" | "label"> {
  const result: Omit<SlicerSetting, "table" | "field" | "label"> = {};
  if (raw.style !== undefined && raw.style !== null && raw.style !== "list") {
    const style = raw.style as SlicerStyle;
    if (!SLICER_STYLES.includes(style)) throw new ValidationError(`${label}: choose the slicer's style from the list.`);
    if (!stylesFor(type).includes(style)) throw new ValidationError(`${label}: that style doesn't suit this column.`);
    result.style = style;
  } else if (!stylesFor(type).includes("list")) {
    // A date slicer was never saved before, so this only guards new ones.
    throw new ValidationError(`${label}: choose a date range or relative dates for a date column.`);
  }
  if (result.style === "hierarchy") {
    const child = typeof raw.child === "string" ? raw.child : "";
    if (!columns.has(child) || child === raw.field) throw new ValidationError(`${label}: choose the second level, another column of the same table.`);
    if (columnKind(columns.get(child)!) !== "text") throw new ValidationError(`${label}: the second level should be a text column.`);
    result.child = child;
  }
  if (raw.pages !== undefined && raw.pages !== null) {
    if (!Array.isArray(raw.pages) || raw.pages.length === 0) throw new ValidationError(`${label}: choose the pages it shows on, or every page.`);
    const pages = [...new Set(raw.pages.map(String))];
    if (pages.some((page) => !pageIds.has(page))) throw new ValidationError(`${label}: one of its pages isn't in this report.`);
    if (pages.length < pageIds.size) result.pages = pages;
  }
  const look = (raw.look && typeof raw.look === "object" ? raw.look : {}) as Record<string, unknown>;
  const size = look.size === "small" || look.size === "large" ? look.size : undefined;
  const width = look.width === "wide" ? "wide" : undefined;
  if (size || width) result.look = { ...(size ? { size } : {}), ...(width ? { width } : {}) };
  return result;
}

/** Whether a slicer shows on (and filters) a page. */
export function slicerOnPage(slicer: Pick<SlicerSetting, "pages">, pageId: string): boolean {
  return !slicer.pages || slicer.pages.includes(pageId);
}

/** The fields a slicer may filter by value: its own, and a hierarchy's second level. */
export function slicerValueFields(slicers: SlicerSetting[]): Set<string> {
  return new Set(slicers.flatMap((slicer) => (isRangeStyle(slicer.style) ? [] : [slicer.field, ...(slicer.child ? [slicer.child] : [])])));
}

/** A range choice from a request, shape only. */
export function parseRanges(input: unknown): Record<string, SlicerRange> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const result: Record<string, SlicerRange> = {};
  for (const [field, value] of Object.entries(input as Record<string, unknown>).slice(0, 12)) {
    const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const range: SlicerRange = {};
    if (typeof raw.min === "string" && raw.min.trim()) range.min = raw.min.trim();
    if (typeof raw.max === "string" && raw.max.trim()) range.max = raw.max.trim();
    const last = (raw.last && typeof raw.last === "object" ? raw.last : null) as Record<string, unknown> | null;
    if (last) {
      const count = Number(last.count);
      const unit = last.unit === "months" ? "months" : last.unit === "days" ? "days" : null;
      if (!unit || !Number.isInteger(count) || count < 1 || count > (unit === "days" ? 3660 : 120)) throw new ValidationError("Choose how many days or months.");
      range.last = { count, unit };
    }
    if (Object.keys(range).length) result[field] = range;
  }
  return result;
}

/**
 * The filters a reader's range slicers add: only for the report's own
 * number, date and relative date slicers (others are left out), each kept
 * to tiles whose table has the column.
 */
export function rangeFilters(slicers: SlicerSetting[], ranges: Record<string, SlicerRange>): Filter[] {
  const filters: Filter[] = [];
  for (const slicer of slicers) {
    if (!isRangeStyle(slicer.style)) continue;
    const range = ranges[slicer.field];
    if (!range) continue;
    const valid = slicer.style === "range" ? NUMBER : DATE;
    if (slicer.style === "relative") {
      if (range.last) filters.push({ field: slicer.field, op: range.last.unit === "days" ? "last_days" : "last_months", value: String(range.last.count) });
      continue;
    }
    for (const [bound, op] of [["min", "gte"], ["max", "lte"]] as const) {
      const value = range[bound];
      if (value === undefined) continue;
      if (!valid.test(value)) throw new ValidationError(`${slicer.label}: ${slicer.style === "range" ? "enter a number" : "dates are YYYY-MM-DD"}.`);
      filters.push({ field: slicer.field, op, value });
    }
  }
  return filters;
}

/** What a range slicer says it's set to, for its button and the filter list. */
export function rangeText(style: SlicerStyle | undefined, range: SlicerRange | undefined, show: (value: string) => string = (value) => value): string {
  if (!range) return "All";
  if (style === "relative") return range.last ? `Last ${range.last.count} ${range.last.count === 1 ? range.last.unit.slice(0, -1) : range.last.unit}` : "All";
  if (range.min && range.max) return `${show(range.min)} to ${show(range.max)}`;
  if (range.min) return `From ${show(range.min)}`;
  if (range.max) return `Up to ${show(range.max)}`;
  return "All";
}
