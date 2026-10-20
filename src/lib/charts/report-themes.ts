import { ValidationError } from "@/lib/errors";
import { CHART_TOKENS } from "@/lib/charts/theme";
import { adaptForDark, CHECKS, checkColours, contrast, darkStep, deltaE, isHex, type ColourWarning, type Mode } from "@/lib/charts/colour-check";

/**
 * Report themes (issue #376, decision 668). The Tohyee look (decision 599)
 * stays the default and is what every chart outside Analytics uses. An
 * Analytics report can choose another built-in theme or one of the
 * organisation's own. A theme is its colours for light and dark, a font
 * from a short safe list, text sizes and the card around each chart.
 *
 * A theme becomes CSS variables (`--chart-*` for the charts, `--report-*`
 * for the cards) on the report's tiles only, so the rest of the page keeps
 * Tohyee's look. Every colour is checked: any hex is allowed, and the checks
 * from the data-visualisation validator warn but never block.
 */

export type ThemeColours = {
  /** Series colours in order (2 to 12). */
  series: string[];
  /** Behind the cards. */
  page: string;
  /** The card each chart sits on. */
  card: string;
  text: string;
  mutedText: string;
  /** Left out: worked out from the card and text. */
  grid?: string;
  border?: string;
};

export const FONTS = {
  app: { label: "Tohyee (Inter)", css: "var(--font)" },
  system: { label: "System", css: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  arial: { label: "Arial", css: "Arial, Helvetica, sans-serif" },
  verdana: { label: "Verdana", css: "Verdana, Geneva, sans-serif" },
  trebuchet: { label: "Trebuchet", css: '"Trebuchet MS", Tahoma, sans-serif' },
  georgia: { label: "Georgia (serif)", css: 'Georgia, "Times New Roman", serif' },
} as const;
export type FontId = keyof typeof FONTS;

export type CardStyle = {
  /** Corner radius in pixels (0-24). */
  radius?: number;
  /** Border width in pixels (0-4). */
  border?: number;
  shadow?: "none" | "soft" | "strong";
  /** Padding inside the card in pixels (4-32). */
  padding?: number;
};

export type ThemeSizes = {
  /** The tile's title (12-28). */
  title?: number;
  /** Data labels, legend and tooltip text (9-18). */
  labels?: number;
  /** Axis labels (9-18). */
  axes?: number;
};

export type ReportTheme = {
  name: string;
  light: ThemeColours;
  dark: ThemeColours;
  font?: FontId;
  sizes?: ThemeSizes;
  card?: CardStyle;
};

export const BUILT_IN_IDS = ["tohyee", "harbour", "kowhai", "bush", "bright", "contrast"] as const;
export type BuiltInThemeId = (typeof BUILT_IN_IDS)[number];
export const DEFAULT_THEME_ID: BuiltInThemeId = "tohyee";

/**
 * The built-in themes. Every series set was run through the colour checks in
 * both modes (adjacent pairs: colour-blind ΔE at least 8 and normal-vision ΔE
 * at least 15; see decision 668 for the figures), and a unit test keeps them
 * passing. A light-mode yellow under 3:1 against white is the only warning,
 * as for Tohyee's own yellow.
 */
export const BUILT_IN_THEMES: Record<BuiltInThemeId, ReportTheme> = {
  tohyee: {
    name: "Tohyee",
    light: { series: [...CHART_TOKENS.light.series], page: "#f5f7fa", card: "#ffffff", text: "#1b2533", mutedText: "#546072", grid: "#e9edf2", border: "#dde2e9" },
    dark: { series: [...CHART_TOKENS.dark.series], page: "#0b1018", card: "#121925", text: "#e4e9f1", mutedText: "#9ba6b6", grid: "#1f2836", border: "#263041" },
  },
  harbour: {
    name: "Harbour",
    light: { series: ["#036b9a", "#dc604a", "#079a94", "#584cad", "#298646", "#c65b93", "#d6a20a", "#139cb6"], page: "#eef4f7", card: "#ffffff", text: "#14232e", mutedText: "#4a5d6b" },
    dark: { series: ["#1c90cb", "#d15e49", "#079a94", "#7970d5", "#298646", "#c0558d", "#b08505", "#0c8fa7"], page: "#0b141b", card: "#12202a", text: "#e3edf3", mutedText: "#9fb2bf" },
    font: "system",
    card: { radius: 12, border: 0, shadow: "soft" },
  },
  kowhai: {
    name: "Kōwhai",
    light: { series: ["#c68206", "#1666aa", "#b02a2d", "#0c9999", "#cf5604", "#614092", "#2e7c35", "#a44a94"], page: "#faf6ee", card: "#fffdf8", text: "#2a1f12", mutedText: "#63543f" },
    dark: { series: ["#bc7d19", "#418ad1", "#cb4644", "#029393", "#c4530f", "#7e5db1", "#38853e", "#b559a3"], page: "#16120c", card: "#1f1a12", text: "#f2ebdf", mutedText: "#b5a78f" },
    font: "georgia",
    card: { radius: 6 },
  },
  bush: {
    name: "Bush",
    light: { series: ["#137738", "#765092", "#be7125", "#1aa598", "#c1a20b", "#a43a41", "#0e6a9b", "#7c9128"], page: "#f2f5f0", card: "#ffffff", text: "#1b261c", mutedText: "#4f5e50" },
    dark: { series: ["#348f4f", "#946db1", "#b36d2a", "#0b9488", "#a58a07", "#bf5257", "#3e8ec1", "#718516"], page: "#0e140f", card: "#162019", text: "#e4ece4", mutedText: "#a1b2a2" },
    card: { radius: 8, padding: 20 },
  },
  bright: {
    name: "Bright",
    light: { series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"], page: "#fcfcfb", card: "#ffffff", text: "#0b0b0b", mutedText: "#52514e" },
    dark: { series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"], page: "#121211", card: "#1a1a19", text: "#f0efec", mutedText: "#c3c2b7" },
    font: "system",
  },
  contrast: {
    name: "Strong contrast",
    light: { series: ["#0053a4", "#b84b03", "#088871", "#b32228", "#5637a7", "#1f6d02", "#8c2a87", "#8f6b02"], page: "#ffffff", card: "#ffffff", text: "#000000", mutedText: "#333333", grid: "#d0d0d0", border: "#000000" },
    dark: { series: ["#4087de", "#dc692e", "#29a288", "#d24c49", "#816bd8", "#499537", "#bd5ab6", "#b68b16"], page: "#000000", card: "#0a0a0a", text: "#ffffff", mutedText: "#d6d6d6", grid: "#3a3a3a", border: "#ffffff" },
    sizes: { labels: 13, axes: 13 },
    card: { radius: 4, border: 2, shadow: "none" },
  },
};

export function isBuiltInTheme(id: unknown): id is BuiltInThemeId {
  return typeof id === "string" && (BUILT_IN_IDS as readonly string[]).includes(id);
}

/** A report's theme choice: a built-in id, or `custom:<id>` for one of the organisation's. */
export const CUSTOM_PREFIX = "custom:";

export function customThemeId(choice: string | null | undefined): string | null {
  return choice && choice.startsWith(CUSTOM_PREFIX) && /^\d{1,18}$/.test(choice.slice(CUSTOM_PREFIX.length)) ? choice.slice(CUSTOM_PREFIX.length) : null;
}

// ---- Colour helpers (display only) ------------------------------------------

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
}

/** `amount` of the way from a to b, in sRGB. */
export function mix(a: string, b: string, amount: number): string {
  const x = channels(a);
  const y = channels(b);
  return `#${x.map((value, index) => Math.round(value + (y[index] - value) * amount).toString(16).padStart(2, "0")).join("")}`;
}

/** The colours a theme leaves out, worked out from the card and text. */
export function fullColours(colours: ThemeColours) {
  return {
    ...colours,
    grid: colours.grid ?? mix(colours.card, colours.text, 0.09),
    border: colours.border ?? mix(colours.card, colours.text, 0.14),
    axis: mix(colours.card, colours.text, 0.24),
    secondaryText: mix(colours.text, colours.mutedText, 0.4),
    tinted: mix(colours.card, colours.text, 0.04),
  };
}

/**
 * Dark colours from light ones, for a custom theme made in light only
 * (Power BI themes have one set; Tohyee needs both). The surfaces become
 * Tohyee's dark ones tinted towards the light card's hue, and each series
 * colour keeps its hue at a dark-mode lightness. The result is checked like
 * any other.
 */
export function deriveDark(light: ThemeColours): ThemeColours {
  const darkBase = BUILT_IN_THEMES.tohyee.dark;
  return {
    series: light.series.map(darkStep),
    page: mix(darkBase.page, light.page, 0.04),
    card: mix(darkBase.card, light.card, 0.03),
    text: darkBase.text,
    mutedText: darkBase.mutedText,
  };
}

// ---- Checking what's saved ---------------------------------------------------

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function hex(value: unknown, what: string): string {
  if (!isHex(value)) throw new ValidationError(`${what} should be a colour like #1f5fae.`);
  return value.toLowerCase();
}

function optionalHex(value: unknown, what: string): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : hex(value, what);
}

function wholeNumber(value: unknown, low: number, high: number, what: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < low || number > high) throw new ValidationError(`${what} should be a whole number from ${low} to ${high}.`);
  return number;
}

