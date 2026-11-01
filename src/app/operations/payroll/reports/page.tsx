"use client";

import { InfoTip } from "@/components/info-tip";
import { RequireOrganisation } from "@/components/books";
import { PayrollAccessGate } from "@/components/payroll-access";
import { PayrollReports } from "@/components/payroll-reports";
import { Page, PageHeader } from "@/components/ui";

export default function PayrollReportsPage() {
  return (
    <Page>
      <PageHeader
        title="Payroll reports"
        description={<>Payroll reports from approved pay runs. Only people with payroll access can see them.{" "}<InfoTip label="Payroll reports">Labour cost, the payroll summary, the reconciliation to the ledger, headcount and FTE, earnings history and PAYE, KiwiSaver and student loan, from approved pay runs by pay date.</InfoTip></>}
      />
      <RequireOrganisation>
        {(organisationId) => (
          <PayrollAccessGate key={organisationId} organisationId={organisationId}>
            <PayrollReports organisationId={organisationId} />
          </PayrollAccessGate>
        )}
      </RequireOrganisation>
    </Page>
  );
}
