"use client";

import { RequireOrganisation } from "@/components/books";
import { PayrollAccessSettings } from "@/components/payroll-access";
import { Page, PageHeader } from "@/components/ui";

export default function PayrollAccessPage() {
  return (
    <Page>
      <PageHeader title="Payroll access" description="Choose who can see and change payroll. Admins only." />
      <RequireOrganisation>{(organisationId) => <PayrollAccessSettings key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