function compact<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return entries.length ? (Object.fromEntries(entries) as T) : undefined;
}

function parseColours(input: unknown, what: string): ThemeColours {
  const raw = object(input);
  if (!Array.isArray(raw.series)) throw new ValidationError(`${what}: the chart colours should be a list.`);
  if (raw.series.length < 2 || raw.series.length > 12) throw new ValidationError(`${what}: a theme has 2 to 12 chart colours.`);
  const series = raw.series.map((colour, index) => hex(colour, `${what} chart colour ${index + 1}`));
  return {
    series,
    page: hex(raw.page, `${what} page background`),
    card: hex(raw.card, `${what} card background`),
    text: hex(raw.text, `${what} text`),
    mutedText: hex(raw.mutedText, `${what} muted text`),
    ...compact({ grid: optionalHex(raw.grid, `${what} gridlines`), border: optionalHex(raw.border, `${what} border`) }),
  };
}

/**
 * Checks a theme (from the editor or an imported file). Unknown settings
 * are dropped and wrong values refused; a theme with light colours only
 * gets dark ones worked out.
 */
export function parseReportTheme(input: unknown): ReportTheme {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("That isn't a theme.");
  const raw = input as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > 60) throw new ValidationError("Give the theme a name (up to 60 characters).");
  const light = parseColours(raw.light, "Light");
  const dark = raw.dark === undefined || raw.dark === null ? deriveDark(light) : parseColours(raw.dark, "Dark");
  if (raw.font !== undefined && raw.font !== null && raw.font !== "" && !(typeof raw.font === "string" && raw.font in FONTS)) {
    throw new ValidationError("Choose a font from the list.");
  }
  const sizes = object(raw.sizes);
  const card = object(raw.card);
  const shadow = card.shadow;
  if (shadow !== undefined && shadow !== null && shadow !== "" && !["none", "soft", "strong"].includes(shadow as string)) throw new ValidationError("Card shadow: choose one of the options.");
  return {
    name,
    light,
    dark,
    ...compact({
      font: raw.font ? (raw.font as FontId) : undefined,
      sizes: compact({
        title: wholeNumber(sizes.title, 12, 28, "Title size"),
        labels: wholeNumber(sizes.labels, 9, 18, "Label size"),
        axes: wholeNumber(sizes.axes, 9, 18, "Axis text size"),
      }),
      card: compact({
        radius: wholeNumber(card.radius, 0, 24, "Corner radius"),
        border: wholeNumber(card.border, 0, 4, "Border width"),
        shadow: shadow ? (shadow as CardStyle["shadow"]) : undefined,
        padding: wholeNumber(card.padding, 4, 32, "Padding"),
      }),
    }),
  };
}

