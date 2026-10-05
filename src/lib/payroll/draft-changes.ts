import type { OrgTx } from "@/lib/db/org-transaction";

/**
 * Someone changed an employee's payroll details (tax code, student loan,
 * KiwiSaver, ESCT, bank account, a pay rate) while draft pay runs include
 * them: what those drafts pay now depends on the change, so the person
 * counts as preparing them (PRUN7b, #140).
 */
export async function markEmployeeDetailsChanged(tx: OrgTx, employeeId: string): Promise<void> {
  if (!tx.actor.userId) return;
  await tx.query(
    `update payroll_pay_runs r
        set details_changed_by = r.details_changed_by || jsonb_build_array(jsonb_build_object('userId', $2::text, 'employeeId', $1::text,
              'name', (select concat_ws(' ', e.first_name, e.last_name) from payroll_employees e where e.id = $1))),
            updated_at = now()
      where r.status = 'draft'
        and exists (select 1 from payroll_pay_run_employees pe where pe.pay_run_id = r.id and pe.employee_id = $1)
        and not r.details_changed_by @> jsonb_build_array(jsonb_build_object('userId', $2::text, 'employeeId', $1::text))`,
    [employeeId, tx.actor.userId],
  );
}
