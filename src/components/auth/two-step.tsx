"use client";

import { type FormEvent, useEffect, useState } from "react";
import { Button, Field, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import styles from "./auth.module.css";

type Enrolment = { secret: string; otpauthUri: string; qrSvg: string };

/** Backup codes, shown once, with ways to keep them. */
export function BackupCodes({ codes, onDone, doneLabel = "I've saved them, continue" }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  const [saved, setSaved] = useState(false);
  const text = ["Tohyee backup codes. Each works once, instead of an authenticator code.", "", ...codes].join("\n");

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "tohyee-backup-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={styles.form}>
      <Notice tone="warning">
        Save these backup codes somewhere safe (not only on your phone). Each works once if you lose your phone. They won&apos;t be shown
        again.
      </Notice>
      <ol className={styles.codes} aria-label="Backup codes">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ol>
      <div className={styles.row}>
        <Button variant="secondary" onClick={download}>
          Download
        </Button>
        <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(text)}>
          Copy
        </Button>
        <Button variant="secondary" onClick={() => window.print()}>
          Print
        </Button>
      </div>
      <label className={styles.check}>
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
        I&apos;ve saved my backup codes
      </label>
      <Button disabled={!saved} onClick={onDone}>
        {doneLabel}
      </Button>
    </div>
  );
}

/** Setting up an authenticator app: QR code, then its first code, then backup codes. */
export function TwoStepEnrol({ email, onDone }: { email: string; onDone: () => void }) {
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);

  async function load(fresh = false) {
    setError(null);
    try {
      setEnrolment(await api<Enrolment>("/api/auth/two-step/enrol", { query: { fresh: fresh ? "true" : null } }));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  useEffect(() => {
    let cancelled = false;
    api<Enrolment>("/api/auth/two-step/enrol").then(
      (result) => {
        if (!cancelled) setEnrolment(result);
      },
      (caught) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") ?? "");
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ backupCodes: string[] }>("/api/auth/two-step/enrol", { method: "POST", body: { code } });
      setCodes(result.backupCodes);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (codes) {
    return (
      <>
        <div>
          <h1 className={styles.title}>Two-step sign-in is on</h1>
          <p className={styles.text}>From now on you&apos;ll sign in with your password and a code from your authenticator app.</p>
        </div>
        <BackupCodes codes={codes} onDone={onDone} />
      </>
    );
  }

  return (
    <>
      <div>
        <h1 className={styles.title}>Set up two-step sign-in</h1>
        <p className={styles.text}>
          Everyone on this server signs in with a password and a code from an authenticator app (Google Authenticator, Microsoft
          Authenticator, Authy, 1Password and so on) for {email}.
        </p>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {enrolment ? (
        <>
          <ol className={styles.steps}>
            <li>Open your authenticator app and add an account (usually a + button).</li>
            <li>Scan this QR code with it.</li>
          </ol>
          <div className={styles.qr} role="img" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: enrolment.qrSvg }} />
          <p className={styles.text}>
            Can&apos;t scan it?{" "}
            <button type="button" className={styles.linkButton} onClick={() => setShowKey((value) => !value)}>
              {showKey ? "Hide the key" : "Type the key instead"}
            </button>
          </p>
          {showKey ? (
            <p className={styles.key}>
              <code>{enrolment.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
              <span className={styles.text}> (time-based, 6 digits)</span>
            </p>
          ) : null}
          <form className={styles.form} onSubmit={(event) => void confirm(event)} autoComplete="off">
            <Field label="Enter the 6-digit code the app shows">
              <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required autoFocus />
            </Field>
            <Button type="submit" disabled={busy}>
              {busy ? "Checking…" : "Turn on two-step sign-in"}
            </Button>
          </form>
          <p className={styles.text}>
            <button type="button" className={styles.linkButton} onClick={() => void load(true)}>
              Make a new QR code
            </button>
          </p>
        </>
      ) : error ? null : (
        <p className={styles.text}>Loading…</p>
      )}
    </>
  );
}

/** The second step: an authenticator code or a backup code. */
export function TwoStepVerify({ email, emailResetAvailable, onDone }: { email: string; emailResetAvailable: boolean; onDone: () => void }) {
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lost, setLost] = useState(false);

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") ?? "");
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ usedBackupCode: boolean; backupCodesLeft: number }>("/api/auth/two-step/verify", {
        method: "POST",
        body: { code },
      });
      if (result.usedBackupCode && result.backupCodesLeft <= 3) {
        window.alert(
          `You have ${result.backupCodesLeft} backup ${result.backupCodesLeft === 1 ? "code" : "codes"} left. Make new ones under your profile.`,
        );
      }
      onDone();
    } catch (caught) {
      const message = errorMessage(caught);
      if (/sign in with your password again|locked|set up your authenticator app again/i.test(message)) {
        // This page is the sign-in page: reloading starts again from the password.
        window.alert(message);
        window.location.reload();
        return;
      }
      setError(message);
      setBusy(false);
    }
  }

  async function emailReset() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/two-step/email-reset", { method: "POST" });
      setNotice(`A reset link is on its way to ${email}. It works for 30 minutes.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div>
        <h1 className={styles.title}>Two-step sign-in</h1>
        <p className={styles.text}>
          {useBackup ? "Enter one of your backup codes." : "Enter the 6-digit code from your authenticator app."}
        </p>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      <form key={useBackup ? "backup" : "app"} className={styles.form} onSubmit={(event) => void verify(event)} autoComplete="off">
        {useBackup ? (
          <Field label="Backup code">
            <input name="code" autoComplete="off" placeholder="xxxxx-xxxxx" maxLength={12} required autoFocus />
          </Field>
        ) : (
          <Field label="Code">
            <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required autoFocus />
          </Field>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? "Checking…" : "Sign in"}
        </Button>
      </form>
      <p className={styles.text}>
        <button type="button" className={styles.linkButton} onClick={() => setUseBackup((value) => !value)}>
          {useBackup ? "Use my authenticator app" : "Use a backup code"}
        </button>
        {" · "}
        <button type="button" className={styles.linkButton} onClick={() => setLost((value) => !value)}>
          Lost your phone?
        </button>
      </p>
      {lost ? (
        <div className={styles.form}>
          <p className={styles.text}>
            Use a backup code if you have one. Otherwise{" "}
            {emailResetAvailable ? "we can email you a link to reset two-step sign-in, or " : ""}a server admin can reset it for you
            from Users.
          </p>
          {emailResetAvailable ? (
            <Button variant="secondary" disabled={busy} onClick={() => void emailReset()}>
              Email me a reset link
            </Button>
          ) : null}
        </div>
      ) : null}
      <p className={styles.text}>
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => void api("/api/auth/logout", { method: "POST" }).finally(() => window.location.reload())}
        >
          Use a different account
        </button>
      </p>
    </>
  );
}
