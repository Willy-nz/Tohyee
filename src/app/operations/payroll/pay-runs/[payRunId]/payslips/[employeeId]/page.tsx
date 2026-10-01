"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { PayrollAccessGate } from "@/components/payroll-access";
import { PayslipView } from "@/components/payroll-p5";
import { Page } from "@/components/ui";

/** Payroll › Pay runs › a pay run › one employee's payslip, to print or download (PSLIP4). */
export default function PayslipPage() {
  const { payRunId, employeeId } = useParams<{ payRunId: string; employeeId: string }>();
  return (
    <Page>
      <RequireOrganisation>
        {(organisationId) => (
          <PayrollAccessGate key={`${organisationId}:${payRunId}:${employeeId}`} organisationId={organisationId}>
            <PayslipView organisationId={organisationId} payRunId={payRunId} employeeId={employeeId} />
          </PayrollAccessGate>
        )}
      </RequireOrganisation>
    </Page>
  );
}
