"use client";

import Link from "next/link";
import { useState } from "react";
import { InfoTip } from "@/components/info-tip";
import { SignatureForm } from "@/components/signing/signature-form";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import {
  groupedFingerprint,
  LEGAL_NOTE,
  METHOD_LABELS,
  type RequestState,
  SIGNER_STATUS_LABELS,
  type SigningRequestView,
  SOURCE_LABELS,
  STATE_LABELS,
} from "@/lib/signing/shared";
import styles from "./signing.module.css";

const STATE_TONES: Record<RequestState, "neutral" | "blue" | "green" | "amber" | "red"> = { sent: "blue", completed: "green", declined: "red", voided: "neutral", expired: "amber" };

export function SigningStateBadge({ state }: { state: RequestState }) {
  return <Badge tone={STATE_TONES[state]}>{STATE_LABELS[state]}</Badge>;
}

export function signingFileHref(organisationId: string, requestId: string, which: "document" | "signed", download = false): string {
  const query = new URLSearchParams({ organisationId, which, ...(download ? { download: "true" } : {}) });
  return `/api/signing-requests/${encodeURIComponent(requestId)}/file?${query}`;
}

const EVENT_WORDS: Record<string, string> = {
  sent: "Sent",
  link_emailed: "Link emailed",
  link_opened: "Link opened",
  code_sent: "Code emailed",
  verified: "Email checked with the code",
  viewed: "Document opened",
  signed: "Signed",
  declined: "Declined",
  voided: "Voided",
  completed: "Everyone signed: signed copy kept",
  reminded: "Reminder emailed (new link)",
  link_resent: "New link emailed",
  expired: "Expired",
};

