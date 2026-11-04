"use client";

import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { SendForSigning, type SendOutcome } from "@/components/signing/send-wizard";
import { SigningRequestList } from "@/components/signing/requests";
import { Button, Card, Notice } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { Quote } from "@/lib/quotes/service";
import { LEGAL_NOTE, type SigningRequestView } from "@/lib/signing/shared";
import { pdfHref } from "@/components/documents/email-document";

type Data = { requests: SigningRequestView[]; email: { ready: boolean; reason: string | null }; suggested: { name: string; email: string } };

/**
 * Online acceptance (QT9-QT11): send a finalised quote for the customer to
 * accept by signing it, and see how it's going.
 */
export function QuoteSigning({ organisationId, quote, canSend, onChanged }: { organisationId: string; quote: Quote; canSend: boolean; onChanged: () => void }) {
  const data = useApiData<Data>(quote.status === "draft" ? null : `/api/quotes/${encodeURIComponent(quote.id)}/signing`, { organisationId });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  if (quote.status === "draft") return null;
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return null;
  const { requests, email, suggested } = data.data;
  const open = requests.find((request) => request.state === "sent");
  if (!requests.length && (quote.status !== "finalised" || !canSend)) return null;
  return (
    <Card
      title="Online acceptance"
      actions={
        <InfoTip label="About online acceptance">
          The customer gets a link, checks it&apos;s them with an emailed code, reads the quote and signs (typed or drawn). The quote is then accepted, and you make the invoice or sales order from it. {LEGAL_NOTE}
        </InfoTip>
      }
    >
      {sent ? <Notice tone="success">{sent}</Notice> : null}
      <SigningRequestList organisationId={organisationId} requests={requests} />
      {sending ? (
        <SendForSigning
          document={{ name: `${quote.quoteNumber} (PDF)`, previewHref: pdfHref(organisationId, "quote", quote.id), text: <p style={{ margin: 0 }}>The quote&apos;s PDF, as it prints. Its fingerprint is worked out when it&apos;s sent.</p> }}
          initialSigners={[{ name: suggested.name, email: suggested.email, roleLabel: "" }]}
          maxSigners={1}
          roleLabelName="Their role (optional)"
          emailReady={email.ready}
          emailReason={email.reason}
          onSend={async (payload) =>
            api<SendOutcome>(`/api/quotes/${quote.id}/signing`, {
              method: "POST",
              body: { organisationId, idempotencyKey: payload.idempotencyKey, signers: payload.signers, message: payload.message, expiresInDays: payload.expiresInDays },
            })
          }
          onDone={(outcome) => {
            setSending(false);
            setSent(outcome.emailNote ?? `Sent to ${outcome.request.signers[0].name}.`);
            data.reload();
            onChanged();
          }}
          onCancel={() => setSending(false)}
        />
      ) : quote.status === "finalised" && canSend && !open ? (
        <>
          {!email.ready ? <Notice tone="warning">{email.reason}</Notice> : null}
          <div>
            <Button variant={requests.length ? "secondary" : "primary"} onClick={() => setSending(true)}>
              {requests.length ? "Send again to accept" : "Send to accept online"}
            </Button>
          </div>
        </>
      ) : null}
    </Card>
  );
}


