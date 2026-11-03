"use client";

import { RequireOrganisation } from "@/components/books";
import { SalespeopleManager } from "@/components/salespeople";
import { Page, PageHeader } from "@/components/ui";

export default function SalespeopleSettingsPage() {
  return (
    <Page>
      <PageHeader title="Salespeople" />
      <RequireOrganisation>{(organisationId) => <SalespeopleManager key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
