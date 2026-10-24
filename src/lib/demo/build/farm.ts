import { addNotebookEntry } from "@/lib/ai-workspace/notebook";
import { approveBill, createBill } from "@/lib/bills/service";
import { addDistribution, addHolding, addMovement } from "@/lib/farming/coop-shares";
import { addCalendarItem } from "@/lib/farming/calendar";
import { setExpenseGroup, setYearFigures } from "@/lib/farming/benchmarks";
import { createPlan, linkPurchase, linkableBillLines, recordApplication, savePlanVersion, saveProduct } from "@/lib/farming/fertiliser";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addGrazing, addReading, addSupplement } from "@/lib/farming/pasture";
import { addSoilTest } from "@/lib/farming/soil";
import { addDays } from "@/lib/financial-year";
import { add, dec, type Decimal, divide, mul, roundHalfUp, toFixedString } from "@/lib/money/decimal";
import { type Books, COOP_NAME, plain } from "@/lib/demo/build/books";
import type { DemoContext } from "@/lib/demo/build/context";
import { averageCoverFor, dayOf, demoMonths, inMilk, lastDayOf } from "@/lib/demo/plan";

/*
 * The farm records (#437): two farms (the milking platform and a runoff)
 * with mapped paddocks, weekly farm walks, the cows' rotation, supplements,
 * fertiliser plans with applications and the bills behind them, soil tests,
 * co-op shares, the farm calendar, the notebook and the benchmark figures.
 * Made up throughout; the map is a tidy grid, not a real farm.
 */

type Paddock = { id: string; name: string; ha: string; farm: "home" | "runoff" };

const HOME_COLUMNS = 6;
const HOME_ROWS = 4;
const RUNOFF_COLUMNS = 4;
const RUNOFF_ROWS = 2;

function box(west: number, south: number, width: number, height: number) {
  const r = (value: number) => Math.round(value * 1e6) / 1e6;
  return {
    type: "Polygon",
    coordinates: [
      [
        [r(west), r(south)],
        [r(west + width), r(south)],
        [r(west + width), r(south + height)],
        [r(west), r(south + height)],
        [r(west), r(south)],
      ],
    ],
  };
}

export type Farm = { home: Paddock[]; runoff: Paddock[] };

/** A whole number of tenths as text, e.g. 84 -> "8.4". */
function tenths(value: number): string {
  return `${Math.floor(value / 10)}.${value % 10}`;
}

const total = (values: readonly Decimal[]) => values.reduce((sum, value) => add(sum, value), dec("0"));

export async function setUpFarm(ctx: DemoContext): Promise<Farm> {
  const made = `${Number(ctx.start.slice(0, 4)) - 6}-06-01`;
  return ctx.as(async (tx) => {
    await setFarmingEnabled(tx, { enabled: true });
    await saveFarm(tx, { name: "Home farm", notes: "The milking platform: 24 paddocks, about 210 ha effective." });
    const farms = await saveFarm(tx, { name: "Runoff", notes: "Young stock and winter grazing for the dry cows: 8 paddocks." });
    const homeId = farms.find((farm) => farm.name === "Home farm")!.id;
    const runoffId = farms.find((farm) => farm.name === "Runoff")!.id;
    ctx.ids.set("farm:home", homeId);
    ctx.ids.set("farm:runoff", runoffId);
    const farm: Farm = { home: [], runoff: [] };
    // Made-up coordinates in rolling country; each paddock about 9 ha (runoff 8 ha).
    for (let index = 0; index < HOME_COLUMNS * HOME_ROWS; index += 1) {
      const column = index % HOME_COLUMNS;
      const row = Math.floor(index / HOME_COLUMNS);
      const ha = tenths(84 + ((index * 7) % 9));
      const paddock = await addPaddock(tx, { farmId: homeId, name: String(index + 1), effectiveHa: ha, onDate: made, geometry: box(169.7 + column * 0.0047, -46.25 + row * 0.0023, 0.0046, 0.00227) });
      farm.home.push({ id: paddock.id, name: paddock.name, ha, farm: "home" });
    }
    for (let index = 0; index < RUNOFF_COLUMNS * RUNOFF_ROWS; index += 1) {
      const column = index % RUNOFF_COLUMNS;
      const row = Math.floor(index / RUNOFF_COLUMNS);
      const ha = tenths(72 + ((index * 3) % 6));
      const paddock = await addPaddock(tx, { farmId: runoffId, name: `R${index + 1}`, effectiveHa: ha, onDate: made, geometry: box(169.735 + column * 0.0043, -46.236 + row * 0.0024, 0.0042, 0.0023) });
      farm.runoff.push({ id: paddock.id, name: paddock.name, ha, farm: "runoff" });
    }
    const products = [
      { name: "Urea", nPct: "46" },
      { name: "Superphosphate", pPct: "9", sPct: "11" },
      { name: "Potash super 30%", pPct: "6.3", kPct: "15", sPct: "7.7" },
    ];
    let saved: Awaited<ReturnType<typeof saveProduct>> = [];
    for (const product of products) saved = await saveProduct(tx, product);
    for (const product of saved) ctx.ids.set(`product:${product.name}`, product.id);
    for (const [code, group] of [
      ["6200", "wages"],
      ["6210", "wages"],
      ["6400", "animal_health"],
      ["6410", "breeding"],
      ["6420", "farm_dairy"],
      ["6110", "electricity"],
      ["6430", "feed"],
      ["6440", "grazing"],
      ["6310", "fertiliser"],
      ["6320", "fertiliser"],
      ["6450", "regrassing"],
      ["6460", "weed_pest"],
      ["6120", "vehicles"],
      ["6160", "repairs"],
      ["6060", "freight"],
      ["6010", "administration"],
      ["6170", "administration"],
      ["6020", "administration"],
      ["6080", "insurance"],
      ["6470", "rates"],
    ] as const) {
      await setExpenseGroup(tx, { accountCode: code, group });
    }
    return farm;
  });
}

