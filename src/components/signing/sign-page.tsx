"use client";

import { useCallback, useEffect, useState } from "react";
import { InfoTip } from "@/components/info-tip";
import { SignatureForm, type SignatureValue } from "@/components/signing/signature-form";
import { Button, Field, Notice, ui } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { groupedFingerprint, LEGAL_NOTE } from "@/lib/signing/shared";
import styles from "./signing.module.css";

/*
 * The signer's page (decisions 1396-1410): no login. Three steps, made for a
 * phone: check it's you (a code emailed to you), read the document, sign
 * (or decline). The session from the code is kept in this tab only.
 */

type View = {
  organisationName: string;
  title: string;
  message: string | null;
  sourceLabel: string;
  signerName: string;
  maskedEmail: string;
  roleLabel: string | null;
  verified: boolean;
  emailReady: boolean;
  documentName: string;
  documentSha256: string;
  documentBytes: number;
  viewed: boolean;
  expiresAt: string;
  sentBy: string;
  consentText: string;
  codeSentAt: string | null;
};

type Done = { kind: "signed"; complete: boolean } | { kind: "declined" };

function sessionKey(organisationId: string, token: string) {
  let hash = 0;
  for (const char of `${organisationId}/${token}`) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `tohyee.signing.${(hash >>> 0).toString(36)}`;
}

function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string | null) {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Private browsing: it still works while the page is open.
  }
}

async function fetchView(url: string, session: string | null): Promise<View> {
  const response = await fetch(url, { cache: "no-store", headers: session ? { "x-signing-session": session } : {} });
  const body = (await response.json()) as View & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "This signing link isn't working.");
  return body;
}

