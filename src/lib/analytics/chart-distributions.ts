import type { EChartsOption } from "echarts";
import type { ChartKit } from "@/lib/analytics/chart-visuals";
import { MARKS, tooltipHtml, type TooltipRow } from "@/lib/charts/theme";
import { add, cmp, dec, divideTruncated, isDecimalString, mul, sub, toPlainString, type Decimal } from "@/lib/money/decimal";

/**
 * Scatter and bubble, histogram and box plot (#376 phase 2, decision 678).
 * Bins and quartiles are worked out exactly in decimals, so a value on a
 * bin's edge always lands in the same bin and a quartile is the figure a
 * spreadsheet's QUARTILE.INC gives; only drawing turns them into numbers.
 */

function exact(value: string | number | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return isDecimalString(text) ? dec(text) : null;
}

const sortDecimals = (values: Decimal[]) => [...values].sort((a, b) => cmp(a, b));

function rgba(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(match[1].slice(at, at + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ---------------------------------------------------------------- Histogram

export type HistogramBin = { from: string; to: string; count: number };

/** A round bin width near `raw`: 1, 2, 2.5 or 5 times a power of ten, as an exact decimal string. */
export function niceWidth(raw: number): string {
  if (!Number.isFinite(raw) || raw <= 0) return "1";
  const exponent = Math.floor(Math.log10(raw));
  const fraction = raw / 10 ** exponent;
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  const digits = step === 2.5 ? "25" : String(step);
  const shift = exponent - (step === 2.5 ? 1 : 0);
  // digits × 10^shift, written out exactly.
  if (shift >= 0) return digits + "0".repeat(shift);
  const padded = digits.padStart(-shift + 1, "0");
  return toPlainString(dec(`${padded.slice(0, padded.length + shift)}.${padded.slice(padded.length + shift)}`));
}

export const MAX_BINS = 100;

/**
 * A histogram's bins over the values (Power BI's binning, Excel's
 * histogram): each bin runs from its start up to, not including, the next
 * one's, starting at a whole number of widths at or below the smallest
 * value. The width is the one chosen, or worked out from the number of bins
 * chosen (Sturges' rule when left out: 1 + log2 of the number of values),
 * rounded to 1, 2, 2.5 or 5 times a power of ten. Values that aren't
 * numbers are left out and counted.
 */
export function histogramBins(values: Array<string | number | null>, options: { bins?: number; width?: string } = {}): { bins: HistogramBin[]; skipped: number } {
  const numbers = values.map(exact);
  const kept = numbers.filter((value): value is Decimal => value !== null);
  const skipped = numbers.length - kept.length;
  if (!kept.length) return { bins: [], skipped };
  const sorted = sortDecimals(kept);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const span = Number(toPlainString(sub(max, min)));
  const count = options.bins ?? Math.min(50, Math.ceil(Math.log2(kept.length)) + 1);
  let width = options.width && cmp(dec(options.width), dec("0")) > 0 ? dec(options.width) : dec(niceWidth(span / Math.max(1, count)));
  const startOf = (step: Decimal) => {
    let whole = divideTruncated(min, step, 0);
    // Truncating goes towards zero; below zero the start must be at or below the smallest value.
    if (cmp(mul(whole, step), min) > 0) whole = sub(whole, dec("1"));
    return mul(whole, step);
  };
  let start = startOf(width);
  const binsFor = (step: Decimal, from: Decimal) => Number(toPlainString(divideTruncated(sub(max, from), step, 0))) + 1;
  // A width too small for the values falls back to the automatic one.
  if (binsFor(width, start) > MAX_BINS) {
    width = dec(niceWidth(span / Math.min(50, Math.ceil(Math.log2(kept.length)) + 1)));
    start = startOf(width);
  }
  const total = binsFor(width, start);
  const bins: HistogramBin[] = Array.from({ length: total }, (_unused, index) => {
    const from = add(start, mul(dec(String(index)), width));
    return { from: toPlainString(from), to: toPlainString(add(from, width)), count: 0 };
  });
  for (const value of kept) {
    const index = Number(toPlainString(divideTruncated(sub(value, start), width, 0)));
    bins[Math.min(index, bins.length - 1)].count += 1;
  }
  return { bins, skipped };
}

export function histogramOption(kit: ChartKit): EChartsOption {
  const { spec, rows, theme, format, base } = kit;
  const field = spec.series[0].field;
  const { bins } = histogramBins(rows.map((row) => row[field]), format.histogram ?? {});
  const total = bins.reduce((sum, bin) => sum + bin.count, 0);
  const shortName = kit.axisFormatters[0];
  const fullName = kit.fullFormatters[0];
  const names = bins.map((bin) => `${shortName(bin.from)}–${shortName(bin.to)}`);
  const colour = kit.seriesColour(0);
  const labels = format.labels ?? {};
  const counts = new Intl.NumberFormat("en-NZ", { maximumFractionDigits: 0 });
  const share = new Intl.NumberFormat("en-NZ", { style: "percent", maximumFractionDigits: 1 });
  const countAxis = kit.valueAxis(0, format.valueAxis);
  return {
    ...kit.common,
    legend: { show: false },
    tooltip: {
      ...(kit.common.tooltip as Record<string, unknown>),
      trigger: "axis" as const,
      axisPointer: base.barPointer,
      formatter: (params: unknown) => {
        const list = (Array.isArray(params) ? params : [params]) as Array<{ dataIndex?: number }>;
        const bin = bins[list[0]?.dataIndex ?? 0];
        if (!bin) return "";
        const out: TooltipRow[] = [
          { colour, name: "Count", value: counts.format(bin.count) },
          { colour: "transparent", name: "Of all", value: total ? share.format(bin.count / total) : "—" },
        ];
        return tooltipHtml(theme, `${fullName(bin.from)} up to ${fullName(bin.to)}`, out);
      },
    },
    grid: { top: kit.compact ? 8 : 20, bottom: 4, left: 4, right: kit.compact ? 8 : 16, outerBoundsMode: "same", outerBoundsContain: "all" },
    xAxis: { ...kit.categoryAxis, data: names },
    // Counts are whole numbers.
    yAxis: { ...countAxis, minInterval: 1, axisLabel: { ...(countAxis.axisLabel as object), formatter: (value: number) => counts.format(value) } },
    series: [
      {
        type: "bar",
        name: spec.series[0].label,
        data: bins.map((bin) => bin.count),
        // Bins touch, with the 2px surface gap between them.
        barCategoryGap: "0%",
        itemStyle: { color: colour, borderColor: theme.background, borderWidth: MARKS.gap / 2, borderRadius: format.bars?.rounded === false ? 0 : [2, 2, 0, 0] },
        ...(labels.show
          ? { label: { show: true, position: "top", color: labels.color ?? kit.secondaryText, fontSize: kit.labelSize, formatter: (params: { value?: unknown }) => (params.value ? counts.format(Number(params.value)) : "") } }
          : {}),
      },
    ] as EChartsOption["series"],
  };
}

// ----------------------------------------------------------------- Box plot

export type BoxStats = {
  count: number;
  min: string;
  q1: string;
  median: string;
  q3: string;
  max: string;
  /** The whiskers: the furthest values within 1.5 times the middle half's spread of the box (Tukey). */
  low: string;
  high: string;
  outliers: string[];
};

/** A quantile by linear interpolation between ranks (Excel's QUARTILE.INC and PERCENTILE.INC), exactly. */
export function quantile(sorted: Decimal[], share: string): Decimal {
  const rank = mul(dec(String(sorted.length - 1)), dec(share));
  const low = Number(toPlainString(divideTruncated(rank, dec("1"), 0)));
  const fraction = sub(rank, dec(String(low)));
  if (low + 1 >= sorted.length || cmp(fraction, dec("0")) === 0) return sorted[low];
  return add(sorted[low], mul(sub(sorted[low + 1], sorted[low]), fraction));
}

/** One box's figures from its values (blanks and non-numbers left out); null with no values. */
export function boxStats(values: Array<string | number | null>): BoxStats | null {
  const kept = values.map(exact).filter((value): value is Decimal => value !== null);
  if (!kept.length) return null;
  const sorted = sortDecimals(kept);
  const q1 = quantile(sorted, "0.25");
  const q3 = quantile(sorted, "0.75");
  const reach = mul(sub(q3, q1), dec("1.5"));
  const lowFence = sub(q1, reach);
  const highFence = add(q3, reach);
  const inside = sorted.filter((value) => cmp(value, lowFence) >= 0 && cmp(value, highFence) <= 0);
  return {
    count: sorted.length,
    min: toPlainString(sorted[0]),
    q1: toPlainString(q1),
    median: toPlainString(quantile(sorted, "0.5")),
    q3: toPlainString(q3),
    max: toPlainString(sorted[sorted.length - 1]),
    low: toPlainString(inside[0] ?? q1),
    high: toPlainString(inside[inside.length - 1] ?? q3),
    outliers: sorted.filter((value) => cmp(value, lowFence) < 0 || cmp(value, highFence) > 0).map(toPlainString),
  };
}

/** The boxes: one per group, from the values of its second grouping's items (or every row when there's none), in the groups' order. */
export function boxGroups(rows: Array<Record<string, string | number | null>>, category: string, field: string): Array<{ name: unknown; first: number; stats: BoxStats }> {
  const groups = new Map<string, { name: unknown; first: number; values: Array<string | number | null> }>();
  rows.forEach((row, index) => {
    const key = JSON.stringify(row[category] ?? null);
    const group = groups.get(key) ?? { name: row[category] ?? null, first: index, values: [] };
    group.values.push(row[field]);
    groups.set(key, group);
  });
  return [...groups.values()].flatMap((group) => {
    const stats = boxStats(group.values);
    return stats ? [{ name: group.name, first: group.first, stats }] : [];
  });
}

export function boxPlotOption(kit: ChartKit): EChartsOption {
  const { spec, rows, theme, format } = kit;
  const field = spec.series[0].field;
  // With a second grouping, each box is a group's items; without one, a single box of every group's value.
  const boxes = spec.detail ? boxGroups(rows, spec.category, field) : (() => {
    const stats = boxStats(rows.map((row) => row[field]));
    return stats ? [{ name: spec.series[0].label, first: 0, stats }] : [];
  })();
  // Groups as the chart names them (dates as "Jan 2026").
  const categories = spec.detail ? boxes.map((box) => kit.categories[box.first] ?? "") : boxes.map((box) => String(box.name));
  const colour = kit.seriesColour(0);
  const thickness = format.bars?.thickness ?? (kit.compact ? 16 : 32);
  const showOutliers = format.boxplot?.outliers !== false;
  const full = kit.fullFormatters[0];
  const outliers = showOutliers ? boxes.flatMap((box, index) => box.stats.outliers.map((value) => ({ value: [index, Number(value)], raw: value }))) : [];
  return {
    ...kit.common,
    legend: { show: false },
    tooltip: {
      ...(kit.common.tooltip as Record<string, unknown>),
      trigger: "item" as const,
      formatter: (params: unknown) => {
        const entry = params as { seriesType?: string; dataIndex?: number; data?: { raw?: string; value?: number[] } };
        if (entry.seriesType === "scatter") {
          const index = entry.data?.value?.[0] ?? 0;
          return tooltipHtml(theme, categories[index] ?? "", [{ colour, name: "Outlier", value: full(entry.data?.raw ?? "") }]);
        }
        const box = boxes[entry.dataIndex ?? 0];
        if (!box) return "";
        const stats = box.stats;
        const rowsShown: TooltipRow[] = [
          { colour: "transparent", name: "Count", value: new Intl.NumberFormat("en-NZ").format(stats.count) },
          { colour: "transparent", name: "Highest", value: full(stats.max) },
          { colour: "transparent", name: "Upper whisker", value: full(stats.high) },
          { colour, name: "Upper quartile", value: full(stats.q3) },
          { colour, name: "Median", value: full(stats.median) },
          { colour, name: "Lower quartile", value: full(stats.q1) },
          { colour: "transparent", name: "Lower whisker", value: full(stats.low) },
          { colour: "transparent", name: "Lowest", value: full(stats.min) },
        ];
        return tooltipHtml(theme, categories[entry.dataIndex ?? 0] ?? "", rowsShown);
      },
    },
    grid: { top: kit.compact ? 8 : 20, bottom: 4, left: 4, right: kit.compact ? 8 : 16, outerBoundsMode: "same", outerBoundsContain: "all" },
    xAxis: { ...kit.categoryAxis, data: categories },
    yAxis: kit.valueAxis(0, format.valueAxis),
    series: [
      {
        type: "boxplot",
        name: spec.series[0].label,
        boxWidth: [Math.min(8, thickness), thickness],
        // A wash of the colour inside, the colour's 1.5px outline and median.
        itemStyle: { color: rgba(colour, 0.14), borderColor: colour, borderWidth: 1.5 },
        emphasis: { itemStyle: { color: rgba(colour, 0.24), borderColor: colour, borderWidth: 2 } },
        data: boxes.map((box) => [box.stats.low, box.stats.q1, box.stats.median, box.stats.q3, box.stats.high].map(Number)),
      },
      ...(outliers.length
        ? [
            {
              type: "scatter",
              name: "Outliers",
              symbolSize: MARKS.symbolSize,
              itemStyle: { color: colour, borderColor: theme.background, borderWidth: MARKS.ringWidth / 2 },
              data: outliers,
            },
          ]
        : []),
    ] as EChartsOption["series"],
  };
}

// ---------------------------------------------------------- Scatter, bubble

/** Bubble diameters with area in proportion to the size value (zero or less is the smallest dot). */
export function bubbleSizes(sizes: Array<number | null>, smallest = 8, largest = 40): number[] {
  const top = Math.max(0, ...sizes.map((size) => size ?? 0));
  return sizes.map((size) => (size === null || size <= 0 || top === 0 ? smallest : smallest + (largest - smallest) * Math.sqrt(size / top)));
}

/** A least-squares line through the points (display numbers), as its two ends; null with fewer than two different x values. */
export function fitLine(points: Array<[number, number]>): [[number, number], [number, number]] | null {
  if (points.length < 2) return null;
  const n = points.length;
  const meanX = points.reduce((total, [x]) => total + x, 0) / n;
  const meanY = points.reduce((total, [, y]) => total + y, 0) / n;
  const spread = points.reduce((total, [x]) => total + (x - meanX) ** 2, 0);
  if (spread === 0) return null;
  const slope = points.reduce((total, [x, y]) => total + (x - meanX) * (y - meanY), 0) / spread;
  const xs = points.map(([x]) => x);
  const low = Math.min(...xs);
  const high = Math.max(...xs);
  const at = (x: number) => Math.round((meanY + slope * (x - meanX)) * 1e9) / 1e9;
  return [[low, at(low)], [high, at(high)]];
}

export function scatterOption(kit: ChartKit): EChartsOption {
  const { spec, rows, theme, format } = kit;
  const [xSeries, ySeries, sizeSeries] = spec.series;
  const bubble = Boolean(sizeSeries);
  const points = rows.flatMap((row, index) => {
    const x = kit.displayNumber(row[xSeries.field]);
    const y = ySeries ? kit.displayNumber(row[ySeries.field]) : null;
    if (x === null || y === null) return [];
    return [{ index, x, y, size: sizeSeries ? kit.displayNumber(row[sizeSeries.field]) : null }];
  });
  const diameters = bubble ? bubbleSizes(points.map((point) => point.size)) : points.map(() => MARKS.symbolSize + MARKS.ringWidth);
  // One colour for every dot: the first value's (the theme's first colour unless chosen).
  const colour = kit.seriesColour(0);
  const labels = format.labels ?? {};
  const name = (index: number) => kit.categories[index] ?? "";
  // Names of dots on the right-hand side go to their left, so they stay on the card.
  const xs = points.map((point) => point.x);
  const middle = (Math.min(...xs) + Math.max(...xs)) / 2;
  const data = points.map((point, at) => {
    const ruled = kit.ruleColour(1, rows[point.index][ySeries.field]) ?? kit.groupColour(point.index);
    return {
      value: [point.x, point.y],
      name: name(point.index),
      symbolSize: diameters[at],
      row: point.index,
      ...(ruled ? { itemStyle: { color: ruled } } : {}),
      ...(labels.show && point.x > middle ? { label: { position: "left" as const } } : {}),
    };
  });
  const fitted = format.scatter?.trend ? fitLine(points.map((point) => [point.x, point.y])) : null;
  const xAxis = { ...kit.valueAxis(0, format.xAxis, { vertical: false }), position: "bottom" as const, ...(format.xAxis?.title ? { nameGap: 28 } : {}) };
  const yAxis = kit.valueAxis(1, format.valueAxis);
  return {
    ...kit.common,
    legend: { show: false },
    tooltip: {
      ...(kit.common.tooltip as Record<string, unknown>),
      trigger: "item" as const,
      formatter: (params: unknown) => {
        const entry = params as { seriesType?: string; data?: { row?: number } };
        if (entry.seriesType !== "scatter" || entry.data?.row === undefined) return "";
        const row = rows[entry.data.row];
        const list: TooltipRow[] = spec.series.map((series, index) => ({
          colour: index === 0 ? "transparent" : colour,
          name: series.label,
          value: row[series.field] === null ? "—" : kit.fullFormatters[index](row[series.field] as string | number),
        }));
        return tooltipHtml(theme, name(entry.data.row), list);
      },
    },
    grid: { top: kit.compact ? 8 : 20, bottom: 4, left: 4, right: kit.compact ? 8 : 24, outerBoundsMode: "same", outerBoundsContain: "all" },
    xAxis,
    yAxis,
    series: [
      {
        type: "scatter",
        name: ySeries.label,
        data,
        // A 2px ring in the surface colour keeps overlapping dots apart; bubbles are a little see-through.
        itemStyle: { color: colour, borderColor: theme.background, borderWidth: MARKS.ringWidth, ...(bubble ? { opacity: 0.78 } : {}) },
        emphasis: { scale: 1.15, itemStyle: { opacity: 1 } },
        ...(labels.show
          ? {
              label: { show: true, position: "right", width: 120, overflow: "truncate", color: labels.color ?? kit.secondaryText, fontSize: kit.labelSize, formatter: (params: { name?: string }) => params.name ?? "" },
              labelLayout: { hideOverlap: true },
            }
          : {}),
      },
      ...(fitted
        ? [
            {
              type: "line",
              name: "Trend",
              data: fitted,
              silent: true,
              showSymbol: false,
              symbol: "none",
              lineStyle: { color: theme.mutedText, width: 1.5, type: "dashed" },
              tooltip: { show: false },
            },
          ]
        : []),
    ] as EChartsOption["series"],
  };
}
