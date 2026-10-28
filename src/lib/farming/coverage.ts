import type { Feature, FeatureCollection, MultiPolygon as GeoMultiPolygon, Polygon as GeoPolygon } from "geojson";
import { difference } from "@turf/difference";
import { intersect } from "@turf/intersect";
import { union } from "@turf/union";
import type { PaddockGeometry, Position } from "@/lib/farming/geometry";

/*
 * Tractor and spreader coverage (#472 stage 5, decisions 1020-1024): the
 * area a spreader, sprayer or mower probably worked, worked out from a phone's
 * GPS track. Pure, shared by the phone (while driving) and the server (when
 * the job is saved), so both show the same numbers.
 *
 * How it works:
 * - Positions are put on a flat local grid in metres centred on the job
 *   (WGS84 radii of curvature at the centre, an equirectangular projection).
 *   Over a farm (a few kilometres) that's within about 0.1% of geodesic
 *   area, far closer than phone GPS. Polygon maths (union, intersection,
 *   difference) is done there with Turf (polyclip-ts underneath).
 * - The track is cleaned first (THRESHOLDS below). A fix that's too vague,
 *   a jump, a long wait between fixes, a pause or a time the screen was off
 *   breaks the track: a gap is shown and nothing is painted across it. No
 *   straight line is ever drawn to fill a gap.
 * - Only a stretch between two fixes that were both recorded with Working
 *   ON, at the same width and offset, while moving, is painted. The stretch
 *   where Working was switched (about a second) isn't counted.
 * - Each painted stretch is a rectangle the working width wide, moved by
 *   the implement's offset from the phone, with the corner between two
 *   stretches filled in. Rectangles are joined into passes (a pass ends at a
 *   turn of more than 60 degrees or a gap). Unique area is the union of
 *   everything, so going over the same ground twice counts once. Overlap is
 *   ground covered by more than one pass, shown on its own.
 * - With paddocks chosen, worked and overlap areas are clipped to their
 *   boundaries; what's outside and what's not covered inside are shown
 *   separately. Without paddocks ("Unassigned paddock") only the swept area
 *   is given, with no share of a paddock.
 *
 * All of this is an estimate from phone GPS. It isn't proof that product
 * was applied, and the numbers are never money.
 */

/** Width and offsets in metres. `lateralM`: implement centre right (+) or left (-) of the phone. `backM`: implement centre behind (+) the phone. */
export type TrackSettings = { widthM: number; lateralM: number; backM: number };

/**
 * One GPS fix as recorded. `t` milliseconds since 1970 (device time); `acc`
 * the browser's accuracy radius in metres (95% for most phones); `w` Working
 * ON; `s` the index into the track's settings; `spd` the device's own speed
 * in m/s when it gives one; `b` recording was broken just before this fix
 * (paused, screen off, GPS lost or the app reopened).
 */
export type TrackPoint = { t: number; lon: number; lat: number; acc: number | null; w: boolean; s: number; spd?: number | null; b?: boolean };

export type Track = { settings: TrackSettings[]; points: TrackPoint[] };

export const THRESHOLDS = {
  /** Accuracy at or under this is good. */
  goodAccuracyM: 10,
  /** A fix vaguer than this isn't used: the track breaks (shown as GPS weak). */
  maxAccuracyM: 20,
  /** No usable fix for longer than this breaks the track. */
  maxGapS: 10,
  /** Faster than this between fixes (43 km/h) is a jump, not driving. */
  maxSpeedMs: 12,
  /** Moves shorter than this from the last painted point wait for the next fix (stops GPS wander painting blobs). */
  minStepM: 2,
  /** Slower than this (1.8 km/h) is standing still: the position wanders but nothing is painted. Uses the device's own speed when it gives one, else how far the fixes moved over the last stillWindowS. */
  minSpeedMs: 0.5,
  stillWindowS: 5,
  /** A pass's centreline is straightened where it strays less than this (far less than phone GPS error), to keep the maths quick. */
  simplifyM: 0.5,
  /** A pass ends when the heading has turned this far from where it started. */
  turnDeg: 60,
} as const;

export type Thresholds = typeof THRESHOLDS;

export type GapReason = "paused" | "poor_accuracy" | "no_fix" | "jump";

export type TrackGap = { from: Position; to: Position; seconds: number; reason: GapReason };

