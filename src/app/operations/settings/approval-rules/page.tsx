"use client";

import { ApprovalRules } from "@/components/approvals";
import { RequireOrganisation } from "@/components/books";
import { Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

/** Settings › Approval rules (AW1, AW11). Everyone sees them; admins change them. */
export default function ApprovalRulesPage() {
  const { can } = useWorkspace();
  return (
    <Page>
      <PageHeader
        title="Approval rules"
        description="Send bills, purchase orders and expense claims through one or more approval steps before they're approved. Approvers are asked on the Approvals page and by email."
      />
      <RequireOrganisation>{(organisationId) => <ApprovalRules key={organisationId} organisationId={organisationId} canEdit={can("admin")} />}</RequireOrganisation>
    </Page>
  );
}
