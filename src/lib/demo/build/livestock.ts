import { createAccount } from "@/lib/accounts/service";
import { approveBill, createBill } from "@/lib/bills/service";
import { addDays } from "@/lib/financial-year";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { headCount, recordCounts, recordMovement, setOpenings, updateLivestockSettings } from "@/lib/livestock/movements";
import { add, dec, mul, toFixedString } from "@/lib/money/decimal";
import { type Books, plain } from "@/lib/demo/build/books";
import type { DemoContext } from "@/lib/demo/build/context";
import { dayOf, seasonEnd } from "@/lib/demo/plan";

/*
 * The herd (#437): about 300 dairy cows with replacements, recorded as
 * livestock movements (births, sales, deaths, bulls bought and sold), with
 * the sales invoiced through the stock agent and each season's year-end
 * count matching the movements. Made up.
 */

/** Last season's closing head, before the 1 June ageing (rising two-year heifers become cows). */
const OPENINGS = [
  { classCode: "ma_cows", head: 232, perHead: "2100.00" },
  { classCode: "r2_heifers", head: 74, perHead: "1750.00" },
  { classCode: "r1_heifers", head: 78, perHead: "950.00" },
];

/** The value of the opening herd, for the opening balances. */
export function openingHerdValue(): string {
  return toFixedString(OPENINGS.reduce((sum, entry) => add(sum, mul(dec(String(entry.head)), dec(entry.perHead))), dec("0")), 2);
}

export async function setUpLivestock(ctx: DemoContext): Promise<void> {
  await ctx.as(async (tx) => {
    await updateLivestockSettings(tx, { enabled: true, firstYearStart: ctx.start });
    await setOpenings(tx, {
      lines: OPENINGS.map((entry) => ({ kind: "dairy_cattle", classCode: entry.classCode, head: entry.head, value: toFixedString(mul(dec(String(entry.head)), dec(entry.perHead)), 2) })),
    });
    await createAccount(tx, { code: "5200", name: "Livestock purchases", accountType: "direct_costs" });
  });
}

type Event = { day: number; type: "birth" | "sale" | "death" | "purchase"; classCode: string; head: [number, number]; perHead?: [number, number]; note: string };

/** The year's movements by month: calving July-August, mating bulls October-January, culls February-April. */
const EVENTS: Record<number, Event[]> = {
  7: [
    { day: 18, type: "birth", classCode: "r1_heifers", head: [38, 44], note: "Heifer calves kept as replacements" },
    { day: 18, type: "birth", classCode: "r1_steers_bulls", head: [66, 74], note: "Bull calves" },
    { day: 26, type: "sale", classCode: "r1_steers_bulls", head: [60, 64], perHead: [28, 42], note: "Bobby calves" },
  ],
  8: [
    { day: 14, type: "birth", classCode: "r1_heifers", head: [36, 42], note: "Heifer calves kept as replacements" },
    { day: 14, type: "birth", classCode: "r1_steers_bulls", head: [70, 78], note: "Bull calves" },
    { day: 22, type: "death", classCode: "r1_heifers", head: [1, 3], note: "Calf deaths" },
    { day: 28, type: "death", classCode: "ma_cows", head: [1, 2], note: "Down cow" },
  ],
  9: [{ day: 5, type: "sale", classCode: "r1_steers_bulls", head: [0, 0], perHead: [30, 45], note: "Last bobby calves" }],
  10: [{ day: 15, type: "purchase", classCode: "breeding_bulls", head: [4, 4], perHead: [2300, 2600], note: "Mating bulls" }],
  11: [{ day: 9, type: "death", classCode: "ma_cows", head: [1, 1], note: "Bloat" }],
  1: [{ day: 20, type: "sale", classCode: "breeding_bulls", head: [4, 4], perHead: [1650, 1900], note: "Mating bulls sold after mating" }],
  2: [{ day: 24, type: "sale", classCode: "ma_cows", head: [16, 22], perHead: [980, 1150], note: "Cull cows" }],
  3: [
    { day: 17, type: "sale", classCode: "ma_cows", head: [20, 26], perHead: [960, 1120], note: "Cull cows (empties)" },
    { day: 25, type: "death", classCode: "ma_cows", head: [1, 2], note: "Cow deaths" },
  ],
  4: [
    { day: 14, type: "sale", classCode: "ma_cows", head: [22, 28], perHead: [940, 1100], note: "Cull cows" },
    { day: 14, type: "sale", classCode: "r2_heifers", head: [4, 7], perHead: [1200, 1400], note: "Empty in-calf heifers" },
  ],
};

