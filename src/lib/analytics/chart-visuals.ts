import type { EChartsOption } from "echarts";
import type { ChartFormat } from "@/lib/analytics/chart-format";
import type { ChartSpec } from "@/lib/analytics/chart-spec";
import { MARKS, tooltipHtml, type ChartTheme, type TooltipRow, echartsBase } from "@/lib/charts/theme";
import { contrast } from "@/lib/charts/colour-check";
import { boxPlotOption, histogramOption, scatterOption } from "@/lib/analytics/chart-distributions";
import { add, dec, isDecimalString, isNegative, sum, toPlainString, type Decimal } from "@/lib/money/decimal";

/**
 * The visuals added in #376 phase 2 (decisions 676-677): waterfall, funnel,
 * gauge and bullet chart. Each is drawn from the same pieces as the other
 * charts (the report theme, the tile's format, number formats, labels and
 * colour rules), handed over by `toEChartsOption` as a kit.
 */

export type ExtraKind = "waterfall" | "funnel" | "gauge" | "bullet" | "scatter" | "histogram" | "boxplot";
export const EXTRA_KINDS: ReadonlySet<ExtraKind> = new Set(["waterfall", "funnel", "gauge", "bullet", "scatter", "histogram", "boxplot"]);

type ChartRow = Record<string, string | number | null>;
type Formatter = (value: number | string) => string;

/** What `toEChartsOption` has already worked out for a chart, for the builders here. */
export type ChartKit = {
  spec: ChartSpec;
  rows: ChartRow[];
  theme: ChartTheme;
  /** The tile's format, with chosen colours adapted for a dark card. */
  format: ChartFormat;
  base: ReturnType<typeof echartsBase>;
  /** The group names as shown (dates as "Jan 2026"). */
  categories: string[];
  /** Background, colours, text, title, legend and tooltip, as every chart has them. */
  common: EChartsOption;
  /** The group axis, formatted as the tile says. */
  categoryAxis: Record<string, unknown>;
  /** A value axis for a value (by position), formatted as the tile says. */
  valueAxis: (index: number, settings: ChartFormat["valueAxis"], options?: { vertical?: boolean }) => Record<string, unknown>;
  fullFormatters: Formatter[];
  labelFormatters: Formatter[];
  /** Short numbers for axis labels ($1.5K), in each value's own format. */
  axisFormatters: Formatter[];
  seriesColour: (index: number) => string;
  /** A colour chosen for a group by name (#376), if any. */
  groupColour: (rowIndex: number) => string | undefined;
  /** The first colour rule that matches a value's raw figure (compared exactly), if any. */
  ruleColour: (index: number, raw: string | number | null | undefined) => string | undefined;
  displayNumber: (value: string | number | null) => number | null;
  secondaryText: string;
  labelSize: number;
  compact: boolean;
};

export function extraOption(kit: ChartKit): EChartsOption {
  switch (kit.spec.kind as ExtraKind) {
    case "waterfall":
      return waterfallOption(kit);
    case "funnel":
      return funnelOption(kit);
    case "gauge":
      return gaugeOption(kit);
    case "bullet":
      return bulletOption(kit);
    case "scatter":
      return scatterOption(kit);
    case "histogram":
      return histogramOption(kit);
    case "boxplot":
      return boxPlotOption(kit);
  }
}

function exact(value: string | number | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return isDecimalString(text) ? dec(text) : null;
}

