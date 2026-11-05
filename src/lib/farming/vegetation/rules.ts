/*
 * Satellite vegetation (#612, decisions 1520-1540): the rules that don't
 * need a server. Browser-safe and pure, tested in
 * tests/unit/vegetation-rules.test.ts.
 *
 * What it shows is greenness (NDVI, from Sentinel-2's near-infrared and red
 * bands), not feed. Nothing here turns it into kg DM/ha (decision 1521).
 */

/** Bumped when the maths or masks change, so old numbers stay labelled with what made them (decision 1528). */
export const PROCESSOR_VERSION = "tohyee-ndvi-1";

/** Sentinel-2 pixels for B04 and B08 are 10 m on the ground (decision 1524). */
export const GROUND_PIXEL_METRES = 10;

/** Pictures older than this are "stale" (decision 1531). */
export const STALE_DAYS = 20;

/** Dates more cloudy than this over the whole satellite picture aren't fetched (decision 1527). */
export const SKIP_SCENE_CLOUD_PCT = 80;

/** At most this many pixels a picture: about 100 km² (decision 1529). */
export const MAX_PIXELS = 1_000_000;
/** And at most this many a side (the Process API's own limit is 2500). */
export const MAX_SIDE = 2500;

/** The note shown wherever greenness is (decision 1521). */
export const GREENNESS_NOTE = "This shows greenness, not feed available. It isn't a pasture cover reading.";

/** Settings someone can change, with their limits (decision 1530). */
export const THRESHOLD_LIMITS = {
  minCoveragePct: { min: 50, max: 100, start: 80 },
  minValidPixels: { min: 5, max: 10000, start: 20 },
  historyDays: { min: 7, max: 365, start: 60 },
  retentionDays: { min: 14, max: 3650, start: 120 },
  monthlyUnitBudget: { min: 1, max: 100000, start: 2000 },
  monthlyRequestBudget: { min: 1, max: 100000, start: 1000 },
  storageCapMb: { min: 10, max: 1048576, start: 500 },
} as const;

/**
 * The attribution the data licence asks for (decision 1533). Greenness is
 * worked out from the bands, so it's "modified". Pictures from the demo
 * provider are made up and never claim to be Copernicus data.
 */
export function attributionText(provider: "copernicus" | "demo", years: number[]): string {
  if (provider === "demo") return "Made-up demo pictures, not satellite data.";
  const unique = [...new Set(years)].sort((a, b) => a - b);
  if (unique.length === 0) return "Contains modified Copernicus Sentinel data";
  const year = unique.length === 1 ? String(unique[0]) : `${unique[0]}–${unique[unique.length - 1]}`;
  return `Contains modified Copernicus Sentinel data ${year}`;
}

// Colour scales: fixed, the same on every date (decision 1532) --------------------------------

export type ScaleStep = { from: number | null; to: number | null; colour: [number, number, number]; label: string };

/** Greenness, light brown to dark green; lightness falls step by step so it reads in grey too. */
export const NDVI_SCALE: ScaleStep[] = [
  { from: null, to: 0.2, colour: [238, 228, 204], label: "Under 0.2: bare or very little green" },
  { from: 0.2, to: 0.4, colour: [222, 204, 140], label: "0.2 to 0.4" },
  { from: 0.4, to: 0.5, colour: [176, 198, 102], label: "0.4 to 0.5" },
  { from: 0.5, to: 0.6, colour: [146, 190, 94], label: "0.5 to 0.6" },
  { from: 0.6, to: 0.7, colour: [92, 158, 70], label: "0.6 to 0.7" },
  { from: 0.7, to: 0.8, colour: [46, 118, 52], label: "0.7 to 0.8" },
  { from: 0.8, to: null, colour: [20, 80, 36], label: "0.8 and over: very green" },
];

/** Change since an earlier date: orange for less green, blue for more, pale for little change. */
export const CHANGE_SCALE: ScaleStep[] = [
  { from: null, to: -0.15, colour: [200, 90, 20], label: "Much less green (down 0.15 or more)" },
  { from: -0.15, to: -0.05, colour: [240, 170, 100], label: "Less green" },
  { from: -0.05, to: 0.05, colour: [236, 236, 228], label: "Little change" },
  { from: 0.05, to: 0.15, colour: [120, 170, 220], label: "More green" },
  { from: 0.15, to: null, colour: [30, 90, 170], label: "Much more green (up 0.15 or more)" },
];

/** Missing: grey with stripes, so it can't be taken for poor pasture (decision 1532). */
export const MISSING_COLOURS: { light: [number, number, number]; dark: [number, number, number] } = { light: [176, 176, 176], dark: [128, 128, 128] };
export const MISSING_LABEL = "No clear view (cloud, shadow or no data)";

export function scaleStep(scale: ScaleStep[], value: number): ScaleStep {
  for (const step of scale) {
    if ((step.from === null || value >= step.from) && (step.to === null || value < step.to)) return step;
  }
  return scale[scale.length - 1];
}

export function cssColour([r, g, b]: [number, number, number]): string {
  return `rgb(${r}, ${g}, ${b})`;
}

// Quality ---------------------------------------------------------------------------------------

export type Quality = "good" | "low_coverage" | "too_small" | "no_data";
export type QualityFlag = "small" | "narrow_or_edge";

export const QUALITY_WORDS: Record<Quality, string> = {
  good: "Clear view",
  low_coverage: "Partly hidden by cloud",
  too_small: "Too small to measure reliably",
  no_data: "No clear view",
};

