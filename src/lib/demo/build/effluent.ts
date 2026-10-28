import type { DemoContext } from "@/lib/demo/build/context";
import type { Farm } from "@/lib/demo/build/farm";
import { addApplication, addDeferral, addPondReading, changeApplication } from "@/lib/effluent/log";
import { addSetup, addSystem, changeSetup } from "@/lib/effluent/setup";
import { addDays } from "@/lib/financial-year";
import type { PaddockGeometry } from "@/lib/farming/geometry";
import { safetyPeopleMap } from "@/lib/safety/people";

/*
 * Effluent on the demo farm (#487, decision 1079): the home farm's
 * effluent setup, entered through the same services a person uses, as the
 * demo farm's owner, so it's dated by the database like any effluent record
 * (decision 1040). Made up throughout: the consent number, the stream's
 * name and every figure. The consent starts from Otago Regional Council's
 * template, with made-up figures entered "from the consent", so the screens
 * show what a farm would see.
 */

async function box(ctx: DemoContext, paddockId: string): Promise<{ west: number; south: number; east: number; north: number }> {
  const row = await ctx.as((tx) => tx.query<{ geometry: PaddockGeometry }>("select geometry from paddock_boundaries where paddock_id = $1 order by paddock_boundaries.id desc limit 1", [paddockId]));
  const geometry = row.rows[0].geometry;
  const ring = geometry.type === "Polygon" ? geometry.coordinates[0] : geometry.coordinates[0][0];
  const lons = ring.map((position) => position[0]);
  const lats = ring.map((position) => position[1]);
  return { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
}

const r6 = (value: number) => Math.round(value * 1e6) / 1e6;
const at = (b: { west: number; south: number; east: number; north: number }, fx: number, fy: number): [number, number] => [r6(b.west + (b.east - b.west) * fx), r6(b.south + (b.north - b.south) * fy)];

/** A thin strip along a paddock's side, for a stream. */
function strip(b: { west: number; south: number; east: number; north: number }) {
  const ring = [at(b, 0.82, 0), at(b, 0.9, 0), at(b, 0.9, 1), at(b, 0.82, 1)];
  return { type: "Polygon", coordinates: [[...ring, ring[0]]] };
}

export async function farmEffluentSetup(ctx: DemoContext, farm: Farm): Promise<void> {
  const home = ctx.id("farm:home");
  const members = await safetyPeopleMap(ctx.organisation.id);
  const paddock = (name: string) => farm.home.find((entry) => entry.name === name)!.id;
  const shed = await box(ctx, paddock("1"));
  const creek = await box(ctx, paddock("14"));

  await ctx.as(async (tx) => {
    // The consent, from ORC's template, then the consent's own (made-up) figures.
    const consent = await addSetup(tx, "consents", { farmId: home, council: "orc", template: "orc", consentNumber: "RM00.000.000 (made up)", expiresOn: `${Number(ctx.today.slice(0, 4)) + 22}-06-30` });
    await changeSetup(tx, "consents", consent.recordId, { expectedVersion: consent.version, maxDepthMm: "25", maxRateMmPerHour: "10", returnPeriodDays: 10, storageM3: "2600", why: null });

    const pond = await addSetup(tx, "ponds", {
      farmId: home,
      name: "Main effluent pond",
      kind: "pond",
      capacityM3: "2800",
      fullAtMm: "2600",
      highAtMm: "2200",
      lowAtMm: "300",
      dailyInflowM3: "24",
      markers: [{ label: "Low", mm: "300" }, { label: "Medium", mm: "1300" }, { label: "Full", mm: "2600" }],
      point: at(shed, 0.15, 0.85),
      notes: "Synthetic lined, built 2019 (made up).",
    });
    ctx.ids.set("effluent:pond", pond.recordId);
    const sump = await addSetup(tx, "ponds", { farmId: home, name: "Yard sump", kind: "sump", capacityM3: "45", fullAtMm: "1500", highAtMm: "1300", point: at(shed, 0.1, 0.92) });
    ctx.ids.set("effluent:sump", sump.recordId);

    const shedBlock = await addSetup(tx, "blocks", { farmId: home, name: "Shed block", paddockIds: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].map(paddock), risk: "low", notes: "Free-draining silt loam (made up)." });
    const backBlock = await addSetup(tx, "blocks", { farmId: home, name: "Back block (tanker)", paddockIds: ["11", "12"].map(paddock), risk: "high", notes: "Tile drained: tanker only when it's dry (made up)." });
    ctx.ids.set("effluent:block:shed", shedBlock.recordId);
    ctx.ids.set("effluent:block:back", backBlock.recordId);

    await addSetup(tx, "zones", { farmId: home, name: "Kōwhai Stream (made up)", feature: "waterway", zone: strip(creek) });
    await addSetup(tx, "zones", { farmId: home, name: "Stock water bore", feature: "bore", point: at(shed, 0.9, 0.08) });
    await addSetup(tx, "zones", { farmId: home, name: "Neighbour's house", feature: "dwelling", point: at(shed, -0.8, 1.6), notes: "Over the boundary, beyond paddock 1 (made up)." });

    const irrigator = await addSystem(tx, { farmId: home, name: "Travelling irrigator", type: "travelling_irrigator", pondId: pond.recordId, blockIds: [shedBlock.recordId], settings: { flowM3PerHour: "18", wettedWidthM: "32", speedMPerHour: "60", rateMmPerHour: "9" }, shiftEveryHours: "12", serviceEveryMonths: 6, wofDue: `${ctx.today.slice(0, 4)}-12-15`, responsibleUserId: ctx.actor.userId }, members);
    ctx.ids.set("effluent:irrigator", irrigator.recordId);
    const pods = await addSystem(tx, { farmId: home, name: "Pods (K-line)", type: "pods", pondId: pond.recordId, blockIds: [shedBlock.recordId], settings: { rateMmPerHour: "4", pulsePercent: "50" }, shiftEveryHours: "8", checkEvery: "week", serviceEveryMonths: 12 }, members);
    ctx.ids.set("effluent:pods", pods.recordId);
    const tanker = await addSystem(tx, { farmId: home, name: "Slurry tanker", type: "slurry_tanker", pondId: pond.recordId, blockIds: [backBlock.recordId], settings: { tankM3: "11" }, serviceEveryMonths: 12 }, members);
    ctx.ids.set("effluent:tanker", tanker.recordId);
  });
}