export function SignPage({ organisationId, token }: { organisationId: string; token: string }) {
  const url = `/api/sign/${encodeURIComponent(organisationId)}/${encodeURIComponent(token)}`;
  const key = sessionKey(organisationId, token);
  // Kept in this tab only (sessionStorage); read once, before the first load.
  const [session, setSession] = useState<string | null>(() => (typeof window === "undefined" ? null : readSession(key)));
  const [view, setView] = useState<View | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);
  const [opened, setOpened] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<Done | null>(null);

  const headers = useCallback((current: string | null): Record<string, string> => (current ? { "x-signing-session": current } : {}), []);

  const apply = useCallback(
    (body: View, current: string | null) => {
      setView(body);
      setOpened(body.viewed);
      if (current && !body.verified) {
        writeSession(key, null);
        setSession(null);
      }
    },
    [key],
  );

  const load = useCallback(async (current: string | null) => apply(await fetchView(url, current), current), [url, apply]);

  useEffect(() => {
    let cancelled = false;
    const stored = readSession(key);
    fetchView(url, stored).then(
      (body) => {
        if (!cancelled) apply(body, stored);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "No connection. Check your internet and reload.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, url, apply]);

  useEffect(() => () => (pdfUrl ? URL.revokeObjectURL(pdfUrl) : undefined), [pdfUrl]);

  const post = async (body: Record<string, unknown>) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers(session) }, body: JSON.stringify(body) });
    const result = (await response.json()) as Record<string, unknown> & { error?: string };
    if (!response.ok) throw new Error(result.error ?? "That didn't work. Try again.");
    return result;
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "No connection. Try again." });
    } finally {
      setBusy(false);
    }
  };

  const sendCode = () =>
    run(async () => {
      const result = await post({ action: "send_code" });
      setCodeSent(String(result.sentTo));
      setMessage({ tone: "success", text: `We've emailed a code to ${String(result.sentTo)}. It can take a minute to arrive; check your junk folder too.` });
    });

  const verify = () =>
    run(async () => {
      const result = await post({ action: "verify_code", code });
      const next = String(result.session);
      writeSession(key, next);
      setSession(next);
      setCode("");
      await load(next);
    });

  const openDocument = () =>
    run(async () => {
      const response = await fetch(`${url}/document`, { headers: headers(session), cache: "no-store" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "The document couldn't be opened.");
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      setPdfUrl(objectUrl);
      setOpened(true);
    });

  const sign = (value: SignatureValue) =>
    run(async () => {
      const result = await post({ action: "sign", ...value, documentSha256: view!.documentSha256 });
      writeSession(key, null);
      setDone({ kind: "signed", complete: result.complete === true });
    });

  const decline = () =>
    run(async () => {
      await post({ action: "decline", reason });
      writeSession(key, null);
      setDone({ kind: "declined" });
    });

  if (loadError) {
    return (
      <main className={styles.signPage}>
        <div className={styles.signHeader}>
          <h1>Signing link</h1>
        </div>
        <Notice tone="error">{loadError}</Notice>
      </main>
    );
  }
  if (!view) {
    return (
      <main className={styles.signPage}>
        <p className={ui.muted}>Loading…</p>
      </main>
    );
  }
  if (done) {
    return (
      <main className={styles.signPage}>
        <div className={styles.signHeader}>
          <h1>{done.kind === "signed" ? "Thank you, you've signed" : "You've declined to sign"}</h1>
          <p className={styles.from}>{view.title}</p>
        </div>
        <Notice tone="success">
          {done.kind === "signed"
            ? done.complete
              ? `Everyone has signed. ${view.emailReady ? "We'll email you a link to download the signed copy." : `Ask ${view.organisationName} for the signed copy.`}`
              : `${view.organisationName} will let you know when everyone has signed.`
            : `${view.organisationName} has been told, with your reason.`}
        </Notice>
        <p className={ui.muted}>You can close this page. This link won&apos;t work again.</p>
      </main>
    );
  }

  const step1 = view.verified ? "done" : "current";
  const step2 = !view.verified ? "todo" : opened ? "done" : "current";
  const step3 = view.verified && opened ? "current" : "todo";

  return (
    <main className={styles.signPage}>
      <div className={styles.signHeader}>
        <h1>
          {view.title}{" "}
          <InfoTip label="About signing here">
            {view.sentBy} at {view.organisationName} sent this from Tohyee. The link works until {formatDateTime(view.expiresAt)}, once. {LEGAL_NOTE}
          </InfoTip>
        </h1>
      </div>
      {view.message ? <Notice tone="info">{view.message}</Notice> : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <ol className={styles.steps}>
        <li className={styles.step} data-state={step1}>
          <span className={styles.stepNumber} aria-hidden="true">
            {step1 === "done" ? "✓" : 1}
          </span>
          <div className={styles.stepBody}>
            <h2>Check it&apos;s you</h2>
            {view.verified ? (
              <p className={ui.muted} style={{ margin: 0 }}>
                Checked: {view.maskedEmail}
              </p>
            ) : !view.emailReady ? (
              <Notice tone="warning">{view.organisationName} can&apos;t send email from Tohyee at the moment, so we can&apos;t send you a code. Ask them to check their email setup.</Notice>
            ) : (
              <>
                <p style={{ margin: 0 }}>
                  For {view.signerName}
                  {view.roleLabel ? `, ${view.roleLabel}` : ""}. We&apos;ll email a 6-digit code to {view.maskedEmail}.
                </p>
                <div className={styles.actions}>
                  <Button variant={codeSent || view.codeSentAt ? "secondary" : "primary"} onClick={() => void sendCode()} disabled={busy}>
                    {codeSent || view.codeSentAt ? "Send a new code" : "Email me a code"}
                  </Button>
                </div>
                {codeSent || view.codeSentAt ? (
                  <form
                    className={styles.actions}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void verify();
                    }}
                  >
                    <Field label="Code">
                      <input className={styles.codeInput} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required />
                    </Field>
                    <Button type="submit" disabled={busy || code.length !== 6}>
                      Check code
                    </Button>
                  </form>
                ) : null}
              </>
            )}
          </div>
        </li>
        <li className={styles.step} data-state={step2}>
          <span className={styles.stepNumber} aria-hidden="true">
            {step2 === "done" ? "✓" : 2}
          </span>
          <div className={styles.stepBody}>
            <h2>Read the document</h2>
            {view.verified ? (
              <>
                <div className={styles.actions}>
                  {pdfUrl ? (
                    <>
                      <a className={`${ui.button} ${ui.primary}`} href={pdfUrl} target="_blank" rel="noopener">
                        Open the PDF
                      </a>
                      <a href={pdfUrl} download={view.documentName}>
                        Download
                      </a>
                    </>
                  ) : (
                    <Button onClick={() => void openDocument()} disabled={busy}>
                      {`Show the ${view.sourceLabel.toLowerCase()}`}
                    </Button>
                  )}
                </div>
                {pdfUrl ? <iframe className={styles.pdfFrame} src={pdfUrl} title={view.documentName} /> : null}
                <p className={styles.fingerprint} style={{ margin: 0 }}>
                  Fingerprint {groupedFingerprint(view.documentSha256)}{" "}
                  <InfoTip label="What the fingerprint is">
                    A code worked out from the document&apos;s exact contents (SHA-256). Your signature is tied to it: if anything in the document changed, the fingerprint would too. It&apos;s on the signing certificate.
                  </InfoTip>
                </p>
              </>
            ) : (
              <p className={ui.muted} style={{ margin: 0 }}>
                After the code, you can open {view.documentName}.
              </p>
            )}
          </div>
        </li>
        <li className={styles.step} data-state={step3}>
          <span className={styles.stepNumber} aria-hidden="true">
            3
          </span>
          <div className={styles.stepBody}>
            <h2>Sign</h2>
            {step3 === "current" ? (
              declining ? (
                <form
                  className={styles.stack}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void decline();
                  }}
                >
                  <Field label="Why you're declining">
                    <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000} required />
                  </Field>
                  <div className={styles.actions}>
                    <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>
                      Decline to sign
                    </Button>
                    <Button variant="secondary" onClick={() => setDeclining(false)} disabled={busy}>
                      Back
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <SignatureForm defaultName={view.signerName} busy={busy} onSubmit={(value) => void sign(value)} />
                  <div>
                    <Button variant="secondary" size="small" onClick={() => setDeclining(true)} disabled={busy}>
                      Decline to sign
                    </Button>
                  </div>
                </>
              )
            ) : (
              <p className={ui.muted} style={{ margin: 0 }}>
                Once you&apos;ve read it, type or draw your name here.
              </p>
            )}
          </div>
        </li>
      </ol>
    </main>
  );
}
