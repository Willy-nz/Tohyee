import { describe, expect, it } from "vitest";
import type { CoverageSummary } from "@/lib/farming/coverage";
import {
  checkNotWorking,
  correctedTrack,
  correctionFields,
  EARLIER_EDITS_NOT_RECORDED,
  exportScope,
  type ExportJob,
  jobChanges,
  type JobSnapshot,
  jobSummaryText,
  type JobTrack,
  TRACTOR_RECORD_NOTE,
} from "@/lib/farming/tractor-shared";

/*
 * A tractor job's corrections and history, as words (#491, decisions
 * 1100-1104). Made-up job.
 */

const summary = (workedHa: number): CoverageSummary => ({
  workedHa,
  overlapHa: 0,
  sweptHa: workedHa,
  grossHa: workedHa,
  outsideHa: null,
  missedHa: null,
  paddockHa: null,
  coveredPct: null,
  distanceM: 100,
  workingDistanceM: 100,
  recordedSeconds: 50,
  workingSeconds: 50,
  gapSeconds: 0,
  points: { total: 51, used: 51, poorAccuracy: 0, jumps: 0, stationary: 0 },
  accuracy: { median: 4, worst: 4 },
});

const base: JobSnapshot = {
  paddockIds: ["7"],
  paddockNames: ["7"],
  boundaryIds: ["31"],
  summary: summary(1.2),
  notes: null,
  product: "Urea",
  declaredRate: "100",
  declaredRateUnit: "kg/ha",
  declaredQuantity: "5",
  declaredQuantityUnit: "t",
  fertiliserPlanId: null,
  fertiliserApplicationId: null,
  chemicalRecordId: null,
  notWorking: [],
  status: "active",
  withdrawnReason: null,
};

describe("what changed between versions", () => {
  it("gives the earlier and new values, units included", () => {
    expect(jobChanges(base, { ...base, declaredQuantity: "500", declaredQuantityUnit: "kg" })).toEqual([{ field: "quantity", label: "Quantity (entered)", from: "5 t", to: "500 kg" }]);
  });

  it("leaves the plan link out for people who don't see it", () => {
    const linked = { ...base, fertiliserPlanId: "3", fertiliserPlanName: "Spring" };
    expect(jobChanges(base, linked).map((change) => change.field)).toEqual(["plan"]);
    expect(jobChanges(base, linked, { withLinks: false })).toEqual([]);
  });
});

describe("which changes are corrections (need why)", () => {
  it("replacing a value already entered is; filling a blank isn't", () => {
    expect(correctionFields(base, { ...base, declaredQuantity: "0.5" })).toEqual(["Quantity (entered)"]);
    expect(correctionFields(base, { ...base, declaredRateUnit: "L/ha" })).toEqual(["Rate (entered)"]);
    expect(correctionFields(base, { ...base, product: "DAP" })).toEqual(["Product (entered)"]);
    expect(correctionFields(base, { ...base, notes: "First note" })).toEqual([]);
    expect(correctionFields({ ...base, notes: "First note" }, { ...base, notes: "Better note" })).toEqual(["Notes"]);
    expect(correctionFields({ ...base, paddockIds: [], paddockNames: [] }, base)).toEqual([]);
    expect(correctionFields(base, { ...base, paddockIds: ["8"], paddockNames: ["8"] })).toEqual(["Paddocks"]);
  });

  it("adding a time marked not working isn't; removing or changing one is", () => {
    const one = { from: "2026-10-28T09:00:25.000Z", to: "2026-10-28T09:00:50.000Z", why: "Drive back" };
    const two = { from: "2026-10-28T09:00:05.000Z", to: "2026-10-28T09:00:10.000Z", why: "Turning" };
    expect(correctionFields(base, { ...base, notWorking: [one] })).toEqual([]);
    expect(correctionFields({ ...base, notWorking: [one] }, { ...base, notWorking: [two, one] })).toEqual([]);
    expect(correctionFields({ ...base, notWorking: [one] }, { ...base, notWorking: [] })).toEqual(["Marked not working"]);
  });
});

