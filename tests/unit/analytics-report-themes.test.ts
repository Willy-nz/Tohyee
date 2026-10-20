import { describe, expect, it } from "vitest";
import { checkColours, contrast, deltaE, fromOklch, oklch } from "@/lib/charts/colour-check";
import {
  BUILT_IN_IDS,
  BUILT_IN_THEMES,
  checkTheme,
  customThemeId,
  deriveDark,
  exportTheme,
  importTheme,
  parseReportTheme,
  resolveTheme,
  themeCss,
  themeVariables,
  type ReportTheme,
} from "@/lib/charts/report-themes";
import { CHART_TOKENS, readChartTheme } from "@/lib/charts/theme";

const custom = {
  name: "Shop colours",
  light: { series: ["#1f5fae", "#d66919", "#009e98"], page: "#f5f7fa", card: "#ffffff", text: "#1b2533", mutedText: "#546072" },
};

describe("the colour checks (ported from the data-visualisation validator)", () => {
  it("gives the same figures as decision 599 for the Tohyee colours", () => {
    const light = checkColours({ series: CHART_TOKENS.light.series, card: "#ffffff", text: "#1b2533", mutedText: "#546072" }, "light");
    const dark = checkColours({ series: CHART_TOKENS.dark.series, card: "#121925", text: "#e4e9f1", mutedText: "#9ba6b6" }, "dark");
    expect(light.worstColourBlind!.toFixed(1)).toBe("15.1");
    expect(light.worstNormal!.toFixed(1)).toBe("22.7");
    expect(dark.worstColourBlind!.toFixed(1)).toBe("12.9");
    expect(dark.worstNormal!.toFixed(1)).toBe("20.4");
    // Only the yellow's contrast on white, as decision 599 says.
    expect(light.warnings.map((warning) => warning.check)).toEqual(["mark-contrast"]);
    expect(dark.warnings).toEqual([]);
  });

  it("measures contrast and colour distance", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(deltaE("#1f5fae", "#1f5fae")).toBe(0);
    const { l, c, h } = oklch("#1f5fae");
    expect(fromOklch(l, c, h)).toBe("#1f5fae");
  });

  it("warns about colours that are too close, grey or faint, and text that's hard to read", () => {
    const result = checkColours({ series: ["#1f5fae", "#2060b0", "#888888", "#f5f5f5"], card: "#ffffff", text: "#bbbbbb", mutedText: "#cccccc" }, "light");
    const checks = new Set(result.warnings.map((warning) => warning.check));
    expect(checks).toEqual(new Set(["colour-blind", "normal", "chroma", "band", "mark-contrast", "text-contrast"]));
  });
});

describe("built-in report themes (decision 668)", () => {
  it("has the Tohyee theme first and five more", () => {
    expect(BUILT_IN_IDS[0]).toBe("tohyee");
    expect(BUILT_IN_IDS).toHaveLength(6);
    expect(BUILT_IN_THEMES.tohyee.light.series).toEqual(CHART_TOKENS.light.series);
    expect(BUILT_IN_THEMES.tohyee.dark.series).toEqual(CHART_TOKENS.dark.series);
  });

  it.each(BUILT_IN_IDS)("%s passes the colour-blind and normal-vision checks in light and dark", (id) => {
    const theme = BUILT_IN_THEMES[id];
    // Every built-in theme is a valid theme.
    expect(parseReportTheme(theme)).toEqual(parseReportTheme(JSON.parse(JSON.stringify(theme))));
    for (const mode of ["light", "dark"] as const) {
      const result = checkColours(theme[mode], mode);
      expect(result.worstColourBlind!).toBeGreaterThanOrEqual(8);
      expect(result.worstNormal!).toBeGreaterThanOrEqual(15);
      const allowed = result.warnings.filter((warning) => warning.check !== "mark-contrast");
      expect(allowed, `${id} ${mode}`).toEqual([]);
    }
    // At most one light colour (a yellow or gold) under 3:1, and none in dark except where named.
    const faint = checkTheme(theme).filter((warning) => warning.check === "mark-contrast");
    expect(faint.length).toBeLessThanOrEqual(id === "bright" ? 3 : 1);
  });
});

