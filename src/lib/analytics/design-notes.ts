import type { Tile } from "@/lib/analytics/dashboards";
import { reportPages, tilePage, type ReportPage } from "@/lib/analytics/pages";
import type { QueryResult } from "@/lib/analytics/query";

/**
 * Design notes (#691, decision 1625): what a person would notice on looking
 * at the report, said in words, because the AI that built it can't see it.
 * Each is a suggestion with a way to fix it, never a refusal: the report is
 * saved either way.
 *
 * `results` holds the answers of the tiles that were run (after a change,
 * only the new or changed ones); a tile without one gets only the notes that
 * its definition alone can give.
 */
export type DesignNote = {
  /** The tile it's about; left out for a note about a whole page. */
  tileId?: string;
  title?: string;
  page?: string;
  note: string;
  /** What to change, in the words of the tile's own settings. */
  fix: string;
};

export const MAX_DESIGN_NOTES = 12;
const MAX_SLICES = 6;
const MAX_BARS = 20;
const MAX_TILES_WITHOUT_TEXT = 8;

const ROUND = new Set(["pie", "donut"]);
const BARS = new Set(["bar", "column"]);
const TREND = new Set(["line", "area"]);
/** Visuals that read well in a quarter-width tile. */
const SMALL_IS_FINE = new Set(["kpi", "gauge", "bullet", "table", "pivot"]);
/** Tiles that aren't a chart or table of figures. */
const ITEMS = new Set(["text", "image", "shape", "button", "report"]);

function numbers(result: QueryResult, key: string): number[] {
  return result.rows.flatMap((row) => {
    const value = row[key];
    if (value === null || value === undefined) return [];
    const number = Number(value);
    return Number.isFinite(number) ? [Math.abs(number)] : [];
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function compared(tile: Tile): boolean {
  const first = tile.query?.measures[0];
  return Boolean(first?.compare) || tile.format?.kpi?.target !== undefined;
}

/**
 * A balance (cash in bank, what's owed) or a figure worked out from one is a
 * position on a day, not a period's total, so it isn't expected to carry a
 * comparison with the period before.
 */
function isBalance(tile: Tile): boolean {
  const first = tile.query?.measures[0] as { asAt?: unknown; snapshot?: unknown; inputs?: Array<{ asAt?: unknown; snapshot?: unknown }> } | undefined;
  if (!first) return false;
  return Boolean(first.asAt || first.snapshot || first.inputs?.some((input) => input.asAt || input.snapshot));
}

/** Key figures that could carry a comparison: a period's total, with dates to compare. */
function comparable(tile: Tile): boolean {
  return tile.visual === "kpi" && Boolean(tile.query?.dateField) && !tile.format?.kpi?.multi && !isBalance(tile);
}

function tileNotes(tile: Tile, result: QueryResult | undefined): Array<Pick<DesignNote, "note" | "fix">> {
  const notes: Array<Pick<DesignNote, "note" | "fix">> = [];
  const query = tile.query;
  if (!query || ITEMS.has(tile.visual)) return notes;
  const rows = result && !result.pivot ? result.rows.length : null;

  if (tile.visual === "kpi") {
    if (!compared(tile) && comparable(tile)) {
      notes.push({
        note: "A key figure on its own, with nothing to compare it with.",
        fix: `Set compare to "previous_period" or "previous_year" on its first value${query.sparkline ? "" : ", and sparkline: true on the query for a small trend"}.`,
      });
    }
    return notes;
  }

  if (ROUND.has(tile.visual) && rows !== null && rows > MAX_SLICES) {
    notes.push({
      note: `A ${tile.visual} with ${rows} slices: past about ${MAX_SLICES} the small ones can't be told apart.`,
      fix: `Sort by value and set limit to ${MAX_SLICES - 1}, or make it a bar chart.`,
    });
  }
  if (BARS.has(tile.visual) && rows !== null && !query.groupBy?.grain && rows > MAX_BARS) {
    notes.push({
      note: `${rows} ${tile.visual === "bar" ? "bars" : "columns"}: the labels will crowd.`,
      fix: "Sort by value with a limit (the top 10, say), or make it a table.",
    });
  }
  if (TREND.has(tile.visual) && rows !== null && rows > 0 && rows < 3 && !query.breakdown) {
    notes.push({
      note: `A ${tile.visual} chart with only ${rows} point${rows === 1 ? "" : "s"} in these dates: there is no trend to see.`,
      fix: "Use a finer grain (month rather than year), wider dates, or a key figure.",
    });
  }
  if (BARS.has(tile.visual) && result && !result.pivot && query.measures.length === 1 && !query.breakdown) {
    const values = numbers(result, "m0");
    const middle = values.length >= 4 ? median(values) : 0;
    const largest = Math.max(0, ...values);
    if (middle > 0 && largest > middle * 10) {
      notes.push({
        note: "One value is more than ten times the usual one, so the other bars are flattened.",
        fix: "Filter that group out into its own key figure, or show the values as a table.",
      });
    }
  }
  if (tile.width === "quarter" && !SMALL_IS_FINE.has(tile.visual) && rows !== null && rows > 4) {
    notes.push({
      note: "A chart in a quarter-width tile is cramped: axis labels and legends are cut short.",
      fix: 'Set width to "third" or "half", or make it a key figure.',
    });
  }
  return notes;
}

/** A row of key figures reads best when each has the same parts. */
function unevenKeyFigures(tiles: Tile[]): Pick<DesignNote, "note" | "fix"> | null {
  const figures = tiles.filter(comparable);
  if (figures.length < 2) return null;
  const withComparison = figures.filter(compared);
  if (withComparison.length === 0 || withComparison.length === figures.length) return null;
  const without = figures.filter((tile) => !compared(tile)).map((tile) => tile.title);
  return {
    note: `Some key figures on this page have a comparison and some don't (${without.join(", ")}), so the cards don't match.`,
    fix: "Give each the same compare (and sparkline), or none.",
  };
}

export function designNotes(tiles: Tile[], pages: ReportPage[] | undefined, results: ReadonlyMap<string, QueryResult> = new Map()): DesignNote[] {
  const notes: DesignNote[] = [];
  const named = reportPages(pages);
  const several = named.length > 1;
  for (const page of named) {
    const onPage = tiles.filter((tile) => tilePage(tile, pages) === page.id);
    const where = several ? { page: page.name } : {};
    const figures = onPage.filter((tile) => !ITEMS.has(tile.visual));
    if (figures.length > MAX_TILES_WITHOUT_TEXT && !onPage.some((tile) => tile.visual === "text")) {
      notes.push({
        ...where,
        note: `${figures.length} tiles on one page with no heading or notes between them: it reads as a wall of charts.`,
        fix: "Add a text tile as a section heading, or move some tiles to a second page.",
      });
    }
    const uneven = unevenKeyFigures(onPage);
    if (uneven) notes.push({ ...where, ...uneven });
    // A key figure's own "nothing to compare" note is the page's note when the page already has one.
    for (const tile of onPage) {
      for (const entry of tileNotes(tile, results.get(tile.id))) {
        if (uneven && tile.visual === "kpi") continue;
        notes.push({ tileId: tile.id, title: tile.title, ...where, ...entry });
      }
    }
  }
  return notes.slice(0, MAX_DESIGN_NOTES);
}
