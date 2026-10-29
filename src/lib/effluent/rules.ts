/*
 * Effluent's sums and comparisons (#487, decisions 1080-1089), shared by the
 * server, the screens and the council pack. Browser-safe and pure.
 *
 * - Depth is shown as entered (by the person) and as worked out from the
 *   system's settings, never one passed off as the other (decision 1080).
 * - Comparisons with the consent's limits are counts in neutral words
 *   ("applications over the most depth entered: 0"). They compare records
 *   with what the farm entered; they never say the farm complies (decision
 *   1086).
 *
 * Depths, volumes and storage use the decimal library. Distances on the map
 * (buffers) and the minutes between two times are display figures from
 * coordinates and clocks, and use plain numbers, rounded.
 */

import { cmp, dec, divide, isZero, mul, sub, toPlainString, type Decimal } from "@/lib/money/decimal";
import type { Position } from "@/lib/safety/shared";
import { bufferFor, type ConsentData, type SystemSettings, type SystemType, type ZoneData, type PondData } from "@/lib/effluent/shared";

// Log records ----------------------------------------------------------------------------------------

/** Where the pods or irrigator were set, and when (the phone's or the person's time). */
export type PodPosition = { label: string | null; paddockId: string | null; point: Position | null; movedAt: string };

export const PONDING_RESULTS = ["none", "ponding", "runoff"] as const;
export type PondingResult = (typeof PONDING_RESULTS)[number];
export const PONDING_LABELS: Record<PondingResult, string> = { none: "No ponding or runoff", ponding: "Ponding seen", runoff: "Runoff seen" };

export type PondingCheck = { result: PondingResult; note: string | null; checkedAt: string };
export type WorkedOut = { mm: string; how: string };

export type ApplicationData = {
  systemId: string;
  blockId: string | null;
  paddockIds: string[];
  /** As the person (or the phone) says, ISO with offset. */
  startedAt: string;
  stoppedAt: string | null;
  positions: PodPosition[];
  /** As entered, mm. */
  depthEnteredMm: string | null;
  /** Worked out from the system's settings when it was saved (kept, so a later change to the settings never rewrites it). */
  depthWorkedOut: WorkedOut | null;
  /** The settings it was worked out from. */
  settings: SystemSettings;
  /** Tanker or spreader: loads and the area they went on. */
  loads: number | null;
  areaHa: string | null;
  ponding: PondingCheck | null;
  weather: string | null;
  soil: string | null;
  files: Array<{ id: string; name: string; sha256: string }>;
  /** The system was out of use (a failed critical check not released) when this was recorded (decision 1083). */
  usedWhileOutOfUse: boolean;
  /** A tractor mode job for a tanker or spreader run (part 4). */
  tractorJobId?: string | null;
  why?: string | null;
};

export const DEFERRAL_REASONS = ["too_wet", "raining", "frozen_or_snow", "pond_low", "system_out_of_use", "other"] as const;
export type DeferralReason = (typeof DEFERRAL_REASONS)[number];
export const DEFERRAL_LABELS: Record<DeferralReason, string> = {
  too_wet: "Too wet: stored",
  raining: "Raining: stored",
  frozen_or_snow: "Frozen ground or snow: stored",
  pond_low: "Pond too low to irrigate",
  system_out_of_use: "System out of use",
  other: "Other",
};

export type DeferralData = { on: string; reason: DeferralReason; note: string | null; systemId: string | null; why?: string | null };

export type PondReadingData = { pondId: string; levelMm: string; readAt: string; note: string | null; files: Array<{ id: string; name: string; sha256: string }>; why?: string | null };

// Depth ----------------------------------------------------------------------------------------------