describe("custom themes", () => {
  it("accepts any hex colours, dropping settings it doesn't know", () => {
    const theme = parseReportTheme({ ...custom, extra: "ignored", sizes: { title: 18, mystery: 3 }, card: { radius: 0, shadow: "soft" }, font: "georgia" });
    expect(theme.name).toBe("Shop colours");
    expect(theme.sizes).toEqual({ title: 18 });
    expect(theme.card).toEqual({ radius: 0, shadow: "soft" });
    expect(theme.font).toBe("georgia");
    expect("extra" in theme).toBe(false);
  });

  it("works out dark colours when only light ones are given, inside the dark band", () => {
    const theme = parseReportTheme(custom);
    expect(theme.dark.series).toHaveLength(3);
    for (const colour of theme.dark.series) {
      const { l } = oklch(colour);
      expect(l).toBeGreaterThanOrEqual(0.48);
      expect(l).toBeLessThanOrEqual(0.67);
    }
    expect(deriveDark(theme.light).card).not.toBe(theme.light.card);
    // The derived set is checked like any other, and its text reads on its card.
    expect(checkTheme(theme).filter((warning) => warning.mode === "dark" && warning.check === "text-contrast")).toEqual([]);
  });

  it("refuses wrong values", () => {
    expect(() => parseReportTheme({ ...custom, name: "" })).toThrow(/name/);
    expect(() => parseReportTheme({ ...custom, light: { ...custom.light, series: ["#1f5fae"] } })).toThrow(/2 to 12/);
    expect(() => parseReportTheme({ ...custom, light: { ...custom.light, series: Array(13).fill("#1f5fae") } })).toThrow(/2 to 12/);
    expect(() => parseReportTheme({ ...custom, light: { ...custom.light, card: "red" } })).toThrow(/colour like/);
    expect(() => parseReportTheme({ ...custom, light: { ...custom.light, page: "#fff" } })).toThrow(/colour like/);
    expect(() => parseReportTheme({ ...custom, light: { ...custom.light, text: "#ffffff;}body{" } })).toThrow(/colour like/);
    expect(() => parseReportTheme({ ...custom, font: "Comic Sans" })).toThrow(/font/);
    expect(() => parseReportTheme({ ...custom, sizes: { labels: 40 } })).toThrow(/9 to 18/);
    expect(() => parseReportTheme({ ...custom, card: { radius: 2.5 } })).toThrow(/whole number/);
    expect(() => parseReportTheme({ ...custom, card: { shadow: "huge" } })).toThrow(/shadow/);
    expect(() => parseReportTheme([])).toThrow();
  });

  it("warns but doesn't refuse colours that fail the checks", () => {
    const theme = parseReportTheme({ ...custom, light: { ...custom.light, series: ["#1f5fae", "#2060b0"] } });
    expect(checkTheme(theme).some((warning) => warning.check === "normal" && warning.mode === "light")).toBe(true);
  });

  it("exports and imports as JSON", () => {
    const theme = parseReportTheme({ ...custom, card: { radius: 10 } });
    const file = exportTheme(theme);
    expect(JSON.parse(file).tohyeeTheme).toBe(1);
    expect(importTheme(file)).toEqual(theme);
    expect(() => importTheme("not json")).toThrow(/isn't JSON/);
    expect(() => importTheme("{}")).toThrow(/name/);
  });

  it("reads a report's choice of a custom theme", () => {
    expect(customThemeId("custom:12")).toBe("12");
    expect(customThemeId("custom:x")).toBeNull();
    expect(customThemeId("harbour")).toBeNull();
    const own = parseReportTheme(custom);
    expect(resolveTheme("harbour", null)).toBe(BUILT_IN_THEMES.harbour);
    expect(resolveTheme("custom:12", own)).toBe(own);
    // A custom theme that's gone falls back to Tohyee.
    expect(resolveTheme("custom:12", null)).toBe(BUILT_IN_THEMES.tohyee);
    expect(resolveTheme(null, null)).toBe(BUILT_IN_THEMES.tohyee);
  });
});

describe("a theme as CSS", () => {
  it("changes nothing for the Tohyee theme, so existing reports look the same", () => {
    expect(themeCss(BUILT_IN_THEMES.tohyee, "report-theme")).toBe("");
    expect(themeCss(null, "report-theme")).toBe("");
  });

  it("scopes light and dark to the report, following the computer and the user menu", () => {
    const css = themeCss(BUILT_IN_THEMES.harbour, "report-theme");
    expect(css).toContain(".report-theme{--chart-surface:#ffffff");
    expect(css).toContain('@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .report-theme{--chart-surface:#12202a');
    expect(css).toContain(':root[data-theme="dark"] .report-theme{--chart-surface:#12202a');
    expect(() => themeCss(BUILT_IN_THEMES.harbour, "x;}body{")).toThrow();
  });

  it("is read back by the charts: colours (up to 12), font and sizes", () => {
    const theme: ReportTheme = parseReportTheme({
      ...custom,
      light: { ...custom.light, series: Array.from({ length: 12 }, (_unused, index) => `#${(index * 16 + 16).toString(16).padStart(2, "0")}3366`) },
      font: "verdana",
      sizes: { labels: 14, axes: 11 },
    });
    const variables = themeVariables(theme, "light");
    const chart = readChartTheme((name) => variables[name] ?? "");
    expect(chart.palette).toHaveLength(12);
    expect(chart.palette[11]).toBe(theme.light.series[11]);
    expect(chart.font).toContain("Verdana");
    expect(chart.labelSize).toBe(14);
    expect(chart.axisSize).toBe(11);
    expect(chart.background).toBe("#ffffff");
  });

  it("keeps eight colours when nothing says otherwise", () => {
    const chart = readChartTheme(() => "");
    expect(chart.palette).toEqual(CHART_TOKENS.light.series);
    expect(chart.labelSize).toBeUndefined();
  });
});
