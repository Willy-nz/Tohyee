"use client";

import { RequireOrganisation } from "@/components/books";
import { TimesheetsPage } from "@/components/payroll-timesheets";
import { Page, PageHeader } from "@/components/ui";

/**
 * Payroll › Timesheets (TS1-TS11). Open to viewers and above: each person
 * sees their own timesheets, the ones they approve, or everyone's with
 * payroll access (decision 95). Hours only, never pay.
 */
export default function TimesheetsRoutePage() {
  return (
    <Page>
      <PageHeader
        title="Timesheets"
        description="Hours each day by R&D activity, Department or project. Approved timesheets split pay runs' costs and are the R&D claim's time record."
      />
      <RequireOrganisation>{(organisationId) => <TimesheetsPage key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
