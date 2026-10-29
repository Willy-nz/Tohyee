import type { CoverageResult, CoverageSummary, Track, TrackPoint, TrackSettings } from "@/lib/farming/coverage";
import type { PaddockGeometry, Position } from "@/lib/farming/geometry";

/*
 * Tractor mode's shared shapes and words (#472 stage 5, decisions 1020-1027):
 * what the phone sends, what the server gives back, and the GeoJSON and GPX
 * exports. No server imports: the phone uses this too.
 */

export const TRACTOR_NOTICE =
  "Estimated from phone GPS. Phone GPS is usually within 3 to 10 metres and can be worse under trees, near sheds or in gullies. This is not precision guidance, and it isn't proof that product was applied. Gaps are times the GPS was weak or lost, or recording stopped.";

/**
 * What the record does and doesn't establish (#491, decision 1104): shown
 * beside the estimate on screens and in every export.
 */
export const TRACTOR_RECORD_NOTE =
  "Working ON and OFF are what the operator switched on the phone, not a sensor on the machine. Product, rate and quantity are what someone entered. A track near water, a boundary or a no-go zone is a phone position, not a finding that anything was spread or discharged there.";

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

// Corrections and history (#491, decisions 1100-1104) -----------------------------------------------------

/** A time the person says Working was really OFF (they forgot to switch it). Device times, as ISO strings. */
export type NotWorking = { from: string; to: string; why: string };

/** A job's details as one version had them (paddock, chemical and plan names as they were then). */
export type JobSnapshot = {
  paddockIds: string[];
  paddockNames?: string[];
  boundaryIds: string[];
  summary: CoverageSummary;
  notes: string | null;
  product: string | null;
  declaredRate: string | null;
  declaredRateUnit: string | null;
  declaredQuantity: string | null;
  declaredQuantityUnit: string | null;
  fertiliserPlanId: string | null;
  fertiliserPlanName?: string | null;
  fertiliserApplicationId: string | null;
  chemicalRecordId: string | null;
  chemicalName?: string | null;
  notWorking: NotWorking[];
  status: "active" | "withdrawn";
  withdrawnReason: string | null;
};

export const JOB_CHANGES = ["saved", "changed", "corrected", "withdrawn", "before_history"] as const;
export type JobChangeKind = (typeof JOB_CHANGES)[number];
export const JOB_CHANGE_LABELS: Record<JobChangeKind, string> = {
  saved: "Saved from the phone",
  changed: "Added to",
  corrected: "Corrected",
  withdrawn: "Withdrawn",
  before_history: "As it stood when version history started",
};

/** Shown on a job changed before Tohyee kept each version: what it said before isn't known, and isn't made up. */
export const EARLIER_EDITS_NOT_RECORDED =
  "Earlier edits not recorded. This job was changed before Tohyee kept every version of a job's details. Its first version shows it as it stood when version history started; what it said before that isn't known.";

export type JobFieldChange = { field: string; label: string; from: string; to: string };

export type JobVersion = {
  version: number;
  change: JobChangeKind;
  changeLabel: string;
  /** The database's time, never the person's. */
  enteredAt: string;
  enteredByEmail: string;
  reason: string | null;
  details: JobSnapshot;
  /** What differs from the version before (none for the first). */
  changes: JobFieldChange[];
};

const blank = (value: string | null | undefined) => (value == null || value === "" ? "—" : value);
const amount = (value: string | null, unit: string | null) => (value ? `${value} ${unit ?? ""}`.trim() : "—");

/** "10:02:15 to 10:09:40: forgot to switch off at the gate". */
export function notWorkingText(entry: NotWorking, timeZone?: string): string {
  const time = (iso: string) => new Date(iso).toLocaleString("en-NZ", { dateStyle: "medium", timeStyle: "medium", ...(timeZone ? { timeZone } : {}) });
  return `${time(entry.from)} to ${time(entry.to)}: ${entry.why}`;
}

/**
 * The fields a version can change, as words. `withLinks` false leaves the
 * fertiliser plan out (farm staff don't see plan links; decision 1025).
 */
