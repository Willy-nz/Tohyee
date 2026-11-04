"use client";

import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { type MemberOption, SendForSigning, type SendOutcome } from "@/components/signing/send-wizard";
import { SigningRequestList } from "@/components/signing/requests";
import { Button, Card, Notice } from "@/components/ui";
import { api } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import { LEGAL_NOTE, type SigningRequestView } from "@/lib/signing/shared";

type Data = { requests: SigningRequestView[]; email: { ready: boolean; reason: string | null }; members: MemberOption[]; notesAreDrafts: boolean; canSend: boolean };

/**
 * Signing the year's statements (decision 1407): send the PDF to the
 * directors or officers, and keep the signed copy with that year.
 */
export function YearEndSigning({ organisationId, yearEnd, downloadHref }: { organisationId: string; yearEnd: string; downloadHref: string }) {
  const data = useApiData<Data>("/api/reports/financial-statements/signing", { organisationId, yearEnd });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return null;
  const { requests, email, members, notesAreDrafts, canSend } = data.data;
  const open = requests.find((request) => request.state === "sent");
  const signed = requests.find((request) => request.state === "completed");
  return (
    <Card
      title="Signing"
      actions={
        <InfoTip label="About signing the statements">
          Each person gets a link, checks it&apos;s them with an emailed code (members can sign in Tohyee instead), reads the PDF and signs. The signed copy, with a signature page and certificate, is kept with this year. Check
          who must sign your entity&apos;s statements (for a company, usually the directors). {LEGAL_NOTE}
        </InfoTip>
      }
    >
      {sent ? <Notice tone="success">{sent}</Notice> : null}
      {signed ? <Notice tone="success">Signed copy kept for the year ending {formatDate(yearEnd)}.</Notice> : null}
      <SigningRequestList organisationId={organisationId} requests={requests} />
      {sending ? (
        <SendForSigning
          document={{
            name: `the statements for the year ending ${formatDate(yearEnd)}`,
            previewHref: downloadHref,
            text: (
              <>
                {notesAreDrafts ? <Notice tone="warning">The notes are still Tohyee&apos;s drafts, and the PDF says so. Save your own notes first.</Notice> : null}
                <p style={{ margin: 0 }}>The PDF as it downloads now, for the year ending {formatDate(yearEnd)}.{open ? " It replaces the request that's out now, which is voided." : ""}</p>
              </>
            ),
          }}
          initialSigners={[]}
          maxSigners={20}
          roleLabelName="Signing as"
          members={members}
          emailReady={email.ready}
          emailReason={email.reason}
          onSend={(payload) =>
            api<SendOutcome>("/api/reports/financial-statements/signing", {
              method: "POST",
              body: {
                organisationId,
                yearEnd,
                idempotencyKey: payload.idempotencyKey,
                signers: payload.signers,
                signingOrder: payload.signingOrder,
                message: payload.message,
                expiresInDays: payload.expiresInDays,
                replacesRequestId: open?.id ?? null,
              },
            })
          }
          onDone={(outcome) => {
            setSending(false);
            setSent(outcome.emailNote ?? `Sent to ${outcome.request.signers.map((signer) => signer.name).join(", ")}.`);
            data.reload();
          }}
          onCancel={() => setSending(false)}
        />
      ) : canSend ? (
        <>
          {!email.ready ? <Notice tone="warning">{email.reason}</Notice> : null}
          <div>
            <Button variant={requests.length ? "secondary" : "primary"} onClick={() => setSending(true)}>
              {open ? "Send a new version" : signed ? "Send again to sign" : "Send to sign"}
            </Button>
          </div>
        </>
      ) : null}
    </Card>
  );
}