/** The colour checks for both modes; warnings only (decision 668). */
export function checkTheme(theme: ReportTheme): ColourWarning[] {
  return (["light", "dark"] as Mode[]).flatMap((mode) => checkColours(theme[mode], mode).warnings);
}

// ---- Turning a theme into CSS -------------------------------------------------

const SHADOWS = {
  none: "none",
  soft: "0 1px 2px rgba(15, 23, 35, 0.06), 0 4px 12px rgba(15, 23, 35, 0.06)",
  strong: "0 2px 4px rgba(15, 23, 35, 0.12), 0 8px 24px rgba(15, 23, 35, 0.16)",
} as const;

/** The CSS variables for one mode. */
export function themeVariables(theme: ReportTheme, mode: Mode): Record<string, string> {
  const colours = fullColours(theme[mode]);
  const variables: Record<string, string> = {
    "--chart-surface": colours.card,
    "--chart-text": colours.text,
    "--chart-text-secondary": colours.secondaryText,
    "--chart-text-muted": colours.mutedText,
    "--chart-grid": colours.grid,
    "--chart-axis": colours.axis,
    "--chart-count": String(colours.series.length),
    "--report-page": colours.page,
    "--report-card": colours.card,
    "--report-card-tinted": colours.tinted,
    "--report-text": colours.text,
    "--report-text-muted": colours.mutedText,
    "--report-border": colours.border,
  };
  colours.series.forEach((colour, index) => {
    variables[`--chart-${index + 1}`] = colour;
  });
  // The app font is already the charts' font, so only the others are set.
  if (theme.font && theme.font !== "app") variables["--chart-font"] = FONTS[theme.font].css;
  if (theme.font) variables["--report-font"] = FONTS[theme.font].css;
  if (theme.sizes?.title) variables["--report-title-size"] = `${theme.sizes.title}px`;
  if (theme.sizes?.labels) variables["--chart-label-size"] = String(theme.sizes.labels);
  if (theme.sizes?.axes) variables["--chart-axis-size"] = String(theme.sizes.axes);
  if (theme.card?.radius !== undefined) variables["--report-radius"] = `${theme.card.radius}px`;
  if (theme.card?.border !== undefined) variables["--report-border-width"] = `${theme.card.border}px`;
  if (theme.card?.shadow) variables["--report-shadow"] = mode === "dark" && theme.card.shadow !== "none" ? SHADOWS[theme.card.shadow].replaceAll("15, 23, 35", "0, 0, 0") : SHADOWS[theme.card.shadow];
  if (theme.card?.padding !== undefined) variables["--report-padding"] = `${theme.card.padding}px`;
  return variables;
}