/** An ISO time on a day (YYYY-MM-DD) at a New Zealand hour, never later than an hour ago. */
function nzTime(day: string, hour: number, minute = 0): string {
  // New Zealand is 12 or 13 hours ahead of UTC; 13 in summer. Near enough for made-up times: the exact hour isn't checked.
  const at = Date.parse(`${day}T00:00:00Z`) + (hour - 13) * 3_600_000 + minute * 60_000;
  return new Date(Math.min(at, Date.now() - 3_600_000)).toISOString();
}

/**
 * The last fortnight's effluent log on the home farm (decision 1089): the
 * pods shifted twice a day round the shed block, the travelling irrigator
 * on alternate days, one tanker run on the back block, a pond reading each
 * morning (rising after rain), two wet days stored, one run with a little
 * ponding, and the pods running now.
 */
export async function farmEffluentLog(ctx: DemoContext, farm: Farm): Promise<void> {
  const home = ctx.id("farm:home");
  const paddock = (name: string) => farm.home.find((entry) => entry.name === name)!.id;
  const shed = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
  const boxes = new Map<string, Awaited<ReturnType<typeof box>>>();
  for (const name of [...shed, "11", "13"]) boxes.set(name, await box(ctx, paddock(name)));
  const wet = new Set([addDays(ctx.today, -9), addDays(ctx.today, -8)]);
  let level = 900;
  await ctx.as(async (tx) => {
    for (let back = 14; back >= 1; back -= 1) {
      const day = addDays(ctx.today, -back);
      level += wet.has(day) ? 260 : -40 + ctx.whole(0, 30);
      await addPondReading(tx, { farmId: home, pondId: ctx.id("effluent:pond"), levelMm: String(level), readAt: nzTime(day, 6, 10), note: wet.has(day) ? "Before milking; heavy rain overnight" : "Before milking" });
      if (wet.has(day)) {
        await addDeferral(tx, { farmId: home, on: day, reason: "too_wet", note: "Boot prints filling with water; stored in the pond" });
        continue;
      }
      // Pods: two lines a day, round the shed block's paddocks.
      const name = shed[back % shed.length];
      const b = boxes.get(name)!;
      const start = await addApplication(tx, {
        farmId: home,
        systemId: ctx.id("effluent:pods"),
        blockId: ctx.id("effluent:block:shed"),
        startedAt: nzTime(day, 7),
        positions: [{ label: "Line 1", paddockId: paddock(name), point: [r6(b.west + (b.east - b.west) * 0.3), r6(b.south + (b.north - b.south) * 0.5)], movedAt: nzTime(day, 7) }],
        weather: back % 3 ? "Fine" : "Cloudy, light wind",
        soil: "Boot print dry",
      });
      const shifted = await changeApplication(tx, start.recordId, { step: "shift", expectedVersion: 1, position: { label: "Line 2", paddockId: paddock(name), point: [r6(b.west + (b.east - b.west) * 0.7), r6(b.south + (b.north - b.south) * 0.5)], movedAt: nzTime(day, 14) } });
      const ponded = back === 6;
      await changeApplication(tx, start.recordId, { step: "stop", expectedVersion: shifted.version, stoppedAt: nzTime(day, 19), ponding: ponded ? { result: "ponding", note: "Small puddle by the trough on line 2; turned it off 20 minutes early", checkedAt: nzTime(day, 19) } : { result: "none", checkedAt: nzTime(day, 19) } });
      level -= 60;
      // The travelling irrigator on paddock 13 twice, a week apart: the log shows it as sooner than the consent's 10 days.
      if (back === 10 || back === 3) {
        const p13 = boxes.get("13")!;
        await addApplication(tx, { farmId: home, systemId: ctx.id("effluent:irrigator"), paddockIds: [paddock("13")], startedAt: nzTime(day, 9), stoppedAt: nzTime(day, 12), positions: [{ label: "Run 2", paddockId: paddock("13"), point: [r6((p13.west + p13.east) / 2), r6(p13.south + (p13.north - p13.south) * 0.1)], movedAt: nzTime(day, 9) }], depthEnteredMm: "9", ponding: { result: "none", checkedAt: nzTime(day, 12) }, weather: "Fine" });
        level -= 50;
      }
      if (back === 4) {
        await addApplication(tx, { farmId: home, systemId: ctx.id("effluent:tanker"), blockId: ctx.id("effluent:block:back"), paddockIds: [paddock("11")], startedAt: nzTime(day, 10), stoppedAt: nzTime(day, 13), loads: 8, areaHa: "4.2", ponding: { result: "none", checkedAt: nzTime(day, 13) }, soil: "Dry on top; tiles not running" });
      }
    }
    // Today: a reading, and the pods running since this morning.
    await addPondReading(tx, { farmId: home, pondId: ctx.id("effluent:pond"), levelMm: String(level), readAt: nzTime(ctx.today, 6, 5), note: "Before milking" });
    const b = boxes.get(shed[0])!;
    await addApplication(tx, { farmId: home, systemId: ctx.id("effluent:pods"), blockId: ctx.id("effluent:block:shed"), startedAt: nzTime(ctx.today, 7), positions: [{ label: "Line 1", paddockId: paddock(shed[0]), point: [r6(b.west + (b.east - b.west) * 0.4), r6(b.south + (b.north - b.south) * 0.4)], movedAt: nzTime(ctx.today, 7) }], weather: "Fine" });
  });
}
