"use client";

import { RequireOrganisation } from "@/components/books";
import { SalespeopleManager } from "@/components/salespeople";
import { Page, PageHeader } from "@/components/ui";

export default function SalespeopleSettingsPage() {
  return (
    <Page>
      <PageHeader title="Salespeople" description="Who sold what: a salesperson on each invoice and credit note, and sales by salesperson under Reporting." />
      <RequireOrganisation>{(organisationId) => <SalespeopleManager key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