/** The month's movements, with sales invoiced through the agent (paid a week later) and bulls billed. */
export async function livestockMonth(ctx: DemoContext, books: Books, month: string): Promise<void> {
  const events = EVENTS[Number(month.slice(5, 7))] ?? [];
  for (const event of events) {
    const date = dayOf(month, event.day);
    if (date > ctx.today) continue;
    let head = ctx.whole(event.head[0], event.head[1]);
    if (event.type === "sale" && event.classCode === "r1_steers_bulls" && head === 0) {
      // The rest of the bull calves.
      const count = await ctx.as((tx) => headCount(tx, { yearEnd: seasonEnd(date) }));
      head = count.rows.find((row) => row.classCode === "r1_steers_bulls")?.closing ?? 0;
    }
    if (head <= 0) continue;
    const perHead = event.perHead ? ctx.money(event.perHead[0], event.perHead[1]) : null;
    const amount = perHead ? toFixedString(mul(dec(String(head)), dec(perHead)), 2) : null;
    await ctx.as((tx) =>
      recordMovement(tx, {
        idempotencyKey: ctx.key("livestock"),
        kind: "dairy_cattle",
        movementType: event.type,
        movementDate: date,
        classCode: event.classCode,
        head,
        ...(amount ? { amount } : {}),
        note: event.note,
      }),
    );
    if (event.type === "sale" && perHead) {
      const payOn = addDays(date, 7);
      const invoice = await ctx.as(async (tx) => {
        const { invoice: draft } = await createInvoice(tx, {
          idempotencyKey: ctx.key("stock-sale"),
          contactId: ctx.id("contact:agent"),
          invoiceDate: date,
          dueDate: payOn,
          reference: event.note,
          amountsMode: "exclusive",
          lines: [{ description: `${event.note}: ${head} head`, quantity: String(head), unitPrice: perHead, accountCode: "4020", taxCode: "GST" }],
        });
        return (await approveInvoice(tx, draft.id, { idempotencyKey: ctx.key("approve") })).invoice;
      });
      books.toPay.push({ kind: "invoice", id: invoice.id, payOn, amount: plain(invoice.total), payee: "Taieri Stock Agents Ltd" });
    }
    if (event.type === "purchase" && perHead) {
      const payOn = dayOf(month, 28);
      const bill = await ctx.as(async (tx) => {
        const { bill: draft } = await createBill(tx, {
          idempotencyKey: ctx.key("stock-buy"),
          contactId: ctx.id("contact:agent"),
          billDate: date,
          dueDate: payOn,
          supplierInvoiceNumber: `TSA-${month.replace("-", "")}-B`,
          amountsMode: "exclusive",
          lines: [{ description: `${event.note}: ${head} head`, quantity: String(head), unitPrice: perHead, accountCode: "5200", taxCode: "GST" }],
        });
        return (await approveBill(tx, draft.id, { idempotencyKey: ctx.key("approve"), approveDespiteWarnings: true })).bill;
      });
      books.toPay.push({ kind: "bill", id: bill.id, payOn, amount: plain(bill.total), payee: "Taieri Stock Agents Ltd" });
    }
  }
}

/** At a season's end, the herd counted: it agrees with the movements, so nothing is left to explain. */
export async function countHerd(ctx: DemoContext, yearEnd: string): Promise<void> {
  await ctx.as(async (tx) => {
    const count = await headCount(tx, { yearEnd });
    await recordCounts(tx, {
      countDate: yearEnd,
      lines: count.rows.filter((row) => row.closing > 0).map((row) => ({ kind: row.kind, classCode: row.classCode, head: row.closing })),
    });
  });
}