export type CoverageSummary = {
  /** Unique worked area in hectares: clipped to the paddocks when there are any. */
  workedHa: number;
  /** Ground worked by more than one pass (inside the paddocks when there are any). */
  overlapHa: number;
  /** Everything swept, before clipping. */
  sweptHa: number;
  /** Distance worked × width, as if nothing overlapped. */
  grossHa: number;
  /** Swept outside the chosen paddocks (null without paddocks). */
  outsideHa: number | null;
  /** Inside the chosen paddocks but not swept (null without paddocks). */
  missedHa: number | null;
  /** The chosen paddocks' mapped area (null without paddocks). */
  paddockHa: number | null;
  /** Worked ÷ paddock area, 0-100 (null without paddocks). */
  coveredPct: number | null;
  distanceM: number;
  workingDistanceM: number;
  /** Time between the first and last fix, less gaps. */
  recordedSeconds: number;
  workingSeconds: number;
  gapSeconds: number;
  points: { total: number; used: number; poorAccuracy: number; jumps: number; stationary: number };
  /** The largest accuracy radius among fixes used, and the middle one. */
  accuracy: { median: number | null; worst: number | null };
};

export type CoverageResult = {
  summary: CoverageSummary;
  /** Worked footprint (clipped when there are paddocks), longitude and latitude. */
  footprint: GeoMultiPolygon;
  overlap: GeoMultiPolygon;
  /** Inside the paddocks, not worked. */
  missed: GeoMultiPolygon | null;
  /** Worked outside the paddocks. */
  outside: GeoMultiPolygon | null;
  /** Usable track, one line per unbroken stretch. */
  lines: Position[][];
  gaps: TrackGap[];
};

type XY = [number, number];
type Ring = XY[];
type Poly = Ring[];
type Multi = Poly[];

// Projection -----------------------------------------------------------------------------------------------------

const A = 6_378_137;
const E2 = 0.006_694_379_990_14;
const RAD = Math.PI / 180;

export type LocalProjection = { origin: Position; toXY: (position: Position) => XY; toLonLat: (xy: XY) => Position };

/** A flat grid in metres around `origin` (WGS84 meridional and prime-vertical radii at the origin's latitude). */
export function localProjection(origin: Position): LocalProjection {
  const phi = origin[1] * RAD;
  const s = Math.sin(phi);
  const w = 1 - E2 * s * s;
  const meridional = (A * (1 - E2)) / (w * Math.sqrt(w));
  const primeVertical = A / Math.sqrt(w);
  const east = primeVertical * Math.cos(phi) * RAD;
  const north = meridional * RAD;
  return {
    origin,
    toXY: ([lon, lat]) => [(lon - origin[0]) * east, (lat - origin[1]) * north],
    toLonLat: ([x, y]) => [round7(origin[0] + x / east), round7(origin[1] + y / north)],
  };
}

function round7(value: number): number {
  return Math.round(value * 1e7) / 1e7;
}

// Polygon helpers (planar, metres) ----------------------------------------------------------------------------

function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return sum / 2;
}

/** Area in square metres: outlines less holes. */
export function multiArea(multi: Multi): number {
  let total = 0;
  for (const [outline, ...holes] of multi) {
    total += Math.abs(ringArea(outline));
    for (const hole of holes) total -= Math.abs(ringArea(hole));
  }
  return Math.max(0, total);
}

const feature = (multi: Multi): Feature<GeoMultiPolygon> => ({ type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: multi } });

function collection(parts: Multi[]): FeatureCollection<GeoPolygon | GeoMultiPolygon> {
  return { type: "FeatureCollection", features: parts.map(feature) };
}

function toMulti(result: Feature<GeoPolygon | GeoMultiPolygon> | null): Multi {
  if (!result) return [];
  return (result.geometry.type === "Polygon" ? [result.geometry.coordinates] : result.geometry.coordinates) as Multi;
}

function unionAll(parts: Multi[]): Multi {
  const nonEmpty = parts.filter((part) => part.length);
  if (nonEmpty.length === 0) return [];
  // Turf wants two shapes; a shape joined with itself tidies its overlapping parts into one.
  if (nonEmpty.length === 1) return toMulti(union(collection([nonEmpty[0], nonEmpty[0]])));
  return toMulti(union(collection(nonEmpty)));
}

function intersectTwo(a: Multi, b: Multi): Multi {
  if (!a.length || !b.length) return [];
  return toMulti(intersect(collection([a, b])));
}

