import type { EChartsOption } from "echarts";
import type { ChartKit } from "@/lib/analytics/chart-visuals";
import { contrast } from "@/lib/charts/colour-check";
import { MARKS, tooltipHtml, type TooltipRow } from "@/lib/charts/theme";
import { add, cmp, dec, isDecimalString, toPlainString, type Decimal } from "@/lib/money/decimal";

/**
 * Treemap, heat map, calendar heat map and Sankey (#376 phase 2, decision
 * 680). Each groups rows by two levels (the tile's group by and its second
 * grouping) or by day; totals for a box or a node are added exactly.
 */

type Row = Record<string, string | number | null>;

function exact(value: string | number | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return isDecimalString(text) ? dec(text) : null;
}

const inkOn = (fill: string) => (contrast(fill, "#ffffff") >= contrast(fill, "#0b1018") ? "#ffffff" : "#0b1018");

// ------------------------------------------------------------------ Treemap

export type TreeNode = { name: string; value: string; children?: TreeNode[] };

/**
 * A treemap's boxes: one per group, holding a box per second-grouping value
 * when there is one, largest first. A box's size is its total, added
 * exactly; only values above zero have an area, so the rest are left out
 * (and counted).
 */
export function treeNodes(rows: Row[], names: string[], field: string, detail?: string): { nodes: TreeNode[]; skipped: number } {
  let skipped = 0;
  const groups = new Map<string, { total: Decimal; children: Map<string, Decimal> }>();
  rows.forEach((row, index) => {
    const value = exact(row[field]);
    if (value === null || cmp(value, dec("0")) <= 0) {
      skipped += 1;
      return;
    }
    const name = names[index] ?? "";
    const group = groups.get(name) ?? { total: dec("0"), children: new Map<string, Decimal>() };
    group.total = add(group.total, value);
    if (detail) {
      const child = String(row[detail] ?? "(blank)");
      group.children.set(child, add(group.children.get(child) ?? dec("0"), value));
    }
    groups.set(name, group);
  });
  const bySize = (a: TreeNode, b: TreeNode) => cmp(dec(b.value), dec(a.value));
  const nodes = [...groups.entries()].map(([name, group]): TreeNode => ({
    name,
    value: toPlainString(group.total),
    ...(detail ? { children: [...group.children.entries()].map(([child, total]) => ({ name: child, value: toPlainString(total) })).sort(bySize) } : {}),
  }));
  return { nodes: nodes.sort(bySize), skipped };
}

export function treemapOption(kit: ChartKit): EChartsOption {
  const { spec, rows, theme, format } = kit;
  const field = spec.series[0].field;
  const { nodes } = treeNodes(rows, kit.categories, field, spec.detail);
  const palette = theme.palette;
  // The top groups take the theme's colours in order; past the last colour the rest are grey (never a made-up colour).
  const colourOf = (name: string, index: number) => {
    const rowIndex = kit.categories.indexOf(name);
    return (rowIndex >= 0 ? kit.groupColour(rowIndex) : undefined) ?? (format.colorByCategory === false ? kit.seriesColour(0) : palette[index] ?? theme.muted ?? theme.mutedText);
  };
  const labels = format.labels ?? {};
  const full = kit.fullFormatters[0];
  const data = nodes.map((node, index) => {
    const colour = colourOf(node.name, index);
    const look = { itemStyle: { color: colour }, label: { color: labels.color ?? inkOn(colour) } };
    return {
      name: node.name,
      value: Number(node.value),
      raw: node.value,
      ...look,
      ...(node.children
        ? { children: node.children.map((child) => ({ name: child.name, value: Number(child.value), raw: child.value, ...look, parentName: node.name })) }
        : {}),
    };
  });
  return {
    ...kit.common,
    legend: { show: false },
    tooltip: {
      ...(kit.common.tooltip as Record<string, unknown>),
      trigger: "item" as const,
      formatter: (params: unknown) => {
        const entry = params as { name?: string; color?: string; data?: { raw?: string; parentName?: string } };
        const list: TooltipRow[] = [{ colour: typeof entry.color === "string" ? entry.color : palette[0], name: spec.series[0].label, value: full(entry.data?.raw ?? "") }];
        return tooltipHtml(theme, entry.data?.parentName ? `${entry.data.parentName} › ${entry.name ?? ""}` : entry.name ?? "", list);
      },
    },
    series: [
      {
        type: "treemap",
        name: spec.series[0].label,
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        // The 2px surface gap between boxes, a little more round the groups.
        itemStyle: { borderColor: theme.background, borderWidth: MARKS.gap, gapWidth: MARKS.gap },
        // levels[0] is the whole chart (no label of its own), then the groups, then the boxes inside them.
        levels: [
          { itemStyle: { borderWidth: 0, gapWidth: MARKS.gap }, upperLabel: { show: false } },
          { itemStyle: { borderColor: theme.background, borderWidth: MARKS.gap, gapWidth: 1 } },
          { itemStyle: { borderColor: theme.background, borderWidth: 1, gapWidth: 1 } },
        ],
        label: {
          show: labels.show !== false,
          fontSize: kit.labelSize,
          overflow: "truncate",
          formatter: (params: { name?: string; data?: { raw?: string } }) => (labels.content?.value === false ? params.name ?? "" : `${params.name ?? ""}\n${kit.labelFormatters[0](params.data?.raw ?? "")}`),
        },
        upperLabel: spec.detail ? { show: true, height: 20, color: theme.text, fontSize: kit.labelSize } : { show: false },
        data,
      },
    ] as EChartsOption["series"],
  };
}