function rgba(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(match[1].slice(at, at + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ---------------------------------------------------------------- Waterfall

export type WaterfallStep = {
  kind: "increase" | "decrease" | "total";
  /** The running total before and after this step, and the change (exact decimal strings). */
  start: string;
  end: string;
  value: string;
};

/**
 * A waterfall's bars (a P&L bridge): each value moves the running total up
 * or down from where the last one ended, worked out exactly in decimals,
 * then a total bar from zero to where it finished. A blank value moves
 * nothing. Values that aren't plain decimals are treated as blank.
 */
export function waterfallSteps(values: Array<string | number | null>, options: { total?: boolean } = {}): WaterfallStep[] {
  let running = dec("0");
  const steps: WaterfallStep[] = values.map((raw) => {
    const value = exact(raw) ?? dec("0");
    const start = running;
    running = add(running, value);
    return { kind: isNegative(value) ? "decrease" : "increase", start: toPlainString(start), end: toPlainString(running), value: toPlainString(value) };
  });
  if (options.total !== false) {
    const total = toPlainString(sum(values.map((raw) => exact(raw) ?? dec("0"))));
    steps.push({ kind: "total", start: "0", end: total, value: total });
  }
  return steps;
}

type RenderApi = {
  value: (dimension: number) => number;
  coord: (point: [number, number]) => [number, number];
  size: (point: [number, number]) => [number, number];
};

function waterfallOption(kit: ChartKit): EChartsOption {
  const { spec, rows, theme, format, base } = kit;
  const field = spec.series[0].field;
  const settings = format.waterfall ?? {};
  const showTotal = settings.total !== false;
  const steps = waterfallSteps(rows.map((row) => row[field]), { total: showTotal });
  const totalLabel = settings.totalLabel ?? "Total";
  const categories = [...kit.categories, ...(showTotal ? [totalLabel] : [])];
  // Rises and falls in the theme's first two colours (blue and orange in Tohyee's: its diverging pair), the total in grey.
  const colours = {
    increase: settings.increase ?? kit.seriesColour(0),
    decrease: settings.decrease ?? theme.palette[1 % theme.palette.length],
    total: settings.totalColor ?? theme.muted ?? theme.mutedText,
  };
  const colourOf = (index: number) => {
    const step = steps[index];
    if (step.kind !== "total") {
      const chosen = kit.ruleColour(0, rows[index]?.[field]) ?? kit.groupColour(index);
      if (chosen) return chosen;
    }
    return colours[step.kind];
  };
  const labels = format.labels ?? {};
  const showLabels = labels.show === true;
  const connectors = settings.connectors !== false;
  const thickness = format.bars?.thickness ?? (kit.compact ? 16 : MARKS.barMaxWidth);
  const rounded = format.bars?.rounded !== false;
  const font = `${kit.labelSize}px ${base.textStyle.fontFamily}`;
  const KIND_NAMES = { increase: "Rise", decrease: "Fall", total: "Total" } as const;

  const data = steps.map((step, index) => [index, Number(step.start), Number(step.end)]);
  const series = {
    type: "custom" as const,
    name: spec.series[0].label,
    encode: { x: 0, y: [1, 2] },
    data,
    renderItem: (_params: unknown, api: RenderApi) => {
      const index = api.value(0);
      const start = api.value(1);
      const end = api.value(2);
      const [centre, startY] = api.coord([index, start]);
      const [, endY] = api.coord([index, end]);
      const band = api.size([1, 0])[0];
      const width = Math.max(2, Math.min(thickness, band * 0.6));
      const top = Math.min(startY, endY);
      const height = Math.max(1, Math.abs(startY - endY));
      const up = end >= start;
      // The data end is rounded; the end it grows from stays square.
      const r = rounded ? Math.min(MARKS.barRadius, height / 2) : 0;
      const radius = up ? [r, r, 0, 0] : [0, 0, r, r];
      const children: Array<Record<string, unknown>> = [
        { type: "rect", shape: { x: centre - width / 2, y: top, width, height, r: radius }, style: { fill: colourOf(index) } },
      ];
      if (connectors && index < steps.length - 1) {
        // A hairline from this bar's end across to the next bar, which starts there.
        children.push({
          type: "line",
          shape: { x1: centre + width / 2, y1: endY, x2: centre + band - width / 2, y2: endY },
          style: { stroke: theme.axis ?? theme.grid, lineWidth: 1 },
          silent: true,
        });
      }
      if (showLabels && (labels.density !== "ends" || index === 0 || index === steps.length - 1)) {
        const step = steps[index];
        const text = kit.labelFormatters[0](step.kind === "total" ? step.end : step.value);
        children.push({
          type: "text",
          silent: true,
          style: {
            text,
            x: centre,
            y: up ? top - 4 : top + height + 4,
            align: "center",
            verticalAlign: up ? "bottom" : "top",
            fill: labels.color ?? kit.secondaryText,
            font,
          },
        });
      }
      return { type: "group", children };
    },
  };

  const tooltip = {
    ...(kit.common.tooltip as Record<string, unknown>),
    trigger: "axis" as const,
    axisPointer: base.barPointer,
    formatter: (params: unknown) => {
      const entry = (Array.isArray(params) ? params[0] : params) as { dataIndex?: number };
      const index = entry?.dataIndex ?? 0;
      const step = steps[index];
      if (!step) return "";
      const format = kit.fullFormatters[0];
      const rows: TooltipRow[] =
        step.kind === "total"
          ? [{ colour: colourOf(index), name: totalLabel, value: format(step.end) }]
          : [
              { colour: colourOf(index), name: `${KIND_NAMES[step.kind]} (${spec.series[0].label})`, value: format(step.value) },
              { colour: "transparent", name: "Running total", value: format(step.end) },
            ];
      return tooltipHtml(theme, categories[index] ?? "", rows);
    },
  };

  return {
    ...kit.common,
    legend: { show: false },
    tooltip,
    grid: { top: kit.compact ? 8 : 20, bottom: 4, left: 4, right: kit.compact ? 8 : 16, outerBoundsMode: "same", outerBoundsContain: "all" },
    xAxis: { ...kit.categoryAxis, data: categories },
    yAxis: kit.valueAxis(0, format.valueAxis),
    series: [series] as unknown as EChartsOption["series"],
  };
}

// ------------------------------------------------------------------- Funnel

/** A stage's share of the first stage or of the stage before it (display only: drawing, never adding up). */
export function funnelShares(values: Array<number | null>, of: "first" | "previous"): Array<number | null> {
  return values.map((value, index) => {
    const base = of === "first" ? values[0] : values[index - 1];
    if (index === 0) return value === null ? null : 1;
    if (value === null || base === null || base === undefined || base === 0) return null;
    return value / base;
  });
}

function funnelOption(kit: ChartKit): EChartsOption {
  const { spec, rows, theme, format } = kit;
  const field = spec.series[0].field;
  const values = rows.map((row) => kit.displayNumber(row[field]));
  const percentOf = format.funnel?.percent ?? "first";
  const shares = percentOf === "none" ? values.map(() => null) : funnelShares(values, percentOf);
  const percent = (share: number | null) => (share === null ? "" : new Intl.NumberFormat("en-NZ", { style: "percent", maximumFractionDigits: 1 }).format(share));
  const colour = kit.seriesColour(0);
  const labels = format.labels ?? {};
  const inside = labels.position === "inside";
  const showLabels = labels.show !== false;
  const ofWhat = percentOf === "previous" ? "of the stage before" : "of the first stage";

  // Text inside a stage is white or dark ink, whichever reads on its colour.
  const inkOn = (fill: string) => (contrast(fill, "#ffffff") >= contrast(fill, "#0b1018") ? "#ffffff" : "#0b1018");
  const data = rows.flatMap((row, index) => {
    const value = values[index];
    if (value === null) return [];
    const fill = kit.ruleColour(0, row[field]) ?? kit.groupColour(index) ?? colour;
    return [{
      name: kit.categories[index],
      value,
      share: shares[index],
      itemStyle: { color: fill },
      ...(inside && showLabels && !labels.color ? { label: { color: inkOn(fill) } } : {}),
    }];
  });

  return {
    ...kit.common,
    legend: { show: false },
    tooltip: {
      ...(kit.common.tooltip as Record<string, unknown>),
      trigger: "item" as const,
      formatter: (params: unknown) => {
        const entry = params as { name?: string; value?: number; color?: string; dataIndex?: number; data?: { share?: number | null } };
        const share = entry.data?.share ?? null;
        const list: TooltipRow[] = [{ colour: typeof entry.color === "string" ? entry.color : colour, name: spec.series[0].label, value: kit.fullFormatters[0](entry.value ?? 0) }];
        if (share !== null && percentOf !== "none" && (entry.dataIndex ?? 0) > 0) list.push({ colour: "transparent", name: `Share ${ofWhat}`, value: percent(share) });
        return tooltipHtml(theme, entry.name ?? "", list);
      },
    },
    series: [
      {
        type: "funnel",
        name: spec.series[0].label,
        sort: "none",
        // A 2px gap in the surface colour between stages.
        gap: MARKS.gap,
        top: kit.compact ? 4 : 12,
        bottom: kit.compact ? 4 : 12,
        left: "2%",
        width: inside || !showLabels ? "96%" : "56%",
        minSize: "6%",
        data,
        itemStyle: { borderWidth: 0 },
        label: showLabels
          ? {
              show: true,
              position: inside ? "inside" : "right",
              ...(labels.color ? { color: labels.color } : inside ? {} : { color: kit.secondaryText }),
              fontSize: kit.labelSize,
              ...(inside ? {} : { width: 150, overflow: "truncate" }),
              formatter: (params: { name?: string; value?: unknown; data?: { share?: number | null } }) => {
                const value = kit.labelFormatters[0](Number(params.value));
                const share = params.data?.share ?? null;
                const tail = share !== null && percentOf !== "none" ? ` · ${percent(share)}` : "";
                return labels.content?.category === false ? `${value}${tail}` : `${params.name ?? ""}\n${value}${tail}`;
              },
            }
          : { show: false },
        labelLine: { show: showLabels && !inside, length: 12, lineStyle: { color: theme.axis ?? theme.grid } },
      },
    ] as EChartsOption["series"],
  };
}

// -------------------------------------------------------------------- Gauge

/** A round number at or above a value, for the end of a dial (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 times a power of ten). */
export function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((factor) => factor * power >= value - 1e-9 * power) ?? 10;
  return Math.round(step * power * 1e6) / 1e6;
}

/**
 * A gauge's dial: from the chosen minimum (0 when left out) to the chosen
 * maximum. Left out, the maximum is twice the value rounded up, as Power BI
 * does; with a target it's a little past the target or the value, whichever
 * is further, so the target sits well inside the dial.
 */
export function gaugeRange(value: number | null, target: number | null, chosen: { min?: string; max?: string }): { min: number; max: number } {
  const min = chosen.min !== undefined ? Number(chosen.min) : 0;
  if (chosen.max !== undefined) return { min, max: Number(chosen.max) };
  const furthest = target !== null ? Math.max(target, value ?? 0) * 1.1 : value !== null ? value * 2 : 0;
  return { min, max: Math.max(niceCeiling(furthest), min + 1) };
}

function gaugeOption(kit: ChartKit): EChartsOption {
  const { spec, rows, theme, format, base } = kit;
  const row = rows[0] ?? {};
  const raw = row[spec.series[0].field] ?? null;
  const value = kit.displayNumber(raw);
  const targetRaw = spec.series[1] ? row[spec.series[1].field] ?? null : format.gauge?.target ?? null;
  const target = kit.displayNumber(targetRaw);
  const { min, max } = gaugeRange(value, target, format.gauge ?? {});
  const colour = kit.ruleColour(0, raw) ?? kit.seriesColour(0);
  const width = kit.compact ? 10 : 16;
  const position = (number: number) => Math.min(1, Math.max(0, (number - min) / (max - min)));
  const geometry = { startAngle: 200, endAngle: -20, min, max, radius: kit.compact ? "92%" : "88%", center: ["50%", "62%"] };
  const font = base.textStyle.fontFamily;
  const series: Array<Record<string, unknown>> = [
    {
      type: "gauge",
      name: spec.series[0].label,
      ...geometry,
      // The filled part carries the value; the track is the theme's hairline grey.
      progress: { show: value !== null, width, itemStyle: { color: colour } },
      axisLine: { lineStyle: { width, color: [[1, theme.grid]] } },
      axisTick: { show: false },
      splitLine: { show: false },
      splitNumber: 1,
      axisLabel: {
        show: !kit.compact,
        distance: -width - 14,
        color: theme.mutedText,
        fontSize: base.textStyle.fontSize,
        formatter: (number: number) => kit.axisFormatters[0](number),
      },
      pointer: { show: false },
      anchor: { show: false },
      title: { show: false },
      detail: {
        offsetCenter: [0, "-8%"],
        color: theme.text,
        fontFamily: font,
        fontSize: kit.compact ? 18 : 28,
        fontWeight: 600,
        formatter: () => (value === null ? "—" : kit.fullFormatters[0](raw as string | number)),
      },
      data: [{ value: value ?? min, name: spec.series[0].label }],
    },
  ];
  if (target !== null) {
    const at = position(target);
    // The target: a short dark tick across the track, a little wider than it.
    series.push({
      type: "gauge",
      name: "Target",
      ...geometry,
      silent: true,
      progress: { show: false },
      axisLine: { lineStyle: { width: width + 8, color: [[Math.max(0, at - 0.005), "transparent"], [Math.min(1, at + 0.005), theme.text], [1, "transparent"]] } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      pointer: { show: false },
      anchor: { show: false },
      title: { show: false },
      detail: {
        show: !kit.compact,
        offsetCenter: [0, "22%"],
        color: theme.mutedText,
        fontFamily: font,
        fontSize: base.textStyle.fontSize,
        formatter: () => `Target ${kit.fullFormatters[0](targetRaw as string | number)}`,
      },
      data: [{ value: target }],
      z: 3,
    });
  }
  return {
    ...kit.common,
    legend: { show: false },
    tooltip: {
      ...(kit.common.tooltip as Record<string, unknown>),
      trigger: "item" as const,
      formatter: () => {
        const list: TooltipRow[] = [{ colour, name: spec.series[0].label, value: value === null ? "—" : kit.fullFormatters[0](raw as string | number) }];
        if (target !== null) list.push({ colour: theme.text, name: spec.series[1]?.label ?? "Target", value: kit.fullFormatters[0](targetRaw as string | number) });
        return tooltipHtml(theme, "", list);
      },
    },
    series: series as EChartsOption["series"],
  };
}

// ------------------------------------------------------------------- Bullet

/**
 * A bullet chart's bands (Stephen Few's design, as in Power BI's bullet
 * visual): shaded ranges at percentages of the target, the last running on
 * to the end of the scale. Display numbers, for drawing only.
 */
export function bulletBands(target: number | null, actual: number | null, cutPercents: number[] = [60, 80]): number[] {
  if (target === null || target <= 0) return [];
  const cuts = cutPercents.map((percent) => (target * percent) / 100);
  const end = Math.max(target * 1.2, actual ?? 0, cuts[cuts.length - 1] ?? 0);
  const edges = [0, ...cuts, end];
  return edges.slice(1).map((edge, index) => edge - edges[index]).filter((width) => width > 0);
}

function bulletOption(kit: ChartKit): EChartsOption {
  const { spec, rows, theme, format } = kit;
  const actualField = spec.series[0].field;
  const targetField = spec.series[1]?.field;
  const grouped = rows.some((row) => Object.prototype.hasOwnProperty.call(row, spec.category));
  const categories = grouped ? kit.categories : [spec.series[0].label];
  const fixedTarget = format.bullet?.target ?? null;
  const actuals = rows.map((row) => kit.displayNumber(row[actualField]));
  const targetRaw = rows.map((row) => (targetField ? row[targetField] ?? null : fixedTarget));
  const targets = targetRaw.map((raw) => kit.displayNumber(raw));
  const bandSets = rows.map((_row, index) => bulletBands(targets[index], actuals[index], format.bullet?.bands));
  const bandCount = Math.max(0, ...bandSets.map((set) => set.length));
  // Darkest band first (furthest from the target), all in the muted text's grey so they sit back in both themes.
  const bandShades = Array.from({ length: bandCount }, (_unused, index) => rgba(theme.mutedText, 0.3 - (0.2 * index) / Math.max(1, bandCount - 1)));
  const thickness = format.bars?.thickness ?? (kit.compact ? 16 : MARKS.barMaxWidth);
  const colour = kit.seriesColour(0);
  const labels = format.labels ?? {};

  const series: Array<Record<string, unknown>> = [];
  for (let band = 0; band < bandCount; band += 1) {
    series.push({
      type: "bar",
      name: `Band ${band + 1}`,
      stack: "bands",
      silent: true,
      barWidth: thickness,
      itemStyle: { color: bandShades[band] },
      emphasis: { disabled: true },
      data: bandSets.map((set) => set[band] ?? null),
      tooltip: { show: false },
      z: 1,
    });
  }
  series.push({
    type: "bar",
    name: spec.series[0].label,
    barWidth: Math.max(4, Math.round(thickness / 3)),
    barGap: "-100%",
    z: 3,
    itemStyle: { color: colour, borderRadius: format.bars?.rounded === false ? 0 : [0, 2, 2, 0] },
    data: actuals.map((value, index) => {
      const ruled = kit.ruleColour(0, rows[index][actualField]) ?? kit.groupColour(index);
      return ruled ? { value, itemStyle: { color: ruled } } : value;
    }),
    ...(labels.show
      ? {
          label: {
            show: true,
            position: "right",
            color: labels.color ?? kit.secondaryText,
            fontSize: kit.labelSize,
            formatter: (params: { value?: unknown }) => (params.value === null || params.value === undefined ? "" : kit.labelFormatters[0](params.value as number)),
          },
        }
      : {}),
  });
  if (targets.some((value) => value !== null)) {
    series.push({
      type: "scatter",
      name: spec.series[1]?.label ?? "Target",
      // A short upright line in the text colour: the target.
      symbol: "rect",
      symbolSize: [3, thickness + 4],
      itemStyle: { color: theme.text },
      z: 4,
      data: targets.map((value, index) => (value === null ? null : [value, index])),
    });
  }
  const tooltip = {
    ...(kit.common.tooltip as Record<string, unknown>),
    trigger: "axis" as const,
    axisPointer: kit.base.barPointer,
    formatter: (params: unknown) => {
      const list = (Array.isArray(params) ? params : [params]) as Array<{ dataIndex?: number }>;
      const index = list[0]?.dataIndex ?? 0;
      const row = rows[index];
      if (!row) return "";
      const out: TooltipRow[] = [{ colour, name: spec.series[0].label, value: row[actualField] === null ? "—" : kit.fullFormatters[0](row[actualField] as string | number) }];
      if (targetRaw[index] !== null) out.push({ colour: theme.text, name: spec.series[1]?.label ?? "Target", value: kit.fullFormatters[spec.series[1] ? 1 : 0](targetRaw[index] as string | number) });
      if (actuals[index] !== null && targets[index]) {
        out.push({ colour: "transparent", name: "Of the target", value: new Intl.NumberFormat("en-NZ", { style: "percent", maximumFractionDigits: 1 }).format(actuals[index]! / targets[index]!) });
      }
      return tooltipHtml(theme, categories[index] ?? "", out);
    },
  };
  const categoryAxis = { ...kit.categoryAxis, data: categories, inverse: format.categoryAxis?.reverse !== true, axisLabel: { ...(kit.categoryAxis.axisLabel as object), width: kit.compact ? 88 : 140, overflow: "truncate" as const } };
  return {
    ...kit.common,
    legend: { show: false },
    tooltip,
    grid: { top: kit.compact ? 8 : 16, bottom: 4, left: 4, right: kit.compact ? 8 : 24, outerBoundsMode: "same", outerBoundsContain: "all" },
    xAxis: kit.valueAxis(0, format.valueAxis, { vertical: false }),
    yAxis: categoryAxis,
    series: series as EChartsOption["series"],
  };
}