/** Hours between two ISO times, as a decimal string to two places (minutes are whole). */
export function hoursBetween(from: string, to: string): string | null {
  const minutes = Math.round((Date.parse(to) - Date.parse(from)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return toPlainString(divide(dec(String(minutes)), dec("60"), 2));
}

/** Each position's time there: until the next move, or the stop (or `now`, while it runs). */
export function positionHours(positions: readonly PodPosition[], until: string): Array<{ position: PodPosition; hours: string | null }> {
  const sorted = [...positions].sort((a, b) => a.movedAt.localeCompare(b.movedAt));
  return sorted.map((position, index) => ({ position, hours: hoursBetween(position.movedAt, sorted[index + 1]?.movedAt ?? until) }));
}

const fmt = (value: Decimal, places = 1) => toPlainString(divide(value, dec("1"), places));

/**
 * The depth worked out from the system's settings (decision 1080), or null
 * when the settings don't give one:
 * - travelling irrigator: flow ÷ (wetted width × speed), the same for every
 *   run at that speed;
 * - pods, K-line, sprinklers: rate × hours at the position × the share of
 *   time running (the deepest position);
 * - tanker or spreader: loads × tank ÷ area (1 mm on 1 ha is 10 m³).
 */
export function workedOutDepth(type: SystemType, settings: SystemSettings, input: { hours?: string | null; positionHours?: Array<string | null>; loads?: number | null; areaHa?: string | null }): WorkedOut | null {
  if (type === "travelling_irrigator") {
    const { flowM3PerHour, wettedWidthM, speedMPerHour } = settings;
    if (!flowM3PerHour || !wettedWidthM || !speedMPerHour) return null;
    const area = mul(dec(wettedWidthM), dec(speedMPerHour));
    if (isZero(area)) return null;
    const mm = divide(mul(dec(flowM3PerHour), dec("1000")), area, 1);
    return { mm: toPlainString(mm), how: `${flowM3PerHour} m³ an hour ÷ (${wettedWidthM} m wide × ${speedMPerHour} m an hour)` };
  }
  if (type === "slurry_tanker") {
    if (!settings.tankM3 || !input.loads || !input.areaHa || isZero(dec(input.areaHa))) return null;
    const volume = mul(dec(settings.tankM3), dec(String(input.loads)));
    return { mm: fmt(divide(volume, mul(dec(input.areaHa), dec("10")), 4)), how: `${input.loads} loads × ${settings.tankM3} m³ ÷ ${input.areaHa} ha (10 m³ a hectare is 1 mm)` };
  }
  if (!settings.rateMmPerHour) return null;
  const share = settings.pulsePercent ? divide(dec(settings.pulsePercent), dec("100"), 4) : dec("1");
  const hours = (input.positionHours?.length ? input.positionHours : [input.hours ?? null]).filter((value): value is string => value !== null);
  if (!hours.length) return null;
  const longest = hours.reduce((most, value) => (cmp(dec(value), dec(most)) > 0 ? value : most));
  const mm = mul(mul(dec(settings.rateMmPerHour), dec(longest)), share);
  return { mm: fmt(mm), how: `${settings.rateMmPerHour} mm an hour × ${longest} hours${settings.pulsePercent ? ` × ${settings.pulsePercent}% running` : ""}${hours.length > 1 ? " (the longest position)" : ""}` };
}

/** The depth to compare: as entered if given, else as worked out. */
export function depthForComparison(data: Pick<ApplicationData, "depthEnteredMm" | "depthWorkedOut">): { mm: string; source: "entered" | "worked_out" } | null {
  if (data.depthEnteredMm) return { mm: data.depthEnteredMm, source: "entered" };
  if (data.depthWorkedOut) return { mm: data.depthWorkedOut.mm, source: "worked_out" };
  return null;
}

// Ponds ----------------------------------------------------------------------------------------------

export type PondState = {
  percentFull: string | null;
  /** Storage left, m³, assuming the pond's sides are straight (gauge readings to volume is a straight line). */
  storageLeftM3: string | null;
  daysLeft: string | null;
  warning: "high" | "low" | null;
  /** The gauge mark at or just below the reading. */
  mark: string | null;
};

/** A pond's state at a reading (decision 1084). */
export function pondState(pond: Pick<PondData, "capacityM3" | "fullAtMm" | "highAtMm" | "lowAtMm" | "dailyInflowM3" | "markers">, levelMm: string): PondState {
  const level = dec(levelMm);
  const warning = pond.highAtMm && cmp(level, dec(pond.highAtMm)) >= 0 ? "high" : pond.lowAtMm && cmp(level, dec(pond.lowAtMm)) <= 0 ? "low" : null;
  const mark = [...pond.markers].filter((marker) => cmp(dec(marker.mm), level) <= 0).sort((a, b) => cmp(dec(b.mm), dec(a.mm)))[0]?.label ?? null;
  if (!pond.fullAtMm || isZero(dec(pond.fullAtMm))) return { percentFull: null, storageLeftM3: null, daysLeft: null, warning, mark };
  const full = dec(pond.fullAtMm);
  const fraction = divide(level, full, 6);
  const leftFraction = cmp(level, full) >= 0 ? dec("0") : sub(dec("1"), fraction);
  const storageLeft = mul(dec(pond.capacityM3), leftFraction);
  const daysLeft = pond.dailyInflowM3 && !isZero(dec(pond.dailyInflowM3)) ? toPlainString(divide(storageLeft, dec(pond.dailyInflowM3), 1)) : null;
  return { percentFull: toPlainString(divide(mul(level, dec("100")), full, 0)), storageLeftM3: toPlainString(divide(storageLeft, dec("1"), 0)), daysLeft, warning, mark };
}

// Comparing with the consent -------------------------------------------------------------------------

/** Metres between two points (haversine). */
export function metresBetween(a: Position, b: Position): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function inside(point: Position, ring: readonly Position[]): boolean {
  let within = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) within = !within;
  }
  return within;
}

