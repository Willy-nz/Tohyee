import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, type Decimal, isZero, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { ID_PATTERN, list, parseColumns, record, text } from "@/lib/reports/custom";
import {
  CASH_FLOW_END_LABELS,
  CASH_FLOW_SECTIONS,
  type CashFlowBlock,
  type CashFlowEndLabels,
  type CashFlowLayout,
  type CashFlowLineRef,
  type CashFlowRow,
  type CashFlowSection,
  type CashFlowSectionKind,
  CUSTOM_REPORT_LIMITS as LIMITS,
  periodColumns,
  type ReportColumn,
  type ReportValues,
} from "@/lib/reports/custom-layout";
import { cashFlowStatement } from "@/lib/reports/statements";

/*
 * Cash flow layouts (examples CFL1-CFL5). A layout arranges the statement of
 * cash flows' lines (net profit, non-cash adjustments, each account's
 * movement, disposal proceeds) into sections, headings and groups, renamed,
 * reordered, hidden or with notes. The amounts come from the standard
 * statement (SCF1), and any line the layout doesn't place stays in its
 * usual section, so the net change always matches the bank accounts.
 */

const SECTION_KINDS = Object.keys(CASH_FLOW_SECTIONS) as CashFlowSectionKind[];
const ADJUSTMENTS = ["depreciation", "livestock", "rations", "fx", "disposal", "opening"];
const REF_PATTERN = /^(profit|disposal_proceeds|adjust:(depreciation|livestock|rations|fx|disposal|opening)|account:[A-Za-z0-9._-]{1,20})$/;

/** Checks a cash flow layout (CFL3): ids, labels, each line placed once, accounts that exist. */
export async function parseCashFlowLayout(tx: OrgTx, input: unknown): Promise<CashFlowLayout> {
  const raw = record(input, "The report");
  if (JSON.stringify(raw).length > 200_000) throw new ValidationError("This report is too big to save.");
  const title = text(raw.title, "The title", LIMITS.titleLength, { required: true });
  const columns = parseColumns("profit_and_loss", raw.columns);
  if (columns.difference || columns.percent || columns.yearToDate || columns.budgetId) throw new ValidationError("A cash flow report has period columns only.");
  const ids = new Set<string>();
  const placed = new Set<string>();
  const id = (value: unknown, what: string) => {
    if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new ValidationError(`Each ${what} needs an id of letters, numbers, - or _.`);
    if (ids.has(value)) throw new ValidationError(`Two rows or sections share the id ${value}.`);
    ids.add(value);
    return value;
  };
  const extras = (row: Record<string, unknown>) => ({
    ...(row.hidden === true ? { hidden: true } : {}),
    ...(row.pageBreakAfter === true ? { pageBreakAfter: true } : {}),
    ...(typeof row.note === "string" && row.note.trim() ? { note: text(row.note, "A row's note", LIMITS.noteLength, { required: false }) } : {}),
  });
  const blocks = list(raw.blocks, "The sections and notes", LIMITS.blocks).map((entry): CashFlowBlock => {
    const block = record(entry, "A section or note");
    if (block.kind === "text") return { id: id(block.id, "note"), kind: "text", text: text(block.text, "A note", LIMITS.noteLength, { required: true }) };
    if (block.kind !== "section") throw new ValidationError("A block is a section or a note.");
    const usual = block.usual;
    if (typeof usual !== "string" || !SECTION_KINDS.includes(usual as CashFlowSectionKind))
      throw new ValidationError("Each section is operating, investing or financing at heart.");
    const rows = list(block.rows, "A section's rows", LIMITS.rowsPerTable).map((rawRow): CashFlowRow => {
      const row = record(rawRow, "A row");
      const rowId = id(row.id, "row");
      const label = text(row.label, "A row's name", LIMITS.labelLength, { required: true });
      if (row.kind === "heading") return { id: rowId, kind: "heading", label, ...extras(row) };
      if (row.kind !== "group") throw new ValidationError("A row is a heading or a group.");
      const lines = list(row.lines, "A group's lines", 200).map((ref) => {
        if (typeof ref !== "string" || !REF_PATTERN.test(ref))
          throw new ValidationError(`${label}: a line must be net profit, an adjustment, an account or disposal proceeds.`);
        if (placed.has(ref)) throw new ValidationError(`${describe(ref)} is in the layout twice. Each line can be placed once.`);
        placed.add(ref);
        return ref;
      });
      return { id: rowId, kind: "group", label, lines, showLines: row.showLines === true, ...extras(row) };
    });
    return {
      id: id(block.id, "section"),
      kind: "section",
      usual: usual as CashFlowSectionKind,
      title: text(block.title, "A section's name", LIMITS.labelLength, { required: true }),
      totalLabel: text(block.totalLabel, "A section's total", LIMITS.labelLength, { required: true }),
      rows,
    };
  });
  const codes = [...placed].filter((ref) => ref.startsWith("account:")).map((ref) => ref.slice(8));
  if (codes.length > 0) {
    const found = await tx.query<{ code: string }>("select code from accounts where code = any($1::text[])", [codes]);
    const known = new Set(found.rows.map((row) => row.code));
    const unknown = codes.filter((code) => !known.has(code));
    if (unknown.length > 0) throw new ValidationError(`There's no account ${unknown.join(", ")}.`);
  }
  const endLabels: Partial<CashFlowEndLabels> = {};
  if (raw.endLabels != null) {
    const labels = record(raw.endLabels, "The last lines' names");
    for (const key of Object.keys(CASH_FLOW_END_LABELS) as Array<keyof CashFlowEndLabels>) {
      if (labels[key] != null && labels[key] !== "") endLabels[key] = text(labels[key], "A last line's name", LIMITS.labelLength, { required: true });
    }
  }
  return { title, columns, blocks, ...(Object.keys(endLabels).length ? { endLabels } : {}) };
}

