"use client";

import { RequireOrganisation } from "@/components/books";
import { ExpenseClaimList } from "@/components/expense-claims";
import { Page, PageHeader } from "@/components/ui";

export default function ExpenseClaimsPage() {
  return (
    <Page>
      <PageHeader title="Expense claims" description="Receipts people paid for themselves, approved and then paid back." />
      <RequireOrganisation>{(organisationId) => <ExpenseClaimList key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