function subtract(a: Multi, b: Multi): Multi {
  if (!a.length) return [];
  if (!b.length) return a;
  return toMulti(difference(collection([a, b])));
}

/** Drops slivers (under 0.01 m²) the polygon maths leaves where shapes only touch. */
function dropSlivers(multi: Multi): Multi {
  return multi.filter((poly) => Math.abs(ringArea(poly[0])) >= 0.01);
}

function closeRing(points: XY[]): Ring {
  return [...points, points[0]];
}

/** Convex hull (monotone chain) of a few points, as a closed counter-clockwise ring, or null if they're in a line. */
function hull(points: XY[]): Ring | null {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: XY[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: XY[] = [];
  for (const p of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const ring = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  if (ring.length < 3 || Math.abs(ringArea(closeRing(ring))) < 1e-6) return null;
  return closeRing(ring);
}

// Cleaning the track -------------------------------------------------------------------------------------------

type Vertex = { xy: XY; t: number; w: boolean; s: number; acc: number; piece: number; moving: boolean };

type Cleaned = { vertices: Vertex[]; gaps: Array<{ from: XY; to: XY; seconds: number; reason: GapReason }>; poorAccuracy: number; jumps: number; stationary: number; used: number; accuracies: number[] };

const dist = (a: XY, b: XY) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * Walks the fixes in time order and keeps those worth drawing between. Each
 * kept vertex has a piece number: vertices in the same piece may be joined;
 * a new piece is a gap.
 */
function clean(points: TrackPoint[], project: (position: Position) => XY, limits: Thresholds): Cleaned {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const out: Cleaned = { vertices: [], gaps: [], poorAccuracy: 0, jumps: 0, stationary: 0, used: 0, accuracies: [] };
  let piece = 0;
  let anchor: Vertex | null = null;
  /** The last usable fix (painted or not): gaps and speeds are measured from it. */
  let previous: { xy: XY; t: number } | null = null;
  /** A fix that jumped away from `previous`; if the next agrees with it, the GPS has moved there. */
  let pending: { xy: XY; t: number; point: TrackPoint } | null = null;
  let breakReason: GapReason | null = null;
  let lastKept: { xy: XY; t: number } | null = null;
  /** A short move held back by minStepM: kept if the track breaks or ends before the next one, so a stretch's last metre or two isn't lost. */
  let held: Vertex | null = null;
  /** Usable fixes in this piece over the last stillWindowS, oldest first. */
  let recent: Array<{ xy: XY; t: number }> = [];
  const flush = () => {
    if (!held) return;
    out.vertices.push(held);
    lastKept = { xy: held.xy, t: held.t };
    out.used += 1;
    out.accuracies.push(held.acc);
    held = null;
  };

  const startPiece = (xy: XY, point: TrackPoint, reason: GapReason | null) => {
    flush();
    if (lastKept && reason) out.gaps.push({ from: lastKept.xy, to: xy, seconds: Math.max(0, (point.t - lastKept.t) / 1000), reason });
    piece += 1;
    anchor = { xy, t: point.t, w: point.w, s: point.s, acc: point.acc ?? 0, piece, moving: false };
    out.vertices.push(anchor);
    previous = { xy, t: point.t };
    recent = [previous];
    lastKept = previous;
    out.used += 1;
    out.accuracies.push(point.acc ?? 0);
  };

  for (const point of sorted) {
    if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat) || !Number.isFinite(point.t)) continue;
    if (point.b) breakReason = "paused";
    if (point.acc == null || !Number.isFinite(point.acc) || point.acc > limits.maxAccuracyM) {
      out.poorAccuracy += 1;
      breakReason ??= "poor_accuracy";
      continue;
    }
    const xy = project([point.lon, point.lat]);
    if (!anchor || !previous) {
      startPiece(xy, point, null);
      breakReason = null;
      continue;
    }
    const prev: { xy: XY; t: number } = previous;
    if (breakReason) {
      startPiece(xy, point, breakReason);
      breakReason = null;
      pending = null;
      continue;
    }
    const dt = (point.t - prev.t) / 1000;
    if (dt <= 0) continue;
    if (dt > limits.maxGapS) {
      startPiece(xy, point, "no_fix");
      pending = null;
      continue;
    }
    if (dist(prev.xy, xy) / dt > limits.maxSpeedMs) {
      // A jump. If the last jump and this fix agree with each other, the GPS has settled somewhere new: start again from there.
      const settled = pending && point.t > pending.t && dist(pending.xy, xy) / ((point.t - pending.t) / 1000) <= limits.maxSpeedMs;
      out.jumps += 1;
      if (settled && pending) {
        out.jumps -= 1; // The earlier fix was right after all.
        startPiece(pending.xy, pending.point, "jump");
        // fall through to treat this fix as the next after `pending`
      } else {
        pending = { xy, t: point.t, point };
        continue;
      }
    }
    pending = null;
    // Speed over the window: GPS wander goes back and forth, so it moves little over a few seconds; driving doesn't.
    recent = recent.filter((fix) => point.t - fix.t <= limits.stillWindowS * 1000);
    const from = recent[0] ?? previous!;
    const step = (point.t - from.t) / 1000;
    const speed = typeof point.spd === "number" && Number.isFinite(point.spd) && point.spd >= 0 ? point.spd : step > 0 ? dist(from.xy, xy) / step : 0;
    previous = { xy, t: point.t };
    recent.push(previous);
    const current: Vertex = anchor!;
    const stateChanged = current.w !== point.w || current.s !== point.s;
    if (speed < limits.minSpeedMs) {
      // Standing still: the position wanders, nothing is painted. The anchor follows so the next real move starts from here.
      out.stationary += 1;
      held = null;
      anchor = { xy, t: point.t, w: point.w, s: point.s, acc: point.acc, piece, moving: false };
      out.vertices.push(anchor);
      lastKept = previous;
      out.used += 1;
      out.accuracies.push(point.acc);
      continue;
    }
    if (dist(current.xy, xy) < limits.minStepM && !stateChanged) {
      held = { xy, t: point.t, w: point.w, s: point.s, acc: point.acc, piece, moving: true };
      continue;
    }
    held = null;
    anchor = { xy, t: point.t, w: point.w, s: point.s, acc: point.acc, piece, moving: true };
    out.vertices.push(anchor);
    lastKept = previous;
    out.used += 1;
    out.accuracies.push(point.acc);
  }
  flush();
  return out;
}