function block(selector: string, variables: Record<string, string>): string {
  return `${selector}{${Object.entries(variables).map(([name, value]) => `${name}:${value}`).join(";")}}`;
}

/**
 * A style sheet for a theme scoped to one element (`.scope`): light by
 * default, dark when the computer or the user menu asks for it (the same
 * rules as `globals.css`). The Tohyee theme needs nothing, so nothing
 * changes for reports that keep it. Everything in it was checked by
 * `parseReportTheme` (hex colours, numbers, fonts from the list).
 */
export function themeCss(theme: ReportTheme | null, scope: string): string {
  if (!theme || theme === BUILT_IN_THEMES.tohyee) return "";
  if (!/^[a-z][a-z0-9_-]*$/i.test(scope)) throw new Error("Bad theme scope.");
  const dark = themeVariables(theme, "dark");
  return [
    block(`.${scope}`, themeVariables(theme, "light")),
    `@media (prefers-color-scheme: dark){${block(`:root:not([data-theme="light"]) .${scope}`, dark)}}`,
    block(`:root[data-theme="dark"] .${scope}`, dark),
  ].join("\n");
}

/** The theme a report uses: a built-in one, or the organisation's (looked up by the caller). */
export function resolveTheme(choice: string | null | undefined, custom: ReportTheme | null): ReportTheme {
  if (isBuiltInTheme(choice)) return BUILT_IN_THEMES[choice];
  return custom ?? BUILT_IN_THEMES.tohyee;
}

/** A theme as a file to share (and to bring back with Import). */
export function exportTheme(theme: ReportTheme): string {
  return `${JSON.stringify({ tohyeeTheme: 1, ...theme }, null, 2)}\n`;
}

/** Reads an exported theme file; the same checks as saving. */
export function importTheme(text: string): ReportTheme {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError("That file isn't a theme (it isn't JSON).");
  }
  return parseReportTheme(parsed);
}

/** Checks a report's theme choice; the Tohyee theme is stored as nothing, so existing reports are unchanged. */
export function parseThemeChoice(input: unknown): string | null {
  if (input === undefined || input === null || input === "" || input === DEFAULT_THEME_ID) return null;
  if (isBuiltInTheme(input)) return input;
  if (typeof input === "string" && customThemeId(input)) return input;
  throw new ValidationError("Choose a theme from the list.");
}

/**
 * Checks for colours chosen on one chart (decision 668: warn, don't block).
 * `chosen` is each value's own colour or nothing (the theme's). Each chosen
 * colour is checked against the theme's card in light and dark, and against
 * its neighbours (chosen or the theme's) for colour-blind and normal vision.
 */
export function chosenColourWarnings(chosen: Array<string | undefined>, theme: ReportTheme): string[] {
  const messages: string[] = [];
  if (!chosen.some(Boolean)) return messages;
  for (const mode of ["light", "dark"] as Mode[]) {
    const colours = theme[mode];
    const name = mode === "light" ? "Light" : "Dark";
    // In dark mode a chosen colour is drawn as its dark version (decision 672), so that's what's checked.
    const drawn = chosen.map((colour) => (colour && mode === "dark" ? adaptForDark(colour, "mark", colours.card) : colour));
    const resolved = drawn.map((colour, index) => colour ?? colours.series[index % colours.series.length]);
    drawn.forEach((colour, index) => {
      if (!colour) return;
      const ratio = contrast(colour, colours.card);
      if (ratio < CHECKS.markContrast) messages.push(`${name}: value ${index + 1}'s colour is ${ratio.toFixed(2)}:1 against the card (under 3:1). Show data labels, or choose a stronger colour.`);
    });
    for (let index = 0; index + 1 < resolved.length; index += 1) {
      if (!chosen[index] && !chosen[index + 1]) continue;
      const a = resolved[index];
      const b = resolved[index + 1];
      const blind = Math.min(deltaE(a, b, "protan"), deltaE(a, b, "deutan"));
      const normal = deltaE(a, b);
      if (normal < CHECKS.normalFloor) messages.push(`${name}: values ${index + 1} and ${index + 2} look nearly the same (${normal.toFixed(1)}; aim for ${CHECKS.normalFloor} or more).`);
      else if (blind < CHECKS.cvdTarget) messages.push(`${name}: values ${index + 1} and ${index + 2} are hard to tell apart for colour-blind readers (${blind.toFixed(1)}; aim for ${CHECKS.cvdTarget} or more).`);
    }
  }
  return messages;
}
