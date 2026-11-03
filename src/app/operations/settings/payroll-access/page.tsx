"use client";

import { RequireOrganisation } from "@/components/books";
import { PayrollAccessSettings } from "@/components/payroll-access";
import { Page, PageHeader, Notice } from "@/components/ui";

export default function PayrollAccessPage() {
  return (
    <Page>
      <PageHeader title="Payroll access" />
      <Notice>Admins only.</Notice>
      <RequireOrganisation>{(organisationId) => <PayrollAccessSettings key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