// Building the footprint --------------------------------------------------------------------------------------

type Stretch = { a: XY; b: XY; settings: TrackSettings };

function implementEdge(at: XY, unit: XY, settings: TrackSettings): [XY, XY] {
  const right: XY = [unit[1], -unit[0]];
  const centre: XY = [at[0] - unit[0] * settings.backM + right[0] * settings.lateralM, at[1] - unit[1] * settings.backM + right[1] * settings.lateralM];
  const half = settings.widthM / 2;
  return [
    [centre[0] - right[0] * half, centre[1] - right[1] * half],
    [centre[0] + right[0] * half, centre[1] + right[1] * half],
  ];
}

function stretchShape(stretch: Stretch): { quad: Ring; start: [XY, XY]; end: [XY, XY] } {
  const length = dist(stretch.a, stretch.b);
  const unit: XY = [(stretch.b[0] - stretch.a[0]) / length, (stretch.b[1] - stretch.a[1]) / length];
  const start = implementEdge(stretch.a, unit, stretch.settings);
  const end = implementEdge(stretch.b, unit, stretch.settings);
  // left-start, left-end, right-end, right-start: a rectangle.
  return { quad: closeRing([start[0], end[0], end[1], start[1]]), start, end };
}

function angleBetween(a: number, b: number): number {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

/** Splits painted stretches into passes and gives each pass's shape (rectangles plus filled corners). */
/** Douglas-Peucker: drops centreline points within `tolerance` metres of the line through their neighbours. */
function simplify(chain: XY[], tolerance: number): XY[] {
  if (chain.length < 3) return chain;
  const keep = new Uint8Array(chain.length);
  keep[0] = 1;
  keep[chain.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, chain.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    const [ax, ay] = chain[first];
    const [bx, by] = chain[last];
    const length = Math.hypot(bx - ax, by - ay);
    let worst = -1;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const [px, py] = chain[i];
      const off = length === 0 ? Math.hypot(px - ax, py - ay) : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length;
      if (off > worst) {
        worst = off;
        index = i;
      }
    }
    if (worst > tolerance && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return chain.filter((_, i) => keep[i] === 1);
}

type Pass = { chain: XY[]; settings: TrackSettings; extra: Ring[] };

/** A pass's shape: a rectangle for each stretch of its (simplified) centreline, with the corners between them filled in. */
function passShape(pass: Pass, limits: Thresholds): Multi {
  const chain = simplify(pass.chain, limits.simplifyM);
  const rings: Ring[] = [...pass.extra];
  let previous: ReturnType<typeof stretchShape> | null = null;
  for (let i = 1; i < chain.length; i += 1) {
    if (dist(chain[i - 1], chain[i]) === 0) continue;
    const shape = stretchShape({ a: chain[i - 1], b: chain[i], settings: pass.settings });
    if (previous) {
      const corner = hull([...previous.end, ...shape.start]);
      if (corner) rings.push(corner);
    }
    rings.push(shape.quad);
    previous = shape;
  }
  // Each rectangle and corner is its own shape to the polygon maths, so overlapping parts of a pass join properly.
  return unionAll(rings.map((ring) => [[ring]]));
}

/** Splits painted stretches into passes and gives each pass's shape. */
function passes(vertices: Vertex[], settings: TrackSettings[], limits: Thresholds): { passShapes: Multi[]; grossM2: number; workingDistanceM: number; workingSeconds: number } {
  const done: Pass[] = [];
  let grossM2 = 0;
  let workingDistanceM = 0;
  let workingSeconds = 0;
  let current: Pass | null = null;
  let startHeading = 0;
  let last: { shape: ReturnType<typeof stretchShape>; b: XY } | null = null;
  const finish = () => {
    if (current) done.push(current);
    current = null;
    last = null;
  };
  for (let i = 1; i < vertices.length; i += 1) {
    const a = vertices[i - 1];
    const b = vertices[i];
    const own = settings[a.s];
    const painted = a.piece === b.piece && b.moving && a.w && b.w && a.s === b.s && own && own.widthM > 0 && dist(a.xy, b.xy) > 0;
    if (!painted) {
      finish();
      continue;
    }
    const heading = Math.atan2(b.xy[1] - a.xy[1], b.xy[0] - a.xy[0]);
    const shape = stretchShape({ a: a.xy, b: b.xy, settings: own });
    const length = dist(a.xy, b.xy);
    grossM2 += length * own.widthM;
    workingDistanceM += length;
    workingSeconds += (b.t - a.t) / 1000;
    const continuing: { shape: ReturnType<typeof stretchShape>; b: XY } | null = last;
    const open: Pass | null = current;
    if (continuing && open && continuing.b === a.xy) {
      if (angleBetween(heading, startHeading) > (limits.turnDeg * Math.PI) / 180) {
        // A turn: the corner goes with the new pass, so the turn's inside counts as overlap with the last pass.
        const corner = hull([...continuing.shape.end, ...shape.start]);
        finish();
        startHeading = heading;
        current = { chain: [a.xy, b.xy], settings: own, extra: corner ? [corner] : [] };
      } else {
        open.chain.push(b.xy);
      }
    } else {
      finish();
      startHeading = heading;
      current = { chain: [a.xy, b.xy], settings: own, extra: [] };
    }
    last = { shape, b: b.xy };
  }
  finish();
  return { passShapes: done.map((pass) => passShape(pass, limits)), grossM2, workingDistanceM, workingSeconds };
}

// The whole job --------------------------------------------------------------------------------------------------

function outlinesOf(geometry: PaddockGeometry): Position[][][] {
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
}

/** The middle of the track's fixes and the paddocks' corners: the projection's origin. */
export function trackOrigin(points: Array<Pick<TrackPoint, "lon" | "lat">>, boundaries: PaddockGeometry[] = []): Position | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const see = (lon: number, lat: number) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  };
  for (const point of points) see(point.lon, point.lat);
  for (const geometry of boundaries) for (const polygon of outlinesOf(geometry)) for (const [lon, lat] of polygon[0]) see(lon, lat);
  return Number.isFinite(west) ? [(west + east) / 2, (south + north) / 2] : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
const EMPTY: GeoMultiPolygon = { type: "MultiPolygon", coordinates: [] };

/**
 * Works out a job's coverage from its track. `boundaries` are the chosen
 * paddocks' shapes (none for an unassigned job). Deterministic: the same
 * track and boundaries always give the same answer.
 */
export function computeCoverage(track: Track, boundaries: PaddockGeometry[] = [], limits: Thresholds = THRESHOLDS): CoverageResult {
  const origin = trackOrigin(track.points, boundaries) ?? [0, 0];
  const projection = localProjection(origin);
  const cleaned = clean(track.points, projection.toXY, limits);
  const { passShapes, grossM2, workingDistanceM, workingSeconds } = passes(cleaned.vertices, track.settings, limits);

  // Unique area and overlap: each pass against everything before it.
  let covered: Multi = [];
  const overlapParts: Multi[] = [];
  for (const pass of passShapes) {
    if (covered.length) {
      const shared = dropSlivers(intersectTwo(pass, covered));
      if (shared.length) overlapParts.push(shared);
      covered = unionAll([covered, pass]);
    } else {
      covered = pass;
    }
  }
  let overlap = dropSlivers(unionAll(overlapParts));

  const paddocks: Multi = unionAll(boundaries.map((geometry) => outlinesOf(geometry).map((polygon) => polygon.map((ring) => ring.map(projection.toXY)))));
  const sweptM2 = multiArea(covered);
  let footprint = covered;
  let missed: Multi | null = null;
  let outside: Multi | null = null;
  if (paddocks.length) {
    footprint = dropSlivers(intersectTwo(covered, paddocks));
    overlap = dropSlivers(intersectTwo(overlap, paddocks));
    missed = dropSlivers(subtract(paddocks, covered));
    outside = dropSlivers(subtract(covered, paddocks));
  }

  // Distances and times over the usable track.
  let distanceM = 0;
  let recordedSeconds = 0;
  const lines: Position[][] = [];
  let line: Position[] = [];
  for (let i = 0; i < cleaned.vertices.length; i += 1) {
    const vertex = cleaned.vertices[i];
    const before = cleaned.vertices[i - 1];
    if (before && before.piece === vertex.piece) {
      distanceM += vertex.moving ? dist(before.xy, vertex.xy) : 0;
      recordedSeconds += (vertex.t - before.t) / 1000;
    } else {
      if (line.length > 1) lines.push(line);
      line = [];
    }
    line.push(projection.toLonLat(vertex.xy));
  }
  if (line.length > 1) lines.push(line);
  const gapSeconds = cleaned.gaps.reduce((total, gap) => total + gap.seconds, 0);

  const workedM2 = multiArea(footprint);
  const paddockM2 = paddocks.length ? multiArea(paddocks) : null;
  const toGeo = (multi: Multi): GeoMultiPolygon => ({ type: "MultiPolygon", coordinates: multi.map((poly) => poly.map((ring) => ring.map((xy) => projection.toLonLat(xy)))) });
  return {
    summary: {
      workedHa: round(workedM2 / 10_000, 4),
      overlapHa: round(multiArea(overlap) / 10_000, 4),
      sweptHa: round(sweptM2 / 10_000, 4),
      grossHa: round(grossM2 / 10_000, 4),
      outsideHa: outside ? round(multiArea(outside) / 10_000, 4) : null,
      missedHa: missed ? round(multiArea(missed) / 10_000, 4) : null,
      paddockHa: paddockM2 == null ? null : round(paddockM2 / 10_000, 4),
      coveredPct: paddockM2 ? round(Math.min(100, (workedM2 / paddockM2) * 100), 1) : null,
      distanceM: round(distanceM, 1),
      workingDistanceM: round(workingDistanceM, 1),
      recordedSeconds: Math.round(recordedSeconds),
      workingSeconds: Math.round(workingSeconds),
      gapSeconds: Math.round(gapSeconds),
      points: { total: track.points.length, used: cleaned.used, poorAccuracy: cleaned.poorAccuracy, jumps: cleaned.jumps, stationary: cleaned.stationary },
      accuracy: { median: median(cleaned.accuracies), worst: cleaned.accuracies.length ? Math.max(...cleaned.accuracies) : null },
    },
    footprint: footprint.length ? toGeo(footprint) : EMPTY,
    overlap: overlap.length ? toGeo(overlap) : EMPTY,
    missed: missed ? toGeo(missed) : null,
    outside: outside ? toGeo(outside) : null,
    lines,
    gaps: cleaned.gaps.map((gap) => ({ from: projection.toLonLat(gap.from), to: projection.toLonLat(gap.to), seconds: round(gap.seconds, 1), reason: gap.reason })),
  };
}

/** GPS quality from an accuracy radius in metres. */
export function gpsQuality(accuracy: number | null | undefined, limits: Thresholds = THRESHOLDS): "good" | "weak" | "poor" | "none" {
  if (accuracy == null || !Number.isFinite(accuracy)) return "none";
  if (accuracy <= limits.goodAccuracyM) return "good";
  if (accuracy <= limits.maxAccuracyM) return "weak";
  return "poor";
}
