"use client";

import { useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { ExpenseClaimEditor } from "@/components/expense-claims";
import { Card, Notice, Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

function NewExpenseClaim({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const router = useRouter();
  if (!can("bookkeeper")) return <Notice tone="info">Only bookkeepers and admins can make expense claims.</Notice>;
  return (
    <Card title="Draft expense claim">
      <ExpenseClaimEditor
        organisationId={organisationId}
        onSaved={(claim) => router.push(`/operations/expense-claims/${claim.id}`)}
        onCancel={() => router.push("/operations/expense-claims")}
      />
    </Card>
  );
}

export default function NewExpenseClaimPage() {
  return (
    <Page>
      <PageHeader title="New expense claim" description="Enter each receipt as paid, including GST. Save it as a draft, attach the receipts, then submit it." />
      <RequireOrganisation>{(organisationId) => <NewExpenseClaim organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
