"use client";

import { type FormEvent, useState } from "react";
import { BackupCodes } from "@/components/auth/two-step";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { api, errorMessage } from "@/lib/client/api";
import type { SignedInSession } from "@/lib/auth/session-list";
import type { TwoStepStatus } from "@/lib/auth/two-step";
import { formatDateTime } from "@/lib/format";

/** Two-step sign-in status, and new backup codes (which need a current authenticator code). */
function TwoStepCard() {
  const status = useApiData<{ status: TwoStepStatus }>("/api/auth/two-step");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function regenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const code = new FormData(formElement).get("code");
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ backupCodes: string[] }>("/api/auth/two-step/backup-codes", { method: "POST", body: { code } });
      formElement.reset();
      setCodes(result.backupCodes);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const current = status.data?.status;
  return (
    <Card title="Two-step sign-in" description="You sign in with your password and a code from your authenticator app.">
      {status.error ? <Notice tone="error">{status.error}</Notice> : null}
      {current ? (
        current.enabled ? (
          <p>
            <Badge tone="green">On</Badge> since {formatDateTime(current.enabledAt)} · {current.backupCodesLeft} backup{" "}
            {current.backupCodesLeft === 1 ? "code" : "codes"} left
          </p>
        ) : (
          <Notice tone="warning">
            {current.required
              ? "Two-step sign-in isn't set up yet. You'll be asked to set it up the next time you sign in."
              : "Two-step sign-in is off on this server because TOHYEE_SECRET_KEY isn't set. A server admin needs to set it."}
          </Notice>
        )
      ) : null}
      {codes ? (
        <BackupCodes codes={codes} doneLabel="Done" onDone={() => {
          setCodes(null);
          status.reload();
        }} />
      ) : current?.enabled ? (
        <form onSubmit={(event) => void regenerate(event)} style={{ display: "grid", gap: 12, maxWidth: 420 }} autoComplete="off">
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Field label="New backup codes" hint="Enter the code your authenticator app shows now. Your old backup codes stop working.">
            <input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required placeholder="6-digit code" />
          </Field>
          <div>
            <Button type="submit" variant="secondary" disabled={busy}>
              {busy ? "Checking…" : "Make new backup codes"}
            </Button>
          </div>
          <p className={ui.muted}>
            New phone? Ask a server admin to reset your two-step sign-in, then set it up on the new phone at your next sign-in.
          </p>
        </form>
      ) : null}
    </Card>
  );
}

/** Where you're signed in (#208): sign out a lost phone, or everywhere else. */
function SessionsCard() {
  const sessions = useApiData<{ sessions: SignedInSession[] }>("/api/auth/sessions");
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  async function end(id: string, text: string) {
    try {
      await api("/api/auth/sessions", { method: "DELETE", body: { id } });
      setStatus({ tone: "success", text });
      sessions.reload();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }
  const list = sessions.data?.sessions ?? [];
  return (
    <Card title="Where you're signed in" description="If you don't recognise one, sign it out and change your password.">
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {sessions.error ? <Notice tone="error">{sessions.error}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Browser</th>
              <th>Address</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((session) => (
              <tr key={session.id}>
                <td style={{ overflowWrap: "anywhere" }}>
                  {session.userAgent ?? "Unknown"} {session.current ? <Badge tone="blue">This one</Badge> : null}
                </td>
                <td>{session.address ?? ""}</td>
                <td>{formatDateTime(session.lastSeenAt)}</td>
                <td className={ui.num}>
                  {session.current ? null : (
                    <Button variant="secondary" size="small" onClick={() => void end(session.id, "Signed out.")}>
                      Sign out
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length > 1 ? (
        <Button variant="secondary" onClick={() => void end("others", "Signed out everywhere else.")}>
          Sign out everywhere else
        </Button>
      ) : null}
    </Card>
  );
}

export default function ProfilePage() {
  const { user, organisations } = useWorkspace();
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    if (form.get("newPassword") !== form.get("confirmPassword")) {
      setStatus({ tone: "error", text: "The new passwords don't match." });
      return;
    }
    try {
      await api("/api/auth/password", {
        method: "POST",
        body: { currentPassword: form.get("currentPassword"), newPassword: form.get("newPassword") },
      });
      formElement.reset();
      setStatus({ tone: "success", text: "Password changed. Your other sessions have been signed out." });
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }

  return (
    <Page>
      <PageHeader title="Your account" description={`${user.displayName} · ${user.email}${user.isServerAdmin ? " · server admin" : ""}`} />
      <Card title="Organisations you can open">
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Organisation</th>
                <th>Your role</th>
                <th>Base currency</th>
              </tr>
            </thead>
            <tbody>
              {organisations.map((organisation) => (
                <tr key={organisation.id}>
                  <td>{organisation.displayName}</td>
                  <td>{ROLE_LABELS[organisation.role]}</td>
                  <td>{organisation.baseCurrency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <TwoStepCard />
      <SessionsCard />
      <Card title="Change password">
        {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
        <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12, maxWidth: 420 }}>
          <Field label="Current password">
            <input name="currentPassword" type="password" autoComplete="current-password" required />
          </Field>
          <Field label="New password" hint="At least 10 characters.">
            <input name="newPassword" type="password" autoComplete="new-password" minLength={10} required />
          </Field>
          <Field label="Confirm new password">
            <input name="confirmPassword" type="password" autoComplete="new-password" minLength={10} required />
          </Field>
          <div>
            <Button type="submit">Change password</Button>
          </div>
        </form>
      </Card>
    </Page>
  );
}