/** The requests for one thing (a quote, a year), newest first, each linking to its page. */
export function SigningRequestList({ organisationId, requests }: { organisationId: string; requests: SigningRequestView[] }) {
  if (!requests.length) return null;
  return (
    <ul className={styles.requestList}>
      {requests.map((request) => (
        <li key={request.id} className={styles.requestItem}>
          <div style={{ minWidth: 0 }}>
            <Link href={`/operations/signing/${request.id}`}>{request.signers.map((signer) => signer.name).join(", ")}</Link>{" "}
            <span className={styles.muted}>· sent {formatDateTime(request.createdAt)}</span>
          </div>
          <div className={styles.actions}>
            <SigningStateBadge state={request.state} />
            {request.signedFileId ? <a href={signingFileHref(organisationId, request.id, "signed", true)}>Signed copy</a> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function sourceHref(request: SigningRequestView): string | null {
  if (request.sourceKind === "quote" && request.sourceId) return `/operations/quotes/${request.sourceId}`;
  if (request.sourceKind === "year_end") return "/operations/reports/financial-statements";
  if (request.sourceKind === "employment") return "/operations/payroll/employees";
  if (request.sourceKind === "induction") return "/operations/farming/safety";
  return null;
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("The file couldn't be read."));
    reader.readAsDataURL(file);
  });
}

/** Checks a copy someone has against what Tohyee kept (decision 1402). */
function CheckCopy({ organisationId, request }: { organisationId: string; request: SigningRequestView }) {
  const [result, setResult] = useState<{ tone: "success" | "warning" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Check a copy">
      <Field label="PDF to check">
        <input
          type="file"
          accept="application/pdf,.pdf"
          disabled={busy}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setBusy(true);
            setResult(null);
            try {
              const checked = await api<{ result: "signed" | "document" | "changed"; sha256: string }>(`/api/signing-requests/${request.id}/check`, {
                method: "POST",
                body: { organisationId, contentBase64: await readBase64(file) },
              });
              setResult(
                checked.result === "signed"
                  ? { tone: "success", text: "Unchanged since signing: it's the signed copy Tohyee kept." }
                  : checked.result === "document"
                    ? { tone: "warning", text: "This is the document as it was sent, before anyone signed. It isn't the signed copy." }
                    : { tone: "error", text: `Changed: this isn't the signed copy Tohyee kept, or it has been altered. Its fingerprint is ${groupedFingerprint(checked.sha256)}.` },
              );
            } catch (caught) {
              setResult({ tone: "error", text: errorMessage(caught) });
            } finally {
              setBusy(false);
            }
          }}
        />
      </Field>
      {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}
    </Card>
  );
}

function SignInTohyee({ organisationId, request, onChanged }: { organisationId: string; request: SigningRequestView; onChanged: (request: SigningRequestView) => void }) {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const { user } = useWorkspace();
  const me = request.signers.find((signer) => signer.userId === user.id && signer.status === "ready" && request.state === "sent");
  if (!me) return null;
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Your signature">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p style={{ margin: 0 }}>
        <a href={signingFileHref(organisationId, request.id, "document")} target="_blank" rel="noreferrer" onClick={() => setOpened(true)}>
          Open {request.documentName}
        </a>{" "}
        <InfoTip label="About signing in Tohyee">Your Tohyee sign-in checks it&apos;s you, so there&apos;s no emailed code. {LEGAL_NOTE}</InfoTip>
      </p>
      {!opened ? <p className={styles.muted}>Open and read it first.</p> : declining ? (
        <form
          className={styles.stack}
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => onChanged((await api<{ request: SigningRequestView }>(`/api/signing-requests/${request.id}/decline`, { method: "POST", body: { organisationId, reason } })).request));
          }}
        >
          <Field label="Why you're declining">
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000} required />
          </Field>
          <div className={styles.actions}>
            <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>
              Decline to sign
            </Button>
            <Button variant="secondary" onClick={() => setDeclining(false)}>
              Back
            </Button>
          </div>
        </form>
      ) : (
        <>
          <SignatureForm
            defaultName={me.name}
            busy={busy}
            onSubmit={(value) =>
              void run(async () => onChanged((await api<{ request: SigningRequestView }>(`/api/signing-requests/${request.id}/sign`, { method: "POST", body: { organisationId, ...value, documentSha256: request.documentSha256 } })).request))
            }
          />
          <div>
            <Button variant="secondary" size="small" onClick={() => setDeclining(true)}>
              Decline to sign
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

/** One request: who's signed, the files, history, checking a copy, voiding and resending. */
export function SigningRequestDetail({ organisationId, initial, canSend }: { organisationId: string; initial: SigningRequestView; canSend: boolean }) {
  const [request, setRequest] = useState(initial);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const open = request.state === "sent";
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const source = sourceHref(request);
  const nameOf = (signerId: string | null) => request.signers.find((signer) => signer.id === signerId)?.name ?? null;
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      <Card
        title={request.title}
        actions={
          <>
            <SigningStateBadge state={request.state} />
            {source ? <Link href={source}>{SOURCE_LABELS[request.sourceKind]}</Link> : null}
          </>
        }
      >
        <dl className={styles.review}>
          <dt>Document</dt>
          <dd>
            <a href={signingFileHref(organisationId, request.id, "document")} target="_blank" rel="noreferrer">
              {request.documentName}
            </a>{" "}
            <span className={styles.muted}>(as sent)</span>
          </dd>
          <dt>Fingerprint</dt>
          <dd className={styles.fingerprint}>
            {groupedFingerprint(request.documentSha256)}{" "}
            <InfoTip label="What the fingerprint is">The SHA-256 of the document&apos;s exact bytes, as each signer was shown it. It&apos;s on the signing certificate.</InfoTip>
          </dd>
          {request.signedFileId ? (
            <>
              <dt>Signed copy</dt>
              <dd>
                <a href={signingFileHref(organisationId, request.id, "signed", true)}>Download</a>{" "}
                <span className={styles.muted}>(with the signature page and certificate)</span>
              </dd>
            </>
          ) : null}
          <dt>Sent</dt>
          <dd>{formatDateTime(request.createdAt)}</dd>
          <dt>{request.state === "expired" ? "Expired" : "Links work until"}</dt>
          <dd>{formatDateTime(request.expiresAt)}</dd>
          {request.voidReason ? (
            <>
              <dt>Voided</dt>
              <dd>{request.voidReason}</dd>
            </>
          ) : null}
        </dl>
      </Card>
      <SignInTohyee organisationId={organisationId} request={request} onChanged={(next) => { setRequest(next); setNotice("Signed."); }} />
      <Card title="Signers">
        <ol className={styles.signerList}>
          {request.signers.map((signer) => (
            <li key={signer.id}>
              <div className={styles.requestItem} style={{ borderBottom: 0, padding: 0 }}>
                <div style={{ minWidth: 0 }}>
                  <strong>{signer.name}</strong>
                  {signer.roleLabel ? `, ${signer.roleLabel}` : ""} <span className={styles.muted}>{signer.email}</span>
                </div>
                <div className={styles.actions}>
                  <Badge tone={signer.status === "signed" ? "green" : signer.status === "declined" ? "red" : signer.status === "ready" ? "blue" : "neutral"}>{SIGNER_STATUS_LABELS[signer.status]}</Badge>
                  {open && canSend && signer.status === "ready" ? (
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          setRequest((await api<{ request: SigningRequestView }>(`/api/signing-requests/${request.id}/resend`, { method: "POST", body: { organisationId, signerId: signer.id } })).request);
                          setNotice(`A new link is on its way to ${signer.email}. The old one no longer works.`);
                        })
                      }
                    >
                      Email a new link
                    </Button>
                  ) : null}
                </div>
              </div>
              {signer.signedAt ? (
                <p className={styles.muted} style={{ margin: "4px 0 0" }}>
                  {METHOD_LABELS[signer.method!]} &quot;{signer.typedName}&quot;, {formatDateTime(signer.signedAt)} · {signer.verifiedBy === "tohyee_sign_in" ? "signed in to Tohyee" : "email checked with a code"}
                </p>
              ) : null}
              {signer.declineReason ? (
                <p style={{ margin: "4px 0 0" }}>
                  Declined {formatDateTime(signer.declinedAt!)}: {signer.declineReason}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
        {request.emails.some((email) => email.status === "failed") ? <Notice tone="warning">An email couldn&apos;t be sent: {request.emails.find((email) => email.status === "failed")!.lastError}</Notice> : null}
      </Card>
      {request.signedFileId ? <CheckCopy organisationId={organisationId} request={request} /> : null}
      <Card title="History">
        <ol className={styles.history}>
          {request.events.map((event) => (
            <li key={event.id}>
              {formatDateTime(event.at)}: {EVENT_WORDS[event.event] ?? event.event}
              {nameOf(event.signerId) ? ` (${nameOf(event.signerId)})` : ""}
              {event.event === "voided" && typeof event.details.reason === "string" ? `: ${event.details.reason}` : ""}
              {event.event === "declined" && typeof event.details.reason === "string" ? `: ${event.details.reason}` : ""}
              {event.ipAddress ? <span className={styles.muted}> · {event.ipAddress}</span> : null}
            </li>
          ))}
        </ol>
      </Card>
      {open && canSend ? (
        <Card title="Void this request">
          {voiding ? (
            <form
              className={styles.stack}
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  setRequest((await api<{ request: SigningRequestView }>(`/api/signing-requests/${request.id}/void`, { method: "POST", body: { organisationId, reason } })).request);
                  setVoiding(false);
                  setNotice("Voided. The links no longer work.");
                });
              }}
            >
              <Field label="Why">
                <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} placeholder="e.g. Wrong version sent" required />
              </Field>
              <Notice tone="warning">Voiding can&apos;t be undone. Signatures already given stay in the history. To change the document, send a new request.</Notice>
              <div className={styles.actions}>
                <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>
                  Void
                </Button>
                <Button variant="secondary" onClick={() => setVoiding(false)}>
                  Back
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="danger" onClick={() => setVoiding(true)}>
              Void…
            </Button>
          )}
        </Card>
      ) : null}
      <p className={ui.muted}>
        About electronic signatures <InfoTip label="About electronic signatures">{LEGAL_NOTE}</InfoTip>
      </p>
    </>
  );
}
