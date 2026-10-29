/*
 * Farm dairy effluent: types, labels, starting templates and the sums the
 * screens and the server share (#487, decisions 1070-1099,
 * docs/FARM-EFFLUENT.md). Browser-safe: no server imports.
 *
 * Tohyee keeps the farm's effluent records. It doesn't decide what the law
 * or a consent needs, and nothing here says a farm complies. The farm
 * enters its own consent conditions; the starting templates only point to
 * each council's published pages and are marked "check against your own
 * consent". Everything drawn from those pages is not yet reviewed by Jess.
 */

import type { Position, ZoneGeometry } from "@/lib/safety/shared";

// Systems ---------------------------------------------------------------------------------------------

export const SYSTEM_TYPES = ["travelling_irrigator", "pods", "slurry_tanker", "fixed_sprinklers"] as const;
export type SystemType = (typeof SYSTEM_TYPES)[number];
export const SYSTEM_TYPE_LABELS: Record<SystemType, string> = {
  travelling_irrigator: "Travelling irrigator",
  pods: "Pods or K-line",
  slurry_tanker: "Slurry tanker or spreader",
  fixed_sprinklers: "Fixed sprinklers or rain gun",
};

/** How often each system's checks are due (decision 1076). */
export const CHECK_EVERY = ["day", "week"] as const;
export type CheckEvery = (typeof CHECK_EVERY)[number];
export const CHECK_EVERY_LABELS: Record<CheckEvery, string> = { day: "Each day it's used", week: "Each week" };

/**
 * The settings used to work out how much was put on (decision 1080), as
 * entered by the farm, from its own bucket tests or designer. Decimal
 * strings; any may be empty.
 * - Travelling irrigator: flow (m³ an hour), wetted width (m) and travel
 *   speed (m an hour).
 * - Pods, K-line, sprinklers and rain guns: the application rate (mm an
 *   hour, from a bucket test) and the share of time they run when pulsed.
 * - Tanker or spreader: the tank's volume (m³).
 */
export type SystemSettings = {
  flowM3PerHour: string | null;
  wettedWidthM: string | null;
  speedMPerHour: string | null;
  rateMmPerHour: string | null;
  pulsePercent: string | null;
  tankM3: string | null;
};

export const EMPTY_SETTINGS: SystemSettings = { flowM3PerHour: null, wettedWidthM: null, speedMPerHour: null, rateMmPerHour: null, pulsePercent: null, tankM3: null };

/** Which settings each type uses, in the order the form asks for them. */
export const SETTINGS_FOR: Record<SystemType, Array<keyof SystemSettings>> = {
  travelling_irrigator: ["flowM3PerHour", "wettedWidthM", "speedMPerHour", "rateMmPerHour"],
  pods: ["rateMmPerHour", "pulsePercent"],
  fixed_sprinklers: ["rateMmPerHour", "pulsePercent"],
  slurry_tanker: ["tankM3"],
};

export const SETTING_LABELS: Record<keyof SystemSettings, { label: string; hint: string }> = {
  flowM3PerHour: { label: "Flow (m³ an hour)", hint: "From the pump or your designer." },
  wettedWidthM: { label: "Wetted width (m)", hint: "How wide it wets the ground." },
  speedMPerHour: { label: "Travel speed (m an hour)", hint: "At the speed you usually set." },
  rateMmPerHour: { label: "Application rate (mm an hour)", hint: "From a bucket test (DairyNZ's staff guide shows how)." },
  pulsePercent: { label: "Share of time running when pulsed (%)", hint: "E.g. 50 for 15 minutes on, 15 off. Empty if it runs all the time." },
  tankM3: { label: "Tank volume (m³)", hint: "One full load." },
};

export type SystemData = {
  name: string;
  type: SystemType;
  /** The machine in Safety's equipment register: its checks, faults and release rules (decision 1075). */
  equipmentId: string;
  /** For a tanker or spreader: the machine in tractor mode, for its runs' coverage. */
  tractorEquipmentId: string | null;
  /** The pond or sump it draws from. */
  pondId: string | null;
  /** The blocks it applies to. */
  blockIds: string[];
  settings: SystemSettings;
  /** Remind to shift the pods or irrigator this many hours after the last move (empty: no reminder). */
  shiftEveryHours: string | null;
  checkEvery: CheckEvery;
  /** Servicing: every this many months, counted from the last service. */
  serviceEveryMonths: number | null;
  /** The next Effluent Warrant of Fitness, if the farm has one done. */
  wofDue: string | null;
  notes: string | null;
  retired: boolean;
  why?: string | null;
};

