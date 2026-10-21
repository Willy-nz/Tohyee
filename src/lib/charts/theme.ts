/**
 * One look for every chart in Tohyee (decisions 599-601): the colours as
 * tokens with a light and a dark value, and the ECharts styling built from
 * them, so Analytics charts, pinned tiles, Home, key figures, the cash flow
 * forecast and the farm pages all match.
 *
 * The values here are the same as the `--chart-*` variables in
 * `src/app/globals.css` (a unit test checks they agree). Charts drawn as SVG
 * use the variables; ECharts reads them from the page with `readChartTheme`,
 * falling back to these values.
 *
 * Every categorical set was run through the data-visualisation colour
 * validator in both themes (light on #ffffff, dark on #121925): see
 * decision 599 for the results.
 */

export type ChartMode = "light" | "dark";

export type ChartTokens = {
  /** The card the chart sits on. */
  surface: string;
  text: string;
  secondaryText: string;
  mutedText: string;
  /** Hairline gridlines, one step off the surface. */
  grid: string;
  /** The baseline (zero line) and the hover crosshair. */
  axis: string;
  /** The faint band behind the hovered group of columns. */
  hover: string;
  /** De-emphasised marks: a sparkline's trend, "everything else". */
  muted: string;
  /** Eight series colours in their checked order (blue, orange, aqua, yellow, pink, green, purple, red). */
  series: string[];
  /** Four steps of Tohyee blue for the "Tohyee blues" colour set, first series first. */
  blues: string[];
  /** One hue, light to dark, for amounts (heat maps, shading by size). */
  sequential: string[];
  /** Below and above a midpoint, with a grey middle that reads as "nothing". */
  diverging: { below: string; middle: string; above: string };
  /** Kept for meaning (good, warning, critical); never used as "series 4". */
  status: { good: string; warning: string; critical: string; criticalWash: string };
};

const SEQUENTIAL = ["#dbe9fc", "#b9d0ef", "#93b3df", "#6e97cf", "#497bbf", "#205fad", "#01458e"];

export const CHART_TOKENS: Record<ChartMode, ChartTokens> = {
  light: {
    surface: "#ffffff",
    text: "#1b2533",
    secondaryText: "#3c4757",
    mutedText: "#546072",
    grid: "#e9edf2",
    axis: "#c5cdd8",
    hover: "rgba(31, 95, 174, 0.06)",
    muted: "#8b94a1",
    series: ["#1f5fae", "#d66919", "#009e98", "#e2a520", "#d4679f", "#057836", "#694daf", "#ba3e3c"],
    blues: ["#004085", "#1f5fae", "#5388cd", "#7ab0f9"],
    sequential: SEQUENTIAL,
    diverging: { below: "#d66919", middle: "#e4e8ed", above: "#1f5fae" },
    status: { good: "#0ca30c", warning: "#fab219", critical: "#d03b3b", criticalWash: "rgba(208, 59, 59, 0.07)" },
  },
  dark: {
    surface: "#121925",
    text: "#e4e9f1",
    secondaryText: "#c5cdd8",
    mutedText: "#9ba6b6",
    grid: "#1f2836",
    axis: "#3a4658",
    hover: "rgba(91, 156, 240, 0.08)",
    muted: "#6b7686",
    series: ["#518fe9", "#cf630d", "#05908a", "#bd8703", "#cd6199", "#17843f", "#7f65ca", "#c04442"],
    blues: ["#b4d4fe", "#70adfe", "#4c87d5", "#215da7"],
    // Dark mode flips the anchor: small amounts sit near the dark surface.
    sequential: [...SEQUENTIAL].reverse(),
    diverging: { below: "#cf630d", middle: "#2e333b", above: "#518fe9" },
    status: { good: "#0ca30c", warning: "#fab219", critical: "#e66767", criticalWash: "rgba(230, 103, 103, 0.1)" },
  },
};

/** The CSS variable for each token (the series, blues and sequential ones are numbered from 1). */
export function chartVariables(tokens: ChartTokens): Record<string, string> {
  return {
    "--chart-surface": tokens.surface,
    "--chart-text": tokens.text,
    "--chart-text-secondary": tokens.secondaryText,
    "--chart-text-muted": tokens.mutedText,
    "--chart-grid": tokens.grid,
    "--chart-axis": tokens.axis,
    "--chart-hover": tokens.hover,
    "--chart-muted": tokens.muted,
    ...Object.fromEntries(tokens.series.map((colour, index) => [`--chart-${index + 1}`, colour])),
    ...Object.fromEntries(tokens.blues.map((colour, index) => [`--chart-blues-${index + 1}`, colour])),
    ...Object.fromEntries(tokens.sequential.map((colour, index) => [`--chart-seq-${index + 1}`, colour])),
    "--chart-diverging-below": tokens.diverging.below,
    "--chart-diverging-middle": tokens.diverging.middle,
    "--chart-diverging-above": tokens.diverging.above,
    "--chart-good": tokens.status.good,
    "--chart-warning": tokens.status.warning,
    "--chart-negative": tokens.status.critical,
    "--chart-negative-wash": tokens.status.criticalWash,
  };
}

