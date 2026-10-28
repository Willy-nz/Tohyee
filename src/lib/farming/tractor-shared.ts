import type { CoverageResult, CoverageSummary, Track, TrackPoint, TrackSettings } from "@/lib/farming/coverage";
import type { PaddockGeometry, Position } from "@/lib/farming/geometry";

/*
 * Tractor mode's shared shapes and words (#472 stage 5, decisions 1020-1027):
 * what the phone sends, what the server gives back, and the GeoJSON and GPX
 * exports. No server imports: the phone uses this too.
 */

export const TRACTOR_NOTICE =
  "Estimated from phone GPS. Phone GPS is usually within 3 to 10 metres and can be worse under trees, near sheds or in gullies. This is not precision guidance, and it isn't proof that product was applied. Gaps are times the GPS was weak or lost, or recording stopped.";

export const OPERATIONS = ["spreading", "spraying", "mowing", "other"] as const;
export type Operation = (typeof OPERATIONS)[number];
export const OPERATION_LABELS: Record<Operation, string> = { spreading: "Spreading", spraying: "Spraying", mowing: "Mowing", other: "Other tractor work" };

export const EQUIPMENT_KINDS = ["spreader", "sprayer", "mower", "other"] as const;
export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];
export const EQUIPMENT_KIND_LABELS: Record<EquipmentKind, string> = { spreader: "Spreader", sprayer: "Sprayer", mower: "Mower", other: "Other" };

export const RATE_UNITS = ["kg/ha", "L/ha", "t/ha"] as const;
export const QUANTITY_UNITS = ["kg", "L", "t"] as const;

/** What happened while recording, kept with the track so a gap can be explained. */
export const TRACK_EVENTS = [
  "start",
  "pause",
  "resume",
  "working_on",
  "working_off",
  "settings",
  "hidden",
  "visible",
  "gps_lost",
  "gps_back",
  "gps_denied",
  "wake_lock_lost",
  "reopened",
  "not_saved",
  "finish",
] as const;
export type TrackEventKind = (typeof TRACK_EVENTS)[number];
export type TrackEvent = { t: number; kind: TrackEventKind };

export const EVENT_LABELS: Record<TrackEventKind, string> = {
  start: "Started",
  pause: "Paused",
  resume: "Resumed",
  working_on: "Working ON",
  working_off: "Working OFF",
  settings: "Width or offset changed",
  hidden: "Screen off or another app: recording stopped",
  visible: "Back in Tohyee: recording again",
  gps_lost: "GPS lost",
  gps_back: "GPS back",
  gps_denied: "Location permission removed",
  wake_lock_lost: "The screen was allowed to sleep",
  reopened: "Tohyee reopened after stopping unexpectedly",
  not_saved: "GPS fixes from here weren't kept on the device (storage full): the track has a gap",
  finish: "Finished",
};

/** Settings as the phone used them: the profile version's id, when there was one. */
export type JobSettings = TrackSettings & { settingsId: string | null };

/**
 * A fix as sent: [time ms, longitude, latitude, accuracy m, Working ON 0/1,
 * settings index, device speed m/s or null, broken-before 0/1].
 */
export type PackedPoint = [number, number, number, number | null, 0 | 1, number, number | null, 0 | 1];

export type JobTrack = { version: 1; settings: JobSettings[]; points: PackedPoint[]; events: TrackEvent[] };

export function packPoint(point: TrackPoint): PackedPoint {
  return [point.t, point.lon, point.lat, point.acc, point.w ? 1 : 0, point.s, point.spd ?? null, point.b ? 1 : 0];
}

export function unpackPoint(packed: PackedPoint): TrackPoint {
  const point: TrackPoint = { t: packed[0], lon: packed[1], lat: packed[2], acc: packed[3], w: packed[4] === 1, s: packed[5] };
  if (packed[6] != null) point.spd = packed[6];
  if (packed[7] === 1) point.b = true;
  return point;
}