/** Metres from a point to an outline's nearest edge (0 inside), on a flat local projection: fine at farm scale. */
function metresToRing(point: Position, ring: readonly Position[]): number {
  if (inside(point, ring)) return 0;
  const k = Math.cos((point[1] * Math.PI) / 180) * 111_320;
  const xy = ([lon, lat]: Position) => [(lon - point[0]) * k, (lat - point[1]) * 111_320];
  let best = Infinity;
  for (let index = 0; index + 1 < ring.length; index += 1) {
    const [ax, ay] = xy(ring[index]);
    const [bx, by] = xy(ring[index + 1]);
    const dx = bx - ax;
    const dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** No-apply zones a placed position is within the buffer of (by the zone's buffer, or the consent's for its kind). */
export function buffersBreached(point: Position, zones: ReadonlyArray<{ recordId: string; data: Pick<ZoneData, "name" | "feature" | "point" | "zone" | "bufferM" | "removed"> }>, consent: Pick<ConsentData, "buffers"> | null): Array<{ zoneId: string; name: string; bufferM: number; metres: number }> {
  const found: Array<{ zoneId: string; name: string; bufferM: number; metres: number }> = [];
  for (const zone of zones) {
    if (zone.data.removed) continue;
    const buffer = Number(zone.data.bufferM ?? bufferFor(consent, zone.data.feature) ?? 0);
    const metres = zone.data.zone ? metresToRing(point, zone.data.zone.coordinates[0]) : zone.data.point ? metresBetween(point, zone.data.point) : Infinity;
    if (metres <= buffer || metres === 0) found.push({ zoneId: zone.recordId, name: zone.data.name, bufferM: buffer, metres: Math.round(metres) });
  }
  return found;
}

export type ApplicationFlags = {
  overDepth: boolean;
  overRate: boolean;
  tooSoon: Array<{ paddockId: string; days: number }>;
  ponding: PondingResult | null;
  inBuffer: Array<{ zoneId: string; name: string; bufferM: number; metres: number }>;
  usedWhileOutOfUse: boolean;
  noPondingCheck: boolean;
};

type AppRecord = { recordId: string; change: string; data: ApplicationData };

/** Days between two ISO times' dates (NZ dates are the caller's concern; this uses the UTC day of each). */
function daysApart(a: string, b: string): number {
  return Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86_400_000);
}

/**
 * How one application compares with what the consent entered (decision
 * 1086): over the most depth (as entered, else as worked out), the system's
 * rate over the most rate, a paddock applied to again inside the return
 * period, ponding or runoff seen, a position inside a buffer, recorded while
 * the system was out of use, or stopped with no ponding check.
 */
export function applicationFlags(application: AppRecord, earlier: readonly AppRecord[], consent: ConsentData | null, zones: Parameters<typeof buffersBreached>[1]): ApplicationFlags {
  const data = application.data;
  const depth = depthForComparison(data);
  const tooSoon: Array<{ paddockId: string; days: number }> = [];
  if (consent?.returnPeriodDays) {
    for (const paddockId of data.paddockIds) {
      const before = earlier.filter((other) => other.change !== "withdrawn" && other.recordId !== application.recordId && other.data.paddockIds.includes(paddockId) && other.data.startedAt < data.startedAt).sort((a, b) => b.data.startedAt.localeCompare(a.data.startedAt))[0];
      if (before) {
        const days = daysApart(before.data.startedAt, data.startedAt);
        if (days < consent.returnPeriodDays) tooSoon.push({ paddockId, days });
      }
    }
  }
  const inBuffer = data.positions.flatMap((position) => (position.point ? buffersBreached(position.point, zones, consent) : []));
  return {
    overDepth: Boolean(consent?.maxDepthMm && depth && cmp(dec(depth.mm), dec(consent.maxDepthMm)) > 0),
    overRate: Boolean(consent?.maxRateMmPerHour && data.settings.rateMmPerHour && cmp(dec(data.settings.rateMmPerHour), dec(consent.maxRateMmPerHour)) > 0),
    tooSoon,
    ponding: data.ponding?.result ?? null,
    inBuffer: inBuffer.filter((each, index) => inBuffer.findIndex((other) => other.zoneId === each.zoneId) === index),
    usedWhileOutOfUse: data.usedWhileOutOfUse,
    noPondingCheck: data.stoppedAt !== null && data.ponding === null,
  };
}

export function hasFlags(flags: ApplicationFlags): boolean {
  return flags.overDepth || flags.overRate || flags.tooSoon.length > 0 || (flags.ponding !== null && flags.ponding !== "none") || flags.inBuffer.length > 0 || flags.usedWhileOutOfUse || flags.noPondingCheck;
}

/** The flags in words, neutral (decision 1086). */
export function flagTexts(flags: ApplicationFlags, consent: ConsentData | null, paddockNames: ReadonlyMap<string, string> = new Map()): string[] {
  const texts: string[] = [];
  if (flags.overDepth) texts.push(`Depth (as entered, else the estimate from the settings) is over the most depth entered for the consent (${consent?.maxDepthMm} mm)`);
  if (flags.overRate) texts.push(`The system's rate is over the most rate entered for the consent (${consent?.maxRateMmPerHour} mm an hour)`);
  for (const each of flags.tooSoon) texts.push(`Paddock ${paddockNames.get(each.paddockId) ?? each.paddockId} again after ${each.days} day${each.days === 1 ? "" : "s"} (the consent entered says at least ${consent?.returnPeriodDays})`);
  if (flags.ponding === "ponding") texts.push("Ponding recorded");
  if (flags.ponding === "runoff") texts.push("Runoff recorded");
  for (const each of flags.inBuffer) texts.push(`A position recorded from the phone's GPS was about ${each.metres} m from ${each.name}, inside its ${each.bufferM} m buffer on the map. It's a phone estimate, not a finding that effluent reached it`);
  if (flags.usedWhileOutOfUse) texts.push("Recorded while the system was out of use in Safety");
  if (flags.noPondingCheck) texts.push("Stopped with no ponding check recorded");
  return texts;
}

export type LimitsSummary = { applications: number; overDepth: number; overRate: number; tooSoon: number; ponding: number; runoff: number; inBuffer: number; whileOutOfUse: number; noPondingCheck: number; noDepth: number };

/** Counts for a date range, for the log and the council pack (decision 1086). */
export function limitsSummary(applications: readonly AppRecord[], all: readonly AppRecord[], consent: ConsentData | null, zones: Parameters<typeof buffersBreached>[1]): LimitsSummary {
  const summary: LimitsSummary = { applications: 0, overDepth: 0, overRate: 0, tooSoon: 0, ponding: 0, runoff: 0, inBuffer: 0, whileOutOfUse: 0, noPondingCheck: 0, noDepth: 0 };
  for (const application of applications) {
    if (application.change === "withdrawn") continue;
    const flags = applicationFlags(application, all, consent, zones);
    summary.applications += 1;
    if (flags.overDepth) summary.overDepth += 1;
    if (flags.overRate) summary.overRate += 1;
    if (flags.tooSoon.length) summary.tooSoon += 1;
    if (flags.ponding === "ponding") summary.ponding += 1;
    if (flags.ponding === "runoff") summary.runoff += 1;
    if (flags.inBuffer.length) summary.inBuffer += 1;
    if (flags.usedWhileOutOfUse) summary.whileOutOfUse += 1;
    if (flags.noPondingCheck) summary.noPondingCheck += 1;
    if (!depthForComparison(application.data)) summary.noDepth += 1;
  }
  return summary;
}

/** The summary as lines, in neutral words: counts against what was entered, never "complies" (decision 1086). */
export function summaryLines(summary: LimitsSummary, consent: ConsentData | null): string[] {
  const lines = [`Applications recorded: ${summary.applications}`];
  lines.push(consent?.maxDepthMm ? `Applications over the most depth entered (${consent.maxDepthMm} mm): ${summary.overDepth}` : "Most depth: not entered for the consent, so not compared");
  lines.push(consent?.maxRateMmPerHour ? `Applications by a system whose rate is over the most rate entered (${consent.maxRateMmPerHour} mm an hour): ${summary.overRate}` : "Most rate: not entered for the consent, so not compared");
  lines.push(consent?.returnPeriodDays ? `Applications to a paddock sooner than ${consent.returnPeriodDays} days after the last: ${summary.tooSoon}` : "Days between applications: not entered for the consent, so not compared");
  lines.push(`Applications with ponding recorded: ${summary.ponding}`);
  lines.push(`Applications with runoff recorded: ${summary.runoff}`);
  lines.push(`Applications with a recorded position (phone GPS, an estimate) inside a buffer on the map: ${summary.inBuffer}`);
  lines.push(`Applications recorded while the system was out of use: ${summary.whileOutOfUse}`);
  lines.push(`Applications stopped with no ponding check: ${summary.noPondingCheck}`);
  lines.push(`Applications with no depth entered or worked out: ${summary.noDepth}`);
  return lines;
}

export const COMPARISON_NOTE = "These count the records against the consent conditions as entered in Tohyee. They don't say whether the farm complies: your consent and your council decide that.";
