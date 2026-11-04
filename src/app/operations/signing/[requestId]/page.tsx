"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { SigningRequestDetail } from "@/components/signing/requests";
import { Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { SigningRequestView } from "@/lib/signing/shared";

function Detail({ organisationId, requestId }: { organisationId: string; requestId: string }) {
  const { can } = useWorkspace();
  const data = useApiData<{ request: SigningRequestView }>(`/api/signing-requests/${encodeURIComponent(requestId)}`, { organisationId });
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return <p className={ui.muted}>Loading…</p>;
  return <SigningRequestDetail key={data.data.request.id} organisationId={organisationId} initial={data.data.request} canSend={can("bookkeeper")} />;
}

/** One signing request (decisions 1396-1410). */
export default function SigningRequestPage() {
  const { requestId } = useParams<{ requestId: string }>();
  return (
    <Page>
      <PageHeader title="Signing request" />
      <RequireOrganisation>{(organisationId) => <Detail organisationId={organisationId} requestId={requestId} />}</RequireOrganisation>
      <p>
        <Link href="/operations/quotes">Back to quotes</Link>
      </p>
    </Page>
  );
}
