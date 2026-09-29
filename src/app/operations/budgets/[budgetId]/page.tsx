"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { BudgetEditor } from "@/components/budgets";
import { Page, PageHeader } from "@/components/ui";

export default function BudgetPage() {
  const { budgetId } = useParams<{ budgetId: string }>();
  return (
    <Page>
      <PageHeader title="Budget" description="Type amounts or quick fill them, then save. Budgets never post to the ledger." />
      <p>
        <Link href="/operations/budgets">All budgets</Link>
      </p>
      <RequireOrganisation>{(organisationId) => <BudgetEditor key={`${organisationId}:${budgetId}`} organisationId={organisationId} budgetId={budgetId} />}</RequireOrganisation>
    </Page>
  );
}
