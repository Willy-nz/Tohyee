"use client";

import { RequireOrganisation } from "@/components/books";
import { BudgetList } from "@/components/budgets";
import { Page, PageHeader } from "@/components/ui";

export default function BudgetsPage() {
  return (
    <Page>
      <PageHeader title="Budgets" />
      <RequireOrganisation>{(organisationId) => <BudgetList key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
