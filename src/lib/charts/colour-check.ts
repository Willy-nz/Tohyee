/**
 * The data-visualisation colour checks (decision 599), in TypeScript so the
 * theme editor and the server can run them on any colours someone picks
 * (decision 668). The thresholds and the colour-vision simulation are the
 * same as the validator the built-in colours were checked with: OKLCH
 * lightness band and chroma floor, OKLab ΔE×100 between neighbouring colours
 * under simulated protanopia and deuteranopia (Machado, Oliveira and
 * Fernandes 2009, severity 1), the same under normal vision, and WCAG
 * contrast against the card.
 *
 * These are display calculations on colours, not money, so they use numbers.
 */

export type Mode = "light" | "dark";

export const CHECKS = {
  band: { light: [0.43, 0.77], dark: [0.48, 0.67] } as Record<Mode, [number, number]>,
  chromaFloor: 0.1,
  cvdTarget: 8,
  cvdFloor: 6,
  normalFloor: 15,
  markContrast: 3,
  textContrast: 4.5,
} as const;

const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;

const HEX = /^#[0-9a-f]{6}$/i;

export function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

type Triple = [number, number, number];

function srgb(hex: string): Triple {
  const h = hex.replace(/^#/, "");
  return [0, 2, 4].map((at) => parseInt(h.slice(at, at + 2), 16) / 255) as Triple;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};

function linear(hex: string): Triple {
  return srgb(hex).map(toLinear) as Triple;
}

function oklabFromLinear([r, g, b]: Triple): Triple {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function linearFromOklab([L, a, b]: Triple): Triple {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function oklch(hex: string): { l: number; c: number; h: number } {
  const [L, a, b] = oklabFromLinear(linear(hex));
  return { l: L, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

function inGamut([r, g, b]: Triple): boolean {
  const e = 1e-6;
  return r >= -e && r <= 1 + e && g >= -e && g <= 1 + e && b >= -e && b <= 1 + e;
}

/** A colour from OKLCH, with chroma reduced until it fits on screen. */
export function fromOklch(l: number, c: number, h: number): string {
  const rad = (h * Math.PI) / 180;
  let chroma = c;
  let rgb = linearFromOklab([l, chroma * Math.cos(rad), chroma * Math.sin(rad)]);
  while (!inGamut(rgb) && chroma > 0) {
    chroma = Math.max(0, chroma - 0.002);
    rgb = linearFromOklab([l, chroma * Math.cos(rad), chroma * Math.sin(rad)]);
  }
  return `#${rgb.map((channel) => Math.round(fromLinear(channel) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex: string): number {
  const [r, g, b] = linear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function simulate(hex: string, kind: keyof typeof MACHADO): Triple {
  const [r, g, b] = linear(hex);
  const M = MACHADO[kind];
  const clamp = (c: number) => Math.max(0, Math.min(1, c));
  return [
    clamp(M[0][0] * r + M[0][1] * g + M[0][2] * b),
    clamp(M[1][0] * r + M[1][1] * g + M[1][2] * b),
    clamp(M[2][0] * r + M[2][1] * g + M[2][2] * b),
  ];
}

/** OKLab distance ×100, under normal vision or a simulated colour-vision deficiency. */
export function deltaE(a: string, b: string, kind?: keyof typeof MACHADO): number {
  const x = oklabFromLinear(kind ? simulate(a, kind) : linear(a));
  const y = oklabFromLinear(kind ? simulate(b, kind) : linear(b));
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

export type ColourWarning = {
  check: "band" | "chroma" | "colour-blind" | "normal" | "mark-contrast" | "text-contrast";
  mode: Mode;
  message: string;
};

export type ModeColours = { series: string[]; card: string; text: string; mutedText: string };

/**
 * Every check on one mode's colours. Nothing here blocks saving: the theme
 * editor shows the warnings and the person decides (decision 668).
 */
export function checkColours(colours: ModeColours, mode: Mode): { warnings: ColourWarning[]; worstColourBlind: number | null; worstNormal: number | null } {
  const warnings: ColourWarning[] = [];
  const name = mode === "light" ? "Light" : "Dark";
  const [low, high] = CHECKS.band[mode];
  const { series, card } = colours;
  series.forEach((colour, index) => {
    const { l, c } = oklch(colour);
    if (l < low) warnings.push({ check: "band", mode, message: `${name}: colour ${index + 1} (${colour}) is darker than chart colours should be, so it can look like text.` });
    if (l > high) warnings.push({ check: "band", mode, message: `${name}: colour ${index + 1} (${colour}) is lighter than chart colours should be, so it fades into the card.` });
    if (c < CHECKS.chromaFloor) warnings.push({ check: "chroma", mode, message: `${name}: colour ${index + 1} (${colour}) is close to grey, so it doesn't read as its own colour.` });
    if (contrast(colour, card) < CHECKS.markContrast) {
      warnings.push({ check: "mark-contrast", mode, message: `${name}: colour ${index + 1} (${colour}) is under 3:1 against the card (${contrast(colour, card).toFixed(2)}:1). Show data labels or the table for charts that use it.` });
    }
  });
  let worstColourBlind: number | null = null;
  let worstNormal: number | null = null;
  for (let index = 0; index + 1 < series.length; index += 1) {
    const a = series[index];
    const b = series[index + 1];
    const blind = Math.min(deltaE(a, b, "protan"), deltaE(a, b, "deutan"));
    const normal = deltaE(a, b);
    worstColourBlind = worstColourBlind === null ? blind : Math.min(worstColourBlind, blind);
    worstNormal = worstNormal === null ? normal : Math.min(worstNormal, normal);
    if (blind < CHECKS.cvdTarget) {
      warnings.push({
        check: "colour-blind",
        mode,
        message: `${name}: colours ${index + 1} and ${index + 2} are hard to tell apart for colour-blind readers (${blind.toFixed(1)}; aim for ${CHECKS.cvdTarget} or more).${blind >= CHECKS.cvdFloor ? " Use data labels so colour isn't the only clue." : ""}`,
      });
    }
    if (normal < CHECKS.normalFloor) {
      warnings.push({ check: "normal", mode, message: `${name}: colours ${index + 1} and ${index + 2} look nearly the same to everyone (${normal.toFixed(1)}; aim for ${CHECKS.normalFloor} or more).` });
    }
  }
  for (const [label, colour] of [["Text", colours.text], ["Muted text", colours.mutedText]] as const) {
    const ratio = contrast(colour, card);
    if (ratio < CHECKS.textContrast) warnings.push({ check: "text-contrast", mode, message: `${name}: ${label.toLowerCase()} is ${ratio.toFixed(2)}:1 against the card; text needs 4.5:1 to be easy to read.` });
  }
  return { warnings, worstColourBlind, worstNormal };
}

/** Moves a colour into the dark band, keeping its hue (and as much of its strength as fits). */
export function darkStep(hex: string): string {
  const { l, c, h } = oklch(hex);
  const [low, high] = CHECKS.band.dark;
  const target = Math.min(high - 0.02, Math.max(low + 0.04, l - 0.06));
  return fromOklch(target, Math.max(c, CHECKS.chromaFloor + 0.02), h);
}
