import type { OrgTx } from "@/lib/db/org-transaction";
import type { HireFacts } from "@/lib/organisations/hire-brief";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { hasPayrollAccess } from "@/lib/payroll/access";

/**
 * The facts a hiring brief is written from (decision 1476): counts and
 * periods only. Bank lines count when they're not reconciled on an active
 * bank or credit card account. The employee count only for someone with payroll
 * access (PE10).
 */
export async function hireFacts(tx: OrgTx): Promise<HireFacts> {
  const settings = await getOrganisationSettings(tx);
  const bank = await tx.query<{ accounts: string; lines: string; first: string | null; last: string | null; months: string }>(
    `with active as (
       select a.id from accounts a where a.account_type in ('bank', 'credit_card') and a.is_active
     ), open_lines as (
       select l.line_date from bank_statement_lines l where l.status = 'unreconciled' and l.account_id in (select id from active)
     )
     select (select count(*) from active)::text as accounts,
            (select count(*) from open_lines)::text as lines,
            (select to_char(min(line_date), 'YYYY-MM') from open_lines) as first,
            (select to_char(max(line_date), 'YYYY-MM') from open_lines) as last,
            (select count(distinct to_char(line_date, 'YYYY-MM')) from open_lines)::text as months`,
  );
  const row = bank.rows[0];
  const modules = [
    settings.accountingEnabled ? "Accounting" : null,
    settings.farmingEnabled ? "Farming" : null,
    settings.livestockEnabled ? "Livestock" : null,
    settings.advancedFeatures ? "Advanced reporting" : null,
    settings.notForProfitEnabled ? "Not-for-profit" : null,
    settings.crmEnabled ? "CRM" : null,
    settings.analyticsEnabled ? "Analytics" : null,
  ].filter((name): name is string => name !== null);
  let employees: number | null = null;
  if (await hasPayrollAccess(tx)) {
    const found = await tx.query<{ count: string }>("select count(*)::text as count from payroll_employees where not is_archived");
    employees = Number(found.rows[0].count);
  }
  return {
    bankAccounts: Number(row.accounts),
    unreconciledLines: Number(row.lines),
    unreconciledFrom: row.first,
    unreconciledTo: row.last,
    unreconciledMonths: Number(row.months),
    gstRegistered: settings.gstRegistered,
    gstPeriodMonths: settings.gstPeriod?.months ?? null,
    gstBasis: settings.gstBasis,
    financialYearEndMonth: settings.financialYearEndMonth,
    modules,
    employees,
  };
}
