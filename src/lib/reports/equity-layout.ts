import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, type Decimal, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { ID_PATTERN, list, parseColumns, record, text } from "@/lib/reports/custom";
import {
  CUSTOM_REPORT_LIMITS as LIMITS,
  EQUITY_END_LABELS,
  type CashFlowRow,
  type EquityBlock,
  type EquityEndLabels,
  type EquityLayout,
  periodColumns,
  type ReportColumn,
  type ReportValues,
} from "@/lib/reports/custom-layout";
import { changesInEquity } from "@/lib/reports/statements";

/*
 * Changes in equity layouts (examples CEL1-CEL5). A layout arranges the
 * statement's lines (net profit, each equity account's movement) into
 * headings and groups, renamed, reordered, hidden or with notes, between
 * equity at the start and at the end. The amounts come from the standard
 * statement (SCE1), and any line the layout doesn't place still shows after
 * its rows, so equity at the end is always the start plus every line.
 */

const REF_PATTERN = /^(profit|account:[A-Za-z0-9._-]{1,20})$/;

/** Checks a changes in equity layout (CEL3): ids, labels, each line placed once, equity accounts that exist. */
export async function parseEquityLayout(tx: OrgTx, input: unknown): Promise<EquityLayout> {
  const raw = record(input, "The report");
  if (JSON.stringify(raw).length > 200_000) throw new ValidationError("This report is too big to save.");
  const title = text(raw.title, "The title", LIMITS.titleLength, { required: true });
  const columns = parseColumns("profit_and_loss", raw.columns);
  if (columns.difference || columns.percent || columns.yearToDate || columns.budgetId) throw new ValidationError("A changes in equity report has period columns only.");
  const ids = new Set<string>();
  const placed = new Set<string>();
  const id = (value: unknown, what: string) => {
    if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new ValidationError(`Each ${what} needs an id of letters, numbers, - or _.`);
    if (ids.has(value)) throw new ValidationError(`Two rows share the id ${value}.`);
    ids.add(value);
    return value;
  };
  const extras = (row: Record<string, unknown>) => ({
    ...(row.hidden === true ? { hidden: true } : {}),
    ...(row.pageBreakAfter === true ? { pageBreakAfter: true } : {}),
    ...(typeof row.note === "string" && row.note.trim() ? { note: text(row.note, "A row's note", LIMITS.noteLength, { required: false }) } : {}),
  });
  const blocks = list(raw.blocks, "The rows and notes", LIMITS.rowsPerTable).map((entry): EquityBlock => {
    const row = record(entry, "A row");
    if (row.kind === "text") return { id: id(row.id, "note"), kind: "text", text: text(row.text, "A note", LIMITS.noteLength, { required: true }) };
    const rowId = id(row.id, "row");
    const label = text(row.label, "A row's name", LIMITS.labelLength, { required: true });
    if (row.kind === "heading") return { id: rowId, kind: "heading", label, ...extras(row) };
    if (row.kind !== "group") throw new ValidationError("A row is a heading, a group or a note.");
    const lines = list(row.lines, "A group's lines", 200).map((ref) => {
      if (typeof ref !== "string" || !REF_PATTERN.test(ref)) throw new ValidationError(`${label}: a line must be net profit or an equity account.`);
      if (placed.has(ref)) throw new ValidationError(`${describe(ref)} is in the layout twice. Each line can be placed once.`);
      placed.add(ref);
      return ref;
    });
    return { id: rowId, kind: "group", label, lines, showLines: row.showLines === true, ...extras(row) };
  });
  const codes = [...placed].filter((ref) => ref.startsWith("account:")).map((ref) => ref.slice(8));
  if (codes.length > 0) {
    const found = await tx.query<{ code: string; account_type: string }>("select code, account_type from accounts where code = any($1::text[])", [codes]);
    const types = new Map(found.rows.map((row) => [row.code, row.account_type]));
    const unknown = codes.filter((code) => !types.has(code));
    if (unknown.length > 0) throw new ValidationError(`There's no account ${unknown.join(", ")}.`);
    const other = codes.filter((code) => types.get(code) !== "equity");
    if (other.length > 0) throw new ValidationError(`Account ${other.join(", ")} isn't an equity account.`);
  }
  const endLabels: Partial<EquityEndLabels> = {};
  if (raw.endLabels != null) {
    const labels = record(raw.endLabels, "The start and end lines' names");
    for (const key of Object.keys(EQUITY_END_LABELS) as Array<keyof EquityEndLabels>) {
      if (labels[key] != null && labels[key] !== "") endLabels[key] = text(labels[key], "The start or end line's name", LIMITS.labelLength, { required: true });
    }
  }
  return { title, columns, blocks, ...(Object.keys(endLabels).length ? { endLabels } : {}) };
}

function describe(ref: string): string {
  return ref === "profit" ? "Net profit" : `Account ${ref.slice(8)}`;
}

