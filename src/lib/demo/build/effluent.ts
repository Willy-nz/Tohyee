import type { DemoContext } from "@/lib/demo/build/context";
import type { Farm } from "@/lib/demo/build/farm";
import { addSetup, addSystem, changeSetup } from "@/lib/effluent/setup";
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
    await changeSetup(tx, "consents", consent.recordId, { expectedVersion: consent.version, maxDepthMm: "25", maxRateMmPerHour: "10", returnPeriodDays: 14, storageM3: "2600", why: null });

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

    const shedBlock = await addSetup(tx, "blocks", { farmId: home, name: "Shed block", paddockIds: ["1", "2", "3", "4", "5"].map(paddock), risk: "low", notes: "Free-draining silt loam (made up)." });
    const backBlock = await addSetup(tx, "blocks", { farmId: home, name: "Back block (tanker)", paddockIds: ["11", "12"].map(paddock), risk: "high", notes: "Tile drained: tanker only when it's dry (made up)." });
    ctx.ids.set("effluent:block:shed", shedBlock.recordId);
    ctx.ids.set("effluent:block:back", backBlock.recordId);

    await addSetup(tx, "zones", { farmId: home, name: "Kōwhai Stream (made up)", feature: "waterway", zone: strip(creek) });
    await addSetup(tx, "zones", { farmId: home, name: "Stock water bore", feature: "bore", point: at(shed, 0.7, 0.2) });
    await addSetup(tx, "zones", { farmId: home, name: "Neighbour's house", feature: "dwelling", point: at(shed, 0.95, 0.05), notes: "Across the road boundary (made up)." });

    const irrigator = await addSystem(tx, { farmId: home, name: "Travelling irrigator", type: "travelling_irrigator", pondId: pond.recordId, blockIds: [shedBlock.recordId], settings: { flowM3PerHour: "18", wettedWidthM: "32", speedMPerHour: "60", rateMmPerHour: "9" }, shiftEveryHours: "12", serviceEveryMonths: 6, wofDue: `${ctx.today.slice(0, 4)}-12-15`, responsibleUserId: ctx.actor.userId }, members);
    ctx.ids.set("effluent:irrigator", irrigator.recordId);
    const pods = await addSystem(tx, { farmId: home, name: "Pods (K-line)", type: "pods", pondId: pond.recordId, blockIds: [shedBlock.recordId], settings: { rateMmPerHour: "4", pulsePercent: "50" }, shiftEveryHours: "8", checkEvery: "week", serviceEveryMonths: 12 }, members);
    ctx.ids.set("effluent:pods", pods.recordId);
    const tanker = await addSystem(tx, { farmId: home, name: "Slurry tanker", type: "slurry_tanker", pondId: pond.recordId, blockIds: [backBlock.recordId], settings: { tankM3: "11" }, serviceEveryMonths: 12 }, members);
    ctx.ids.set("effluent:tanker", tanker.recordId);
  });
}
