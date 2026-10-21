import type { ChartFormat } from "@/lib/analytics/chart-format";

/**
 * The chart editor's panel (#387 "Keep the editor manageable", decisions
 * 750-752): pure rules about what it shows, so they can be tested.
 */

/** The selected visual's panel is split three ways (Power BI's Build / Format / Analytics, Looker Studio's Setup / Style). */
export const PANEL_TABS = ["data", "style", "interactions"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];
export const PANEL_TAB_LABELS: Record<PanelTab, string> = { data: "Data", style: "Style", interactions: "Interactions" };

/**
 * Chart types shown straight away. The rest are specialist (decision 751):
 * they're behind "More chart types", unless the chart already uses one.
 */
export const COMMON_VISUALS = ["column", "bar", "line", "area", "combo", "pie", "donut", "kpi", "table", "pivot"] as const;

export function isSpecialistVisual(visual: string): boolean {
  return !(COMMON_VISUALS as readonly string[]).includes(visual);
}

/** Where a setting the chart shows comes from (decision 750). */
export type SettingSource = "chart" | "default" | "theme";
export type SettingPath = Array<string | number>;

/** The value at a path in a format, or undefined. */
export function valueAt(format: ChartFormat | undefined, path: SettingPath): unknown {
  let value: unknown = format;
  for (const key of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

function isSet(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.some(isSet);
  if (typeof value === "object") return Object.values(value as object).some(isSet);
  return true;
}

/**
 * Which level sets a setting: the chart's own override, the report's
 * default for its chart type, or neither, so the report theme (or Tohyee's
 * look) decides. Any one of several paths counts, for a group of settings.
 */
export function settingSource(paths: SettingPath | SettingPath[], own: ChartFormat | undefined, chartDefault: ChartFormat | undefined): SettingSource {
  const list = (Array.isArray(paths[0]) ? paths : [paths]) as SettingPath[];
  if (list.some((path) => isSet(valueAt(own, path)))) return "chart";
  if (list.some((path) => isSet(valueAt(chartDefault, path)))) return "default";
  return "theme";
}

/** Removes empty objects and trailing empty list entries, so a reset setting leaves nothing behind. */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    const list = value.map((entry) => prune(entry) ?? {});
    while (list.length && !isSet(list[list.length - 1])) list.pop();
    return list.length ? list : undefined;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, entry]) => [key, prune(entry)] as const).filter(([, entry]) => entry !== undefined && entry !== "");
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

/**
 * The chart's format with one setting (or group of settings) taken off, so
 * the chart goes back to its chart type default or the theme for just that
 * setting. Everything else stays as it was.
 */
export function withoutSettings(format: ChartFormat | undefined, paths: SettingPath | SettingPath[]): ChartFormat | undefined {
  if (!format) return undefined;
  const list = (Array.isArray(paths[0]) ? paths : [paths]) as SettingPath[];
  const copy = JSON.parse(JSON.stringify(format)) as Record<string | number, unknown>;
  for (const path of list) {
    let parent: unknown = copy;
    for (const key of path.slice(0, -1)) {
      if (parent === null || typeof parent !== "object") break;
      parent = (parent as Record<string | number, unknown>)[key];
    }
    if (parent && typeof parent === "object") {
      const last = path[path.length - 1];
      if (Array.isArray(parent) && typeof last === "number") parent[last] = {};
      else delete (parent as Record<string | number, unknown>)[last];
    }
  }
  return prune(copy) as ChartFormat | undefined;
}

/** What the source is called next to a setting. */
export function sourceText(source: SettingSource, chartTypeName: string, themeName: string): string {
  if (source === "chart") return "Changed on this chart";
  if (source === "default") return `From this report's ${chartTypeName.toLowerCase()} default`;
  return themeName === "Tohyee" ? "From the theme (Tohyee)" : `From the ${themeName} theme`;
}

/**
 * Advanced settings (decision 751): statistics and fine control most charts
 * don't need. Their sections are hidden until "Show advanced settings" is
 * chosen, unless the chart (or its chart type default) already uses one, so
 * nothing in use is ever out of sight.
 */
export const ADVANCED_SETTINGS: SettingPath[] = [
  ["referenceLines"],
  ["chartRules"],
  ["gridlines"],
  ["plot"],
  ["valueAxis", "log"],
  ["rightAxis", "log"],
  ["xAxis", "log"],
];

/** Whether any value's trend or projection is turned on (an advanced statistic too). */
function usesTrend(format: ChartFormat | undefined): boolean {
  return (format?.series ?? []).some((series) => Boolean(series?.trend || series?.forecast));
}

export function usesAdvanced(format: ChartFormat | undefined): boolean {
  return ADVANCED_SETTINGS.some((path) => isSet(valueAt(format, path))) || usesTrend(format);
}
