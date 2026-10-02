"use client";

import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { EmailSettings } from "@/lib/email/mailer";
import { formatDateTime } from "@/lib/format";
import { useConfirm } from "@/components/confirm-dialog";

const PRESETS = {
  gmail: { label: "Gmail", host: "smtp.gmail.com", port: "465" },
  outlook: { label: "Outlook / Microsoft 365", host: "smtp.office365.com", port: "587" },
  other: { label: "Other", host: "", port: "587" },
} as const;

function EmailForm({ settings, onSaved }: { settings: EmailSettings; onSaved: (settings: EmailSettings) => void }) {
  const [preset, setPreset] = useState<keyof typeof PRESETS>(
    settings.host === "smtp.gmail.com" || !settings.host ? "gmail" : settings.host === "smtp.office365.com" ? "outlook" : "other",
  );
  const [host, setHost] = useState(settings.host ?? PRESETS.gmail.host);
  const [port, setPort] = useState(String(settings.port ?? PRESETS.gmail.port));
  const [username, setUsername] = useState(settings.username ?? "");
  const [password, setPassword] = useState("");
  const [fromAddress, setFromAddress] = useState(settings.fromAddress ?? "");
  const [fromName, setFromName] = useState(settings.fromName ?? "Tohyee");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  function choose(next: keyof typeof PRESETS) {
    setPreset(next);
    if (next !== "other") {
      setHost(PRESETS[next].host);
      setPort(PRESETS[next].port);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ email: EmailSettings }>("/api/admin/email", {
        method: "PUT",
        body: { host, port: Number(port), username, password: password || undefined, fromAddress: fromAddress || undefined, fromName },
      });
      setPassword("");
      onSaved(result.email);
      setMessage({ tone: "success", text: "Saved. Send a test email to check it works." });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)} style={{ display: "grid", gap: 12 }} autoComplete="off">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Field label="Email provider">
        <select value={preset} onChange={(event) => choose(event.target.value as keyof typeof PRESETS)}>
          {Object.entries(PRESETS).map(([value, entry]) => (
            <option key={value} value={value}>
              {entry.label}
            </option>
          ))}
        </select>
      </Field>
      {preset === "gmail" ? (
        <Notice tone="info">
          Gmail needs an <strong>app password</strong>, not your normal password: turn on 2-Step Verification for the Google account,
          then create an app password at myaccount.google.com → Security → App passwords, and paste its 16 letters below.
        </Notice>
      ) : null}
      {preset === "outlook" ? (
        <Notice tone="warning">
          Microsoft has been switching off password sign-in for sending email (SMTP) on Outlook and Microsoft 365 accounts, so this
          may not work. If the test email fails, use a Gmail account or an email service&apos;s SMTP details instead.
        </Notice>
      ) : null}
      <div className={ui.grid3}>
        <Field label="SMTP server">
          <input value={host} onChange={(event) => setHost(event.target.value.trim())} required readOnly={preset !== "other"} />
        </Field>
        <Field label="Port" hint="465 (SSL) or 587 (STARTTLS).">
          <input type="number" value={port} onChange={(event) => setPort(event.target.value)} required readOnly={preset !== "other"} />
        </Field>
        <Field label="Email account" hint="The address you sign in to the email account with.">
          <input type="email" value={username} onChange={(event) => setUsername(event.target.value.trim())} required />
        </Field>
        <Field label={preset === "gmail" ? "App password" : "Password"} hint={settings.hasPassword ? "Saved. Leave blank to keep it." : undefined}>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required={!settings.hasPassword} />
        </Field>
        <Field label="Send from" hint="Usually the same as the email account.">
          <input type="email" value={fromAddress} placeholder={username} onChange={(event) => setFromAddress(event.target.value.trim())} />
        </Field>
        <Field label="From name">
          <input value={fromName} onChange={(event) => setFromName(event.target.value)} maxLength={100} />
        </Field>
      </div>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !settings.secretsAvailable}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

export default function EmailSettingsPage() {
  const confirm = useConfirm();
  const { user } = useWorkspace();
  const settings = useApiData<{ email: EmailSettings }>(user.isServerAdmin ? "/api/admin/email" : null);
  const [current, setCurrent] = useState<EmailSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  if (!user.isServerAdmin) {
    return (
      <Page>
        <PageHeader title="Email" />
        <Notice tone="warning">Only server admins can set up email.</Notice>
      </Page>
    );
  }
  const email = current ?? settings.data?.email ?? null;

  async function test() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ to: string }>("/api/admin/email/test", { method: "POST" });
      setMessage({ tone: "success", text: `Test email sent to ${result.to}. Check your inbox (and spam).` });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!(await confirm("Remove the email settings? Security alerts and reset links stop being sent."))) return;
    setBusy(true);
    try {
      setCurrent((await api<{ email: EmailSettings }>("/api/admin/email", { method: "PUT", body: { clear: true } })).email);
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <PageHeader
        title="Email"
        description="The email account this server sends from: security alerts (two-step sign-in changes, backup codes used, locked accounts) and links to reset two-step sign-in when someone loses their phone."
      />
      {settings.error ? <Notice tone="error">{settings.error}</Notice> : null}
      {email ? (
        <Card
          title="Sending email"
          description={
            email.configured ? (
              <>
                <Badge tone="green">Set up</Badge> Sending as {email.fromAddress} through {email.host}
                {email.updatedAt ? ` · saved ${formatDateTime(email.updatedAt)}` : ""}
              </>
            ) : (
              "Not set up yet."
            )
          }
          actions={
            email.configured ? (
              <>
                <Button variant="secondary" onClick={() => void test()} disabled={busy}>
                  Send a test email
                </Button>
                <Button variant="danger" onClick={() => void clear()} disabled={busy}>
                  Remove
                </Button>
              </>
            ) : null
          }
        >
          {!email.secretsAvailable ? (
            <Notice tone="error">This server has no TOHYEE_SECRET_KEY, so the email password can&apos;t be stored. Set it and restart Tohyee.</Notice>
          ) : null}
          {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
          <EmailForm key={email.updatedAt ?? "new"} settings={email} onSaved={setCurrent} />
        </Card>
      ) : settings.error ? null : (
        <p className={ui.muted}>Loading…</p>
      )}
    </Page>
  );
}