// Ponds and sumps ------------------------------------------------------------------------------------

export const POND_KINDS = ["pond", "sump", "tank", "weeping_wall", "other"] as const;
export type PondKind = (typeof POND_KINDS)[number];
export const POND_KIND_LABELS: Record<PondKind, string> = { pond: "Storage pond", sump: "Sump", tank: "Tank", weeping_wall: "Weeping wall or solids trap", other: "Other" };

export type PondMarker = { label: string; mm: string };

export type PondData = {
  name: string;
  kind: PondKind;
  /** What it holds when full, m³ (from the designer or storage calculator). */
  capacityM3: string;
  /** The gauge reading (mm) when it's full. Readings are taken against the same gauge. */
  fullAtMm: string | null;
  /** The marks on the gauge (e.g. Low, Medium, Full), as on the pond. */
  markers: PondMarker[];
  /** Warn at or above this reading (mm). */
  highAtMm: string | null;
  /** Warn at or below this reading (mm), e.g. so a pump doesn't run dry. */
  lowAtMm: string | null;
  /** About how much goes in each day, m³, for days of storage left. */
  dailyInflowM3: string | null;
  point: Position | null;
  notes: string | null;
  retired: boolean;
  why?: string | null;
};

// Blocks and no-apply zones ------------------------------------------------------------------------

