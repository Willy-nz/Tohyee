import type { PivotColumn, PivotData, PivotRow } from "@/lib/analytics/query";

/**
 * Pivot table (matrix) layout helpers (#376 phase 2, decision 682): the
 * stepped layout, expanding and collapsing row groups, and the header rows
 * for nested column fields. Pure functions, so the screen and its tests
 * agree; the figures themselves come from the server unchanged.
 */

/**
 * Rows for the stepped layout (Power BI's matrix): each group's subtotal row
 * moves above its rows, so it reads as the group's heading; the grand total
 * stays last. Rows arrive with each subtotal after its group.
 */
export function steppedRows(rows: PivotRow[], levels: number): PivotRow[] {
  const grand = rows.filter((row) => row.kind === "grand_total");
  const body = rows.filter((row) => row.kind !== "grand_total");
  const place = (list: PivotRow[], level: number): PivotRow[] => {
    if (level >= levels - 1) return list;
    const out: PivotRow[] = [];
    let at = 0;
    while (at < list.length) {
      const key = JSON.stringify(list[at].dimensions[level] ?? null);
      const group: PivotRow[] = [];
      while (at < list.length && JSON.stringify(list[at].dimensions[level] ?? null) === key) group.push(list[at++]);
      const heading = group.find((row) => row.kind === "subtotal" && row.depth === level + 1);
      out.push(...(heading ? [heading] : []), ...place(group.filter((row) => row !== heading), level + 1));
    }
    return out;
  };
  return [...place(body, 0), ...grand];
}

/** A group a person can open or close: a subtotal row (its key). */
export function isGroupRow(row: PivotRow, levels: number): boolean {
  return row.kind === "subtotal" && row.depth < levels;
}

/** The rows still shown with these groups closed: everything inside a closed group is hidden, the group's own row stays. */
export function visibleWithCollapsed(rows: PivotRow[], collapsed: ReadonlySet<string>): PivotRow[] {
  if (!collapsed.size) return rows;
  const closed = rows.filter((row) => collapsed.has(row.key) && row.kind === "subtotal");
  return rows.filter((row) =>
    !closed.some((group) => row !== group && row.kind !== "grand_total" && row.depth > group.depth && group.dimensions.slice(0, group.depth).every((value, index) => value === row.dimensions[index])),
  );
}

/** The groups closed to start with: every group at or below the level shown open (1 is the first row field); all open when left out. */
export function initiallyCollapsed(rows: PivotRow[], levels: number, expandTo: number | undefined): Set<string> {
  if (!expandTo || expandTo >= levels) return new Set();
  return new Set(rows.filter((row) => isGroupRow(row, levels) && row.depth >= expandTo).map((row) => row.key));
}

export type HeaderCell = { key: string; text: string; colSpan: number; rowSpan: number; total?: boolean; level: number };

/**
 * The header rows above the values for nested column fields: one row per
 * column field, a column subtotal's "Total" spanning down the levels below
 * it (under the value it totals, as Power BI's matrix), and the grand
 * total spanning them all. `label(level, value)` names a
 * value of a column field.
 */
export function columnHeaderRows(pivot: PivotData, label: (level: number, value: string | null) => string): HeaderCell[][] {
  const levels = pivot.columnFields?.length ?? (pivot.columnField ? 1 : 0);
  const rows: HeaderCell[][] = Array.from({ length: levels }, () => []);
  const pathOf = (column: PivotColumn): Array<string | null> => column.path ?? [column.pivotValue];
  for (let level = 0; level < levels; level += 1) {
    let previous: string | null = null;
    pivot.columns.forEach((column, index) => {
      if (column.total) {
        if (level > 0) return;
        const last = rows[0][rows[0].length - 1];
        if (last?.total) last.colSpan += 1;
        else rows[0].push({ key: "grand", text: "Grand total", colSpan: 1, rowSpan: levels, total: true, level: 0 });
        previous = null;
        return;
      }
      const path = pathOf(column);
      if (level > path.length) return;
      const key = level < path.length ? `v:${JSON.stringify(path.slice(0, level + 1))}` : `t:${JSON.stringify(path)}`;
      const last = rows[level][rows[level].length - 1];
      if (key === previous && last) {
        last.colSpan += 1;
        return;
      }
      previous = key;
      rows[level].push(
        level < path.length
          ? { key: `${key}:${index}`, text: label(level, path[level]), colSpan: 1, rowSpan: 1, level }
          : { key: `${key}:${index}`, text: "Total", colSpan: 1, rowSpan: levels - level, total: true, level },
      );
    });
  }
  return rows;
}

/** A column's name for exports and screen readers: each column field's value, then "total" for a column subtotal. */
export function columnPathText(column: PivotColumn, label: (level: number, value: string | null) => string): string {
  if (column.total) return "Grand total";
  const path = column.path ?? [column.pivotValue];
  return `${path.map((value, level) => label(level, value)).join(" › ")}${column.subtotal ? " total" : ""}`;
}
