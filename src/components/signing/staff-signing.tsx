"use client";

import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { type MemberOption, SendForSigning, type SendOutcome } from "@/components/signing/send-wizard";
import { SigningRequestList } from "@/components/signing/requests";
import { Button, Card, Notice } from "@/components/ui";
import { api } from "@/lib/client/api";
import { LEGAL_NOTE, type SigningRequestView } from "@/lib/signing/shared";

type Data = { requests: SigningRequestView[]; email: { ready: boolean; reason: string | null }; members: MemberOption[] };

/** An employee's employment agreements sent to sign (decision 1408). Shown only to people with payroll access. */
export function EmploymentSigning({ organisationId, employee }: { organisationId: string; employee: { id: string; firstName: string; lastName: string; email: string | null } }) {
  const data = useApiData<Data>(`/api/payroll/employees/${encodeURIComponent(employee.id)}/agreements`, { organisationId });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return null;
  const { requests, email, members } = data.data;
  const name = `${employee.firstName} ${employee.lastName}`;
  return (
    <Card
      title="Employment agreement"
      actions={
        <InfoTip label="About signing employment agreements">
          Upload the agreement as a PDF (Tohyee doesn&apos;t write agreements). {employee.firstName} gets a link, checks it&apos;s them with an emailed code, reads it and signs; add whoever signs for the employer too. The signed copy, with
          a certificate, is kept here. Only people with payroll access see it. {LEGAL_NOTE}
        </InfoTip>
      }
    >
      {sent ? <Notice tone="success">{sent}</Notice> : null}
      <SigningRequestList organisationId={organisationId} requests={requests} />
      {!employee.email ? (
        <Notice tone="warning">Add {employee.firstName}&apos;s email address above to send an agreement to sign.</Notice>
      ) : sending ? (
        <SendForSigning
          document={null}
          upload
          titleDefault={`Employment agreement, ${name}`}
          initialSigners={[{ name, email: employee.email, roleLabel: "Employee" }]}
          maxSigners={5}
          roleLabelName="Signing as"
          members={members}
          emailReady={email.ready}
          emailReason={email.reason}
          remindersOffered
          onSend={(payload) =>
            api<SendOutcome>(`/api/payroll/employees/${employee.id}/agreements`, {
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
      ) : (
        <>
          {!email.ready ? <Notice tone="warning">{email.reason}</Notice> : null}
          <div>
            <Button variant={requests.length ? "secondary" : "primary"} onClick={() => setSending(true)}>
              Send an agreement to sign
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

/** Sending a farm's induction to people to sign electronically (decision 1409): each person gets their own request, and signing adds their sign-off. */
export function InductionSigning({ organisationId, farmId, induction, onSent }: { organisationId: string; farmId: string; induction: { recordId: string; version: number; title: string; audiences: string[] }; onSent: () => void }) {
  const data = useApiData<Data & { canSend: boolean }>("/api/farming/safety/induction-signing", { organisationId, farmId });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data || !data.data.canSend) return null;
  const { requests, email, members } = data.data;
  const mine = requests.filter((request) => request.sourceId === `${farmId}:${induction.recordId}`);
  const audience = induction.audiences.includes("worker") ? "worker" : induction.audiences[0];
  return (
    <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
      {sent ? <Notice tone="success">{sent}</Notice> : null}
      <SigningRequestList organisationId={organisationId} requests={mine.slice(0, 10)} />
      {sending ? (
        <SendForSigning
          document={{ name: `${induction.title} (version ${induction.version})`, previewHref: null, text: <p style={{ margin: 0 }}>The induction, this farm&apos;s hazards and its emergency details, written to a PDF when it&apos;s sent.</p> }}
          initialSigners={[]}
          maxSigners={20}
          roleLabelName="Job (optional)"
          members={members}
          emailReady={email.ready}
          emailReason={email.reason}
          orderChoice={false}
          sendText="Each person gets their own link, checks it's them with an emailed code (members can sign in Tohyee instead), reads the PDF and signs. Signing adds their sign-off to this farm's records."
          onSend={async (payload) => {
            const result = await api<{ sent: SendOutcome[] }>("/api/farming/safety/induction-signing", {
              method: "POST",
              body: { organisationId, farmId, inductionId: induction.recordId, inductionVersion: induction.version, audience, idempotencyKey: payload.idempotencyKey, signers: payload.signers, message: payload.message, expiresInDays: payload.expiresInDays },
            });
            return result.sent[0] ? { ...result.sent[0], emailNote: result.sent[0].emailNote ?? `Sent to ${result.sent.map((each) => each.request.signers[0].name).join(", ")}.` } : (() => { throw new Error("Nothing was sent."); })();
          }}
          onDone={(outcome) => {
            setSending(false);
            setSent(outcome.emailNote);
            data.reload();
            onSent();
          }}
          onCancel={() => setSending(false)}
        />
      ) : (
        <div>
          <Button size="small" variant="secondary" onClick={() => setSending(true)}>
            Send to sign electronically
          </Button>{" "}
          <InfoTip label="About signing inductions electronically">
            For staff and contractors who aren&apos;t at the farm office: they read the induction with the farm&apos;s hazards and emergency details on their phone and sign. Their sign-off is added to the farm&apos;s records,
            with the signing certificate. {LEGAL_NOTE}
          </InfoTip>
        </div>
      )}
    </div>
  );
}