/** What an ECharts chart needs from the theme. */
export type ChartTheme = {
  text: string;
  /** Labels and legend text; the main text colour when left out. */
  secondaryText?: string;
  mutedText: string;
  grid: string;
  /** Baseline and crosshair; the grid colour when left out. */
  axis?: string;
  background: string;
  /** Behind the hovered group of columns. */
  hover?: string;
  /** The eight chart colours in their checked order (--chart-1 to --chart-8). */
  palette: string[];
  /** Four steps of blue (--chart-blues-1 to 4), for the "Tohyee blues" colours. */
  blues?: string[];
  /** Below-zero bars when "red when negative" is on (--chart-negative). */
  negative?: string;
  /** The page's font, so chart text matches the text around it. */
  font?: string;
  /** Data labels, legend and tooltip text in pixels (a report theme's; 12 when left out). */
  labelSize?: number;
  /** Axis labels in pixels (a report theme's; 12 when left out). */
  axisSize?: number;
  /** De-emphasised marks (--chart-muted), e.g. a waterfall's total bar. */
  muted?: string;
  /** One hue, light to dark, for amounts (--chart-seq-1 to 7), e.g. heat maps. */
  sequential?: string[];
  /** Below and above a midpoint with a grey middle (--chart-diverging-*), for amounts either side of zero. */
  diverging?: { below: string; middle: string; above: string };
};

export function chartThemeFromTokens(tokens: ChartTokens, font?: string): ChartTheme {
  return {
    text: tokens.text,
    secondaryText: tokens.secondaryText,
    mutedText: tokens.mutedText,
    grid: tokens.grid,
    axis: tokens.axis,
    background: tokens.surface,
    hover: tokens.hover,
    palette: tokens.series,
    blues: tokens.blues,
    negative: tokens.status.critical,
    muted: tokens.muted,
    sequential: tokens.sequential,
    diverging: tokens.diverging,
    ...(font ? { font } : {}),
  };
}

/**
 * The theme from the page's CSS variables (`read` is `getPropertyValue` on
 * the root's computed style), so it follows light and dark. Anything not set
 * falls back to the light tokens.
 */
export function readChartTheme(read: (name: string) => string): ChartTheme {
  const fallback = CHART_TOKENS.light;
  const value = (name: string, otherwise: string) => read(name)?.trim() || otherwise;
  // A report theme (decision 668) can set its own font, sizes and 2-12 colours.
  const font = read("--chart-font")?.trim() || read("--font")?.trim();
  const size = (name: string) => {
    const number = Number(read(name)?.trim());
    return Number.isInteger(number) && number >= 9 && number <= 18 ? number : undefined;
  };
  const counted = Number(read("--chart-count")?.trim());
  const count = Number.isInteger(counted) && counted >= 2 && counted <= 12 ? counted : fallback.series.length;
  const labelSize = size("--chart-label-size");
  const axisSize = size("--chart-axis-size");
  return {
    text: value("--chart-text", fallback.text),
    secondaryText: value("--chart-text-secondary", fallback.secondaryText),
    mutedText: value("--chart-text-muted", fallback.mutedText),
    grid: value("--chart-grid", fallback.grid),
    axis: value("--chart-axis", fallback.axis),
    background: value("--chart-surface", fallback.surface),
    hover: value("--chart-hover", fallback.hover),
    palette: Array.from({ length: count }, (_unused, index) => value(`--chart-${index + 1}`, fallback.series[index % fallback.series.length])),
    blues: fallback.blues.map((colour, index) => value(`--chart-blues-${index + 1}`, colour)),
    negative: value("--chart-negative", fallback.status.critical),
    muted: value("--chart-muted", fallback.muted),
    sequential: fallback.sequential.map((colour, index) => value(`--chart-seq-${index + 1}`, colour)),
    diverging: {
      below: value("--chart-diverging-below", fallback.diverging.below),
      middle: value("--chart-diverging-middle", fallback.diverging.middle),
      above: value("--chart-diverging-above", fallback.diverging.above),
    },
    ...(font ? { font } : {}),
    ...(labelSize ? { labelSize } : {}),
    ...(axisSize ? { axisSize } : {}),
  };
}

