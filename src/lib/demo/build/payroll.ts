import { addDays } from "@/lib/financial-year";
import { dec, isPositive, neg } from "@/lib/money/decimal";
import { createEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import { getIrdPeriod, recordIrdPayment } from "@/lib/payroll/ird-payments";
import { approvePayRun, createPayRun } from "@/lib/payroll/pay-runs";
import { PAYROLL_RATE_EDITIONS } from "@/lib/payroll/rates";
import { recordWagePayment } from "@/lib/payroll/wage-payments";
import { secretsAvailable } from "@/lib/secrets";
import type { Books } from "@/lib/demo/build/books";
import type { DemoContext } from "@/lib/demo/build/context";
import { nextMonth } from "@/lib/demo/plan";

/*
 * Payroll for two made-up staff (#437): fortnightly pay runs approved and
 * paid from the bank, and PAYE, KiwiSaver and ESCT paid to Inland Revenue
 * each month on the 20th. Only pay dates Tohyee has IRD rates for are run
 * (it never guesses a year's rates), so the demo stops short of them.
 */

function ratesCover(date: string): boolean {
  return PAYROLL_RATE_EDITIONS.some((edition) => edition.from <= date && date <= edition.to);
}

/** Payroll keeps IRD numbers encrypted, so a server without TOHYEE_SECRET_KEY has no payroll: the demo farm is made without it. */
export function payrollPossible(): boolean {
  return secretsAvailable();
}

export async function setUpPayroll(ctx: DemoContext): Promise<void> {
  if (!payrollPossible()) return;
  await ctx.as(async (tx) => {
    const group = await createPayGroup(tx, { idempotencyKey: ctx.key("group"), name: "Farm staff (fortnightly)", payFrequency: "fortnightly" });
    ctx.ids.set("payGroup", group.group.id);
    const startDate = `${Number(ctx.start.slice(0, 4)) - 2}-06-01`;
    const common = { taxCode: "M", irdNumber: "123456789", kiwiSaverEmployeeRate: "4", kiwiSaverEmployerRate: "4", studentLoan: false, payBasis: "salary", payFrequency: "fortnightly", startDate, payGroupId: group.group.id };
    await createEmployee(tx, {
      ...common,
      idempotencyKey: ctx.key("employee"),
      firstName: "Tama",
      lastName: "Whitfield",
      jobTitle: "Herd manager",
      annualSalary: "78000.00",
      kiwiSaverStatus: "enrolled",
      esctRate: "30",
      bankAccount: "01-0242-0123456-00",
    });
    await createEmployee(tx, {
      ...common,
      idempotencyKey: ctx.key("employee"),
      firstName: "Ella",
      lastName: "Brodie",
      jobTitle: "Farm assistant",
      annualSalary: "56000.00",
      kiwiSaverStatus: "enrolled",
      esctRate: "17.5",
      bankAccount: "12-3191-0654321-01",
    });
  });
}

/** Pay runs whose pay date is in this month (before today), each paid on its pay date. */
export async function payrollMonth(ctx: DemoContext, books: Books, month: string): Promise<void> {
  if (!payrollPossible()) return;
  // Fortnights from the start of the books; paid the Wednesday-ish two days after each ends.
  for (let periodStart = ctx.start; ; periodStart = addDays(periodStart, 14)) {
    const payDate = addDays(periodStart, 15);
    if (payDate.slice(0, 7) > month || payDate >= ctx.today) break;
    if (payDate.slice(0, 7) < month || !ratesCover(payDate)) continue;
    await ctx.as(async (tx) => {
      const { payRun } = await createPayRun(tx, { idempotencyKey: ctx.key("payrun"), payGroupId: ctx.id("payGroup"), periodStart, payDate });
      const approved = (await approvePayRun(tx, payRun.id, { idempotencyKey: ctx.key("approve") })).payRun;
      await recordWagePayment(tx, approved.id, { idempotencyKey: ctx.key("wages"), paymentDate: payDate, amount: approved.totals.netPay, bankAccountCode: "1000" });
      books.lines.push({ date: payDate, amount: neg(dec(approved.totals.netPay)), payee: "Wages" });
    });
  }
  // Last month's deductions, paid to Inland Revenue on the 20th.
  const [year, number] = month.split("-").map(Number);
  const previous = number === 1 ? `${year - 1}-12` : `${year}-${String(number - 1).padStart(2, "0")}`;
  if (`${previous}-01` < ctx.start || nextMonth(previous) !== month) return;
  await ctx.as(async (tx) => {
    const period = await getIrdPeriod(tx, `${previous}-01`);
    if (period.dueDate >= ctx.today) return;
    const lines = period.liabilities.filter((line) => isPositive(dec(line.owing))).map((line) => ({ liability: line.liability, amount: line.owing }));
    if (lines.length === 0) return;
    await recordIrdPayment(tx, { idempotencyKey: ctx.key("ird"), periodStart: period.start, paymentDate: period.dueDate, bankAccountCode: "1000", lines });
    books.lines.push({ date: period.dueDate, amount: neg(dec(period.totalOwing)), payee: "Inland Revenue PAYE" });
  });
}