function describe(ref: CashFlowLineRef): string {
  if (ref === "profit") return "Net profit";
  if (ref === "disposal_proceeds") return "Proceeds from disposals";
  if (ref.startsWith("adjust:")) return `The ${ref.slice(7)} adjustment`;
  return `Account ${ref.slice(8)}`;
}

/** One line the statement has in a period, with its usual section. */
type Item = { ref: CashFlowLineRef; label: string; usual: CashFlowSectionKind; amount: Decimal };

export type CashFlowFigureLine = { ref: CashFlowLineRef; label: string; values: ReportValues };
export type CashFlowFigureRow = {
  id: string;
  kind: "heading" | "group";
  label: string;
  values: ReportValues;
  lines: CashFlowFigureLine[];
  showLines: boolean;
  hidden?: boolean;
  pageBreakAfter?: boolean;
  note?: string;
  /** Not placed by the layout: kept in its usual section (CFL2). */
  unplaced?: boolean;
};
export type CashFlowFigureSection = {
  id: string;
  kind: "section";
  usual: CashFlowSectionKind;
  title: string;
  rows: CashFlowFigureRow[];
  total: { label: string; values: ReportValues };
};
export type CashFlowFigures = {
  title: string;
  base: "cash_flows";
  currencyCode: string;
  columns: ReportColumn[];
  blocks: Array<CashFlowFigureSection | { id: string; kind: "text"; text: string }>;
  end: Array<{ key: keyof CashFlowEndLabels; label: string; values: ReportValues }>;
  /** Cash at the start + net change + exchange = cash at the end, in every column. */
  reconciles: boolean;
  /** Always empty here: every line is placed (CFL2). Kept so code reading any custom report can read these. */
  notInReport: [];
  inSeveralGroups: [];
  filterLabel?: null;
  data?: undefined;
  computedAt: string;
};

