"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { PayrollAccessGate } from "@/components/payroll-access";
import { LeaveRecordView } from "@/components/payroll-leave";
import { Page, PageHeader } from "@/components/ui";

/** An employee's holiday and leave record (Holidays Act s 81; HL40, HL41). Payroll access only. */
export default function LeaveRecordPage() {
  const { employeeId } = useParams<{ employeeId: string }>();
  return (
    <Page>
      <PageHeader title="Holiday and leave record" />
      <RequireOrganisation>
        {(organisationId) => (
          <PayrollAccessGate key={`${organisationId}:${employeeId}`} organisationId={organisationId}>
            <LeaveRecordView organisationId={organisationId} employeeId={employeeId} />
          </PayrollAccessGate>
        )}
      </RequireOrganisation>
    </Page>
  );
}
