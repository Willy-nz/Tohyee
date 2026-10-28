import { randomUUID } from "node:crypto";
import { addCalendarItem } from "@/lib/farming/calendar";
import type { PaddockGeometry } from "@/lib/farming/geometry";
import { addGrazing, addReading } from "@/lib/farming/pasture";
import { addTractorEquipment, saveTractorJob } from "@/lib/farming/tractor";
import type { JobTrack, PackedPoint, TrackEvent } from "@/lib/farming/tractor-shared";
import { addDays } from "@/lib/financial-year";
import { dec, divide, mul, roundHalfUp, toFixedString } from "@/lib/money/decimal";
import type { DemoContext } from "@/lib/demo/build/context";
import type { Farm } from "@/lib/demo/build/farm";
import { averageCoverFor } from "@/lib/demo/plan";

/*
 * The farmer's workspace and tractor mode on the demo farm (#447, #472;
 * decisions 1043-1045): the heifers moving round the runoff so the map has
 * a mob in and paddocks grazed at different times, a part farm walk on the
 * runoff yesterday, jobs on the farm calendar this week, and finished
 * spreader jobs with GPS tracks over the paddocks' own boundaries, each
 * linked to its fertiliser application. The tracks are generated, not
 * driven: straight runs up and down the paddock at a tractor's speed, with
 * a little GPS wobble, headland turns with Working off, one run spread
 * twice (overlap) and a trip out to refill (Working off, paused).
 */

/** Recent mobs and readings so the map's colours vary on both farms. */
export async function farmWorkspace(ctx: DemoContext, farm: Farm): Promise<void> {
  const on = (days: number) => addDays(ctx.today, days);
  await ctx.as(async (tx) => {
    // The rising one-year heifers, a week a paddock round the runoff, in R-paddocks no other mob is in now.
    const open = await tx.query<{ paddock_id: string }>("select paddock_id::text from grazings where status = 'active' and out_on is null");
    const busy = new Set(open.rows.map((row) => row.paddock_id));
    const free = farm.runoff.filter((paddock) => !busy.has(paddock.id));
    const weeks = Math.min(5, free.length);
    for (let week = weeks - 1; week >= 0; week -= 1) {
      const paddock = free[(weeks - 1 - week) % free.length];
      const inOn = on(-(week * 7) - 3);
      const outOn = week === 0 ? undefined : addDays(inOn, 7);
      await addGrazing(tx, { paddockId: paddock.id, mob: "R1 heifers", head: 78, inOn, outOn, preCover: averageCoverFor(inOn.slice(0, 7)) + 300, postCover: outOn ? 1500 : undefined, note: "Heifers on the runoff" });
    }
    // A part farm walk on the runoff yesterday.
    for (const paddock of farm.runoff.slice(0, 4)) {
      await addReading(tx, { paddockId: paddock.id, measuredOn: on(-1), cover: averageCoverFor(on(-1).slice(0, 7)) - 150 + ctx.whole(-200, 250), method: "visual", note: "Quick look while shifting the heifers" });
    }
    // Jobs for this week on the farm calendar.
    for (const item of [
      { date: on(0), title: "Shift the heifers to the next runoff paddock", kind: "stock_movement", farm: "runoff" },
      { date: on(0), title: "Pre-start check: Quad bike 2 brakes", kind: "other", farm: "home", notes: "Out of use after a failed check (see Safety)." },
      { date: on(3), title: "Calibrate the spreader for the next round", kind: "other", farm: "home" },
      { date: on(5), title: "Pasture walk: home farm", kind: "other", startTime: "06:30", farm: "home" },
    ] as Array<{ date: string; title: string; kind: string; farm: "home" | "runoff"; startTime?: string; notes?: string }>) {
      await addCalendarItem(tx, { date: item.date, title: item.title, kind: item.kind, farmId: ctx.id(`farm:${item.farm}`), ...(item.startTime ? { startTime: item.startTime } : {}), ...(item.notes ? { notes: item.notes } : {}) });
    }
  });
}

// Tractor jobs ------------------------------------------------------------------------------------------

const EARTH = 6_371_008.8;

/** Milliseconds for a local time in New Zealand on a day (the offset found for that day, so daylight saving is right). */
function nzTime(date: string, hour: number, minute: number): number {
  const guess = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour, minute);
  const parts = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(guess));
  const shownHour = Number(parts.find((part) => part.type === "hour")!.value);
  const offsetHours = (shownHour - hour + 24) % 24;
  return guess - offsetHours * 3_600_000;
}

type Box = { west: number; south: number; east: number; north: number };