/** Works out a cash flow layout for each column (CFL1-CFL4). */
export async function computeCashFlowLayout(tx: OrgTx, layout: CashFlowLayout, options: { columns?: ReportColumn[] } = {}): Promise<CashFlowFigures> {
  const columns = (options.columns ?? periodColumns("profit_and_loss", layout.columns)).filter(
    (column) => column.kind === "period" || column.kind === "year_to_date",
  );
  const scale = currencyMinorUnits(tx.baseCurrency);
  const money = (value: Decimal) => toFixedString(value, scale);
  const statements: Array<Awaited<ReturnType<typeof cashFlowStatement>>> = [];
  for (const column of columns) statements.push(await cashFlowStatement(tx, { from: column.from, to: column.to }));
  // Every line in any column, in the statement's order.
  const known = new Map<CashFlowLineRef, { label: string; usual: CashFlowSectionKind }>();
  const amounts = columns.map(() => new Map<CashFlowLineRef, Decimal>());
  statements.forEach((cf, index) => {
    const items: Item[] = [
      { ref: "profit", label: "Net profit", usual: "operating", amount: dec(cf.operating.profit) },
      ...cf.operating.adjustments.map((row) => ({ ref: `adjust:${row.key}`, label: row.label, usual: "operating" as const, amount: dec(row.amount) })),
      ...cf.operating.workingCapital.map((row) => ({ ref: `account:${row.code}`, label: row.label, usual: "operating" as const, amount: dec(row.amount) })),
      ...cf.investing.lines.map((row) => ({ ref: `account:${row.code}`, label: row.label, usual: "investing" as const, amount: dec(row.amount) })),
      ...(isZero(dec(cf.investing.disposalProceeds))
        ? []
        : [
            {
              ref: "disposal_proceeds",
              label: "Proceeds from disposals of fixed assets",
              usual: "investing" as const,
              amount: dec(cf.investing.disposalProceeds),
            },
          ]),
      ...cf.financing.lines.map((row) => ({ ref: `account:${row.code}`, label: row.label, usual: "financing" as const, amount: dec(row.amount) })),
    ];
    for (const item of items) {
      if (!known.has(item.ref)) known.set(item.ref, { label: item.label, usual: item.usual });
      amounts[index].set(item.ref, add(amounts[index].get(item.ref) ?? ZERO_DECIMAL, item.amount));
    }
  });
  const values = (refs: CashFlowLineRef[]): ReportValues =>
    Object.fromEntries(
      columns.map((column, index) => [column.key, money(refs.reduce((sum, ref) => add(sum, amounts[index].get(ref) ?? ZERO_DECIMAL), ZERO_DECIMAL))]),
    );
  const figureLine = (ref: CashFlowLineRef): CashFlowFigureLine => ({ ref, label: known.get(ref)?.label ?? describe(ref), values: values([ref]) });

  const placed = new Set(
    layout.blocks.flatMap((block) => (block.kind === "section" ? block.rows.flatMap((row) => (row.kind === "group" ? row.lines : [])) : [])),
  );
  const blocks: CashFlowBlock[] = [...layout.blocks];
  // A section the layout leaves out comes back at the end with its usual name (CFL2), if it has lines.
  for (const usual of SECTION_KINDS) {
    const needed = [...known.entries()].some(([ref, item]) => item.usual === usual && !placed.has(ref));
    if (needed && !blocks.some((block) => block.kind === "section" && block.usual === usual)) {
      blocks.push({
        id: `usual-${usual}`,
        kind: "section",
        usual,
        title: CASH_FLOW_SECTIONS[usual],
        totalLabel: `Net cash from ${usual} activities`,
        rows: [],
      });
    }
  }
  const firstOf = new Map<CashFlowSectionKind, string>();
  for (const block of blocks) if (block.kind === "section" && !firstOf.has(block.usual)) firstOf.set(block.usual, block.id);

  const sectionTotals: CashFlowLineRef[][] = [];
  const figureBlocks = blocks.map((block): CashFlowFigures["blocks"][number] => {
    if (block.kind === "text") return block;
    const section = block as CashFlowSection;
    const rows: CashFlowFigureRow[] = section.rows.map((row) =>
      row.kind === "heading"
        ? { id: row.id, kind: "heading", label: row.label, values: {}, lines: [], showLines: false, ...pick(row) }
        : {
            id: row.id,
            kind: "group",
            label: row.label,
            values: values(row.lines),
            lines: row.lines.filter((ref) => known.has(ref)).map(figureLine),
            showLines: row.showLines,
            ...pick(row),
          },
    );
    // Lines that usually sit here and the layout doesn't place (CFL2).
    if (firstOf.get(section.usual) === section.id) {
      for (const [ref, item] of known) {
        if (item.usual === section.usual && !placed.has(ref))
          rows.push({
            id: `unplaced-${ref}`,
            kind: "group",
            label: item.label,
            values: values([ref]),
            lines: [figureLine(ref)],
            showLines: false,
            unplaced: true,
          });
      }
    }
    const refs = rows
      .flatMap((row) => row.lines.map((line) => line.ref))
      .concat(section.rows.flatMap((row) => (row.kind === "group" ? row.lines.filter((ref) => !known.has(ref)) : [])));
    sectionTotals.push(refs);
    return { id: section.id, kind: "section", usual: section.usual, title: section.title, rows, total: { label: section.totalLabel, values: values(refs) } };
  });

  const labels = { ...CASH_FLOW_END_LABELS, ...(layout.endLabels ?? {}) };
  const column = (pickValue: (cf: (typeof statements)[number]) => string): ReportValues =>
    Object.fromEntries(columns.map((c, index) => [c.key, pickValue(statements[index])]));
  const allRefs = sectionTotals.flat();
  const exchange = column((cf) => cf.exchangeOnCash);
  const end: CashFlowFigures["end"] = [
    { key: "netChange", label: labels.netChange, values: values(allRefs) },
    ...(Object.values(exchange).some((value) => value !== null && !isZero(dec(value)))
      ? [{ key: "exchange" as const, label: labels.exchange, values: exchange }]
      : []),
    { key: "openingCash", label: labels.openingCash, values: column((cf) => cf.openingCash) },
    { key: "closingCash", label: labels.closingCash, values: column((cf) => cf.closingCash) },
  ];
  const net = values(allRefs);
  const reconciles = columns.every(
    (c, index) =>
      cmp(add(add(dec(statements[index].openingCash), dec(net[c.key] ?? "0")), dec(statements[index].exchangeOnCash)), dec(statements[index].closingCash)) ===
      0,
  );
  return {
    title: layout.title,
    base: "cash_flows",
    currencyCode: tx.baseCurrency,
    columns,
    blocks: figureBlocks,
    end,
    reconciles,
    notInReport: [],
    inSeveralGroups: [],
    computedAt: new Date().toISOString(),
  };
}

function pick(row: CashFlowRow): Pick<CashFlowFigureRow, "hidden" | "pageBreakAfter" | "note"> {
  return { ...(row.hidden ? { hidden: true } : {}), ...(row.pageBreakAfter ? { pageBreakAfter: true } : {}), ...(row.note ? { note: row.note } : {}) };
}

export { ADJUSTMENTS };