// ----------------------------------------------------------------- Heat map

/** A colour scale for the amounts: one hue light to dark, or two hues either side of zero (with a grey middle) when there are both. */
function scaleFor(kit: ChartKit, values: number[]): { min: number; max: number; colours: string[] } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const sequential = kit.theme.sequential ?? [kit.theme.grid, kit.seriesColour(0)];
  if (min < 0 && max > 0 && kit.theme.diverging) {
    const reach = Math.max(-min, max);
    return { min: -reach, max: reach, colours: [kit.theme.diverging.below, kit.theme.diverging.middle, kit.theme.diverging.above] };
  }
  return { min: Math.min(min, 0), max: max === min ? min + 1 : max, colours: sequential };
}

/** The heat map's cells: the groups across, the second grouping down, each cell's total added exactly. */
export function heatCells(rows: Row[], across: string[], field: string, detail: string): { across: string[]; down: string[]; cells: Array<{ x: number; y: number; value: string }> } {
  const xs: string[] = [];
  const ys: string[] = [];
  const totals = new Map<string, Decimal>();
  rows.forEach((row, index) => {
    const x = across[index] ?? "";
    const y = String(row[detail] ?? "(blank)");
    if (!xs.includes(x)) xs.push(x);
    if (!ys.includes(y)) ys.push(y);
    const value = exact(row[field]);
    if (value === null) return;
    const key = JSON.stringify([x, y]);
    totals.set(key, add(totals.get(key) ?? dec("0"), value));
  });
  const cells = [...totals.entries()].map(([key, total]) => {
    const [x, y] = JSON.parse(key) as [string, string];
    return { x: xs.indexOf(x), y: ys.indexOf(y), value: toPlainString(total) };
  });
  return { across: xs, down: ys, cells };
}

function visualMap(kit: ChartKit, values: number[], extra: Record<string, unknown> = {}) {
  const scale = scaleFor(kit, values);
  return {
    type: "continuous" as const,
    min: scale.min,
    max: scale.max,
    calculable: false,
    orient: "horizontal" as const,
    left: "center",
    bottom: 0,
    itemWidth: 10,
    itemHeight: 140,
    inRange: { color: scale.colours },
    textStyle: { color: kit.theme.mutedText, fontSize: kit.base.textStyle.fontSize },
    formatter: (value: unknown) => kit.axisFormatters[0](Number(value)),
    ...extra,
  };
}

export function heatmapOption(kit: ChartKit): EChartsOption {
  const { spec, rows, theme, format } = kit;
  const field = spec.series[0].field;
  const detail = spec.detail ?? "breakdown";
  const grid = heatCells(rows, kit.categories, field, detail);
  const values = grid.cells.map((cell) => Number(cell.value));
  const labels = format.labels ?? {};
  const full = kit.fullFormatters[0];
  return {
    ...kit.common,
    legend: { show: false },
    tooltip: {
      ...(kit.common.tooltip as Record<string, unknown>),
      trigger: "item" as const,
      formatter: (params: unknown) => {
        const entry = params as { color?: string; data?: { cell?: { x: number; y: number; value: string } } };
        const cell = entry.data?.cell;
        if (!cell) return "";
        return tooltipHtml(theme, `${grid.across[cell.x]} · ${grid.down[cell.y]}`, [{ colour: typeof entry.color === "string" ? entry.color : theme.palette[0], name: spec.series[0].label, value: full(cell.value) }]);
      },
    },
    grid: { top: kit.compact ? 4 : 8, bottom: kit.compact ? 36 : 44, left: 4, right: kit.compact ? 4 : 8, outerBoundsMode: "same", outerBoundsContain: "all" },
    xAxis: { ...kit.categoryAxis, data: grid.across, splitArea: { show: false }, axisLine: { show: false } },
    yAxis: {
      ...kit.categoryAxis,
      type: "category",
      data: grid.down,
      inverse: true,
      axisLine: { show: false },
      axisLabel: { ...(kit.categoryAxis.axisLabel as object), width: kit.compact ? 80 : 120, overflow: "truncate" },
      splitLine: { show: false },
    },
    visualMap: (values.length ? visualMap(kit, values) : undefined) as EChartsOption["visualMap"],
    series: [
      {
        type: "heatmap",
        name: spec.series[0].label,
        data: grid.cells.map((cell) => ({ value: [cell.x, cell.y, Number(cell.value)], cell })),
        // The 2px surface gap between cells.
        itemStyle: { borderColor: theme.background, borderWidth: MARKS.gap, borderRadius: 2 },
        emphasis: { itemStyle: { borderColor: theme.text, borderWidth: 1 } },
        label: labels.show
          ? { show: true, fontSize: kit.labelSize, formatter: (params: { data?: { cell?: { value: string } } }) => kit.labelFormatters[0](params.data?.cell?.value ?? ""), ...(labels.color ? { color: labels.color } : {}) }
          : { show: false },
      },
    ] as EChartsOption["series"],
  };
}