export function toCoverageTrack(track: JobTrack): Track {
  return { settings: track.settings.map(({ widthM, lateralM, backM }) => ({ widthM, lateralM, backM })), points: track.points.map(unpackPoint) };
}

export type TractorEquipment = {
  id: string;
  name: string;
  kind: EquipmentKind;
  safetyEquipmentId: string | null;
  fixedAssetId: string | null;
  isActive: boolean;
  /** The current width and offsets (null before any are set). */
  current: EquipmentSettings | null;
  history: EquipmentSettings[];
};

export type EquipmentSettings = { id: string; widthM: string; lateralM: string; backM: string; note: string | null; createdByEmail: string; createdAt: string };

export type JobLinks = {
  fertiliserPlanId: string | null;
  fertiliserPlanName: string | null;
  fertiliserApplicationId: string | null;
  chemicalRecordId: string | null;
  chemicalName: string | null;
};

export type TractorJobListItem = {
  id: string;
  farmId: string;
  paddockIds: string[];
  paddockNames: string[];
  operation: Operation;
  equipmentId: string | null;
  equipmentName: string | null;
  operatorUserId: string;
  operatorEmail: string;
  startedAt: string;
  finishedAt: string;
  receivedAt: string;
  workedHa: string;
  summary: CoverageSummary;
  status: "active" | "withdrawn";
};

export type TractorJob = TractorJobListItem &
  JobLinks & {
    track: JobTrack;
    coverage: Omit<CoverageResult, "summary">;
    /** The chosen paddocks' shapes the summary was clipped to. */
    boundaries: Array<{ paddockId: string; boundaryId: string; geometry: PaddockGeometry }>;
    notes: string | null;
    product: string | null;
    declaredRate: string | null;
    declaredRateUnit: string | null;
    declaredQuantity: string | null;
    declaredQuantityUnit: string | null;
    withdrawnReason: string | null;
    updatedByEmail: string | null;
    updatedAt: string | null;
    /** What the person looking may do. */
    canChange: boolean;
    canLink: boolean;
  };

// Words ----------------------------------------------------------------------------------------------------

/** "Paddock 7", "Paddocks 7, 8" or "Unassigned paddock". */
export function paddockLabel(names: string[]): string {
  if (!names.length) return "Unassigned paddock";
  return `${names.length === 1 ? "Paddock" : "Paddocks"} ${names.join(", ")}`;
}

export function hectares(value: number | string | null | undefined, places = 2): string {
  if (value == null) return "—";
  const number = typeof value === "string" ? Number(value) : value;
  return `${number.toLocaleString("en-NZ", { minimumFractionDigits: places, maximumFractionDigits: places })} ha`;
}

export function durationText(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min${s ? ` ${s} s` : ""}`;
  return `${s} s`;
}

export function distanceText(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toLocaleString("en-NZ", { maximumFractionDigits: 2 })} km` : `${Math.round(metres)} m`;
}

// Exports --------------------------------------------------------------------------------------------------

