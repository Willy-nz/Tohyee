"use client";

import { RequireOrganisation } from "@/components/books";
import { BudgetList } from "@/components/budgets";
import { Page, PageHeader } from "@/components/ui";

export default function BudgetsPage() {
  return (
    <Page>
      <PageHeader title="Budgets" description="The overall budget and named budgets, month by month. Budgets never post to the ledger." />
      <RequireOrganisation>{(organisationId) => <BudgetList key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
