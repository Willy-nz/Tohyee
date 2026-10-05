"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ApprovalRequestView } from "@/components/approvals";
import { RequireOrganisation } from "@/components/books";
import { Page, PageHeader } from "@/components/ui";

/** One document's approval (AW4, AW5, AW12): its steps, the budget, and approve or decline for its approvers. */
export default function ApprovalRequestPage() {
  const { requestId } = useParams<{ requestId: string }>();
  return (
    <Page>
      <PageHeader title="Approval" description={<Link href="/operations/purchases/approvals">Back to Approvals</Link>} />
      <RequireOrganisation>{(organisationId) => <ApprovalRequestView key={`${organisationId}-${requestId}`} organisationId={organisationId} requestId={requestId} />}</RequireOrganisation>
    </Page>
  );
}
