"use client";

import { ApprovalsList } from "@/components/approvals";
import { RequireOrganisation } from "@/components/books";
import { Page, PageHeader } from "@/components/ui";

/** Purchases › Approvals (AW3): bills, purchase orders and expense claims waiting for approval. */
export default function ApprovalsPage() {
  return (
    <Page>
      <PageHeader title="Approvals" description="Bills, purchase orders and expense claims waiting for approval under an approval rule (Settings › Approval rules)." />
      <RequireOrganisation>{(organisationId) => <ApprovalsList key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
