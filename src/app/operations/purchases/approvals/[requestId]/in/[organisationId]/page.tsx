"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { Notice, Page } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

/**
 * Where an approver's email links to, after signing in (AW12): chooses the
 * request's organisation, then opens its approval page. Nothing is approved
 * here.
 */
export default function ApprovalFromEmailPage() {
  const { requestId, organisationId } = useParams<{ requestId: string; organisationId: string }>();
  const { organisations, selectOrganisation } = useWorkspace();
  const router = useRouter();
  const member = organisations.some((organisation) => organisation.id === organisationId);
  useEffect(() => {
    if (!member) return;
    selectOrganisation(organisationId);
    router.replace(`/operations/purchases/approvals/${requestId}`);
  }, [member, organisationId, requestId, router, selectOrganisation]);
  return (
    <Page>
      {member ? <p>Opening the approval…</p> : <Notice tone="error">You aren&apos;t a member of the organisation this approval is in.</Notice>}
    </Page>
  );
}