export const FLAG_WORDS: Record<QualityFlag, string> = {
  small: "Small paddock: a few pixels make a big difference",
  narrow_or_edge: "Narrow paddock: most pixels touch the fence, so they mix in the next paddock",
};

export type Thresholds = { minCoveragePct: number; minValidPixels: number };

/**
 * A paddock's quality on one date (decision 1530): no pixel centre inside
 * it is too small; nothing clear is no data; too few clear pixels, or too
 * little of it clear, isn't good enough to compare.
 */
export function paddockQuality(input: { totalPixels: number; validPixels: number; edgePixels: number }, thresholds: Thresholds): { quality: Quality; coveragePct: number | null; flags: QualityFlag[] } {
  const { totalPixels, validPixels, edgePixels } = input;
  const flags: QualityFlag[] = [];
  if (totalPixels > 0 && totalPixels < thresholds.minValidPixels * 3) flags.push("small");
  if (totalPixels > 0 && edgePixels / totalPixels >= 0.5) flags.push("narrow_or_edge");
  if (totalPixels === 0) return { quality: "too_small", coveragePct: null, flags };
  const coveragePct = Math.round((validPixels / totalPixels) * 10000) / 100;
  if (validPixels === 0) return { quality: "no_data", coveragePct, flags };
  if (totalPixels < thresholds.minValidPixels) return { quality: "too_small", coveragePct, flags };
  if (validPixels < thresholds.minValidPixels || coveragePct < thresholds.minCoveragePct) return { quality: "low_coverage", coveragePct, flags };
  return { quality: "good", coveragePct, flags };
}

// States -----------------------------------------------------------------------------------------

export type VegetationState = "not_set_up" | "checking" | "ready" | "cloudy" | "stale" | "quota_paused" | "reconnect";

export const STATE_WORDS: Record<VegetationState, { title: string; body: string; tone: "info" | "success" | "warning" | "error" }> = {
  not_set_up: { title: "Not set up", body: "Satellite vegetation isn't set up yet.", tone: "info" },
  checking: { title: "Checking", body: "Tohyee is looking for satellite pictures. This can take a while.", tone: "info" },
  ready: { title: "Ready", body: "A recent clear picture is on the map.", tone: "success" },
  cloudy: { title: "Cloudy", body: "The latest pictures were too cloudy to use. Tohyee will keep checking.", tone: "warning" },
  stale: { title: "Out of date", body: `There's no clear picture from the last ${STALE_DAYS} days. Cloud is common: the satellite passes every few days, but it can't see through cloud.`, tone: "warning" },
  quota_paused: { title: "Paused", body: "Tohyee stopped fetching pictures to stay within the limits you set. Nothing is charged.", tone: "warning" },
  reconnect: { title: "Reconnect", body: "The imagery account stopped working. An owner or admin needs to connect it again.", tone: "error" },
};

/** Why fetching paused, in words (decision 1534). */
export const PAUSE_WORDS: Record<"quota" | "requests" | "storage" | "disk_full", string> = {
  quota: "This month's processing budget is used up. It starts again next month, or you can raise the budget.",
  requests: "This month's request budget is used up. It starts again next month, or you can raise the budget.",
  storage: "The pictures kept on the server reached the storage limit. Raise it, or keep pictures for fewer days.",
  disk_full: "The server's disk is full. A server admin needs to free space; then press Carry on.",
};

/**
 * A farm's state (decision 1531), from what's known: the connection,
 * whether it's paused or the farm is waiting on jobs, and its newest
 * usable and newest checked dates (YYYY-MM-DD).
 */
export function farmState(input: {
  connected: boolean;
  reconnect: boolean;
  farmEnabled: boolean;
  paused: boolean;
  jobsWaiting: boolean;
  lastUsableOn: string | null;
  lastSceneOn: string | null;
  today: string;
}): VegetationState {
  if (!input.connected || !input.farmEnabled) return "not_set_up";
  if (input.reconnect) return "reconnect";
  if (input.paused) return "quota_paused";
  const fresh = (day: string | null) => day !== null && daysBetween(day, input.today) <= STALE_DAYS;
  if (fresh(input.lastUsableOn)) return "ready";
  if (input.jobsWaiting) return "checking";
  if (input.lastSceneOn === null) return "checking";
  if (fresh(input.lastSceneOn)) return "cloudy";
  return "stale";
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// Processing units (decision 1535) ---------------------------------------------------------------

/**
 * An estimate of the processing units one picture uses, from the provider's
 * published rule: 1 unit is a 512 × 512 picture of 3 bands at 16 bits or
 * less. Tohyee asks for 3 bands (red, near-infrared, scene classification)
 * plus the data mask at 16 bits. The provider's own count, when its answer
 * gives one, is what's recorded; this is only for budgeting beforehand. Not
 * yet checked against the live service.
 */
export function estimateUnits(width: number, height: number): number {
  return Math.max(0.01, Math.round(((width * height) / (512 * 512)) * 10000) / 10000);
}

/** A byte count in words: 512 KB, 3.4 MB. */
export function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** An NDVI value for people: two places, or "No clear view". */
export function ndviText(value: string | number | null): string {
  if (value === null) return "No clear view";
  return Number(value).toFixed(2);
}

/** A change for people: "+0.06", "−0.12". */
export function changeText(value: string | number | null): string {
  if (value === null) return "Can't compare";
  const number = Number(value);
  return `${number >= 0 ? "+" : "−"}${Math.abs(number).toFixed(2)}`;
}
