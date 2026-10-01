"use client";

import { RequireOrganisation } from "@/components/books";
import { PayrollAccessGate } from "@/components/payroll-access";
import { LeavePage } from "@/components/payroll-leave";
import { Page, PageHeader } from "@/components/ui";

/**
 * Payroll › Leave (payroll stage P8): balances, bookings, public holidays,
 * cash-ups, the leave liability report and the organisation's leave
 * settings. Holidays Act 2003; payroll access only.
 */
export default function LeaveRoutePage() {
  return (
    <Page>
      <PageHeader
        title="Leave"
        description="Holidays Act 2003 leave: annual holidays, sick, bereavement and family violence leave, public and alternative holidays. Pay runs pay what's booked."
      />
      <RequireOrganisation>
        {(organisationId) => (
          <PayrollAccessGate key={organisationId} organisationId={organisationId}>
            <LeavePage organisationId={organisationId} />
          </PayrollAccessGate>
        )}
      </RequireOrganisation>
    </Page>
  );
}
