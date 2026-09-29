"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { ExpenseClaimView } from "@/components/expense-claims";
import { Page, PageHeader } from "@/components/ui";

export default function ExpenseClaimPage() {
  const { claimId } = useParams<{ claimId: string }>();
  return (
    <Page>
      <PageHeader title="Expense claim" />
      <RequireOrganisation>{(organisationId) => <ExpenseClaimView key={`${organisationId}:${claimId}`} organisationId={organisationId} claimId={claimId} />}</RequireOrganisation>
    </Page>
  );
}