export type EquityFigureLine = { ref: string; label: string; values: ReportValues };
export type EquityFigureRow = {
  id: string;
  kind: "heading" | "group";
  label: string;
  values: ReportValues;
  lines: EquityFigureLine[];
  showLines: boolean;
  hidden?: boolean;
  pageBreakAfter?: boolean;
  note?: string;
  /** Not placed by the layout: shown after its rows (CEL2). */
  unplaced?: boolean;
};
export type EquityFigures = {
  title: string;
  base: "changes_in_equity";
  currencyCode: string;
  columns: ReportColumn[];
  opening: { label: string; values: ReportValues };
  blocks: Array<EquityFigureRow | { id: string; kind: "text"; text: string }>;
  closing: { label: string; values: ReportValues };
  /** Equity at the start + every line = equity at the end (the balance sheet's), in every column. */
  reconciles: boolean;
  /** Always empty here: every line is shown (CEL2). Kept so code reading any custom report can read these. */
  notInReport: [];
  inSeveralGroups: [];
  filterLabel?: null;
  data?: undefined;
  computedAt: string;
};

/** Works out a changes in equity layout for each column (CEL1-CEL4). */
export async function computeEquityLayout(tx: OrgTx, layout: EquityLayout, options: { columns?: ReportColumn[] } = {}): Promise<EquityFigures> {
  const columns = (options.columns ?? periodColumns("profit_and_loss", layout.columns)).filter(
    (column) => column.kind === "period" || column.kind === "year_to_date",
  );
  const scale = currencyMinorUnits(tx.baseCurrency);
  const money = (value: Decimal) => toFixedString(value, scale);
  const statements: Array<Awaited<ReturnType<typeof changesInEquity>>> = [];
  for (const column of columns) statements.push(await changesInEquity(tx, { from: column.from, to: column.to }));
  // Every line in any column, in the statement's order.
  const known = new Map<string, string>();
  const amounts = columns.map(() => new Map<string, Decimal>());
  statements.forEach((sce, index) => {
    const items = [{ ref: "profit", label: "Net profit", amount: sce.profit }, ...sce.movements.map((row) => ({ ref: `account:${row.code}`, label: row.label, amount: row.amount }))];
    for (const item of items) {
      if (!known.has(item.ref)) known.set(item.ref, item.label);
      amounts[index].set(item.ref, add(amounts[index].get(item.ref) ?? ZERO_DECIMAL, dec(item.amount)));
    }
  });
  const values = (refs: string[]): ReportValues =>
    Object.fromEntries(
      columns.map((column, index) => [column.key, money(refs.reduce((sum, ref) => add(sum, amounts[index].get(ref) ?? ZERO_DECIMAL), ZERO_DECIMAL))]),
    );
  const figureLine = (ref: string): EquityFigureLine => ({ ref, label: known.get(ref) ?? describe(ref), values: values([ref]) });
  const placed = new Set(layout.blocks.flatMap((block) => (block.kind === "group" ? block.lines : [])));

  const blocks: EquityFigures["blocks"] = layout.blocks.map((block) => {
    if (block.kind === "text") return block;
    if (block.kind === "heading") return { id: block.id, kind: "heading", label: block.label, values: {}, lines: [], showLines: false, ...pick(block) };
    return {
      id: block.id,
      kind: "group",
      label: block.label,
      values: values(block.lines),
      lines: block.lines.filter((ref) => known.has(ref)).map(figureLine),
      showLines: block.showLines,
      ...pick(block),
    };
  });
  // Lines the layout doesn't place (CEL2).
  for (const [ref, label] of known) {
    if (!placed.has(ref)) blocks.push({ id: `unplaced-${ref}`, kind: "group", label, values: values([ref]), lines: [figureLine(ref)], showLines: false, unplaced: true });
  }

  const labels = { ...EQUITY_END_LABELS, ...(layout.endLabels ?? {}) };
  const column = (pickValue: (sce: (typeof statements)[number]) => string): ReportValues =>
    Object.fromEntries(columns.map((c, index) => [c.key, pickValue(statements[index])]));
  const opening = column((sce) => sce.openingEquity);
  const closing = column((sce) => sce.closingEquity);
  const every = values([...known.keys()]);
  const reconciles = columns.every((c) => cmp(add(dec(opening[c.key] ?? "0"), dec(every[c.key] ?? "0")), dec(closing[c.key] ?? "0")) === 0);
  return {
    title: layout.title,
    base: "changes_in_equity",
    currencyCode: tx.baseCurrency,
    columns,
    opening: { label: labels.opening, values: opening },
    blocks,
    closing: { label: labels.closing, values: closing },
    reconciles,
    notInReport: [],
    inSeveralGroups: [],
    computedAt: new Date().toISOString(),
  };
}

function pick(row: CashFlowRow): Pick<EquityFigureRow, "hidden" | "pageBreakAfter" | "note"> {
  return { ...(row.hidden ? { hidden: true } : {}), ...(row.pageBreakAfter ? { pageBreakAfter: true } : {}), ...(row.note ? { note: row.note } : {}) };
}