export const RISK_LEVELS = ["low", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const RISK_LABELS: Record<RiskLevel, string> = { low: "Lower-risk soils", high: "Higher-risk soils (tiles, slopes, wet)" };

export type BlockData = {
  name: string;
  paddockIds: string[];
  zone: ZoneGeometry | null;
  /** As entered; when empty, the paddocks' effective area is used. Decimal string. */
  areaHa: string | null;
  risk: RiskLevel | null;
  notes: string | null;
  retired: boolean;
  why?: string | null;
};

export const ZONE_FEATURES = ["waterway", "drain", "wetland", "bore", "boundary", "dwelling", "road", "public_place", "other"] as const;
export type ZoneFeature = (typeof ZONE_FEATURES)[number];
export const ZONE_FEATURE_LABELS: Record<ZoneFeature, string> = {
  waterway: "Waterway (river, stream, lake)",
  drain: "Drain or water race",
  wetland: "Wetland",
  bore: "Bore or soakhole",
  boundary: "Property boundary",
  dwelling: "House or workplace",
  road: "Road",
  public_place: "Public place",
  other: "Other",
};

export type ZoneData = {
  name: string;
  feature: ZoneFeature;
  point: Position | null;
  zone: ZoneGeometry | null;
  /** The buffer around it where effluent isn't applied, metres (from the consent). Decimal string. */
  bufferM: string | null;
  notes: string | null;
  removed: boolean;
  why?: string | null;
};

// Consent conditions ----------------------------------------------------------------------------------

export const COUNCILS = ["orc", "es", "other"] as const;
export type Council = (typeof COUNCILS)[number];
export const COUNCIL_LABELS: Record<Council, string> = { orc: "Otago Regional Council", es: "Environment Southland", other: "Another council" };

export type Source = { title: string; url: string };
export type Buffer = { feature: ZoneFeature; metres: string };
export type CouncilNotice = { who: string; phone: string | null; when: string };

export type ConsentData = {
  title: string;
  consentNumber: string | null;
  council: Council;
  expiresOn: string | null;
  maxDepthMm: string | null;
  maxRateMmPerHour: string | null;
  returnPeriodDays: number | null;
  maxNitrogenKgHaYr: string | null;
  /** Storage the consent asks for, m³. */
  storageM3: string | null;
  buffers: Buffer[];
  /** When not to apply (deferred irrigation), in the consent's words. */
  deferWhen: string[];
  recordsRequired: string[];
  /** Who to tell, and when, if something goes wrong. Tohyee never tells them itself (decision 1092). */
  notifyCouncil: CouncilNotice | null;
  /** Anything else the consent says, as written. */
  otherConditions: string | null;
  /** The template it started from, and the fields still as the template had them. */
  template: Council | null;
  fromTemplate: string[];
  sources: Source[];
  /** Replaced by a newer consent or expired and not renewed. */
  replaced: boolean;
  why?: string | null;
};

export const CHECK_YOUR_CONSENT = "Check against your own consent. Tohyee doesn't decide what the rules are: your consent and your council do.";

export type ConsentTemplate = {
  council: Exclude<Council, "other">;
  title: string;
  /** In plain words: what the template is, and isn't. */
  summary: string;
  sources: Source[];
  buffers: Buffer[];
  deferWhen: string[];
  recordsRequired: string[];
  notifyCouncil: CouncilNotice;
  otherConditions: string;
  /** Fields the template leaves for the consent itself. */
  fromYourConsent: string[];
};

/**
 * Starting templates per council (decision 1073), read 29 October 2026.
 * Figures are what each council's published pages say, with the page named;
 * the farm's own consent may differ and wins. Not yet reviewed by Jess.
 */
export const CONSENT_TEMPLATES: Record<Exclude<Council, "other">, ConsentTemplate> = {
  orc: {
    council: "orc",
    title: "Discharge permit: farm dairy effluent",
    summary:
      "From Otago Regional Council's effluent guide sheet (Regional Plan: Water for Otago rule 12.C.0.2 and the Air Plan). Since Plan Change 8 (June 2022) dairy farms need consent for effluent storage and discharge, so your consent's own conditions apply. Depth, rate and return period are left for you to enter from it.",
    sources: [
      { title: "ORC: Effluent management guide sheet (14 November 2014)", url: "https://orc.govt.nz/media/4448/effluent-management-guide-sheet.pdf" },
      { title: "ORC: Animal effluent storage and discharge requirement workshops (consents due 4 December 2025)", url: "https://www.orc.govt.nz/environment/land-care/managing-nutrients/effluent-management/animal-effluent-storage-and-discharge-requirement-workshops" },
      { title: "ORC: New provisions for managing water and effluent going live (Plan Change 8, June 2022)", url: "https://www.orc.govt.nz/your-council/latest-news/news/2022/june/new-provisions-for-managing-water-and-effluent-going-live" },
    ],
    buffers: [
      { feature: "waterway", metres: "50" },
      { feature: "wetland", metres: "50" },
      { feature: "bore", metres: "50" },
      { feature: "dwelling", metres: "150" },
      { feature: "public_place", metres: "150" },
      { feature: "road", metres: "20" },
    ],
    deferWhen: ["The soil is saturated (a boot print fills with water)", "It would pond", "It would run off to water, a drain or a water race"],
    recordsRequired: ["Servicing and equipment checks (ORC's guide sheet: \"it helps to record these\")", "Higher- and lower-risk paddocks", "Anything else your consent lists"],
    notifyCouncil: { who: "ORC Pollution Hotline (24/7)", phone: "0800 800 033", when: "As soon as possible after a spill, or effluent reaching a drain or water (ORC's guide sheet). Your consent may say more." },
    otherConditions: "Effluent mustn't enter a lake, river, Regionally Significant Wetland, bore or soakhole, or a drain or water race that leads to them (rule 12.C.0.2). Odour mustn't be objectionable beyond the boundary (Air Plan).",
    fromYourConsent: ["consentNumber", "expiresOn", "maxDepthMm", "maxRateMmPerHour", "returnPeriodDays", "maxNitrogenKgHaYr", "storageM3"],
  },
  es: {
    council: "es",
    title: "Discharge permit: farm dairy effluent to land",
    summary:
      "From Environment Southland's effluent pages and its consent application form (Part B, discharge of farm dairy effluent to land), under the Southland Water and Land Plan. Depth, rate and return period are left for you to enter from your consent.",
    sources: [
      { title: "Environment Southland: Effluent management", url: "https://es.govt.nz/environment/land-and-soil/effluent-management" },
      { title: "Environment Southland: Full effluent ponds and irrigation", url: "https://www.es.govt.nz/community/farming/good-management-practice/full-effluent-ponds-and-irrigation" },
      {
        title: "Environment Southland: consent form Part B, discharge to land (farm dairy effluent)",
        url: "https://www.es.govt.nz/repository/libraries/id:26gi9ayo517q9stt81sd/hierarchy/environment/consents/consent-forms/documents/Part%20B%20-%20Discharge%20to%20%20Land%20%28FDE%29.docx.pdf",
      },
    ],
    buffers: [
      { feature: "waterway", metres: "20" },
      { feature: "drain", metres: "20" },
      { feature: "wetland", metres: "20" },
      { feature: "bore", metres: "100" },
      { feature: "boundary", metres: "20" },
      { feature: "dwelling", metres: "200" },
      { feature: "public_place", metres: "200" },
    ],
    deferWhen: [
      "There's snow on the ground",
      "Food is being gathered from the watercourses",
      "Rain or irrigation water has ponded on the surface",
      "Soil temperature is at or below 5°C",
      "Soil moisture isn't suitable (the council's monitoring site or your own)",
    ],
    recordsRequired: ["Every effluent irrigation event (Environment Southland's Full effluent ponds page)", "Anything else your consent lists"],
    notifyCouncil: { who: "Environment Southland", phone: "0800 76 88 45", when: "As soon as possible if there's a problem with irrigation (Environment Southland's Full effluent ponds page). Your consent may say more." },
    otherConditions:
      "Ponding or runoff that could reach a waterway is non-compliant. When soils are very wet, keep depth below 5 mm and run a 15-minute test for ponding first (Full effluent ponds page). Stay inside the consented application area; avoid tile-drained areas.",
    fromYourConsent: ["consentNumber", "expiresOn", "maxDepthMm", "maxRateMmPerHour", "returnPeriodDays", "maxNitrogenKgHaYr", "storageM3"],
  },
};

/** Consent fields a template fills in, so the screen can mark them "from the template". */
export const TEMPLATE_FIELDS = ["buffers", "deferWhen", "recordsRequired", "notifyCouncil", "otherConditions"] as const;

/** The first buffer the consent gives for a feature, as a decimal string, or null. */
export function bufferFor(consent: Pick<ConsentData, "buffers"> | null, feature: ZoneFeature): string | null {
  return consent?.buffers.find((buffer) => buffer.feature === feature)?.metres ?? null;
}

/** The farm's consent in force: the latest one not replaced (and not withdrawn), or null. */
export function activeConsent<T extends { change: string; data: Pick<ConsentData, "replaced"> }>(consents: readonly T[]): T | null {
  return [...consents].reverse().find((consent) => consent.change !== "withdrawn" && !consent.data.replaced) ?? null;
}

// Starting checklists ---------------------------------------------------------------------------------

/**
 * A starting pre-start checklist for each type (decision 1076), from
 * DairyNZ's staff guides to operating effluent irrigation systems
 * (travelling irrigator, and low rate). Each farm changes its own under
 * Safety › Equipment. Critical items put the system out of use when they
 * fail. Not yet reviewed by Jess.
 */
export const STARTING_CHECKLISTS: Record<SystemType, Array<{ text: string; critical: boolean }>> = {
  travelling_irrigator: [
    { text: "In the right place on the run sheet, clear of waterways and buffers", critical: true },
    { text: "Wire rope not frayed; winch and cut-off work", critical: true },
    { text: "Brake in and anchor secure", critical: true },
    { text: "Hoses, couplings and hydrants: no leaks or loose joints", critical: true },
    { text: "Fail-safe or alarm works", critical: true },
    { text: "Boom spins and nozzles are clear", critical: false },
    { text: "Pump sounds and runs right", critical: false },
    { text: "Stone trap and sump clear", critical: false },
    { text: "Stormwater diversion in the right position", critical: false },
  ],
  pods: [
    { text: "Pods in the right place, clear of waterways, tiles, gullies and buffers", critical: true },
    { text: "Cam locks, couplings, end valves and caps closed and not leaking", critical: true },
    { text: "Hoses: no cracks, splits or kinks", critical: true },
    { text: "Fail-safe or alarm works", critical: true },
    { text: "Every pod sprays a fan; no blocked nozzles", critical: false },
    { text: "Pump sounds and runs right", critical: false },
    { text: "Stone trap and sump clear", critical: false },
    { text: "Stormwater diversion in the right position", critical: false },
  ],
  fixed_sprinklers: [
    { text: "Sprinklers or gun set clear of waterways and buffers", critical: true },
    { text: "Pipes, hydrants and couplings not leaking", critical: true },
    { text: "Fail-safe or alarm works", critical: true },
    { text: "Nozzles clear; spraying evenly", critical: false },
    { text: "Pump sounds and runs right", critical: false },
    { text: "Stone trap and sump clear", critical: false },
    { text: "Stormwater diversion in the right position", critical: false },
  ],
  slurry_tanker: [
    { text: "Hitched properly; brakes and lights work", critical: true },
    { text: "Valves, seals and hoses not leaking", critical: true },
    { text: "Today's paddocks are clear of waterways and buffers", critical: true },
    { text: "Spreading plate or dribble bar clear", critical: false },
    { text: "Tyres and wheel bearings look right", critical: false },
  ],
};

export const DAIRYNZ_GUIDES: Source[] = [
  { title: "DairyNZ: A staff guide to operating your effluent irrigation system (travelling irrigator)", url: "https://www.dairynz.co.nz/media/5v3jba14/a-staff-guide-to-operating-your-effluent-irrigation-system-travelling-irrigator.pdf" },
  { title: "DairyNZ: A staff guide to operating your effluent irrigation system (low rate)", url: "https://www.dairynz.co.nz/media/eqbdhzr5/a-staff-guide-to-operating-your-effluent-irrigation-system-low-rate.pdf" },
  { title: "DairyNZ: Effluent management plan poster (2025)", url: "https://www.dairynz.co.nz/media/wu2opztk/effluent-management-plan-poster-2025.pdf" },
  { title: "DairyNZ: Dairy Effluent Warrant of Fitness", url: "https://www.dairynz.co.nz/media/xcgpl3wx/dairy_effluent_wof_brochure.pdf" },
];

// Shapes ----------------------------------------------------------------------------------------------

/**
 * A circle of `metres` around a point, as a ring of longitude-latitude
 * points, for drawing a buffer on the map. Display only (numbers, not
 * decimals): it's a picture, not a measurement.
 */
export function bufferRing(centre: Position, metres: number, points = 36): Position[] {
  const [lon, lat] = centre;
  const latRadius = metres / 111_320;
  const lonRadius = metres / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring: Position[] = [];
  for (let index = 0; index < points; index += 1) {
    const angle = (2 * Math.PI * index) / points;
    ring.push([Math.round((lon + lonRadius * Math.cos(angle)) * 1e6) / 1e6, Math.round((lat + latRadius * Math.sin(angle)) * 1e6) / 1e6]);
  }
  ring.push(ring[0]);
  return ring;
}

// Incidents -------------------------------------------------------------------------------------------

export const INCIDENT_TYPES = ["spill", "ponding", "runoff", "buffer_breach", "rate_breach", "power_failure", "pump_failure", "other"] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];
export const INCIDENT_TYPE_LABELS: Record<IncidentType, string> = {
  spill: "Spill or overflow",
  ponding: "Ponding",
  runoff: "Runoff",
  buffer_breach: "Inside a buffer or no-apply zone",
  rate_breach: "Over the depth or rate",
  power_failure: "Power failure",
  pump_failure: "Pump or pipe failure",
  other: "Other",
};

/** Recorded by a person after they told the council (Tohyee never does, decision 1092). */
export type CouncilTold = { on: string; how: "phone" | "email" | "online" | "in_person"; who: string | null; reference: string | null };
export const COUNCIL_TOLD_HOW: Record<CouncilTold["how"], string> = { phone: "by phone", email: "by email", online: "online", in_person: "in person" };

export type IncidentData = {
  type: IncidentType;
  title: string;
  whatHappened: string | null;
  systemId: string | null;
  applicationId: string | null;
  paddockIds: string[];
  point: Position | null;
  /** When it happened, as the person says. */
  occurredAt: string;
  immediateAction: string | null;
  /** Reached water, a drain or a neighbour's place, as the person says. */
  reachedWater: boolean;
  files: Array<{ id: string; name: string; sha256: string }>;
  councilTold: CouncilTold | null;
  /**
   * Someone (a bookkeeper or above, in person) looked at it and says what they found (#491):
   * the report is the reporter's account; this is the check of it. Absent on older records.
   */
  checked?: { note: string } | null;
  closed: { why: string } | null;
  why?: string | null;
};

export const NEVER_SENDS = "Tohyee never tells the council for you. If your consent says to, tell them yourself, then record it here.";