/** Where a paddock is in the cows' round on a day: 0 just grazed, near 1 next to be grazed. */
function phase(day: number, index: number, paddocks: number): number {
  return (((day + index) % paddocks) + paddocks) % paddocks / paddocks;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The month's farm work: farm walks (weekly while milking, fortnightly in
 * winter; the runoff monthly), the cows' grazing (one paddock a day on a
 * 24-day round), supplements fed, fertiliser bought and spread, soil tests in
 * February.
 */
export async function farmMonth(ctx: DemoContext, books: Books, farm: Farm, month: string): Promise<void> {
  const average = averageCoverFor(month);
  const milking = inMilk(month);
  const last = lastDayOf(month) < ctx.today ? lastDayOf(month) : addDays(ctx.today, -1);
  const coverOf = (date: string, index: number, count: number) => {
    const p = phase(daysBetween(ctx.start, date), index, count);
    return Math.max(900, Math.round(average - 650 + p * 1300 + (ctx.random() - 0.5) * 160));
  };

  // Farm walks.
  for (let day = 3; day <= 31; day += milking ? 7 : 14) {
    const date = dayOf(month, day);
    if (date > last || (day > 28 && date.slice(8, 10) !== String(day))) continue;
    await ctx.as(async (tx) => {
      for (const [index, paddock] of farm.home.entries()) {
        await addReading(tx, { paddockId: paddock.id, measuredOn: date, cover: coverOf(date, index, farm.home.length), method: "plate_meter" });
      }
    });
  }
  const runoffWalk = dayOf(month, 10);
  if (runoffWalk <= last) {
    await ctx.as(async (tx) => {
      for (const paddock of farm.runoff) {
        await addReading(tx, { paddockId: paddock.id, measuredOn: runoffWalk, cover: Math.round(average - 200 + (ctx.random() - 0.5) * 900), method: ctx.random() < 0.5 ? "visual" : "plate_meter" });
      }
    });
  }

  // Grazing: the milkers through the home farm one paddock a day; the dry cows on the runoff in winter.
  await ctx.as(async (tx) => {
    for (let day = 1; day <= 31; day += 1) {
      const date = dayOf(month, day);
      if (date.slice(8, 10) !== String(day).padStart(2, "0") || date > last) continue;
      if (milking) {
        const offset = daysBetween(ctx.start, date);
        const index = (((-offset) % farm.home.length) + farm.home.length) % farm.home.length;
        const paddock = farm.home[index];
        await addGrazing(tx, {
          paddockId: paddock.id,
          mob: "Milkers",
          head: 300,
          inOn: date,
          outOn: addDays(date, 1) < ctx.today ? addDays(date, 1) : undefined,
          preCover: average + 600 + ctx.whole(-120, 120),
          postCover: 1550 + ctx.whole(-80, 80),
        });
      } else if (day % 7 === 1) {
        const paddock = farm.runoff[Math.floor(daysBetween(ctx.start, date) / 7) % farm.runoff.length];
        const outOn = addDays(date, 6);
        await addGrazing(tx, { paddockId: paddock.id, mob: "Dry cows", head: 290, inOn: date, outOn: outOn < ctx.today ? outOn : undefined, preCover: average + 500, postCover: 1400, note: "Winter break with baleage" });
      }
    }
  });

  // Supplements, weekly.
  await ctx.as(async (tx) => {
    for (let day = 2; day <= 30; day += 7) {
      const date = dayOf(month, day);
      if (date > last) continue;
      const number = Number(month.slice(5, 7));
      if ([6, 7].includes(number)) {
        const bales = ctx.whole(18, 26);
        await addSupplement(tx, { farmId: ctx.id("farm:runoff"), fedOn: date, feed: "Baleage", quantity: String(bales), unit: "bales", kgDm: String(bales * 260), mob: "Dry cows" });
      } else if (milking) {
        const kg = ctx.whole(25, 55) * 100;
        await addSupplement(tx, { farmId: ctx.id("farm:home"), fedOn: date, feed: "Palm kernel", quantity: String(kg), unit: "kg_as_fed", kgDm: String(Math.round(kg * 0.9)), mob: "Milkers" });
        if ([1, 2, 3].includes(number) && day < 16) {
          const bales = ctx.whole(8, 14);
          await addSupplement(tx, { farmId: ctx.id("farm:home"), fedOn: date, feed: "Pasture silage", quantity: String(bales), unit: "bales", kgDm: String(bales * 240), mob: "Milkers" });
        }
      }
    }
  });

  await fertiliserMonth(ctx, books, farm, month);

  // Soil tests in February: a third of the home farm and three runoff paddocks.
  if (month.endsWith("-02") && dayOf(month, 15) < ctx.today) {
    await ctx.as(async (tx) => {
      const tested = [...farm.home.filter((_, index) => index % 3 === 0), ...farm.runoff.slice(0, 3)];
      for (const paddock of tested) {
        await addSoilTest(tx, {
          paddockId: paddock.id,
          sampledOn: dayOf(month, 15),
          lab: "Southern Soil Lab (made up)",
          labReference: `SSL-${month.replace("-", "")}-${paddock.name}`,
          depth: "0-75 mm",
          results: [
            { measure: "pH", value: tenths(ctx.whole(57, 63)) },
            { measure: "Olsen P", value: String(ctx.whole(paddock.farm === "home" ? 24 : 14, paddock.farm === "home" ? 40 : 26)), unit: "mg/L" },
            { measure: "Potassium (QTK)", value: String(ctx.whole(5, 11)) },
            { measure: "Sulphate sulphur", value: String(ctx.whole(7, 16)), unit: "mg/kg" },
            { measure: "Magnesium (QTMg)", value: String(ctx.whole(16, 32)) },
          ],
        });
      }
    });
  }
}