/** Fixed mark sizes (the same on every chart). */
export const MARKS = {
  /** Columns and bars are at most this thick, so the leftover reads as air. */
  barMaxWidth: 24,
  /** Rounded at the data end only; square on the baseline. */
  barRadius: 4,
  lineWidth: 2,
  /** Dots on lines: 8px across with a 2px ring in the surface colour. */
  symbolSize: 8,
  ringWidth: 2,
  /** Area under a line: a wash of the line's colour. */
  areaOpacity: 0.12,
  stackedAreaOpacity: 0.22,
  /** The gap in the surface colour between touching marks (stacked segments, slices). */
  gap: 2,
} as const;

/** The rounded data end of a column or bar: up or right for positive values, down or left for negative ones. */
export function barRadius(horizontal: boolean, negative: boolean): [number, number, number, number] {
  const r = MARKS.barRadius;
  if (horizontal) return negative ? [r, 0, 0, r] : [0, r, r, 0];
  return negative ? [0, 0, r, r] : [r, r, 0, 0];
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export type TooltipRow = { colour: string; name: string; value: string; note?: string; line?: boolean };

/**
 * One tooltip layout for every chart: the group in muted text, then a row a
 * value with a short key in its colour (a line for lines, a square for
 * columns and slices), the name in secondary text and the value in bold.
 * Names come from the data, so everything is escaped.
 */
export function tooltipHtml(theme: ChartTheme, heading: string, rows: TooltipRow[]): string {
  const secondary = theme.secondaryText ?? theme.text;
  const head = heading ? `<div style="color:${theme.mutedText};font-size:12px;margin-bottom:4px">${escapeHtml(heading)}</div>` : "";
  const body = rows
    .map((row) => {
      const key = row.line
        ? `<span style="display:inline-block;width:12px;height:2px;border-radius:1px;background:${row.colour};vertical-align:middle;margin-right:8px"></span>`
        : `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${row.colour};vertical-align:middle;margin-right:8px"></span>`;
      const note = row.note ? ` <span style="color:${theme.mutedText}">${escapeHtml(row.note)}</span>` : "";
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;line-height:20px"><span style="color:${secondary}">${key}${escapeHtml(row.name)}</span><span style="color:${theme.text};font-weight:600;font-variant-numeric:tabular-nums">${escapeHtml(row.value)}${note}</span></div>`;
    })
    .join("");
  return `${head}${body}`;
}

/** The parts of every ECharts option that come from the theme rather than the data. */
export function echartsBase(theme: ChartTheme) {
  const secondary = theme.secondaryText ?? theme.text;
  const font = theme.font ?? "system-ui, -apple-system, \"Segoe UI\", sans-serif";
  const labelSize = theme.labelSize ?? 12;
  const axisSize = theme.axisSize ?? 12;
  return {
    backgroundColor: "transparent",
    labelSize,
    textStyle: { color: theme.text, fontFamily: font, fontSize: labelSize },
    legend: {
      textStyle: { color: secondary, fontSize: labelSize },
      pageTextStyle: { color: theme.mutedText },
      pageIconColor: secondary,
      pageIconInactiveColor: theme.grid,
      itemWidth: 12,
      itemHeight: 8,
      itemGap: 16,
    },
    tooltip: {
      backgroundColor: theme.background,
      borderColor: theme.grid,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: theme.text, fontSize: labelSize + 1, fontFamily: font },
      extraCssText: "border-radius:8px;box-shadow:0 2px 6px rgba(15,23,35,0.08),0 8px 24px rgba(15,23,35,0.12);",
    },
    /** For the value axis: no line, light gridlines, muted labels. */
    valueAxis: {
      axisLabel: { color: theme.mutedText, fontSize: axisSize },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: theme.grid, width: 1, type: "solid" as const } },
    },
    /** For the group axis: a baseline, no ticks, muted labels. */
    categoryAxis: {
      axisLabel: { color: theme.mutedText, fontSize: axisSize, hideOverlap: true },
      axisLine: { show: true, lineStyle: { color: theme.axis ?? theme.grid, width: 1 } },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: theme.grid, width: 1, type: "solid" as const } },
    },
    axisName: { color: theme.mutedText, fontSize: axisSize },
    /** The hover marker: a hairline for lines, a faint band for columns. */
    linePointer: { type: "line" as const, lineStyle: { color: theme.axis ?? theme.grid, width: 1, type: "solid" as const }, z: 0 },
    barPointer: { type: "shadow" as const, shadowStyle: { color: theme.hover ?? "rgba(31, 95, 174, 0.06)" }, z: 0 },
  };
}