function fieldTexts(snapshot: JobSnapshot, withLinks: boolean, timeZone?: string): Array<{ field: string; label: string; text: string; correctable: boolean }> {
  const fields = [
    { field: "paddocks", label: "Paddocks", text: paddockLabel(snapshot.paddockNames ?? snapshot.paddockIds.map((id) => `#${id}`)), correctable: snapshot.paddockIds.length > 0 },
    { field: "boundaries", label: "Paddock boundary versions used", text: snapshot.boundaryIds.length ? snapshot.boundaryIds.join(", ") : "—", correctable: false },
    { field: "product", label: "Product (entered)", text: blank(snapshot.product), correctable: snapshot.product != null },
    { field: "rate", label: "Rate (entered)", text: amount(snapshot.declaredRate, snapshot.declaredRateUnit), correctable: snapshot.declaredRate != null },
    { field: "quantity", label: "Quantity (entered)", text: amount(snapshot.declaredQuantity, snapshot.declaredQuantityUnit), correctable: snapshot.declaredQuantity != null },
    { field: "chemical", label: "Chemical", text: snapshot.chemicalRecordId ? (snapshot.chemicalName ?? "a chemical in Safety's register") : "—", correctable: snapshot.chemicalRecordId != null },
    { field: "notes", label: "Notes", text: blank(snapshot.notes), correctable: snapshot.notes != null && snapshot.notes !== "" },
    { field: "notWorking", label: "Marked not working", text: snapshot.notWorking.length ? snapshot.notWorking.map((entry) => notWorkingText(entry, timeZone)).join("; ") : "—", correctable: snapshot.notWorking.length > 0 },
    { field: "estimate", label: "Worked (estimated)", text: hectares(snapshot.summary.workedHa), correctable: false },
    { field: "status", label: "Status", text: snapshot.status === "withdrawn" ? `Withdrawn: ${snapshot.withdrawnReason ?? ""}` : "Current", correctable: false },
  ];
  if (withLinks) fields.splice(6, 0, { field: "plan", label: "Fertiliser plan", text: snapshot.fertiliserPlanId ? (snapshot.fertiliserPlanName ?? `plan #${snapshot.fertiliserPlanId}`) : "—", correctable: false });
  return fields;
}

/** What differs between two versions, as words: the earlier value and the new one. */
export function jobChanges(before: JobSnapshot, after: JobSnapshot, options: { withLinks?: boolean; timeZone?: string } = {}): JobFieldChange[] {
  const old = fieldTexts(before, options.withLinks ?? true, options.timeZone);
  const now = new Map(fieldTexts(after, options.withLinks ?? true, options.timeZone).map((entry) => [entry.field, entry]));
  return old.filter((entry) => now.get(entry.field)!.text !== entry.text).map((entry) => ({ field: entry.field, label: entry.label, from: entry.text, to: now.get(entry.field)!.text }));
}

/**
 * Whether a change needs a reason (decision 1101): it replaces or removes
 * something already entered (paddocks, product, rate, quantity, units,
 * chemical, notes or times marked not working). Filling in a blank, linking
 * a plan, or the estimate changing as a result, doesn't.
 */
export function correctionFields(before: JobSnapshot, after: JobSnapshot): string[] {
  const old = fieldTexts(before, true);
  const now = new Map(fieldTexts(after, true).map((entry) => [entry.field, entry.text]));
  // Adding another time marked not working (each has its own why) isn't a correction; changing or removing one is.
  const same = (a: NotWorking, b: NotWorking) => a.from === b.from && a.to === b.to && a.why === b.why;
  const notWorkingChanged = before.notWorking.some((entry) => !after.notWorking.some((other) => same(entry, other)));
  return old.filter((entry) => entry.correctable && (entry.field === "notWorking" ? notWorkingChanged : now.get(entry.field) !== entry.text)).map((entry) => entry.label);
}