/** The raw track in unbroken pieces, each split again where Working changed. */
export function trackPieces(track: JobTrack): Array<{ working: boolean; points: TrackPoint[] }> {
  const points = track.points.map(unpackPoint).sort((a, b) => a.t - b.t);
  const pieces: Array<{ working: boolean; points: TrackPoint[] }> = [];
  for (const point of points) {
    const last = pieces[pieces.length - 1];
    if (!last || point.b) {
      pieces.push({ working: point.w, points: [point] });
    } else if (last.working !== point.w) {
      // The new piece starts where the last ended, so the line is continuous.
      pieces.push({ working: point.w, points: [last.points[last.points.length - 1], point] });
    } else {
      last.points.push(point);
    }
  }
  return pieces;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function jobGeoJson(job: Pick<TractorJob, "id" | "operation" | "startedAt" | "finishedAt" | "operatorEmail" | "equipmentName" | "paddockNames" | "summary" | "track" | "coverage" | "product" | "declaredRate" | "declaredRateUnit" | "declaredQuantity" | "declaredQuantityUnit">) {
  const common = { jobId: job.id, notice: TRACTOR_NOTICE };
  const features: unknown[] = [];
  for (const piece of trackPieces(job.track)) {
    if (piece.points.length < 2) continue;
    features.push({
      type: "Feature",
      properties: { ...common, layer: "track", working: piece.working, from: iso(piece.points[0].t), to: iso(piece.points[piece.points.length - 1].t), accuracyM: piece.points.map((point) => point.acc) },
      geometry: { type: "LineString", coordinates: piece.points.map((point) => [point.lon, point.lat]) },
    });
  }
  features.push({ type: "Feature", properties: { ...common, layer: "worked", estimatedHa: job.summary.workedHa, measured: false }, geometry: job.coverage.footprint });
  features.push({ type: "Feature", properties: { ...common, layer: "overlap", estimatedHa: job.summary.overlapHa, measured: false }, geometry: job.coverage.overlap });
  if (job.coverage.missed) features.push({ type: "Feature", properties: { ...common, layer: "not_covered", estimatedHa: job.summary.missedHa, measured: false }, geometry: job.coverage.missed });
  for (const gap of job.coverage.gaps) features.push({ type: "Feature", properties: { ...common, layer: "gap", reason: gap.reason, seconds: gap.seconds }, geometry: { type: "LineString", coordinates: [gap.from, gap.to] } });
  return {
    type: "FeatureCollection",
    // A foreign member (RFC 7946 §6.1): the job as a whole.
    tohyee: {
      jobId: job.id,
      operation: job.operation,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      operator: job.operatorEmail,
      equipment: job.equipmentName,
      paddocks: job.paddockNames.length ? job.paddockNames : ["Unassigned paddock"],
      estimated: job.summary,
      declared: { product: job.product, rate: job.declaredRate ? `${job.declaredRate} ${job.declaredRateUnit}` : null, quantity: job.declaredQuantity ? `${job.declaredQuantity} ${job.declaredQuantityUnit}` : null, note: "Entered by a person, not measured." },
      settings: job.track.settings,
      notice: TRACTOR_NOTICE,
    },
    features,
  };
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function jobGpx(job: Pick<TractorJob, "id" | "operation" | "startedAt" | "paddockNames" | "track">): string {
  const name = `${OPERATION_LABELS[job.operation]} · ${paddockLabel(job.paddockNames)} · ${job.startedAt.slice(0, 10)}`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Tohyee" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${xml(name)}</name><desc>${xml(TRACTOR_NOTICE)}</desc><time>${xml(job.startedAt)}</time></metadata>`,
    `  <trk><name>${xml(name)}</name><desc>${xml(TRACTOR_NOTICE)}</desc><type>${xml(job.operation)}</type>`,
  ];
  const points = job.track.points.map(unpackPoint).sort((a, b) => a.t - b.t);
  let open = false;
  for (const point of points) {
    if (!open || point.b) {
      if (open) lines.push("    </trkseg>");
      lines.push("    <trkseg>");
      open = true;
    }
    const accuracy = point.acc == null ? "accuracy unknown" : `accuracy ±${Math.round(point.acc)} m`;
    lines.push(`      <trkpt lat="${point.lat.toFixed(7)}" lon="${point.lon.toFixed(7)}"><time>${iso(point.t)}</time><cmt>${accuracy}</cmt><type>${point.w ? "working" : "not working"}</type></trkpt>`);
  }
  if (open) lines.push("    </trkseg>");
  lines.push("  </trk>", "</gpx>", "");
  return lines.join("\n");
}

/** A short file name: tractor-2026-10-28-spreading. */
export function exportFileName(job: Pick<TractorJob, "startedAt" | "operation">, extension: "geojson" | "gpx"): string {
  return `tractor-${job.startedAt.slice(0, 10)}-${job.operation}.${extension}`;
}

export type { Position };
