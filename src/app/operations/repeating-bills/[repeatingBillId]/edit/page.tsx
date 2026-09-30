"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { RepeatingBillEditor } from "@/components/repeating/repeating-bill-editor";
import { Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { RepeatingBill } from "@/lib/repeating/bills";

function EditRepeatingBill({ organisationId, id }: { organisationId: string; id: string }) {
  const { can, current } = useWorkspace();
  const router = useRouter();
  const details = useApiData<{ repeatingBill: RepeatingBill }>(`/api/repeating-bills/${encodeURIComponent(id)}`, { organisationId });
  const viewHref = `/operations/repeating-bills/${encodeURIComponent(id)}`;
  if (!can("bookkeeper") || !current) return <Notice tone="info">Only bookkeepers and admins can change repeating bills.</Notice>;
  if (details.error) return <Notice tone="error">{details.error}</Notice>;
  if (!details.data) return <p className={ui.muted}>Loading…</p>;
  const template = details.data.repeatingBill;
  if (template.status === "ended") {
    return (
      <Notice tone="warning">
        This repeating bill has ended, so it can&apos;t be changed. <Link href={viewHref}>Back to it</Link>
      </Notice>
    );
  }
  return (
    <Card title={`Repeating bill from ${template.contactName}`}>
      <RepeatingBillEditor
        organisationId={organisationId}
        baseCurrency={current.baseCurrency}
        template={template}
        onSaved={() => router.push(viewHref)}
        onCancel={() => router.push(viewHref)}
      />
    </Card>
  );
}

export default function EditRepeatingBillPage() {
  const { repeatingBillId } = useParams<{ repeatingBillId: string }>();
  return (
    <Page>
      <PageHeader
        title="Change repeating bill"
        description="Bills already made keep what they had. Changing how often or the first date starts the new schedule from today."
      />
      <RequireOrganisation>{(organisationId) => <EditRepeatingBill organisationId={organisationId} id={repeatingBillId} />}</RequireOrganisation>
    </Page>
  );
}