/** Checks and tidies times marked not working: inside the job, in order, each with why. */
export function checkNotWorking(input: unknown, job: { startedAt: string; finishedAt: string }): NotWorking[] {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 50) throw new Error("Mark up to 50 times as not working.");
  const start = Date.parse(job.startedAt) - 1000;
  const end = Date.parse(job.finishedAt) + 1000;
  const list = input.map((raw, index) => {
    const value = (raw ?? {}) as Record<string, unknown>;
    const from = typeof value.from === "number" ? value.from : Date.parse(String(value.from ?? ""));
    const to = typeof value.to === "number" ? value.to : Date.parse(String(value.to ?? ""));
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error(`Time ${index + 1} marked not working needs a start and end time.`);
    if (to <= from) throw new Error(`Time ${index + 1} marked not working ends before it starts.`);
    if (from < start || to > end) throw new Error(`Time ${index + 1} marked not working is outside the job's times.`);
    const why = typeof value.why === "string" ? value.why.trim() : "";
    if (!why) throw new Error(`Say why time ${index + 1} is marked not working.`);
    if (why.length > 500) throw new Error(`Why time ${index + 1} is marked not working is too long (500 characters at most).`);
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), why };
  });
  return list.sort((a, b) => a.from.localeCompare(b.from));
}

/**
 * The track as the estimate uses it after corrections: fixes inside a time
 * marked not working count as Working OFF. The stored track isn't touched.
 */
export function correctedTrack(track: JobTrack, notWorking: NotWorking[]): Track {
  const coverage = toCoverageTrack(track);
  if (!notWorking.length) return coverage;
  const periods = notWorking.map((entry) => [Date.parse(entry.from), Date.parse(entry.to)] as const);
  return { ...coverage, points: coverage.points.map((point) => (point.w && periods.some(([from, to]) => point.t >= from && point.t <= to) ? { ...point, w: false } : point)) };
}