// --------------------------------------------------------- Calendar heat map

/** The years a calendar shows: those with data, the latest three, newest first. */
export function calendarYears(dates: string[]): string[] {
  const years = [...new Set(dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).map((date) => date.slice(0, 4)))].sort().reverse();
  return years.slice(0, 3);
}

export function calendarOption(kit: ChartKit): EChartsOption {
  const { spec, rows, theme } = kit;
  const field = spec.series[0].field;
  const days = rows.flatMap((row) => {
    const date = row[spec.category];
    const value = exact(row[field]);
    return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && value !== null ? [{ date, value: toPlainString(value) }] : [];
  });
  const years = calendarYears(days.map((day) => day.date));
  const shown = days.filter((day) => years.includes(day.date.slice(0, 4)));
  const values = shown.map((day) => Number(day.value));
  const full = kit.fullFormatters[0];
  const weekday = new Intl.DateTimeFormat("en-NZ", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const yearHeight = kit.compact ? 90 : 120;
  const calendars = years.map((year, index) => ({
    range: year,
    top: 28 + index * (yearHeight + 24),
    left: 48,
    right: 8,
    cellSize: ["auto", Math.round((yearHeight - 20) / 7)],
    orient: "horizontal" as const,
    splitLine: { show: false },
    itemStyle: { color: theme.grid, borderColor: theme.background, borderWidth: MARKS.gap },
    // The year down the left, so it never sits over the month names on a narrow screen.
    yearLabel: { show: true, position: "left" as const, margin: 28, color: theme.mutedText, fontSize: kit.base.textStyle.fontSize, fontWeight: 600 },
    monthLabel: { color: theme.mutedText, fontSize: kit.base.textStyle.fontSize - 1, nameMap: "EN" },
    dayLabel: { color: theme.mutedText, fontSize: kit.base.textStyle.fontSize - 2, firstDay: 1, nameMap: ["S", "M", "T", "W", "T", "F", "S"] },
  }));
  return {
    ...kit.common,
    legend: { show: false },
    tooltip: {
      ...(kit.common.tooltip as Record<string, unknown>),
      trigger: "item" as const,
      formatter: (params: unknown) => {
        const entry = params as { color?: string; data?: { day?: { date: string; value: string } } };
        const day = entry.data?.day;
        if (!day) return "";
        return tooltipHtml(theme, weekday.format(new Date(`${day.date}T00:00:00Z`)), [{ colour: typeof entry.color === "string" ? entry.color : theme.palette[0], name: spec.series[0].label, value: full(day.value) }]);
      },
    },
    calendar: calendars as EChartsOption["calendar"],
    visualMap: (values.length ? visualMap(kit, values, { bottom: 0 }) : undefined) as EChartsOption["visualMap"],
    series: years.map((year, index) => ({
      type: "heatmap",
      name: spec.series[0].label,
      coordinateSystem: "calendar",
      calendarIndex: index,
      data: shown.filter((day) => day.date.startsWith(year)).map((day) => ({ value: [day.date, Number(day.value)], day })),
    })) as EChartsOption["series"],
  };
}

/** How tall a calendar heat map needs to be for the years it shows (each year a band, plus the scale). */
export function calendarHeight(years: number, compact = false): number {
  const yearHeight = compact ? 90 : 120;
  return 28 + Math.max(1, years) * (yearHeight + 24) + 40;
}

// -------------------------------------------------------------------- Sankey

export type SankeyFlows = {
  nodes: Array<{ name: string; label: string }>;
  links: Array<{ source: string; target: string; value: string }>;
  skipped: number;
};

/**
 * A Sankey diagram's flows: from each group to each value of the second
 * grouping, totals added exactly. Only amounts above zero can flow, so the
 * rest are left out (and counted). A name on both sides is kept apart (the
 * right-hand one gets an invisible mark), since a flow can't loop back.
 */
export function sankeyFlows(rows: Row[], sources: string[], field: string, detail: string): SankeyFlows {
  const totals = new Map<string, Decimal>();
  const left: string[] = [];
  const right: string[] = [];
  let skipped = 0;
  rows.forEach((row, index) => {
    const value = exact(row[field]);
    if (value === null || cmp(value, dec("0")) <= 0) {
      skipped += 1;
      return;
    }
    const source = sources[index] ?? "";
    const target = String(row[detail] ?? "(blank)");
    if (!left.includes(source)) left.push(source);
    if (!right.includes(target)) right.push(target);
    const key = JSON.stringify([source, target]);
    totals.set(key, add(totals.get(key) ?? dec("0"), value));
  });
  const rightName = (name: string) => (left.includes(name) ? `${name}​` : name);
  return {
    nodes: [...left.map((name) => ({ name, label: name })), ...right.map((name) => ({ name: rightName(name), label: name }))],
    links: [...totals.entries()].map(([key, total]) => {
      const [source, target] = JSON.parse(key) as [string, string];
      return { source, target: rightName(target), value: toPlainString(total) };
    }),
    skipped,
  };
}

export function sankeyOption(kit: ChartKit): EChartsOption {
  const { spec, rows, theme, format } = kit;
  const field = spec.series[0].field;
  const flows = sankeyFlows(rows, kit.categories, field, spec.detail ?? "breakdown");
  const full = kit.fullFormatters[0];
  const sources = new Set(flows.links.map((link) => link.source));
  // Groups on the left take the theme's colours in order (grey past the last); the right-hand side is grey.
  let next = 0;
  const colours = new Map<string, string>();
  for (const node of flows.nodes) {
    if (!sources.has(node.name)) continue;
    const rowIndex = kit.categories.indexOf(node.name);
    colours.set(node.name, (rowIndex >= 0 ? kit.groupColour(rowIndex) : undefined) ?? theme.palette[next] ?? theme.muted ?? theme.mutedText);
    next += 1;
  }
  const labels = format.labels ?? {};
  return {
    ...kit.common,
    legend: { show: false },
    tooltip: {
      ...(kit.common.tooltip as Record<string, unknown>),
      trigger: "item" as const,
      formatter: (params: unknown) => {
        const entry = params as { dataType?: string; color?: string; data?: { label?: string; source?: string; target?: string; raw?: string; total?: string } };
        if (entry.dataType === "edge") {
          const source = entry.data?.source ?? "";
          const target = (entry.data?.target ?? "").replace("​", "");
          return tooltipHtml(theme, `${source} → ${target}`, [{ colour: colours.get(source) ?? theme.palette[0], name: spec.series[0].label, value: full(entry.data?.raw ?? "") }]);
        }
        return tooltipHtml(theme, entry.data?.label ?? "", [{ colour: typeof entry.color === "string" ? entry.color : theme.palette[0], name: spec.series[0].label, value: full(entry.data?.total ?? "") }]);
      },
    },
    series: [
      {
        type: "sankey",
        name: spec.series[0].label,
        top: kit.compact ? 4 : 8,
        bottom: kit.compact ? 4 : 8,
        left: 4,
        right: kit.compact ? 64 : 120,
        nodeWidth: 12,
        nodeGap: 8,
        nodeAlign: "justify",
        draggable: false,
        emphasis: { focus: "adjacency" },
        data: flows.nodes.map((node) => {
          const total = flows.links.filter((link) => link.source === node.name || link.target === node.name).reduce((sum, link) => add(sum, dec(link.value)), dec("0"));
          return {
            name: node.name,
            label: node.label,
            total: toPlainString(total),
            itemStyle: { color: colours.get(node.name) ?? theme.muted ?? theme.mutedText, borderWidth: 0 },
          };
        }),
        links: flows.links.map((link) => ({ source: link.source, target: link.target, value: Number(link.value), raw: link.value })),
        lineStyle: { color: "source", opacity: 0.32, curveness: 0.5 },
        label: {
          show: labels.show !== false,
          color: labels.color ?? kit.secondaryText,
          fontSize: kit.labelSize,
          width: kit.compact ? 60 : 116,
          overflow: "truncate",
          formatter: (params: { data?: { label?: string; total?: string } }) =>
            labels.content?.value === false ? params.data?.label ?? "" : `${params.data?.label ?? ""} ${kit.labelFormatters[0](params.data?.total ?? "")}`,
        },
        // Names of small nodes that would overlap are left to the tooltip.
        labelLayout: { hideOverlap: true },
      },
    ] as EChartsOption["series"],
  };
}
