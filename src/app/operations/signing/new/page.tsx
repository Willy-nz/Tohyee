"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { type MemberOption, SendForSigning, type SendOutcome } from "@/components/signing/send-wizard";
import { Card, Notice, Page, PageHeader, ui } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { SigningRequestView } from "@/lib/signing/shared";

function NewRequest({ organisationId }: { organisationId: string }) {
  const router = useRouter();
  // "Send a new version" of an uploaded document: the same title and signers, a new PDF; the old request is voided.
  const replaces = useSearchParams().get("replaces");
  const old = useApiData<{ request: SigningRequestView }>(replaces ? `/api/signing-requests/${encodeURIComponent(replaces)}` : null, { organisationId });
  const data = useApiData<{ email: { ready: boolean; reason: string | null }; members: MemberOption[]; canSend: boolean }>("/api/signing-requests", { organisationId, members: true, state: "none" });
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data || (replaces && !old.data && !old.error)) return <p className={ui.muted}>Loading…</p>;
  const previous = old.data?.request && old.data.request.sourceKind === "upload" ? old.data.request : null;
  if (!data.data.canSend) return <Notice tone="warning">Sending documents to sign needs the bookkeeper role or higher.</Notice>;
  return (
    <Card>
      {previous ? <Notice tone="info">A new version of {previous.title}. Sending it voids the earlier request{previous.state === "sent" ? ", which is still waiting" : ""}.</Notice> : null}
      <SendForSigning
        document={null}
        upload
        initialSigners={previous ? previous.signers.map((signer) => ({ name: signer.name, email: signer.email, roleLabel: signer.roleLabel ?? "" })) : []}
        titleDefault={previous?.title ?? ""}
        maxSigners={20}
        members={data.data.members}
        emailReady={data.data.email.ready}
        emailReason={data.data.email.reason}
        remindersOffered
        onSend={(payload) =>
          api<SendOutcome>("/api/signing-requests", {
            method: "POST",
            body: {
              organisationId,
              idempotencyKey: payload.idempotencyKey,
              title: payload.title,
              fileName: payload.upload?.fileName,
              contentBase64: payload.upload?.contentBase64,
              signers: payload.signers,
              signingOrder: payload.signingOrder,
              message: payload.message,
              expiresInDays: payload.expiresInDays,
              remindEveryDays: payload.remindEveryDays,
              replacesRequestId: previous && previous.state === "sent" ? previous.id : null,
            },
          })
        }
        onDone={(outcome) => router.push(`/operations/signing/${outcome.request.id}`)}
        onCancel={() => router.push("/operations/signing")}
      />
    </Card>
  );
}

/** Send any PDF to one or more people to sign (decision 1410). */
export default function NewSigningRequestPage() {
  return (
    <Page>
      <PageHeader title="Send a document to sign" />
      <RequireOrganisation>
        {(organisationId) => (
          <Suspense fallback={<p className={ui.muted}>Loading…</p>}>
            <NewRequest organisationId={organisationId} />
          </Suspense>
        )}
      </RequireOrganisation>
    </Page>
  );
}
