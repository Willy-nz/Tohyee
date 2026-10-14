"use client";

import { RequireOrganisation } from "@/components/books";
import { FarmNotebook } from "@/components/farm-notebook";
import { Page, PageHeader } from "@/components/ui";

export default function FarmNotebookPage() {
  return (
    <Page>
      <PageHeader title="Farm notebook" description="The farm's history, goals, people and ways, for you and your AI." />
      <RequireOrganisation>{(organisationId) => <FarmNotebook key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
