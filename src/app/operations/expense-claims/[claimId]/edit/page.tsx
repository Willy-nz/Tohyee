"use client";

import { useParams, useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { ExpenseClaimEditor } from "@/components/expense-claims";
import { useApiData } from "@/components/hooks";
import { Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import type { ExpenseClaim } from "@/lib/expense-claims/service";

function EditExpenseClaim({ organisationId, claimId }: { organisationId: string; claimId: string }) {
  const router = useRouter();
  const loaded = useApiData<{ claim: ExpenseClaim }>(`/api/expense-claims/${encodeURIComponent(claimId)}`, { organisationId });
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  const claim = loaded.data.claim;
  if (claim.status !== "draft") return <Notice tone="info">Only draft claims can be changed.</Notice>;
  return (
    <Card title={`Change ${claim.reference}`}>
      <ExpenseClaimEditor
        organisationId={organisationId}
        claim={claim}
        onSaved={(saved) => router.push(`/operations/expense-claims/${saved.id}`)}
        onCancel={() => router.push(`/operations/expense-claims/${claim.id}`)}
      />
    </Card>
  );
}

export default function EditExpenseClaimPage() {
  const { claimId } = useParams<{ claimId: string }>();
  return (
    <Page>
      <PageHeader title="Change expense claim" />
      <RequireOrganisation>{(organisationId) => <EditExpenseClaim key={`${organisationId}:${claimId}`} organisationId={organisationId} claimId={claimId} />}</RequireOrganisation>
    </Page>
  );
}
