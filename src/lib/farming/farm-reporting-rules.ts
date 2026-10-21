import { add, dec, type Decimal, divide, isPositive, isZero, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/*
 * Farm-level reporting (#390; examples FR1-FR8, decision 743). As Xero does
 * with tracking categories: a ledger line counts for a farm when it's tagged
 * with the farm's value (or one under it) in the category Farming uses.
 * Everything else is "Not allocated": shown, never spread. The farms and Not
 * allocated always add up to the total, which is the organisation's figures
 * (FK3). A farm's per-unit figures use only that farm's own figures; the
 * organisation's figures are never divided among farms or used for one.
 * Pure: tested in tests/unit/farm-reporting.test.ts.
 */

/** The physical figures that per-unit amounts divide by (FK2). */
export type Figures = { effectiveHa: string | null; peakCows: number | null; stockUnits: string | null; milkSolidsKg: string | null };

/** An amount, and per kgMS, hectare, cow and stock unit (null when that figure isn't entered). */
export type PerUnit = { amount: string; perKgMs: string | null; perHa: string | null; perCow: string | null; perSu: string | null };

/** Per kgMS, ha, cow and su, rounded half up to 2 places; null where a figure isn't entered (FK3, FK4). */
export function perUnit(amount: Decimal, figures: Figures | null): PerUnit {
  const per = (figure: string | number | null | undefined) =>
    figure === null || figure === undefined || !isPositive(dec(String(figure))) ? null : toFixedString(divide(amount, dec(String(figure)), 2), 2);
  return {
    amount: toFixedString(amount, 2),
    perKgMs: per(figures?.milkSolidsKg),
    perHa: per(figures?.effectiveHa),
    perCow: per(figures?.peakCows),
    perSu: per(figures?.stockUnits),
  };
}

export type ReportingLine = {
  accountId: string;
  accountType: string;
  accountClass: string;
  /** The farm the line's tag belongs to; null when untagged or tagged with a value no farm is linked to. */
  farmId: string | null;
  /** In the account's natural direction (revenue credit, expense debit positive). */
  amount: string;
};

export type ReportingColumn = { key: string; label: string; farmId: string | null; kind: "farm" | "not_allocated" | "total"; figures: Figures | null };

export type ReportingRow = { key: string; label: string; total: boolean; cells: Record<string, PerUnit> };

export type FarmSplit = { columns: ReportingColumn[]; rows: ReportingRow[] };

/**
 * Splits gross farm revenue, each working-expense group, farm working
 * expenses and operating surplus by farm (FR2-FR4), with Not allocated and
 * the total. `groups` is the FWE groups in display order; `grouping` maps an
 * expense account to its group (FK1).
 */
export function splitByFarm(input: {
  lines: ReportingLine[];
  grouping: Map<string, string>;
  groups: ReadonlyArray<{ key: string; label: string }>;
  farms: Array<{ id: string; name: string; figures: Figures | null }>;
  organisationFigures: Figures | null;
}): FarmSplit {
  const columns: ReportingColumn[] = [
    ...input.farms.map((farm) => ({ key: farm.id, label: farm.name, farmId: farm.id, kind: "farm" as const, figures: farm.figures })),
    { key: "none", label: "Not allocated", farmId: null, kind: "not_allocated", figures: null },
    { key: "total", label: "Total", farmId: null, kind: "total", figures: input.organisationFigures },
  ];
  const known = new Set(input.farms.map((farm) => farm.id));
  const zero = () => Object.fromEntries(columns.map((column) => [column.key, ZERO_DECIMAL])) as Record<string, Decimal>;
  const revenue = zero();
  const byGroup = new Map<string, Record<string, Decimal>>();
  const put = (totals: Record<string, Decimal>, farmId: string | null, amount: Decimal) => {
    const key = farmId !== null && known.has(farmId) ? farmId : "none";
    totals[key] = add(totals[key], amount);
    totals.total = add(totals.total, amount);
  };
  for (const line of input.lines) {
    const amount = dec(line.amount);
    if (isZero(amount)) continue;
    if (line.accountType === "revenue") put(revenue, line.farmId, amount);
    if (line.accountClass !== "expense") continue;
    const group = input.grouping.get(line.accountId);
    if (!group) continue;
    const totals = byGroup.get(group) ?? zero();
    put(totals, line.farmId, amount);
    byGroup.set(group, totals);
  }
  const fwe = zero();
  for (const totals of byGroup.values()) for (const column of columns) fwe[column.key] = add(fwe[column.key], totals[column.key]);
  const surplus = Object.fromEntries(columns.map((column) => [column.key, sub(revenue[column.key], fwe[column.key])])) as Record<string, Decimal>;
  // Not allocated has no figures to divide by, so no per-unit amounts.
  const cells = (totals: Record<string, Decimal>) => Object.fromEntries(columns.map((column) => [column.key, perUnit(totals[column.key], column.figures)]));
  const rows: ReportingRow[] = [{ key: "revenue", label: "Gross farm revenue", total: true, cells: cells(revenue) }];
  for (const group of input.groups) {
    const totals = byGroup.get(group.key);
    if (totals) rows.push({ key: group.key, label: group.label, total: false, cells: cells(totals) });
  }
  rows.push({ key: "fwe", label: "Farm working expenses", total: true, cells: cells(fwe) });
  rows.push({ key: "surplus", label: "Operating surplus", total: true, cells: cells(surplus) });
  return { columns, rows };
}

/**
 * Which farm each tracking value counts for (FR1): a value linked to a farm,
 * and every value under it. Values with no linked farm above them count for
 * no farm.
 */
export function farmForValues(values: Array<{ id: string; parentId: string | null }>, links: Map<string, string>): Map<string, string> {
  const parents = new Map(values.map((value) => [value.id, value.parentId]));
  const result = new Map<string, string>();
  for (const value of values) {
    let at: string | null = value.id;
    const seen = new Set<string>();
    while (at !== null && !seen.has(at)) {
      seen.add(at);
      const farm = links.get(at);
      if (farm) {
        result.set(value.id, farm);
        break;
      }
      at = parents.get(at) ?? null;
    }
  }
  return result;
}