/**
 * Spring nitrogen (urea in September and October on the home farm) and
 * autumn maintenance (superphosphate in March on both farms): a plan each
 * season, the bill for the product linked to it, and every paddock's
 * application recorded; the spreading billed separately.
 */
async function fertiliserMonth(ctx: DemoContext, books: Books, farm: Farm, month: string): Promise<void> {
  const number = Number(month.slice(5, 7));
  const year = month.slice(0, 4);
  const payDay = dayOf(`${number === 12 ? Number(year) + 1 : year}-${String((number % 12) + 1).padStart(2, "0")}`, 20);
  const spreadOn = (index: number) => dayOf(month, 8 + (index % 3) * 6);
  const runs: Array<{ planKey: string; planName: string; farmKey: "home" | "both"; product: string; kgHa: string; price: string; buy: boolean }> = [];
  if (number === 9) runs.push({ planKey: `spring-${year}`, planName: `Spring nitrogen ${year}`, farmKey: "home", product: "Urea", kgHa: "30", price: "835.00", buy: true });
  if (number === 10) runs.push({ planKey: `spring-${year}`, planName: `Spring nitrogen ${year}`, farmKey: "home", product: "Urea", kgHa: "30", price: "835.00", buy: false });
  if (number === 3) runs.push({ planKey: `autumn-${year}`, planName: `Autumn maintenance ${year}`, farmKey: "both", product: "Superphosphate", kgHa: "350", price: "398.00", buy: true });
  for (const run of runs) {
    const paddocks = run.farmKey === "home" ? farm.home : [...farm.home, ...farm.runoff];
    const dates = paddocks.map((_, index) => spreadOn(index));
    if (dates.some((date) => date >= ctx.today)) continue;
    const productId = ctx.id(`product:${run.product}`);
    const tonnesOf = (paddock: Paddock) => toFixedString(roundHalfUp(divide(mul(dec(paddock.ha), dec(run.kgHa)), dec("1000"), 6), 3), 3);
    const homeTonnes = total(farm.home.map((paddock) => dec(tonnesOf(paddock))));
    const allTonnes = total(paddocks.map((paddock) => dec(tonnesOf(paddock))));
    const planned = run.planKey.startsWith("spring") ? "60" : run.kgHa;
    for (const farmKey of run.farmKey === "home" ? (["home"] as const) : (["home", "runoff"] as const)) {
      const key = `plan:${run.planKey}:${farmKey}`;
      if (!ctx.ids.has(key)) {
        await ctx.as(async (tx) => {
          const plan = await createPlan(tx, { farmId: ctx.id(`farm:${farmKey}`), name: farmKey === "home" ? run.planName : `${run.planName} (runoff)` });
          await savePlanVersion(tx, plan.id, {
            spreadingPerHa: "22.00",
            note: run.planKey.startsWith("spring") ? "Two rounds of 30 kg/ha after grazing" : "Maintenance P and S from the soil tests",
            lines: farm[farmKey].map((paddock) => ({ paddockId: paddock.id, productId, rateKgHa: planned, pricePerTonne: run.price })),
          });
          ctx.ids.set(key, plan.id);
        });
      }
    }
    if (run.buy) {
      // The product for the whole round (spring: both rounds), bought on the first spreading day.
      const tonnes = toFixedString(run.planKey.startsWith("spring") ? mul(allTonnes, dec("2")) : allTonnes, 3);
      await ctx.as(async (tx) => {
        const { bill: draft } = await createBill(tx, {
          idempotencyKey: ctx.key("fert"),
          contactId: ctx.id("contact:fert"),
          billDate: dates[0],
          dueDate: payDay,
          supplierInvoiceNumber: `CF-${month.replace("-", "")}`,
          amountsMode: "exclusive",
          lines: [{ description: `${run.product} (tonnes)`, quantity: tonnes, unitPrice: run.price, accountCode: "6310", taxCode: "GST" }],
        });
        const bill = (await approveBill(tx, draft.id, { idempotencyKey: ctx.key("approve"), approveDespiteWarnings: true })).bill;
        books.toPay.push({ kind: "bill", id: bill.id, payOn: payDay, amount: plain(bill.total), payee: "Coastal Fert Ltd" });
        const line = (await linkableBillLines(tx)).find((entry) => !entry.linked && entry.description === `${run.product} (tonnes)` && entry.billDate === dates[0]);
        if (line) await linkPurchase(tx, ctx.id(`plan:${run.planKey}:home`), { billLineId: line.id, productId, tonnes: run.farmKey === "home" ? tonnes : toFixedString(homeTonnes, 3) });
      });
    }
    await ctx.as(async (tx) => {
      for (const [index, paddock] of paddocks.entries()) {
        await recordApplication(tx, ctx.id(`plan:${run.planKey}:${paddock.farm}`), { paddockId: paddock.id, productId, appliedOn: dates[index], tonnes: tonnesOf(paddock) });
      }
      const hectares = total(paddocks.map((paddock) => dec(paddock.ha)));
      const { bill: draft } = await createBill(tx, {
        idempotencyKey: ctx.key("spread"),
        contactId: ctx.id("contact:spreader"),
        billDate: dates[dates.length - 1],
        dueDate: payDay,
        supplierInvoiceNumber: `KVS-${month.replace("-", "")}`,
        amountsMode: "exclusive",
        lines: [{ description: `Spreading ${run.product.toLowerCase()} (ha)`, quantity: toFixedString(hectares, 1), unitPrice: "22.00", accountCode: "6320", taxCode: "GST" }],
      });
      const bill = (await approveBill(tx, draft.id, { idempotencyKey: ctx.key("approve"), approveDespiteWarnings: true })).bill;
      books.toPay.push({ kind: "bill", id: bill.id, payOn: payDay, amount: plain(bill.total), payee: "Kaka Valley Spreading" });
    });
  }
}

