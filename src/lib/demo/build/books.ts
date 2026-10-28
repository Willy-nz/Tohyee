import { createAccount } from "@/lib/accounts/service";
import { listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine, suggestionsForLine } from "@/lib/bank/reconcile";
import { createBankTransaction } from "@/lib/bank/transactions";
import { recordSupplierPayment } from "@/lib/bills/payments";
import { approveBill, createBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import { addDays } from "@/lib/financial-year";
import { createFixedAsset, createFixedAssetType } from "@/lib/fixed-assets/service";
import { runDepreciation } from "@/lib/fixed-assets/runs";
import { recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { createItem } from "@/lib/items/service";
import { postJournal } from "@/lib/ledger/journals";
import { abs, add, dec, type Decimal, isNegative, isZero, neg, sub, toFixedString } from "@/lib/money/decimal";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { calculateGstReturn, fileGstReturn } from "@/lib/reports/gst-return";
import type { DemoContext } from "@/lib/demo/build/context";
import { DEMO_YEAR_END_MONTH, dayOf, gstDueDate, gstPeriods, inMilk, lastDayOf, milkPriceFor, milkSolidsFor, nextMonth, seasonEnd } from "@/lib/demo/plan";

/*
 * The demo farm's books (#437): settings, accounts, contacts, the opening
 * balances, and each month's milk income, bills, bank transactions, bank
 * statement (imported and reconciled), depreciation and GST returns, all
 * through Tohyee's own services, so they post and reconcile as real entries
 * would. Payroll and livestock are in their own files.
 */

const c2 = (value: Decimal) => toFixedString(value, 2);

/** What happens in the bank, for the statement the build imports each month. */
export type BankLine = { date: string; amount: Decimal; payee: string };

export type Books = {
  bankAccountId: string;
  lines: BankLine[];
  /** Bills and milk invoices still to be paid, with the day they're paid. */
  toPay: Array<{ kind: "bill" | "invoice"; id: string; payOn: string; amount: string; payee: string }>;
  filedGst: Array<{ periodStart: string; periodEnd: string; toPay: string }>;
};

/** The co-op the farm supplies and holds shares in: made up. */
export const COOP_NAME = "Southern Pastures Co-operative";

const CONTACTS: Array<{ ref: string; name: string; customer?: true; supplier?: true }> = [
  { ref: "coop", name: COOP_NAME, customer: true, supplier: true },
  { ref: "agent", name: "Taieri Stock Agents Ltd", customer: true, supplier: true },
  { ref: "vet", name: "Ridgeview Vets Ltd", supplier: true },
  { ref: "genetics", name: "Southern Herd Genetics", supplier: true },
  { ref: "dairy", name: "Clutha Dairy Supplies", supplier: true },
  { ref: "power", name: "Kererū Power", supplier: true },
  { ref: "feed", name: "Matai Feed Merchants", supplier: true },
  { ref: "grazier", name: "Hillcrest Grazing (R & J Doyle)", supplier: true },
  { ref: "fert", name: "Coastal Fert Ltd", supplier: true },
  { ref: "spreader", name: "Kaka Valley Spreading", supplier: true },
  { ref: "contractor", name: "Tūī Contracting Ltd", supplier: true },
  { ref: "fuel", name: "Matai Fuels Ltd", supplier: true },
  { ref: "engineer", name: "Kōtuku Engineering", supplier: true },
  { ref: "accountant", name: "Riverbank Accountants", supplier: true },
  { ref: "telco", name: "Pīwakawaka Telecom", supplier: true },
  { ref: "insurer", name: "Harrier Insurance Ltd", supplier: true },
  { ref: "council", name: "South Coast District Council", supplier: true },
  { ref: "bank", name: "Tōtara Bank", supplier: true },
  { ref: "ird", name: "Inland Revenue", supplier: true },
  { ref: "freight", name: "Southern Stock Cartage", supplier: true },
];

/** Farm accounts beside the standard chart (codes the default chart doesn't use). */
const ACCOUNTS: Array<{ code: string; name: string; accountType: string }> = [
  { code: "4010", name: "Milk income", accountType: "revenue" },
  { code: "4020", name: "Livestock sales", accountType: "revenue" },
  { code: "4300", name: "Dividends received", accountType: "other_income" },
  { code: "1660", name: "Plant and machinery", accountType: "fixed_asset" },
  { code: "1670", name: "Accumulated depreciation - plant and machinery", accountType: "fixed_asset" },
  { code: "1680", name: "Farm buildings", accountType: "fixed_asset" },
  { code: "1690", name: "Accumulated depreciation - farm buildings", accountType: "fixed_asset" },
  { code: "1700", name: "Co-op shares", accountType: "non_current_asset" },
  { code: "1800", name: "Land", accountType: "fixed_asset" },
  { code: "3050", name: "Owners' equity brought forward", accountType: "equity" },
  { code: "6400", name: "Animal health", accountType: "expense" },
  { code: "6410", name: "Breeding and herd testing", accountType: "expense" },
  { code: "6420", name: "Farm dairy", accountType: "expense" },
  { code: "6430", name: "Feed and supplements", accountType: "expense" },
  { code: "6440", name: "Grazing", accountType: "expense" },
  { code: "6450", name: "Regrassing and cropping", accountType: "expense" },
  { code: "6460", name: "Weed and pest", accountType: "expense" },
  { code: "6470", name: "Rates", accountType: "expense" },
];

/** The opening balance sheet at the day before the books start (31 May). */
const OPENING = {
  bank: "85000.00",
  land: "5850000.00",
  plantCost: "412000.00",
  plantDepreciation: "176500.00",
  buildingsCost: "648000.00",
  buildingsDepreciation: "212400.00",
  coopShares: "396000.00",
  termLoan: "1650000.00",
};

/** Opening fixed assets (the register agrees with the two cost and depreciation accounts above). */
const OPENING_ASSETS: Array<{ type: "plant" | "buildings"; name: string; purchased: string; cost: string; depreciation: string }> = [
  { type: "plant", name: "Tractor (110 hp)", purchased: "2019-08-15", cost: "138000.00", depreciation: "71400.00" },
  { type: "plant", name: "Dairy shed plant and vat", purchased: "2016-07-01", cost: "182000.00", depreciation: "79100.00" },
  { type: "plant", name: "Farm bikes (two)", purchased: "2021-09-01", cost: "24000.00", depreciation: "12600.00" },
  { type: "plant", name: "Effluent pond and irrigator", purchased: "2018-03-01", cost: "68000.00", depreciation: "13400.00" },
  { type: "buildings", name: "Rotary dairy shed (40 bail)", purchased: "2014-06-01", cost: "486000.00", depreciation: "158100.00" },
  { type: "buildings", name: "Implement shed and calf sheds", purchased: "2012-02-01", cost: "162000.00", depreciation: "54300.00" },
];

export async function setUpBooks(ctx: DemoContext): Promise<void> {
  await ctx.as(async (tx) => {
    await updateOrganisationSettings(tx, {
      displayName: "Kōwhai Dairies Ltd",
      financialYearEndMonth: DEMO_YEAR_END_MONTH,
      gstRegistered: true,
      gstBasis: "invoice",
      gstPeriodMonths: 2,
      gstPeriodEndMonth: DEMO_YEAR_END_MONTH,
      analyticsEnabled: true,
      postalAddress: "412 Kōwhai Valley Road\nRD 2\nOtago 9000",
      paymentDetails: "Tōtara Bank 00-0000-0000000-00 (made up: this is the demo farm)",
    });
    for (const account of ACCOUNTS) await createAccount(tx, account);
    for (const contact of CONTACTS) {
      const made = await createContact(tx, { idempotencyKey: ctx.key("contact"), name: contact.name, isCustomer: contact.customer ?? false, isSupplier: contact.supplier ?? false });
      ctx.ids.set(`contact:${contact.ref}`, made.contact.id);
    }
    const milk = await createItem(tx, {
      idempotencyKey: ctx.key("item"),
      code: "MS",
      name: "Milk solids",
      description: "Milk solids supplied (kg MS)",
      itemType: "service",
      baseUnit: "kg MS",
      salePrice: "9.70",
      incomeAccountCode: "4010",
      salesTaxCode: "GST",
    });
    ctx.ids.set("item:milk", milk.item.id);
  });
}

/** The opening balances: one journal on the day before the books start, and the fixed asset register to match. */
export async function openBooks(ctx: DemoContext, livestockValue: string): Promise<Books> {
  const openingDate = addDays(ctx.start, -1);
  const credits = add(add(dec(OPENING.plantDepreciation), dec(OPENING.buildingsDepreciation)), dec(OPENING.termLoan));
  const debits = [OPENING.bank, OPENING.land, OPENING.plantCost, OPENING.buildingsCost, OPENING.coopShares, livestockValue].reduce((sum, value) => add(sum, dec(value)), dec("0"));
  const equity = sub(debits, credits);
  return ctx.as(async (tx) => {
    await postJournal(tx, {
      idempotencyKey: ctx.key("opening"),
      postingDate: openingDate,
      reference: "Opening balances",
      description: "Balances brought forward at the last balance date (made-up demo figures)",
      lines: [
        { accountCode: "1000", debitAmount: OPENING.bank, description: "Bank" },
        { accountCode: "1800", debitAmount: OPENING.land, description: "Land" },
        { accountCode: "1660", debitAmount: OPENING.plantCost, description: "Plant and machinery at cost" },
        { accountCode: "1670", creditAmount: OPENING.plantDepreciation, description: "Plant and machinery depreciation to date" },
        { accountCode: "1680", debitAmount: OPENING.buildingsCost, description: "Farm buildings at cost" },
        { accountCode: "1690", creditAmount: OPENING.buildingsDepreciation, description: "Farm buildings depreciation to date" },
        { accountCode: "1700", debitAmount: OPENING.coopShares, description: `${COOP_NAME} shares` },
        { accountCode: "1500", debitAmount: livestockValue, description: "Livestock on hand" },
        { accountCode: "2800", creditAmount: OPENING.termLoan, description: "Tōtara Bank term loan" },
        { accountCode: "3050", creditAmount: c2(equity), description: "Owners' equity" },
      ],
    });
    const plant = await createFixedAssetType(tx, {
      idempotencyKey: ctx.key("type"),
      name: "Plant and machinery",
      assetAccountCode: "1660",
      accumulatedDepreciationAccountCode: "1670",
      depreciationExpenseAccountCode: "6300",
      method: "dv",
      rate: "13",
    });
    const buildings = await createFixedAssetType(tx, {
      idempotencyKey: ctx.key("type"),
      name: "Farm buildings",
      assetAccountCode: "1680",
      accumulatedDepreciationAccountCode: "1690",
      depreciationExpenseAccountCode: "6300",
      method: "dv",
      rate: "6",
    });
    ctx.ids.set("assetType:plant", plant.type.id);
    ctx.ids.set("assetType:buildings", buildings.type.id);
    for (const asset of OPENING_ASSETS) {
      const made = await createFixedAsset(tx, {
        idempotencyKey: ctx.key("asset"),
        name: asset.name,
        typeId: asset.type === "plant" ? plant.type.id : buildings.type.id,
        purchaseDate: asset.purchased,
        cost: asset.cost,
        openingDate,
        openingAccumulatedDepreciation: asset.depreciation,
      });
      // For the safety equipment and tractor mode, which name the machines' fixed assets.
      ctx.ids.set(`asset:${asset.name}`, made.asset.id);
    }
    const bank = (await listBankAccounts(tx)).find((account) => account.code === "1000");
    if (!bank) throw new Error("The demo farm has no bank account 1000.");
    return { bankAccountId: bank.id, lines: [], toPay: [], filedGst: [] };
  });
}

type BillSpec = { supplier: string; account: string; description: string; min: number; max: number; day: number; exempt?: true; quantity?: string };

/** The bills for a month, by month number (made up, seasonal). */
function billsFor(month: string, ctx: DemoContext): BillSpec[] {
  const number = Number(month.slice(5, 7));
  const milking = inMilk(month);
  const bills: BillSpec[] = [
    { supplier: "vet", account: "6400", description: number >= 7 && number <= 9 ? "Calving: metricheck, calf health and minerals" : "Animal health: visits, drench and teat spray", min: number >= 7 && number <= 9 ? 5200 : 2200, max: number >= 7 && number <= 9 ? 7400 : 4100, day: 27 },
    { supplier: "power", account: "6110", description: "Electricity: dairy shed and houses", min: milking ? 3800 : 1300, max: milking ? 5200 : 1900, day: 12 },
    { supplier: "fuel", account: "6120", description: "Diesel and petrol", min: 1900, max: 3400, day: 25 },
    { supplier: "telco", account: "6170", description: "Phone and rural broadband", min: 189, max: 189, day: 3 },
    { supplier: "grazier", account: "6440", description: "Young stock grazing", min: 6100, max: 6900, day: 28 },
  ];
  if (milking) bills.push({ supplier: "dairy", account: "6420", description: "Dairy shed: rubberware, filters and chemicals", min: 1300, max: 2300, day: 16 });
  if ([6, 7, 8].includes(number)) bills.push({ supplier: "feed", account: "6430", description: "Palm kernel and baleage", min: 11000, max: 16500, day: 8 });
  else if (milking) bills.push({ supplier: "feed", account: "6430", description: "Palm kernel", min: 2800, max: 6200, day: 8 });
  if ([10, 11, 12].includes(number)) bills.push({ supplier: "genetics", account: "6410", description: number === 10 ? "AI: semen and technician" : "AI and mating bulls lease", min: 5200, max: 8400, day: 20 });
  if ([9, 12, 2, 4].includes(number)) bills.push({ supplier: "genetics", account: "6410", description: "Herd test", min: 1150, max: 1350, day: 22 });
  if (number === 11) bills.push({ supplier: "contractor", account: "6450", description: "Regrassing: spray, cultivate and sow (two paddocks)", min: 8200, max: 9800, day: 18 });
  if (number === 1) bills.push({ supplier: "contractor", account: "6450", description: "Silage: mow, rake and wrap", min: 12800, max: 15400, day: 22 });
  if (number === 10) bills.push({ supplier: "contractor", account: "6460", description: "Thistle and ragwort spraying", min: 2100, max: 2900, day: 14 });
  if ([3, 6, 9, 12].includes(number)) bills.push({ supplier: "accountant", account: "6010", description: "Accounting and GST", min: 1350, max: 1650, day: 10 });
  if ([8, 11, 2, 5].includes(number)) bills.push({ supplier: "council", account: "6470", description: "Rates instalment", min: 4180, max: 4180, day: 20 });
  if (number === 9) bills.push({ supplier: "insurer", account: "6080", description: "Farm insurance (year)", min: 13600, max: 14400, day: 1 });
  if (ctx.random() < 0.6) bills.push({ supplier: "engineer", account: "6160", description: ctx.pick(["Repairs: pump and pipework", "Repairs: tractor service", "Repairs: fencing materials", "Repairs: shed platform"]), min: 600, max: 3800, day: 19 });
  if ([3, 4].includes(number)) bills.push({ supplier: "freight", account: "6060", description: "Cartage: cull cows to the works", min: 900, max: 1600, day: 26 });
  return bills;
}

/**
 * One month of trading: bills (paid on the 20th of the next month), what was
 * owed from last month paid, the month's milk invoice (paid on the 20th of
 * the next month), bank fees, loan interest, drawings, and GST paid or
 * refunded when due. Nothing after today.
 */
export async function tradeMonth(ctx: DemoContext, books: Books, month: string): Promise<void> {
  const today = ctx.today;
  const payDay = dayOf(nextMonth(month), 20);
  const contact = (ref: string) => ctx.id(`contact:${ref}`);

  // Last month's bills and milk, paid on the 20th.
  for (const due of books.toPay.filter((entry) => entry.payOn.slice(0, 7) === month && entry.payOn <= today)) {
    await ctx.as(async (tx) => {
      if (due.kind === "bill") await recordSupplierPayment(tx, due.id, { idempotencyKey: ctx.key("pay"), paymentDate: due.payOn, amount: due.amount, bankAccountCode: "1000" });
      else await recordPayment(tx, due.id, { idempotencyKey: ctx.key("receipt"), paymentDate: due.payOn, amount: due.amount, bankAccountCode: "1000" });
    });
    books.lines.push({ date: due.payOn, amount: due.kind === "bill" ? neg(dec(due.amount)) : dec(due.amount), payee: due.payee });
  }
  books.toPay = books.toPay.filter((entry) => !(entry.payOn.slice(0, 7) === month && entry.payOn <= today));

  for (const spec of billsFor(month, ctx)) {
    const date = dayOf(month, spec.day);
    if (date > today) continue;
    const net = ctx.money(spec.min, spec.max);
    const bill = await ctx.as(async (tx) => {
      const { bill: draft } = await createBill(tx, {
        idempotencyKey: ctx.key("bill"),
        contactId: contact(spec.supplier),
        billDate: date,
        dueDate: payDay,
        supplierInvoiceNumber: `${spec.supplier.slice(0, 3).toUpperCase()}-${month.replace("-", "")}-${ctx.whole(100, 999)}`,
        amountsMode: "exclusive",
        lines: [{ description: spec.description, quantity: "1", unitPrice: net, accountCode: spec.account, taxCode: spec.exempt ? "EXEMPT" : "GST" }],
      });
      return (await approveBill(tx, draft.id, { idempotencyKey: ctx.key("approve"), approveDespiteWarnings: true })).bill;
    });
    books.toPay.push({ kind: "bill", id: bill.id, payOn: payDay, amount: plain(bill.total), payee: CONTACTS.find((entry) => entry.ref === spec.supplier)!.name });
  }

  // The month's milk, invoiced to the co-op at the month end once the month is over.
  const kg = milkSolidsFor(month, ctx.random);
  const monthEnd = lastDayOf(month);
  if (kg > 0 && monthEnd < today) {
    const invoice = await ctx.as(async (tx) => {
      const { invoice: draft } = await createInvoice(tx, {
        idempotencyKey: ctx.key("milk"),
        contactId: contact("coop"),
        invoiceDate: monthEnd,
        dueDate: payDay,
        reference: `Milk supply ${month}`,
        amountsMode: "exclusive",
        lines: [{ itemId: ctx.id("item:milk"), description: `Milk solids supplied in ${month} (advance price)`, quantity: String(kg), unitPrice: milkPriceFor(seasonEnd(monthEnd)) }],
      });
      return (await approveInvoice(tx, draft.id, { idempotencyKey: ctx.key("approve") })).invoice;
    });
    books.toPay.push({ kind: "invoice", id: invoice.id, payOn: payDay, amount: plain(invoice.total), payee: COOP_NAME });
  }

  // Straight from the bank: fees, loan interest (no GST), and the owners' drawings.
  const spend = async (date: string, ref: string, description: string, accountCode: string, amount: string, kind: "spend" | "receive" = "spend") => {
    if (date > today) return;
    await ctx.as((tx) =>
      createBankTransaction(tx, {
        idempotencyKey: ctx.key("bank"),
        kind,
        accountId: books.bankAccountId,
        contactId: contact(ref),
        date,
        reference: description,
        amountsMode: "no_tax",
        lines: [{ description, accountCode, amount }],
      }),
    );
    books.lines.push({ date, amount: kind === "spend" ? neg(dec(amount)) : dec(amount), payee: CONTACTS.find((entry) => entry.ref === ref)!.name });
  };
  await spend(dayOf(month, 28), "bank", "Account fees", "6020", ctx.money(38, 62));
  await spend(dayOf(month, 28), "bank", "Term loan interest", "6090", ctx.money(8600, 9100));
  await spend(dayOf(month, 15), "bank", "Owners' drawings", "3100", "7500.00");
  const number = Number(month.slice(5, 7));
  // Term loan principal each quarter, and provisional tax on IRD's dates for a 31 May balance date.
  if ([3, 6, 9, 12].includes(number)) await spend(dayOf(month, 28), "bank", "Term loan principal", "2800", "30000.00");
  if (number === 10 || number === 2 || number === 6) await spend(dayOf(month, 28), "ird", "Provisional tax", "2300", "21000.00");
  if (number === 4 || number === 10) await spend(dayOf(month, 18), "coop", number === 4 ? "Co-op interim dividend" : "Co-op final dividend", "4300", number === 4 ? "11000.00" : "16500.00", "receive");

  // GST filed for an earlier period, paid or refunded on its due date.
  for (const filed of books.filedGst) {
    const due = gstDueDate(filed.periodEnd);
    if (due.slice(0, 7) !== month || due > today || isZero(dec(filed.toPay))) continue;
    // Tohyee doesn't record a GST payment against a return yet (and a bank transaction can't use the GST account), so it's a journal between the bank and GST, as an accountant would post it.
    const amount = dec(filed.toPay);
    const paid = c2(abs(amount));
    const refund = isNegative(amount);
    await ctx.as((tx) =>
      postJournal(tx, {
        idempotencyKey: ctx.key("gst-paid"),
        postingDate: due,
        reference: `GST ${filed.periodStart} to ${filed.periodEnd}`,
        description: refund ? "GST refund from Inland Revenue" : "GST paid to Inland Revenue",
        lines: refund
          ? [{ accountCode: "1000", debitAmount: paid }, { accountCode: "2100", creditAmount: paid }]
          : [{ accountCode: "2100", debitAmount: paid }, { accountCode: "1000", creditAmount: paid }],
      }),
    );
    books.lines.push({ date: due, amount: refund ? dec(paid) : neg(dec(paid)), payee: "Inland Revenue GST" });
  }

  if (monthEnd < today) await ctx.as((tx) => runDepreciation(tx, { idempotencyKey: ctx.key("depreciation"), periodEnd: monthEnd }));
}

/** Files the GST return for each two-monthly period that ended this month (before today), from Tohyee's own figures. */
export async function fileGst(ctx: DemoContext, books: Books, month: string): Promise<void> {
  for (const [periodStart, periodEnd] of gstPeriods(ctx.start, ctx.today)) {
    if (periodEnd.slice(0, 7) !== month) continue;
    await ctx.as(async (tx) => {
      const figures = await calculateGstReturn(tx, { periodStart, periodEnd });
      await fileGstReturn(tx, { idempotencyKey: ctx.key("gst"), periodStart, periodEnd });
      books.filedGst.push({ periodStart, periodEnd, toPay: plain(figures.boxes.box15) });
    });
  }
}

/**
 * The month's bank statement, imported as a CSV like the bank's, and each
 * line matched to what's in the books. Lines from the last few days are left
 * to reconcile, as on a real farm.
 */
export async function bankStatement(ctx: DemoContext, books: Books, month: string, balance: { value: Decimal }): Promise<void> {
  const yesterday = addDays(ctx.today, -1);
  const lines = books.lines.filter((line) => line.date.slice(0, 7) === month && line.date <= yesterday).sort((a, b) => a.date.localeCompare(b.date));
  if (lines.length === 0) return;
  const rows = ["Date,Amount,Payee,Balance"];
  for (const line of lines) {
    balance.value = add(balance.value, line.amount);
    const [y, m, d] = line.date.split("-");
    rows.push(`${d}/${m}/${y},${c2(line.amount)},${line.payee.replace(/,/g, " ")},${c2(balance.value)}`);
  }
  const keepUntil = addDays(ctx.today, -6);
  await ctx.as(async (tx) => {
    await importStatementFile(tx, books.bankAccountId, {
      idempotencyKey: ctx.key("statement"),
      fileName: `totara-bank-${month}.csv`,
      fileBase64: Buffer.from(`${rows.join("\n")}\n`).toString("base64"),
    });
  });
  const open = await ctx.as((tx) => listStatementLines(tx, books.bankAccountId, { status: "unreconciled", limit: 500 }));
  for (const line of open.lines) {
    if (line.date > keepUntil) continue;
    await ctx.as(async (tx) => {
      const suggestions = await suggestionsForLine(tx, line.id);
      const match = suggestions.matches.find((candidate) => candidate.exact && !candidate.voided);
      if (match) await reconcileStatementLine(tx, line.id, { idempotencyKey: ctx.key("reconcile"), kind: "match", journalLineIds: [match.journalLineId] });
    });
  }
}

/** Text amounts as reports give them ("1,234.50", "(12.00)") as plain numbers. */
export function plain(text: string | null | undefined): string {
  return (text ?? "0").replace(/[,$\s]/g, "").replace(/^\((.*)\)$/, "-$1");
}