function boxOf(geometry: PaddockGeometry): Box {
  const ring = geometry.type === "Polygon" ? geometry.coordinates[0] : geometry.coordinates[0][0];
  const lons = ring.map((position) => position[0]);
  const lats = ring.map((position) => position[1]);
  return { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
}

/**
 * A spreading job's track over one paddock: runs east and west across it
 * `widthM` apart less a metre, Working on along each run and off on the
 * headland turns. `overlapRun` is spread twice; after `refillAfter` runs it
 * drives out to the gate to refill (paused there) and back.
 */
export function spreadingTrack(box: Box, start: number, random: () => number, options: { widthM: number; overlapRun?: number; refillAfter?: number }): JobTrack {
  const lat0 = (box.south + box.north) / 2;
  const metresPerLat = (Math.PI / 180) * EARTH;
  const metresPerLon = metresPerLat * Math.cos((lat0 * Math.PI) / 180);
  const wide = (box.east - box.west) * metresPerLon;
  const high = (box.north - box.south) * metresPerLat;
  const at = (x: number, y: number): [number, number] => [Math.round((box.west + x / metresPerLon) * 1e7) / 1e7, Math.round((box.south + y / metresPerLat) * 1e7) / 1e7];
  const points: PackedPoint[] = [];
  const events: TrackEvent[] = [{ t: start, kind: "start" }];
  let t = start;
  let working = false;
  let broken = false;
  const speed = 3.6; // m/s, about 13 km/h
  const fix = (x: number, y: number) => {
    const [lon, lat] = at(x + (random() - 0.5) * 0.8, y + (random() - 0.5) * 0.8);
    points.push([t, lon, lat, Math.round((3 + random() * 3) * 10) / 10, working ? 1 : 0, 0, Math.round(speed * 10) / 10, broken ? 1 : 0]);
    broken = false;
    t += 1000;
  };
  const drive = (x0: number, y0: number, x1: number, y1: number) => {
    const length = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.round(length / speed));
    for (let step = 1; step <= steps; step += 1) fix(x0 + ((x1 - x0) * step) / steps, y0 + ((y1 - y0) * step) / steps);
  };
  const toggle = (on: boolean) => {
    working = on;
    events.push({ t, kind: on ? "working_on" : "working_off" });
  };
  const spacing = options.widthM - 1;
  const margin = 4;
  const lanes: number[] = [];
  for (let y = options.widthM / 2; y < high - 2; y += spacing) lanes.push(Math.min(y, high - options.widthM / 2));
  // In from the gate in the south-west corner, Working off.
  let x = margin;
  let y = 0;
  fix(x, y);
  drive(x, y, margin, lanes[0]);
  y = lanes[0];
  const run = (index: number, eastward: boolean) => {
    const from = eastward ? margin : wide - margin;
    const to = eastward ? wide - margin : margin;
    if (x !== from || y !== lanes[index]) drive(x, y, from, lanes[index]);
    toggle(true);
    drive(from, lanes[index], to, lanes[index]);
    toggle(false);
    x = to;
    y = lanes[index];
  };
  let eastward = true;
  for (let index = 0; index < lanes.length; index += 1) {
    run(index, eastward);
    eastward = !eastward;
    if (options.overlapRun === index) {
      // Back over the same run: spread twice.
      run(index, eastward);
      eastward = !eastward;
    }
    if (options.refillAfter === index) {
      // Out to the gate to refill, Working off, paused while loading, and back.
      const backX = x;
      const backY = y;
      drive(x, y, margin, 0);
      events.push({ t, kind: "pause" });
      t += 9 * 60_000;
      events.push({ t, kind: "resume" });
      broken = true;
      fix(margin, 0);
      drive(margin, 0, backX, backY);
      x = backX;
      y = backY;
    }
  }
  drive(x, y, margin, 0);
  events.push({ t, kind: "finish" });
  return { version: 1, settings: [{ widthM: options.widthM, lateralM: 0, backM: 4, settingsId: null }], points, events };
}

/**
 * Finished spreader jobs for the latest day of spreading on the home farm:
 * up to three paddocks, each linked to its fertiliser application, with the
 * product and rate as entered.
 */
export async function tractorJobs(ctx: DemoContext): Promise<number> {
  const home = ctx.id("farm:home");
  const latest = await ctx.as((tx) =>
    tx.query<{ id: string; plan_id: string; paddock_id: string; applied_on: string; tonnes: string; treated_ha: string; product: string; geometry: PaddockGeometry }>(
      `select a.id::text, a.plan_id::text, a.paddock_id::text, a.applied_on::text, a.tonnes::text, a.treated_ha::text, fp.name as product,
              (select b.geometry from paddock_boundaries b where b.paddock_id = a.paddock_id order by b.id desc limit 1) as geometry
         from fertiliser_applications a join fertiliser_plans p on p.id = a.plan_id join fertiliser_products fp on fp.id = a.product_id
        where a.status = 'active' and p.farm_id = $1 and a.applied_on = (select max(x.applied_on) from fertiliser_applications x join fertiliser_plans y on y.id = x.plan_id where x.status = 'active' and y.farm_id = $1)
        order by a.paddock_id limit 3`,
      [home],
    ),
  );
  if (!latest.rows.length) return 0;
  return ctx.as(async (tx) => {
    const equipment = await addTractorEquipment(tx, { name: "Fertiliser spreader", kind: "spreader", widthM: "18", lateralM: "0", backM: "4", note: "Twin-disc, 18 m bout (made up)", safetyEquipmentId: ctx.ids.get("safety:spreader") ?? null });
    let made = 0;
    for (const [index, application] of latest.rows.entries()) {
      const start = nzTime(application.applied_on, 8 + index * 2, 15);
      const track = spreadingTrack(boxOf(application.geometry), start, ctx.random, { widthM: 18, overlapRun: index === 0 ? 5 : undefined, refillAfter: index === 0 ? 8 : index === 1 ? 6 : undefined });
      track.settings[0].settingsId = equipment.current?.id ?? null;
      const rate = toFixedString(roundHalfUp(divide(mul(dec(application.tonnes), dec("1000")), dec(application.treated_ha), 6), 1), 1);
      await saveTractorJob(tx, {
        id: randomUUID(),
        farmId: home,
        paddockIds: [application.paddock_id],
        operation: "spreading",
        equipmentId: equipment.id,
        track,
        product: application.product,
        declaredRate: rate,
        declaredRateUnit: "kg/ha",
        fertiliserPlanId: application.plan_id,
        fertiliserApplicationId: application.id,
        notes: index === 0 ? "Went over one run twice; refilled from the trailer at the gate." : null,
      });
      made += 1;
    }
    return made;
  });
}