export type TractorJob = TractorJobListItem &
  JobLinks & {
    track: JobTrack;
    /** Times marked not working; the estimate leaves them out, the track keeps Working as switched. */
    notWorking: NotWorking[];
    /** Every version of the details, oldest first. */
    history: JobVersion[];
    /** False for a job changed before every version was kept (decision 1103). */
    historyComplete: boolean;
    /** The estimate as first saved, when that's known. */
    firstSummary: CoverageSummary | null;
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

/** The job fields every export uses. */
export type ExportJob = Pick<
  TractorJob,
  | "id"
  | "operation"
  | "startedAt"
  | "finishedAt"
  | "receivedAt"
  | "operatorEmail"
  | "equipmentName"
  | "paddockNames"
  | "summary"
  | "track"
  | "coverage"
  | "product"
  | "declaredRate"
  | "declaredRateUnit"
  | "declaredQuantity"
  | "declaredQuantityUnit"
  | "status"
  | "withdrawnReason"
  | "notWorking"
  | "history"
  | "historyComplete"
  | "firstSummary"
>;

/** What an export covers and what it leaves out, in words (decision 1104). */
export function exportScope(job: ExportJob): string[] {
  const lines = [
    `One tractor job (${job.id}): ${OPERATION_LABELS[job.operation]}, ${paddockLabel(job.paddockNames)}.`,
    `Phone times ${job.startedAt} to ${job.finishedAt}; Tohyee received it ${job.receivedAt}.`,
    "Includes every GPS fix as recorded (time, position, accuracy and Working as switched), the settings used, and every version of the job's details.",
    "Leaves out: the paddocks' shapes, other jobs, Safety records, and anything in the books.",
  ];
  if (job.status === "withdrawn") lines.push(`WITHDRAWN: ${job.withdrawnReason ?? ""}. Kept as a record; it isn't a current job.`);
  if (job.notWorking.length) lines.push(`Corrected: ${job.notWorking.length} time${job.notWorking.length === 1 ? "" : "s"} marked not working after the job. The track still shows Working as switched; the estimate leaves those times out.`);
  if (job.history.some((version) => version.change === "corrected")) lines.push("Corrected after it was saved: see the history for what it said before, who changed it, when and why.");
  if (!job.historyComplete) lines.push(EARLIER_EDITS_NOT_RECORDED);
  return lines;
}

/** The versions as plain data for an export (newest last). */
function historyForExport(job: ExportJob) {
  return job.history.map((version) => ({
    version: version.version,
    change: version.changeLabel,
    enteredAt: version.enteredAt,
    enteredBy: version.enteredByEmail,
    reason: version.reason,
    changes: version.changes.map((change) => ({ what: change.label, from: change.from, to: change.to })),
  }));
}

export function jobGeoJson(job: ExportJob) {
  const common = { jobId: job.id, notice: TRACTOR_NOTICE };
  const features: unknown[] = [];
  for (const piece of trackPieces(job.track)) {
    if (piece.points.length < 2) continue;
    features.push({
      type: "Feature",
      properties: { ...common, layer: "track", working: piece.working, workingFrom: "operator switch", from: iso(piece.points[0].t), to: iso(piece.points[piece.points.length - 1].t), accuracyM: piece.points.map((point) => point.acc) },
      geometry: { type: "LineString", coordinates: piece.points.map((point) => [point.lon, point.lat]) },
    });
  }
  features.push({ type: "Feature", properties: { ...common, layer: "worked", estimatedHa: job.summary.workedHa, measured: false, correctedForNotWorking: job.notWorking.length > 0 }, geometry: job.coverage.footprint });
  features.push({ type: "Feature", properties: { ...common, layer: "overlap", estimatedHa: job.summary.overlapHa, measured: false }, geometry: job.coverage.overlap });
  if (job.coverage.missed) features.push({ type: "Feature", properties: { ...common, layer: "not_covered", estimatedHa: job.summary.missedHa, measured: false }, geometry: job.coverage.missed });
  for (const gap of job.coverage.gaps) features.push({ type: "Feature", properties: { ...common, layer: "gap", reason: gap.reason, seconds: gap.seconds }, geometry: { type: "LineString", coordinates: [gap.from, gap.to] } });
  return {
    type: "FeatureCollection",
    // A foreign member (RFC 7946 §6.1): the job as a whole.
    tohyee: {
      jobId: job.id,
      scope: exportScope(job),
      operation: job.operation,
      status: job.status,
      withdrawnReason: job.withdrawnReason,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      timesFrom: "the phone's clock",
      receivedAt: job.receivedAt,
      operator: job.operatorEmail,
      equipment: job.equipmentName,
      paddocks: job.paddockNames.length ? job.paddockNames : ["Unassigned paddock"],
      estimated: job.summary,
      estimatedAsFirstSaved: job.firstSummary,
      declared: { product: job.product, rate: job.declaredRate ? `${job.declaredRate} ${job.declaredRateUnit}` : null, quantity: job.declaredQuantity ? `${job.declaredQuantity} ${job.declaredQuantityUnit}` : null, note: "Entered by a person, not measured." },
      markedNotWorking: job.notWorking,
      history: historyForExport(job),
      historyComplete: job.historyComplete,
      settings: job.track.settings,
      notice: TRACTOR_NOTICE,
      recordNote: TRACTOR_RECORD_NOTE,
    },
    features,
  };
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function jobGpx(job: ExportJob): string {
  const name = `${OPERATION_LABELS[job.operation]} · ${paddockLabel(job.paddockNames)} · ${job.startedAt.slice(0, 10)}${job.status === "withdrawn" ? " · WITHDRAWN" : ""}`;
  const about = [TRACTOR_NOTICE, TRACTOR_RECORD_NOTE, ...exportScope(job)];
  for (const entry of job.notWorking) about.push(`Marked not working: ${entry.from} to ${entry.to}: ${entry.why}`);
  for (const version of job.history) {
    about.push(`Version ${version.version}, ${version.changeLabel}, ${version.enteredAt} by ${version.enteredByEmail}${version.reason ? `, why: ${version.reason}` : ""}${version.changes.length ? `: ${version.changes.map((change) => `${change.label} ${change.from} → ${change.to}`).join("; ")}` : ""}`);
  }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Tohyee" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${xml(name)}</name><desc>${xml(about.join("\n"))}</desc><time>${xml(job.startedAt)}</time></metadata>`,
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

/** A plain-text summary of one job: what's known, what's estimated, what was entered and every correction. */
export function jobSummaryText(job: ExportJob, timeZone = "Pacific/Auckland"): string {
  const time = (value: string) => new Date(value).toLocaleString("en-NZ", { timeZone, dateStyle: "medium", timeStyle: "medium" });
  const s = job.summary;
  const lines = [
    `Tractor job summary${job.status === "withdrawn" ? " (WITHDRAWN)" : ""}`,
    "",
    "What this covers",
    ...exportScope(job).map((line) => `- ${line}`),
    "",
    "Recorded on the phone",
    `- Operator: ${job.operatorEmail}`,
    `- Equipment: ${job.equipmentName ?? "—"}`,
    `- Started ${time(job.startedAt)}, finished ${time(job.finishedAt)} (the phone's clock)`,
    `- Received by Tohyee ${time(job.receivedAt)} (Tohyee's clock)`,
    `- GPS points: ${s.points.used} used of ${s.points.total}${s.points.poorAccuracy ? `, ${s.points.poorAccuracy} too vague` : ""}${s.points.jumps ? `, ${s.points.jumps} jumps dropped` : ""}`,
    `- GPS accuracy: ${s.accuracy.median != null ? `±${Math.round(s.accuracy.median)} m typical, ±${Math.round(s.accuracy.worst ?? 0)} m worst used` : "unknown"}`,
    `- Gaps: ${s.gapSeconds ? durationText(s.gapSeconds) : "none"}`,
    `- Distance: ${distanceText(s.distanceM)} travelled, ${distanceText(s.workingDistanceM)} with Working ON (as switched)`,
    "",
    "Estimated from the track (not measured)",
    `- Worked: ${hectares(s.workedHa)}${job.notWorking.length ? " (after the corrections below)" : ""}`,
    ...(job.firstSummary && job.firstSummary.workedHa !== s.workedHa ? [`- Worked, as first saved: ${hectares(job.firstSummary.workedHa)}`] : []),
    `- Overlap: ${hectares(s.overlapHa)}`,
    ...(s.paddockHa != null ? [`- Paddocks (mapped): ${hectares(s.paddockHa)}; not covered ${hectares(s.missedHa)}; worked outside them ${hectares(s.outsideHa)}`] : ["- No paddock chosen: swept area only"]),
    "",
    "Entered by a person (not measured)",
    `- Product: ${job.product ?? "—"}`,
    `- Rate: ${job.declaredRate ? `${job.declaredRate} ${job.declaredRateUnit}` : "—"}`,
    `- Quantity: ${job.declaredQuantity ? `${job.declaredQuantity} ${job.declaredQuantityUnit}` : "—"}`,
    "",
    "Marked not working after the job",
    ...(job.notWorking.length ? job.notWorking.map((entry) => `- ${notWorkingText(entry, timeZone)}`) : ["- None"]),
    "",
    "History (Tohyee's clock)",
    ...(job.historyComplete ? [] : [`- ${EARLIER_EDITS_NOT_RECORDED}`]),
    ...job.history.flatMap((version) => [
      `- Version ${version.version}: ${version.changeLabel}, ${time(version.enteredAt)} by ${version.enteredByEmail}${version.reason ? `. Why: ${version.reason}` : ""}`,
      ...version.changes.map((change) => `    ${change.label}: ${change.from} → ${change.to}`),
    ]),
    "",
    TRACTOR_NOTICE,
    TRACTOR_RECORD_NOTE,
    "",
  ];
  return lines.join("\n");
}

/** A short file name: tractor-2026-10-28-spreading. */
export function exportFileName(job: Pick<TractorJob, "startedAt" | "operation">, extension: "geojson" | "gpx" | "txt"): string {
  return `tractor-${job.startedAt.slice(0, 10)}-${job.operation}${extension === "txt" ? "-summary" : ""}.${extension}`;
}

export type { Position };