/** The co-op shares: brought forward, then a dividend in April and October (the same as the bank receipts). */
export async function setUpCoopShares(ctx: DemoContext): Promise<void> {
  await ctx.as(async (tx) => {
    const holding = await addHolding(tx, { coopName: COOP_NAME, shareClass: "Ordinary shares", notes: "One share for each kg MS supplied (made up)." });
    await addMovement(tx, { holdingId: holding.id, date: addDays(ctx.start, -1), kind: "brought_forward", quantity: "110000", value: "396000.00", sourceReference: "Last year's schedule" });
    for (const month of demoMonths(ctx.start, ctx.today)) {
      const number = Number(month.slice(5, 7));
      const date = dayOf(month, 18);
      if ((number !== 4 && number !== 10) || date > ctx.today) continue;
      const amount = number === 4 ? "11000.00" : "16500.00";
      const credits = toFixedString(roundHalfUp(divide(mul(dec(amount), dec("28")), dec("72"), 6), 2), 2);
      await addDistribution(tx, { holdingId: holding.id, date, kind: "dividend", amount, imputationCredits: credits, sourceReference: number === 4 ? "Interim dividend statement" : "Final dividend statement" });
    }
  });
}

/** Benchmark figures for each finished season: milk solids from the co-op invoices, cows and hectares. */
export async function seasonFigures(ctx: DemoContext, yearEnd: string): Promise<void> {
  await ctx.as(async (tx) => {
    const supplied = await tx.query<{ kg: string | null }>(
      `select sum(l.quantity)::text as kg from sales_invoice_lines l join sales_invoices i on i.id = l.invoice_id
        where i.status = 'approved' and l.item_id = $1 and i.invoice_date between $2 and $3`,
      [ctx.id("item:milk"), addDays(`${Number(yearEnd.slice(0, 4)) - 1}-06-01`, 0), yearEnd],
    );
    const kg = supplied.rows[0].kg ? toFixedString(dec(supplied.rows[0].kg), 0) : null;
    await setYearFigures(tx, { yearEnd, effectiveHa: "210", peakCows: "302", ...(kg ? { milkSolidsKg: kg } : {}) });
  });
}

