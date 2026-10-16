import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { recordSupplierPayment } from "@/lib/bills/payments";
import { approveBill, createBill } from "@/lib/bills/service";
import { listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine, suggestionsForLine } from "@/lib/bank/reconcile";
import { createBankTransaction } from "@/lib/bank/transactions";
import { createContact } from "@/lib/contacts/service";
import { refundCreditNote } from "@/lib/credit-notes/refunds";
import { refundOverpayment } from "@/lib/invoices/overpayments";
import { createItem } from "@/lib/items/service";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { applyCreditNote } from "@/lib/credit-notes/applications";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { recordPayment, voidPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, voidInvoice } from "@/lib/invoices/service";
import { postJournal } from "@/lib/ledger/journals";
import { closePeriod, periodChecklist } from "@/lib/ledger/period-close";
import { add, dec, type Decimal, divide, mul, neg, roundHalfUp, sub, toFixedString } from "@/lib/money/decimal";
import { recordPaymentBatch } from "@/lib/payments/batches";
import { fixedAssetRegister } from "@/lib/fixed-assets/register";
import { disposeFixedAsset, runDepreciation } from "@/lib/fixed-assets/runs";
import { createFixedAsset, createFixedAssetType } from "@/lib/fixed-assets/service";
import { agedPayables } from "@/lib/reports/aged-payables";
import { agedReceivables } from "@/lib/reports/aged-receivables";
import { balanceSheet, inventoryValuation, profitAndLoss, trialBalance } from "@/lib/reports/financial";
import { calculateGstReturn, fileGstReturn } from "@/lib/reports/gst-return";
import { cashFlowStatement } from "@/lib/reports/statements";
import { applySupplierCreditNote } from "@/lib/supplier-credit-notes/applications";
import { approveSupplierCreditNote, createSupplierCreditNote } from "@/lib/supplier-credit-notes/service";
import { createTestOrganisation, createTestUser, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/*
 * A year of a fictional business's trading pushed through Tohyee, with an
 * independent tally of what every account should be, to find bugs. Opt-in:
 * SIMULATION=1 (it takes a few minutes). SIMULATION_SEED changes the year.
 *
 * The tally works amounts out itself, with the same rules as the worked
 * examples: line amount = quantity x price x (1 - discount), rounded once;
 * GST per line, rounded half up (exclusive: 15% of the line; inclusive: 3/23).
 *
 * The year has: sales (some inclusive, discounted, zero-rated, exempt or stock),
 * voids, credit notes applied or refunded, part, over- and voided payments,
 * batch receipts and payments, bills and supplier credits, bank fees and
 * interest, accruals, a van bought, depreciated and sold, a US customer paid
 * at a different rate (invoice basis only: Tohyee refuses foreign-currency
 * invoices on the payments basis for now), monthly bank statement imports
 * reconciled line by line, GST returns every two months, and month-end closes.
 */

const run = process.env.SIMULATION === "1" && Boolean(process.env.TEST_DATABASE_URL);
const SEED = Number(process.env.SIMULATION_SEED ?? "20250401");
const BASIS = process.env.SIMULATION_BASIS === "payments" ? "payments" : "invoice";

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ZERO = dec("0");
const c2 = (value: Decimal) => toFixedString(roundHalfUp(value, 2), 2);
const plain = (text: string | null | undefined) => (text ?? "0").replace(/[,$\s]/g, "").replace(/^\((.*)\)$/, "-$1");

type Line = { description: string; quantity: string; unitPrice: string; accountCode: string; taxCode: "GST" | "ZERO" | "EXEMPT"; discountPercent?: string };
type Worked = { net: Decimal; gst: Decimal; total: Decimal; byAccount: Map<string, Decimal> };

function work(lines: Line[], mode: "exclusive" | "inclusive"): Worked {
  let net = ZERO;
  let gst = ZERO;
  const byAccount = new Map<string, Decimal>();
  for (const line of lines) {
    const gross = mul(dec(line.quantity), dec(line.unitPrice));
    const discounted = line.discountPercent ? mul(gross, sub(dec("1"), divide(dec(line.discountPercent), dec("100"), 10))) : gross;
    const amount = roundHalfUp(discounted, 2);
    let lineNet: Decimal;
    let lineGst: Decimal;
    if (line.taxCode !== "GST") {
      lineNet = amount;
      lineGst = ZERO;
    } else if (mode === "exclusive") {
      lineNet = amount;
      lineGst = roundHalfUp(mul(amount, dec("0.15")), 2);
    } else {
      lineGst = roundHalfUp(divide(mul(amount, dec("3")), dec("23"), 10), 2);
      lineNet = sub(amount, lineGst);
    }
    net = add(net, lineNet);
    gst = add(gst, lineGst);
    byAccount.set(line.accountCode, add(byAccount.get(line.accountCode) ?? ZERO, lineNet));
  }
  return { net, gst, total: add(net, gst), byAccount };
}

/** What every account should be, kept by the simulation itself (debits positive). */
class Tally {
  accounts = new Map<string, Decimal>();
  gstByPeriod = new Map<string, Decimal>();
  post(code: string, amount: Decimal) {
    this.accounts.set(code, add(this.accounts.get(code) ?? ZERO, amount));
  }
  gst(date: string, amount: Decimal) {
    const period = gstPeriodOf(date);
    this.gstByPeriod.set(period, add(this.gstByPeriod.get(period) ?? ZERO, amount));
  }
  get(code: string) {
    return this.accounts.get(code) ?? ZERO;
  }
}

/** Two-monthly GST periods for a March balance date: Apr-May, Jun-Jul, … */
function gstPeriodOf(date: string): string {
  const [year, month] = date.split("-").map(Number);
  const startMonth = month % 2 === 0 ? month : month - 1;
  const start = startMonth === 0 ? `${year - 1}-12` : `${year}-${String(startMonth).padStart(2, "0")}`;
  return start;
}

const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
const day = (year: number, month: number, d: number) => `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, 28)).padStart(2, "0")}`;

describe.skipIf(!run)("a year of trading, checked against an independent tally", () => {
  let server: TestServer;
  let owner: SessionUser;
  const org = "simulation-year";
  const as = <T>(work_: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work_);
  const problems: string[] = [];
  const note = (message: string) => {
    problems.push(message);
    console.log(`PROBLEM: ${message}`);
  };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("sim-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, org);
  }, 300_000);

  afterAll(async () => {
    await server?.teardown();
  });

  it("trades for a year and every figure ties out", async () => {
    const rand = random(SEED);
    const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)];
    const chance = (p: number) => rand() < p;
    const money = (min: number, max: number) => (min + rand() * (max - min)).toFixed(2);
    const tally = new Tally();
    // Every bank movement, for the bank statement the simulation imports each month.
    const movements: Array<{ date: string; amount: Decimal; payee: string }> = [];
    const cash = (date: string, amount: Decimal, payee: string) => {
      tally.post("1000", amount);
      movements.push({ date, amount, payee });
    };

    const contact = async (name: string, flags: Record<string, unknown>) => (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name, ...flags }))).contact;
    const customers: Awaited<ReturnType<typeof contact>>[] = [];
    for (const name of ["Aroha Cafe", "Kobe Kennels", "Tui Lane Gifts", "Harbour Vets", "Moana Studio", "Rata Boutique", "Kea Supplies Ltd", "Pohutukawa Hotel"]) customers.push(await contact(name, { isCustomer: true }));
    const suppliers: Awaited<ReturnType<typeof contact>>[] = [];
    for (const name of ["Clutha Clay", "Otago Freight", "Spark", "Contact Energy", "Southern Packaging", "Kiln Parts NZ"]) suppliers.push(await contact(name, { isSupplier: true }));

    const bankContact = await contact("ANZ", { isSupplier: true });
    if (BASIS === "payments") await as((tx) => updateOrganisationSettings(tx, { gstBasis: "payments" }));
    const mug = (
      await as((tx) =>
        createItem(tx, { idempotencyKey: key("item"), code: "MUG", name: "Mug", itemType: "stock", salePrice: "25.00", purchasePrice: "9.00", incomeAccountCode: "4000", salesTaxCode: "GST", purchaseAccountCode: "1400", purchaseTaxCode: "GST" }),
      )
    ).item;
    let mugsOnHand = 0;
    const vanType = (
      await as((tx) =>
        createFixedAssetType(tx, { idempotencyKey: key("type"), name: "Motor vehicles", assetAccountCode: "1640", accumulatedDepreciationAccountCode: "1650", depreciationExpenseAccountCode: "6300", method: "sl", rate: "20" }),
      )
    ).type;
    let vanId: string | null = null;
    const brooklyn = await contact("Brooklyn Clay Co", { isCustomer: true, currencyCode: "USD" });
    // Exchange differences on the US customer: realised gains and rounding together.
    let fxGain = ZERO;
    // What the van has cost overall: its price less what it sold for (the asset accounts, depreciation and any gain or loss together).
    let vanNet = ZERO;
    let stockBought = ZERO;
    let gstPaymentsBasisTolerance = ZERO;
    const bankId = (await as((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '1000'"))).rows[0].id;
    const salesAccounts = ["4000", "4000", "4000", "4100"];
    const costAccounts = ["6070", "6060", "6170", "6110", "6130", "6160"];

    type Open = { id: string; number: string; contactId: string; date: string; due: Decimal; gstShare?: Decimal };
    const openInvoices: Open[] = [];
    const openBills: Open[] = [];
    const filedPeriods: string[] = [];
    let documents = 0;
    let gstFormGap = ZERO;
    let gstReturned = ZERO;
    let statementBalance = ZERO;
    // Each document's GST and how much of it is settled, for the payments basis (GST counts as it's paid).
    const docs = new Map<string, { label: string; gst: Decimal; total: Decimal; settled: Decimal; sign: 1 | -1 }>();
    const settle = (id: string, amount: Decimal) => {
      const doc = docs.get(id);
      if (doc) doc.settled = add(doc.settled, amount);
    };
    const returnedByDoc = new Map<string, Decimal>();

    const saleLines = (): Line[] =>
      Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, index) => ({
        description: `Item ${index + 1}`,
        quantity: String(1 + Math.floor(rand() * 4)),
        unitPrice: money(5, 400),
        accountCode: pick(salesAccounts),
        taxCode: chance(0.85) ? "GST" : pick(["ZERO", "EXEMPT"] as const),
        ...(chance(0.15) ? { discountPercent: pick(["5", "10", "12.5"]) } : {}),
      }));

    for (let m = 0; m < 12; m += 1) {
      const year = m < 9 ? 2025 : 2026;
      const month = ((m + 3) % 12) + 1;
      const monthEnd = lastDay(year, month);

      // Sales: invoices, some inclusive, a few voided before payment.
      // Mugs bought for stock each month.
      {
        const quantity = 20 + Math.floor(rand() * 40);
        const price = money(7, 11);
        const date = day(year, month, 3);
        const net = roundHalfUp(mul(dec(String(quantity)), dec(price)), 2);
        const gst = roundHalfUp(mul(net, dec("0.15")), 2);
        const { bill: draft } = await as((tx) =>
          createBill(tx, { idempotencyKey: key("b"), contactId: suppliers[0].id, billDate: date, dueDate: date, supplierInvoiceNumber: key("M"), amountsMode: "exclusive", lines: [{ itemId: mug.id, quantity: String(quantity), unitPrice: price }] }),
        );
        const bill = (await as((tx) => approveBill(tx, draft.id, { idempotencyKey: key("a"), approveDespiteWarnings: true }))).bill;
        if (plain(bill.total) !== c2(add(net, gst))) note(`Stock bill ${bill.supplierInvoiceNumber}: Tohyee ${bill.total}, tally ${c2(add(net, gst))}`);
        mugsOnHand += quantity;
        stockBought = add(stockBought, net);
        tally.post("2000", neg(add(net, gst)));
        tally.post("2100", gst);
        tally.gst(date, neg(gst));
        openBills.push({ id: bill.id, number: bill.supplierInvoiceNumber!, contactId: suppliers[0].id, date, due: add(net, gst), gstShare: divide(gst, add(net, gst), 10) });
        docs.set(`bill:${bill.id}`, { label: `stock bill ${bill.supplierInvoiceNumber}`, gst, total: add(net, gst), settled: ZERO, sign: -1 });
      }

      // Entered in date order, as stock movements can't be backdated.
      const saleDays = Array.from({ length: 12 }, () => 4 + Math.floor(rand() * 24)).sort((x, y) => x - y);
      for (let n = 0; n < 12; n += 1) {
        const date = day(year, month, saleDays[n]);
        const customer = pick(customers);
        const mode = chance(0.2) ? "inclusive" : "exclusive";
        const lines = saleLines();
        const sent: Array<Record<string, unknown>> = [...lines];
        const mugs = mugsOnHand > 5 && chance(0.4) ? 1 + Math.floor(rand() * 4) : 0;
        if (mugs > 0) {
          lines.push({ description: "Mug", quantity: String(mugs), unitPrice: "25.00", accountCode: "4000", taxCode: "GST" });
          sent.push({ itemId: mug.id, quantity: String(mugs), unitPrice: "25.00" });
          mugsOnHand -= mugs;
        }
        const expected = work(lines, mode);
        const { invoice: draft } = await as((tx) =>
          createInvoice(tx, { idempotencyKey: key("i"), contactId: customer.id, invoiceDate: date, dueDate: date, amountsMode: mode, lines: sent }),
        );
        const invoice = (await as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("a") }))).invoice;
        documents += 1;
        if (plain(invoice.total) !== c2(expected.total) || plain(invoice.taxTotal) !== c2(expected.gst)) {
          note(`Invoice ${invoice.invoiceNumber} (${mode}): Tohyee ${invoice.total} GST ${invoice.taxTotal}, tally ${c2(expected.total)} GST ${c2(expected.gst)}`);
        }
        if (chance(0.03)) {
          await as((tx) => voidInvoice(tx, invoice.id, { idempotencyKey: key("v"), voidDate: date }));
          mugsOnHand += mugs;
          continue;
        }
        tally.post("1100", expected.total);
        for (const [code, amount] of expected.byAccount) tally.post(code, neg(amount));
        tally.post("2100", neg(expected.gst));
        tally.gst(date, expected.gst);
        openInvoices.push({ id: invoice.id, number: invoice.invoiceNumber!, contactId: customer.id, date, due: expected.total, gstShare: divide(expected.gst, expected.total, 10) });
        docs.set(`sales_invoice:${invoice.id}`, { label: `invoice ${invoice.invoiceNumber}`, gst: expected.gst, total: expected.total, settled: ZERO, sign: 1 });
      }

      // A credit note now and then, applied to an open invoice of that customer.
      if (chance(0.6) && openInvoices.length > 0) {
        const target = pick(openInvoices.filter((open) => open.due.toString() !== "0"));
        if (target) {
          const date = target.date > day(year, month, 15) ? target.date : day(year, month, 15);
          const lines: Line[] = [{ description: "Breakage", quantity: "1", unitPrice: money(5, 40), accountCode: "4000", taxCode: "GST" }];
          const expected = work(lines, "exclusive");
          if (expected.total.toString() !== "0" && Number(c2(expected.total)) <= Number(c2(target.due))) {
            const { creditNote: draft } = await as((tx) => createCreditNote(tx, { idempotencyKey: key("cn"), contactId: target.contactId, creditNoteDate: date, amountsMode: "exclusive", lines }));
            const note_ = (await as((tx) => approveCreditNote(tx, draft.id, { idempotencyKey: key("a") }))).creditNote;
            documents += 1;
            if (plain(note_.total) !== c2(expected.total)) note(`Credit note ${note_.creditNoteNumber}: Tohyee ${note_.total}, tally ${c2(expected.total)}`);
            docs.set(`sales_credit_note:${draft.id}`, { label: `credit note ${note_.creditNoteNumber}`, gst: expected.gst, total: expected.total, settled: ZERO, sign: -1 });
            tally.post("1100", neg(expected.total));
            tally.post("4000", expected.net);
            tally.post("2100", expected.gst);
            tally.gst(date, neg(expected.gst));
            if (chance(0.3)) {
              await as((tx) => refundCreditNote(tx, draft.id, { idempotencyKey: key("rf"), refundDate: date, amount: c2(expected.total), bankAccountCode: "1000" }));
              settle(`sales_credit_note:${draft.id}`, expected.total);
              cash(date, neg(expected.total), "Credit refund");
              tally.post("1100", expected.total);
            } else {
              await as((tx) => applyCreditNote(tx, draft.id, { idempotencyKey: key("ap"), applicationDate: date, applications: [{ invoiceId: target.id, amount: c2(expected.total) }] }));
              settle(`sales_credit_note:${draft.id}`, expected.total);
              settle(`sales_invoice:${target.id}`, expected.total);
              target.due = sub(target.due, expected.total);
            }
          }
        }
      }

      // Now and then a customer pays several invoices in one go.
      {
        const customer = pick(customers);
        const theirs = openInvoices.filter((open) => open.contactId === customer.id && Number(c2(open.due)) > 0);
        const date = day(year, month, 19);
        if (theirs.length > 1 && theirs.every((open) => open.date <= date) && chance(0.6)) {
          const total = theirs.reduce((sum, open) => add(sum, open.due), ZERO);
          await as((tx) =>
            recordPaymentBatch(tx, "customer", { idempotencyKey: key("rb"), paymentDate: date, amount: c2(total), bankAccountCode: "1000", documents: theirs.map((open) => ({ id: open.id, amount: c2(open.due) })) }),
          );
          if (BASIS === "payments") gstPaymentsBasisTolerance = add(gstPaymentsBasisTolerance, dec(String(0.01 * theirs.length)));
          for (const open of theirs) settle(`sales_invoice:${open.id}`, open.due);
          cash(date, total, customer.name);
          tally.post("1100", neg(total));
          for (const open of theirs) openInvoices.splice(openInvoices.indexOf(open), 1);
        }
      }

      // Customers pay: most in full, some in part, a few too much.
      for (const open of [...openInvoices]) {
        if (Number(c2(open.due)) <= 0 || !chance(0.7)) continue;
        const payDate = open.date > day(year, month, 20) ? open.date : day(year, month, 20 + Math.floor(rand() * 8));
        if (payDate > monthEnd) continue;
        const amount = chance(0.1) ? roundHalfUp(mul(open.due, dec("0.5")), 2) : chance(0.05) ? add(open.due, dec("10.00")) : open.due;
        const paid = await as((tx) => recordPayment(tx, open.id, { idempotencyKey: key("p"), paymentDate: payDate, amount: c2(amount), bankAccountCode: "1000" }));
        if (BASIS === "payments") gstPaymentsBasisTolerance = add(gstPaymentsBasisTolerance, dec("0.01"));
        if (chance(0.03)) {
          // Entered by mistake: voided the same day.
          await as((tx) => voidPayment(tx, open.id, paid.payment.id, { idempotencyKey: key("vp"), voidDate: payDate }));
          continue;
        }
        cash(payDate, amount, "Customer payment");
        tally.post("1100", neg(amount));
        settle(`sales_invoice:${open.id}`, Number(c2(amount)) > Number(c2(open.due)) ? open.due : amount);
        if (Number(c2(amount)) > Number(c2(open.due)) && chance(0.7)) {
          const extra = sub(amount, open.due);
          await as((tx) => refundOverpayment(tx, paid.payment.id, { idempotencyKey: key("rf"), refundDate: payDate, amount: c2(extra), bankAccountCode: "1000" }));
          cash(payDate, neg(extra), "Overpayment refund");
          tally.post("1100", extra);
        }
        open.due = sub(open.due, amount);
        if (Number(c2(open.due)) <= 0) openInvoices.splice(openInvoices.indexOf(open), 1);
      }

      // Bills, paid one at a time or several together.
      for (let n = 0; n < 8; n += 1) {
        const date = day(year, month, 1 + Math.floor(rand() * 27));
        const supplier = pick(suppliers);
        const lines: Line[] = Array.from({ length: 1 + Math.floor(rand() * 2) }, () => ({
          description: "Supplies",
          quantity: "1",
          unitPrice: money(20, 900),
          accountCode: pick(costAccounts),
          taxCode: chance(0.9) ? "GST" : "EXEMPT",
        }));
        const expected = work(lines, "exclusive");
        const { bill: draft } = await as((tx) =>
          createBill(tx, { idempotencyKey: key("b"), contactId: supplier.id, billDate: date, dueDate: date, supplierInvoiceNumber: key("S"), amountsMode: "exclusive", lines }),
        );
        const bill = (await as((tx) => approveBill(tx, draft.id, { idempotencyKey: key("a"), approveDespiteWarnings: true }))).bill;
        documents += 1;
        if (plain(bill.total) !== c2(expected.total)) note(`Bill ${bill.supplierInvoiceNumber}: Tohyee ${bill.total}, tally ${c2(expected.total)}`);
        tally.post("2000", neg(expected.total));
        for (const [code, amount] of expected.byAccount) tally.post(code, amount);
        tally.post("2100", expected.gst);
        tally.gst(date, neg(expected.gst));
        openBills.push({ id: bill.id, number: bill.supplierInvoiceNumber!, contactId: supplier.id, date, due: expected.total, gstShare: divide(expected.gst, expected.total, 10) });
        docs.set(`bill:${bill.id}`, { label: `bill ${bill.supplierInvoiceNumber}`, gst: expected.gst, total: expected.total, settled: ZERO, sign: -1 });
      }
      // A supplier credit note, applied.
      if (chance(0.5) && openBills.length > 0) {
        const target = pick(openBills);
        const lines: Line[] = [{ description: "Returned", quantity: "1", unitPrice: money(5, 50), accountCode: "6070", taxCode: "GST" }];
        const expected = work(lines, "exclusive");
        if (Number(c2(expected.total)) <= Number(c2(target.due))) {
          const date = target.date > day(year, month, 16) ? target.date : day(year, month, 16);
          const { creditNote: draft } = await as((tx) =>
            createSupplierCreditNote(tx, { idempotencyKey: key("scn"), contactId: target.contactId, creditNoteDate: date, supplierCreditNoteNumber: key("SCN"), amountsMode: "exclusive", lines }),
          );
          await as((tx) => approveSupplierCreditNote(tx, draft.id, { idempotencyKey: key("a") }));
          docs.set(`supplier_credit_note:${draft.id}`, { label: `supplier credit note`, gst: expected.gst, total: expected.total, settled: expected.total, sign: 1 });
          settle(`bill:${target.id}`, expected.total);
          documents += 1;
          tally.post("2000", expected.total);
          tally.post("6070", neg(expected.net));
          tally.post("2100", neg(expected.gst));
          tally.gst(date, expected.gst);
          await as((tx) => applySupplierCreditNote(tx, draft.id, { idempotencyKey: key("ap"), applicationDate: date, applications: [{ billId: target.id, amount: c2(expected.total) }] }));
          target.due = sub(target.due, expected.total);
        }
      }
      // Pay suppliers: one batch per supplier for bills from earlier in the month, the rest single payments.
      const payDay = day(year, month, 28);
      for (const supplier of suppliers) {
        const theirs = openBills.filter((open) => open.contactId === supplier.id && open.date <= payDay && Number(c2(open.due)) > 0);
        if (theirs.length === 0 || !chance(0.75)) continue;
        if (theirs.length > 1 && chance(0.5)) {
          const total = theirs.reduce((sum, open) => add(sum, open.due), ZERO);
          await as((tx) =>
            recordPaymentBatch(tx, "supplier", { idempotencyKey: key("batch"), paymentDate: payDay, amount: c2(total), bankAccountCode: "1000", documents: theirs.map((open) => ({ id: open.id, amount: c2(open.due) })) }),
          );
          cash(payDay, neg(total), supplier.name);
          tally.post("2000", total);
          for (const open of theirs) settle(`bill:${open.id}`, open.due);
        } else {
          for (const open of theirs) {
            await as((tx) => recordSupplierPayment(tx, open.id, { idempotencyKey: key("sp"), paymentDate: payDay, amount: c2(open.due), bankAccountCode: "1000" }));
            cash(payDay, neg(open.due), supplier.name);
            tally.post("2000", open.due);
            settle(`bill:${open.id}`, open.due);
          }
        }
        for (const open of theirs) {
          open.due = ZERO;
          openBills.splice(openBills.indexOf(open), 1);
        }
      }

      // Spend and receive money straight from the bank.
      const fee = money(5, 40);
      await as((tx) =>
        createBankTransaction(tx, { idempotencyKey: key("bt"), kind: "spend", accountId: bankId, contactId: bankContact.id, date: day(year, month, 27), amountsMode: "no_tax", lines: [{ description: "Bank fees", accountCode: "6020", amount: fee }] }),
      );
      cash(day(year, month, 27), neg(dec(fee)), "Bank fees");
      tally.post("6020", dec(fee));
      const interest = money(1, 15);
      await as((tx) =>
        createBankTransaction(tx, { idempotencyKey: key("bt"), kind: "receive", accountId: bankId, contactId: bankContact.id, date: monthEnd, amountsMode: "no_tax", lines: [{ description: "Interest", accountCode: "4200", amount: interest }] }),
      );
      cash(monthEnd, dec(interest), "Interest");
      tally.post("4200", neg(dec(interest)));
      // A US customer: zero-rated export invoiced in USD on the 10th, paid in full into the NZD account on the 25th at that day's rate.
      // Not on the payments basis: Tohyee refuses foreign-currency invoices there for now.
      if (BASIS === "invoice") {
        const date = day(year, month, 10);
        const rate = (1.6 + rand() * 0.15).toFixed(4);
        const lines: Line[] = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ({ description: "Export order", quantity: String(1 + Math.floor(rand() * 5)), unitPrice: money(40, 300), accountCode: "4000", taxCode: "ZERO" }));
        const foreign = work(lines, "exclusive");
        // Each line converted at the invoice's rate and rounded (MC2).
        let base = ZERO;
        for (const line of lines) base = add(base, roundHalfUp(mul(roundHalfUp(mul(dec(line.quantity), dec(line.unitPrice)), 2), dec(rate)), 2));
        const { invoice: draft } = await as((tx) =>
          createInvoice(tx, { idempotencyKey: key("i"), contactId: brooklyn.id, invoiceDate: date, dueDate: date, amountsMode: "exclusive", lines, exchangeRate: rate }, { foreignCurrency: true }),
        );
        const invoice = (await as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("a") }))).invoice;
        documents += 1;
        if (plain(invoice.total) !== c2(foreign.total) || plain(invoice.baseTotal) !== c2(base)) note(`USD invoice ${invoice.invoiceNumber}: Tohyee ${invoice.total} USD (NZD ${invoice.baseTotal}), tally ${c2(foreign.total)} USD (NZD ${c2(base)}) at ${rate}`);
        tally.post("1100", base);
        tally.post("4000", neg(base));
        const payDate = day(year, month, 25);
        const payRate = (1.6 + rand() * 0.15).toFixed(4);
        await as((tx) => recordPayment(tx, invoice.id, { idempotencyKey: key("p"), paymentDate: payDate, amount: c2(foreign.total), bankAccountCode: "1000", exchangeRate: payRate }));
        const received = roundHalfUp(mul(foreign.total, dec(payRate)), 2);
        cash(payDate, received, "Brooklyn Clay Co");
        tally.post("1100", neg(base));
        fxGain = add(fxGain, sub(received, base));
      }

      // A van bought in May (registered as a fixed asset), sold the next February.
      if (year === 2025 && month === 5) {
        const date = "2025-05-12";
        const { bill: draft } = await as((tx) =>
          createBill(tx, { idempotencyKey: key("b"), contactId: suppliers[5].id, billDate: date, dueDate: date, supplierInvoiceNumber: key("VAN"), amountsMode: "exclusive", lines: [{ description: "Van", quantity: "1", unitPrice: "24000.00", accountCode: "1640", taxCode: "GST" }] }),
        );
        await as((tx) => approveBill(tx, draft.id, { idempotencyKey: key("a"), approveDespiteWarnings: true }));
        await as((tx) => recordSupplierPayment(tx, draft.id, { idempotencyKey: key("sp"), paymentDate: date, amount: "27600.00", bankAccountCode: "1000" }));
        docs.set(`bill:${draft.id}`, { label: "van bill", gst: dec("3600.00"), total: dec("27600.00"), settled: dec("27600.00"), sign: -1 });
        cash(date, dec("-27600.00"), "Southern Motors");
        tally.post("2100", dec("3600.00"));
        tally.gst(date, dec("-3600.00"));
        vanNet = dec("24000.00");
        vanId = (await as((tx) => createFixedAsset(tx, { idempotencyKey: key("asset"), name: "Van", typeId: vanType.id, purchaseDate: date, cost: "24000.00" }))).asset.id;
      }
      if (year === 2026 && month === 2 && vanId) {
        const date = "2026-02-20";
        const sale = await as((tx) =>
          createBankTransaction(tx, { idempotencyKey: key("bt"), kind: "receive", accountId: bankId, contactId: bankContact.id, date, amountsMode: "exclusive", lines: [{ description: "Van sold", accountCode: "1640", amount: "20000.00", taxCode: "GST" }] }),
        );
        docs.set(`bank_transaction:${sale.bankTransaction.id}`, { label: "van sale", gst: dec("3000.00"), total: dec("23000.00"), settled: dec("23000.00"), sign: 1 });
        cash(date, dec("23000.00"), "Van buyer");
        tally.post("2100", dec("-3000.00"));
        tally.gst(date, dec("3000.00"));
        vanNet = sub(vanNet, dec("20000.00"));
        await as((tx) => disposeFixedAsset(tx, vanId!, { idempotencyKey: key("dispose"), disposalDate: date, proceeds: "20000.00", proceedsAccountCode: "1640" }));
      }
      await as((tx) => runDepreciation(tx, { idempotencyKey: key("run"), periodEnd: monthEnd }));

      // A month-end accrual and its reversal next month.
      const accrual = money(100, 500);
      await as((tx) => postJournal(tx, { idempotencyKey: key("j"), postingDate: monthEnd, reference: "Accrual", lines: [{ accountCode: "6010", debitAmount: accrual }, { accountCode: "2300", creditAmount: accrual }] }));
      tally.post("6010", dec(accrual));
      tally.post("2300", neg(dec(accrual)));

      // The month's bank statement, imported and reconciled line by line.
      {
        const theMonth = movements.filter((movement) => movement.date.slice(0, 7) === monthEnd.slice(0, 7)).sort((x, y) => x.date.localeCompare(y.date));
        const rows = ["Date,Amount,Payee,Balance"];
        for (const movement of theMonth) {
          statementBalance = add(statementBalance, movement.amount);
          const [y, mo, d] = movement.date.split("-");
          rows.push(`${d}/${mo}/${y},${c2(movement.amount)},${movement.payee},${c2(statementBalance)}`);
        }
        if (theMonth.length > 0) {
          const bank = (await as((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
          await as((tx) => importStatementFile(tx, bank.id, { idempotencyKey: key("st"), fileName: `statement-${monthEnd}.csv`, fileBase64: Buffer.from(rows.join("\n") + "\n").toString("base64") }));
          const lines = (await as((tx) => listStatementLines(tx, bank.id, { status: "unreconciled", limit: 500 }))).lines;
          for (const line of lines) {
            const suggestions = await as((tx) => suggestionsForLine(tx, line.id));
            const match = suggestions.matches.find((candidate) => candidate.exact && !candidate.voided);
            if (!match) {
              note(`${line.date} statement line ${line.amount} ${line.payee ?? line.description}: no exact match suggested (${suggestions.matches.length} candidates)`);
              continue;
            }
            await as((tx) => reconcileStatementLine(tx, line.id, { idempotencyKey: key("rec"), kind: "match", journalLineIds: [match.journalLineId] }));
          }
        }
      }

      // GST every two months, then close the month.
      if (month % 2 === 1) {
        const period = gstPeriodOf(monthEnd);
        const periodStart = `${period}-01`;
        const report = await as((tx) => calculateGstReturn(tx, { periodStart, periodEnd: monthEnd }));
        const expected = c2(tally.gstByPeriod.get(period) ?? ZERO);
        // The form works GST out from totals (x 3/23), so box 15 can differ by cents from the GST actually charged; that's shown separately.
        const actualGst = sub(dec(plain(report.gstOnTransactions.sales)), dec(plain(report.gstOnTransactions.purchases)));
        if (report.basis !== BASIS) note(`GST basis is ${report.basis}, expected ${BASIS}`);
        gstReturned = add(gstReturned, actualGst);
        for (const line of report.lines) {
          const id = `${line.documentType}:${line.documentId}`;
          const signed = line.side === "sales" ? dec(plain(line.gst)) : neg(dec(plain(line.gst)));
          returnedByDoc.set(id, add(returnedByDoc.get(id) ?? ZERO, signed));
        }
        if (BASIS === "invoice" && c2(actualGst) !== expected) note(`GST ${periodStart} to ${monthEnd}: GST on transactions ${c2(actualGst)}, tally ${expected}`);
        const formGap = sub(dec(plain(report.boxes.box15)), dec(expected));
        if (BASIS === "invoice" && (Number(c2(formGap)) > 0.5 || Number(c2(formGap)) < -0.5)) note(`GST ${periodStart} to ${monthEnd}: box 15 ${report.boxes.box15} is ${c2(formGap)} from the GST charged (${expected})`);
        gstFormGap = add(gstFormGap, formGap);
        await as((tx) => fileGstReturn(tx, { idempotencyKey: key("gst"), periodStart, periodEnd: monthEnd }));
        filedPeriods.push(period);
      }
      const checklist = await as((tx) => periodChecklist(tx, { periodEnd: monthEnd }));
      for (const check of checklist.checks) {
        if (["receivables", "payables", "bank", "depreciation"].includes(check.key) && check.status !== "pass" && !(check.key === "depreciation" && check.status === "not_applicable")) {
          note(`${monthEnd} ${check.key}: ${check.status}: ${check.summary} ${check.items.map((item) => item.detail).join("; ")}`);
        }
      }
      try {
        await as((tx) => closePeriod(tx, "owner", { periodEnd: monthEnd, acknowledgeWarnings: true }));
      } catch (error) {
        note(`Closing ${monthEnd}: ${(error as Error).message}`);
      }

      // Every ledger account against the tally, at the month end.
      const ledger = await as((tx) =>
        tx.query<{ code: string; balance: string }>(
          `select a.code, coalesce(sum(l.debit_amount - l.credit_amount), 0)::numeric(18,2)::text as balance
             from accounts a left join ledger_journal_lines l on l.account_id = a.id
             left join ledger_journals j on j.id = l.journal_id
            where j.posting_date is null or j.posting_date <= $1
            group by a.code`,
          [monthEnd],
        ),
      );
      const actual = new Map(ledger.rows.map((row) => [row.code, row.balance]));
      const fxLedger = ["7020", "7050"].reduce((sum, code) => add(sum, dec(actual.get(code) ?? "0")), ZERO);
      if (c2(neg(fxLedger)) !== c2(fxGain)) note(`${monthEnd} exchange gains ${c2(neg(fxLedger))}, tally ${c2(fxGain)}`);
      const vanLedger = ["1640", "1650", "6300", "7030", "7040"].reduce((sum, code) => add(sum, dec(actual.get(code) ?? "0")), ZERO);
      if (c2(vanLedger) !== c2(vanNet)) note(`${monthEnd} van accounts together ${c2(vanLedger)}, what it cost less what it sold for ${c2(vanNet)}`);
      const register = await as((tx) => fixedAssetRegister(tx, { asOf: monthEnd }));
      if (!register.ties) note(`${monthEnd} fixed asset register doesn't tie to the ledger: ${JSON.stringify(register.ledger)}`);
      const stockLedger = add(dec(actual.get("1400") ?? "0"), dec(actual.get("5000") ?? "0"));
      if (c2(stockLedger) !== c2(stockBought)) note(`${monthEnd} inventory plus cost of sales ${c2(stockLedger)}, stock bought ${c2(stockBought)}`);
      for (const code of new Set([...tally.accounts.keys(), ...actual.keys()])) {
        if (["1400", "5000", "1640", "1650", "6300", "7030", "7040", "7020", "7050"].includes(code)) continue;
        // On the payments basis GST moves when paid: the GST account is checked at the year end only.
        if (BASIS === "payments" && code === "2100") continue;
        const want = c2(tally.get(code));
        const got = actual.get(code) ?? "0.00";
        if (want !== got) note(`${monthEnd} account ${code}: ledger ${got}, tally ${want}`);
      }
    }

    // Year end: reports agree with the ledger and with each other.
    const yearEnd = "2026-03-31";
    const tb = await as((tx) => trialBalance(tx, { asAt: yearEnd }));
    const tbJson = JSON.stringify(tb);
    const tbRows = (tb as unknown as { rows: Array<{ code: string; debit: string; credit: string }> }).rows;
    const tbDebits = tbRows.reduce((sum, row) => add(sum, dec(plain(row.debit))), ZERO);
    const tbCredits = tbRows.reduce((sum, row) => add(sum, dec(plain(row.credit))), ZERO);
    if (c2(tbDebits) !== c2(tbCredits)) note(`Trial balance doesn't balance: debits ${c2(tbDebits)}, credits ${c2(tbCredits)}`);
    const ledgerAt = async (code: string, asAt: string) =>
      dec(
        (
          await as((tx) =>
            tx.query<{ b: string }>(
              "select coalesce(sum(l.debit_amount - l.credit_amount), 0)::numeric(18,2)::text as b from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id join accounts a on a.id = l.account_id where a.code = $1 and j.posting_date <= $2",
              [code, asAt],
            ),
          )
        ).rows[0].b,
      );
    const stock = await as((tx) => inventoryValuation(tx));
    const stockTotal = plain(stock.totalValue);
    const mugsCounted = stock.items.find((item) => item.itemCode === "MUG")?.quantity ?? "0";
    if (Number(mugsCounted) !== mugsOnHand) note(`Mugs on hand: Tohyee ${mugsCounted}, tally ${mugsOnHand}`);
    if (stockTotal !== c2(await ledgerAt("1400", "2099-12-31"))) note(`Inventory valuation ${stockTotal}, inventory account ${c2(await ledgerAt("1400", "2099-12-31"))}`);
    const cogs = await ledgerAt("5000", yearEnd);
    if (BASIS === "payments") {
      // GST returned over the year = all GST charged less claimed, less the GST in what customers still owe (and suppliers are still owed).
      let charged = ZERO;
      for (const amount of tally.gstByPeriod.values()) charged = add(charged, amount);
      let unpaid = ZERO;
      for (const open of openInvoices) unpaid = add(unpaid, mul(open.due, open.gstShare ?? ZERO));
      for (const open of openBills) unpaid = sub(unpaid, mul(open.due, open.gstShare ?? ZERO));
      const gap = sub(gstReturned, sub(charged, unpaid));
      for (const [id, doc] of docs) {
        const expectedDoc = mul(roundHalfUp(divide(mul(doc.gst, doc.settled), doc.total, 10), 2), dec(String(doc.sign)));
        const got = returnedByDoc.get(id) ?? ZERO;
        if (Math.abs(Number(c2(sub(got, expectedDoc)))) > 0.02) note(`Payments basis: ${doc.label} (${id}): GST returned ${c2(got)}, expected ${c2(expectedDoc)} (GST ${c2(doc.gst)}, settled ${c2(doc.settled)} of ${c2(doc.total)})`);
      }
      for (const id of returnedByDoc.keys()) if (!docs.has(id) && c2(returnedByDoc.get(id)!) !== "0.00") note(`Payments basis: GST returned for ${id}, which the simulation didn't make: ${c2(returnedByDoc.get(id)!)}`);
      if (Math.abs(Number(c2(gap))) > 0.05 * (openInvoices.length + openBills.length + 1)) note(`Payments basis: GST returned ${c2(gstReturned)}, charged less claimed ${c2(charged)}, unpaid share ${c2(unpaid)}: ${c2(gap)} unexplained`);
      const gstLedger = c2(await ledgerAt("2100", yearEnd));
      if (gstLedger !== c2(tally.get("2100"))) note(`Payments basis: GST account ${gstLedger}, tally (all GST charged and claimed) ${c2(tally.get("2100"))}`);
    }
    const pl = await as((tx) => profitAndLoss(tx, { from: "2025-04-01", to: yearEnd }));
    let income = ZERO;
    for (const [code, amount] of tally.accounts) if (/^[4-7]/.test(code)) income = sub(income, amount);
    income = sub(income, cogs);
    for (const code of ["6300", "7030", "7040", "7020", "7050"]) income = sub(income, await ledgerAt(code, yearEnd));
    if (plain(pl.netProfit) !== c2(income)) note(`Net profit: P&L ${pl.netProfit}, tally ${c2(income)}`);
    let monthly = ZERO;
    for (let m = 0; m < 12; m += 1) {
      const year = m < 9 ? 2025 : 2026;
      const month = ((m + 3) % 12) + 1;
      const part = await as((tx) => profitAndLoss(tx, { from: `${year}-${String(month).padStart(2, "0")}-01`, to: lastDay(year, month) }));
      monthly = add(monthly, dec(plain(part.netProfit)));
    }
    if (c2(monthly) !== plain(pl.netProfit)) note(`Twelve monthly P&Ls add to ${c2(monthly)}, the year's says ${pl.netProfit}`);
    const bs = await as((tx) => balanceSheet(tx, { asAt: yearEnd }));
    const bsJson = JSON.stringify(bs);
    const ar = await as((tx) => agedReceivables(tx, { asAt: yearEnd }));
    const ap = await as((tx) => agedPayables(tx, { asAt: yearEnd }));
    const arTotal = plain((ar as unknown as { total?: { total?: string }; totals?: { total?: string } }).totals?.total ?? (ar as unknown as { total?: { total?: string } }).total?.total);
    const apTotal = plain((ap as unknown as { totals?: { total?: string }; total?: { total?: string } }).totals?.total ?? (ap as unknown as { total?: { total?: string } }).total?.total);
    if (arTotal !== c2(tally.get("1100"))) note(`Aged receivables total ${arTotal}, accounts receivable ${c2(tally.get("1100"))}`);
    if (apTotal !== c2(neg(tally.get("2000")))) note(`Aged payables total ${apTotal}, accounts payable ${c2(neg(tally.get("2000")))}`);
    const cf = await as((tx) => cashFlowStatement(tx, { from: "2025-04-01", to: yearEnd }));
    const cfJson = JSON.stringify(cf);
    // Into the next year: last year's profit is in earlier years' earnings, and the balance sheet still balances.
    await as((tx) => postJournal(tx, { idempotencyKey: key("j"), postingDate: "2026-04-10", reference: "New year", lines: [{ accountCode: "6010", debitAmount: "100.00" }, { accountCode: "1000", creditAmount: "100.00" }] }));
    const nextTb = await as((tx) => trialBalance(tx, { asAt: "2026-04-30" }));
    const previous = plain((nextTb as unknown as { previousYearsEarnings: string }).previousYearsEarnings);
    if (previous !== c2(income)) note(`Next year: earlier years' earnings ${previous}, last year's profit ${c2(income)}`);
    const nextBs = (await as((tx) => balanceSheet(tx, { asAt: "2026-04-30" }))) as unknown as Record<string, unknown>;
    const totalOf = (section: unknown) => plain(String((section as { total?: string })?.total ?? "0"));
    const netAssets = sub(dec(totalOf(nextBs.assets)), dec(totalOf(nextBs.liabilities)));
    if (c2(netAssets) !== totalOf(nextBs.equity)) note(`Next year's balance sheet: net assets ${c2(netAssets)}, equity ${totalOf(nextBs.equity)}`);

    console.log(
      JSON.stringify(
        {
          seed: SEED,
          documents,
          filedPeriods: filedPeriods.length,
          gstFormRoundingOverYear: c2(gstFormGap),
          gstReturned: c2(gstReturned),
          bank: c2(tally.get("1000")),
          receivables: c2(tally.get("1100")),
          payables: c2(neg(tally.get("2000"))),
          netProfit: c2(income),
          costOfSales: c2(cogs),
          stockOnHand: stockTotal,
          reports: { tb: tbJson.slice(0, 300), bs: bsJson.slice(0, 300), cf: cfJson.slice(0, 600), ar: JSON.stringify(ar).slice(0, 200) },
        },
        null,
        1,
      ),
    );
    console.log(`PROBLEMS FOUND: ${problems.length}`);
    expect(problems).toEqual([]);
  }, 1_800_000);
});