describe("times marked not working", () => {
  const job = { startedAt: "2026-10-28T09:00:00Z", finishedAt: "2026-10-28T09:10:00Z" };

  it("must be inside the job, in order, each with why", () => {
    expect(checkNotWorking([{ from: "2026-10-28T09:05:00Z", to: "2026-10-28T09:06:00Z", why: " Gate " }], job)).toEqual([{ from: "2026-10-28T09:05:00.000Z", to: "2026-10-28T09:06:00.000Z", why: "Gate" }]);
    expect(() => checkNotWorking([{ from: "2026-10-28T08:00:00Z", to: "2026-10-28T09:06:00Z", why: "x" }], job)).toThrow(/outside the job/);
    expect(() => checkNotWorking([{ from: "2026-10-28T09:06:00Z", to: "2026-10-28T09:05:00Z", why: "x" }], job)).toThrow(/ends before/);
    expect(() => checkNotWorking([{ from: "2026-10-28T09:05:00Z", to: "2026-10-28T09:06:00Z", why: "" }], job)).toThrow(/Say why/);
  });

  it("turn Working OFF for the estimate only: the track given in isn't changed", () => {
    const start = Date.parse(job.startedAt);
    const track: JobTrack = { version: 1, settings: [{ widthM: 10, lateralM: 0, backM: 0, settingsId: null }], points: [0, 1, 2, 3].map((i) => [start + i * 1000, 170, -45, 4, 1, 0, null, 0]), events: [] };
    const copy = JSON.stringify(track);
    const corrected = correctedTrack(track, [{ from: new Date(start + 2000).toISOString(), to: new Date(start + 3000).toISOString(), why: "x" }]);
    expect(corrected.points.map((point) => point.w)).toEqual([true, true, false, false]);
    expect(JSON.stringify(track)).toBe(copy);
  });
});

describe("the job summary export", () => {
  const job: ExportJob = {
    id: "0a8f4f9e-3d1c-4b7a-9c55-1f2e3d4c5b6a",
    operation: "spreading",
    startedAt: "2026-10-28T09:00:00Z",
    finishedAt: "2026-10-28T09:10:00Z",
    receivedAt: "2026-10-28T12:00:00Z",
    operatorEmail: "driver@example.com",
    equipmentName: "Spreader",
    paddockNames: ["7"],
    summary: summary(1.0),
    track: { version: 1, settings: [], points: [], events: [] },
    coverage: { footprint: null, overlap: null, missed: null, lines: [], gaps: [] } as unknown as ExportJob["coverage"],
    product: "Urea",
    declaredRate: null,
    declaredRateUnit: null,
    declaredQuantity: "500",
    declaredQuantityUnit: "kg",
    status: "active",
    withdrawnReason: null,
    notWorking: [{ from: "2026-10-28T09:08:00.000Z", to: "2026-10-28T09:10:00.000Z", why: "Drive back" }],
    history: [
      { version: 1, change: "saved", changeLabel: "Saved from the phone", enteredAt: "2026-10-28T12:00:00Z", enteredByEmail: "driver@example.com", reason: null, details: base, changes: [] },
      { version: 2, change: "corrected", changeLabel: "Corrected", enteredAt: "2026-10-29T08:00:00Z", enteredByEmail: "driver@example.com", reason: "Typed tonnes", details: base, changes: [{ field: "quantity", label: "Quantity (entered)", from: "5 t", to: "500 kg" }] },
    ],
    historyComplete: true,
    firstSummary: summary(1.2),
  };

  it("labels scope, both clocks, estimates, entered values, corrections and history", () => {
    const text = jobSummaryText(job);
    expect(text).toContain("One tractor job (0a8f4f9e-3d1c-4b7a-9c55-1f2e3d4c5b6a)");
    expect(text).toContain("Leaves out:");
    expect(text).toContain("(the phone's clock)");
    expect(text).toContain("(Tohyee's clock)");
    expect(text).toContain("Estimated from the track (not measured)");
    expect(text).toContain("Worked, as first saved: 1.20 ha");
    expect(text).toContain("Quantity: 500 kg");
    expect(text).toContain("Drive back");
    expect(text).toContain("Why: Typed tonnes");
    expect(text).toContain("Quantity (entered): 5 t → 500 kg");
    expect(text).toContain(TRACTOR_RECORD_NOTE);
    expect(text).not.toContain(EARLIER_EDITS_NOT_RECORDED);
  });

  it("says when earlier edits weren't recorded, and when a job is withdrawn", () => {
    const scope = exportScope({ ...job, historyComplete: false, status: "withdrawn", withdrawnReason: "Test run" }).join("\n");
    expect(scope).toContain(EARLIER_EDITS_NOT_RECORDED);
    expect(scope).toContain("WITHDRAWN: Test run");
  });

  it("never claims more than the record shows", () => {
    expect(TRACTOR_RECORD_NOTE).toMatch(/not a sensor/);
    expect(TRACTOR_RECORD_NOTE).toMatch(/not a finding/);
    expect(jobSummaryText(job)).not.toMatch(/\b(proves?|privileged|guarantee)\b/i);
  });
});