/** The calendar around today and the farm notebook. */
export async function calendarAndNotebook(ctx: DemoContext): Promise<void> {
  const on = (days: number) => addDays(ctx.today, days);
  await ctx.as(async (tx) => {
    const items: Array<{ date: string; title: string; kind: string; startTime?: string; farm?: "home" | "runoff"; notes?: string; repeat?: string }> = [
      { date: on(-5), title: "Herd test", kind: "animal_health", startTime: "05:30", farm: "home" },
      { date: on(-2), title: "Fence repairs on the runoff boundary", kind: "other", farm: "runoff" },
      { date: on(1), title: "Vet: pregnancy testing the heifers", kind: "animal_health", startTime: "08:00", farm: "runoff" },
      { date: on(2), title: "Palm kernel delivery (28 t)", kind: "delivery", farm: "home" },
      { date: on(4), title: "Staff meeting and roster", kind: "meeting", startTime: "13:00", repeat: "fortnightly" },
      { date: on(6), title: "Spray thistles in 7, 8 and 15", kind: "contractor", farm: "home" },
      { date: on(9), title: "Drench the R1 heifers", kind: "animal_health", farm: "runoff" },
      { date: on(12), title: "Co-op shareholders' meeting", kind: "meeting", startTime: "11:00", notes: "Made up: this is the demo farm." },
      { date: on(16), title: "Pay GST", kind: "deadline" },
      { date: on(20), title: "Truck booked: cull cows to the works", kind: "stock_movement", startTime: "07:00" },
      { date: on(27), title: "Discussion group at the neighbours'", kind: "meeting" },
    ];
    for (const item of items) {
      await addCalendarItem(tx, {
        date: item.date,
        title: item.title,
        kind: item.kind,
        ...(item.startTime ? { startTime: item.startTime } : {}),
        ...(item.farm ? { farmId: ctx.id(`farm:${item.farm}`) } : {}),
        ...(item.notes ? { notes: item.notes } : {}),
        ...(item.repeat ? { repeat: item.repeat, repeatUntil: on(120) } : {}),
      });
    }
    const notes: Array<{ category: string; title: string; body: string; happenedOn?: string }> = [
      { category: "goals", title: "400 kg MS a cow by 2028", body: "Better spring feeding and fewer empties: aim for a 10% empty rate or less." },
      { category: "goals", title: "Winter covers of 2,100 kg DM/ha", body: "Average cover on 1 August, so the cows calve onto enough grass." },
      { category: "history", title: "Bought the runoff", body: "The 60 ha runoff, for young stock and wintering the dry cows.", happenedOn: `${Number(ctx.start.slice(0, 4)) - 6}-05-15` },
      { category: "history", title: "New rotary shed", body: "40-bail rotary built; milking time down by an hour.", happenedOn: `${Number(ctx.start.slice(0, 4)) - 11}-06-01` },
      { category: "people", title: "Tama, herd manager", body: "Runs the herd and the roster. Keen on genetics; leads AI in October." },
      { category: "practices", title: "Spring rotation", body: "24-day round from mid-September; slow to 30 days if covers drop below 2,200." },
      { category: "places", title: "Wet paddocks", body: "14 and 15 pug in winter: graze them early, on-off in wet weather." },
    ];
    for (const note of notes) await addNotebookEntry(tx, note);
  });
}
