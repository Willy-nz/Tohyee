"use client";

import { useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { OrganisationEmailSettings, SendingMethod, SmtpSecurity } from "@/lib/email/settings";
import { EMAIL_KIND_LABELS, type EmailTemplate, PLACEHOLDERS } from "@/lib/email/templates";
import { formatDateTime, personName } from "@/lib/format";

/**
 * Settings › Email (admins): the organisation's own email account, which
 * invoices, quotes, credit notes, purchase orders and statements are sent
 * from (a Microsoft 365 / Outlook mailbox an admin signs in to, or any SMTP
 * account), and the templates each email starts with.
 */

type Preset = "gmail" | "microsoft" | "other";

const PRESETS: Record<Exclude<Preset, "other">, { host: string; port: number; security: SmtpSecurity }> = {
  gmail: { host: "smtp.gmail.com", port: 465, security: "ssl" },
  microsoft: { host: "smtp.office365.com", port: 587, security: "starttls" },
};

const SECURITY_LABELS: Record<SmtpSecurity, string> = {
  ssl: "SSL/TLS (usually port 465)",
  starttls: "STARTTLS (usually port 587)",
  none: "None (only a mail server on this computer)",
};

function presetOf(host: string | null): Preset {
  if (host === PRESETS.gmail.host) return "gmail";
  if (host === PRESETS.microsoft.host) return "microsoft";
  return host ? "other" : "gmail";
}

function PresetHelp({ preset }: { preset: Preset }) {
  if (preset === "gmail") {
    return (
      <Notice tone="info">
        <strong>Gmail and Google Workspace:</strong> Google doesn&apos;t let other apps use your normal password. Turn on 2-Step Verification for the
        Google account, then make an <strong>app password</strong> at{" "}
        <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
          myaccount.google.com/apppasswords
        </a>{" "}
        (call it &ldquo;Tohyee&rdquo;) and paste its 16 letters below. The username is the full Gmail address. Gmail sends from that address; to send
        from another address (like accounts@yourbusiness.co.nz), add it in Gmail first under Settings › Accounts › &ldquo;Send mail as&rdquo;. A Google
        Workspace admin may need to allow app passwords. Gmail sends up to about 500 emails a day from a personal account.
      </Notice>
    );
  }
  if (preset === "microsoft") {
    return (
      <Notice tone="info">
        <strong>Microsoft 365 with a password:</strong> Microsoft is retiring passwords for this kind of sending, and personal Outlook.com and Hotmail
        accounts already refuse them, so choose <strong>Microsoft 365 / Outlook (sign in)</strong> above instead where you can. If you still use a
        password: the mailbox&apos;s email address and password (or an app password), and a Microsoft 365 admin must turn on{" "}
        <strong>Authenticated SMTP</strong> for this mailbox (Microsoft 365 admin centre › Users › the user › Mail › Manage email apps).
      </Notice>
    );
  }
  return (
    <Notice tone="info">
      <strong>Any other email provider:</strong> use the outgoing (SMTP) server details from your provider or website host, usually port 465 with SSL/TLS
      or port 587 with STARTTLS. Many providers offer app passwords; use one if they do.
    </Notice>
  );
}

function AccountForm({ organisationId, settings, onSaved }: { organisationId: string; settings: OrganisationEmailSettings; onSaved: (message: string) => void }) {
  const [preset, setPreset] = useState<Preset>(presetOf(settings.host));
  const replacesMicrosoft = settings.sendingMethod === "microsoft" && settings.microsoft !== null;
  const [fromName, setFromName] = useState(settings.fromName ?? "");
  const [fromAddress, setFromAddress] = useState(settings.fromAddress ?? "");
  const [replyTo, setReplyTo] = useState(settings.replyTo ?? "");
  const [host, setHost] = useState(settings.host ?? PRESETS.gmail.host);
  const [port, setPort] = useState(String(settings.port ?? PRESETS.gmail.port));
  const [security, setSecurity] = useState<SmtpSecurity>(settings.security ?? PRESETS.gmail.security);
  const [username, setUsername] = useState(settings.username ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function choose(next: Preset) {
    setPreset(next);
    if (next !== "other") {
      setHost(PRESETS[next].host);
      setPort(String(PRESETS[next].port));
      setSecurity(PRESETS[next].security);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/email/settings", {
        method: "PUT",
        body: { organisationId, fromName, fromAddress: fromAddress || username, replyTo, host, port, security, username, password },
      });
      onSaved("Saved. Send a test email to check it works.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("Remove this email account? Documents can't be emailed until one is set up again. Emails already sent stay in each document's history.")) return;
    setError(null);
    try {
      await api("/api/email/settings", { method: "PUT", body: { organisationId, clear: true } });
      onSaved("Removed.");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!settings.secretsAvailable ? (
        <Notice tone="error">This server has no TOHYEE_SECRET_KEY, so it can&apos;t keep an email password safely. A server admin needs to set it first.</Notice>
      ) : null}
      {replacesMicrosoft ? (
        <Notice tone="info">Documents are sent from the Microsoft mailbox {settings.microsoft?.email} now. Saving SMTP details here switches to SMTP.</Notice>
      ) : null}
      {settings.hasPassword && !settings.passwordReadable ? (
        <Notice tone="warning">The saved password can&apos;t be read on this server any more (was the server&apos;s key changed?). Enter it again.</Notice>
      ) : null}
      <Field label="Email account">
        <select value={preset} onChange={(event) => choose(event.target.value as Preset)}>
          <option value="gmail">Gmail or Google Workspace</option>
          <option value="microsoft">Microsoft 365 with a password</option>
          <option value="other">Other (any SMTP server)</option>
        </select>
      </Field>
      <PresetHelp preset={preset} />
      <div className={ui.grid3}>
        <Field label="From name" hint="What customers see, usually the business name.">
          <input value={fromName} onChange={(event) => setFromName(event.target.value)} maxLength={100} required />
        </Field>
        <Field label="From address" hint="Blank uses the username.">
          <input type="email" value={settings.sendingMethod === "microsoft" && fromAddress === settings.microsoft?.email ? "" : fromAddress} onChange={(event) => setFromAddress(event.target.value)} maxLength={254} placeholder={username} />
        </Field>
        <Field label="Reply-to address" hint="Optional. Where replies go, if not the from address.">
          <input type="email" value={replyTo} onChange={(event) => setReplyTo(event.target.value)} maxLength={254} />
        </Field>
      </div>
      <div className={ui.grid3}>
        <Field label="SMTP server">
          <input value={host} onChange={(event) => setHost(event.target.value)} disabled={preset !== "other"} required />
        </Field>
        <Field label="Port">
          <input inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} disabled={preset !== "other"} required />
        </Field>
        <Field label="Security">
          <select value={security} onChange={(event) => setSecurity(event.target.value as SmtpSecurity)} disabled={preset !== "other"}>
            {(Object.keys(SECURITY_LABELS) as SmtpSecurity[]).map((value) => (
              <option key={value} value={value}>
                {SECURITY_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className={ui.grid2}>
        <Field label="Username" hint="Usually the full email address.">
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" maxLength={254} required />
        </Field>
        <Field
          label={preset === "gmail" ? "App password" : "Password"}
          hint={settings.hasPassword ? "Saved, and never shown again. Leave blank to keep it." : "Stored encrypted on this server; never shown again."}
        >
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" maxLength={500} />
        </Field>
      </div>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !settings.secretsAvailable}>
          Save
        </Button>
        {settings.hasPassword || settings.microsoft ? (
          <Button variant="danger" onClick={() => void remove()}>
            Remove everything
          </Button>
        ) : null}
      </div>
    </form>
  );
}

const METHOD_LABELS: Record<SendingMethod, string> = {
  microsoft: "Microsoft 365 / Outlook (sign in)",
  smtp: "SMTP: Gmail, or any email provider, with a password",
};

/** The organisation's Microsoft app (shared with the CRM's mail sync), which the mailbox signs in through. */
function MicrosoftAppForm({ organisationId, settings, onSaved }: { organisationId: string; settings: OrganisationEmailSettings; onSaved: (message: string) => void }) {
  const [clientId, setClientId] = useState(settings.microsoftApp.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [tenant, setTenant] = useState(settings.microsoftApp.tenant);
  const [error, setError] = useState<string | null>(null);
  const redirect = typeof window === "undefined" ? "/api/email/microsoft/callback" : `${window.location.origin}/api/email/microsoft/callback`;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      await api("/api/crm/mail/settings", { method: "PUT", body: { organisationId, microsoftClientId: clientId, microsoftClientSecret: secret, microsoftTenant: tenant } });
      onSaved("Microsoft app saved. Now connect the mailbox.");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      <Notice tone="info">
        <strong>1. The organisation&apos;s Microsoft app.</strong> Tohyee signs in through an app you register once, so no one else&apos;s app ever has access. In
        the Microsoft Entra admin centre (entra.microsoft.com) › App registrations › New registration: any name (&ldquo;Tohyee&rdquo;); for a business
        mailbox choose &ldquo;Accounts in this organizational directory only&rdquo; and put your domain as the tenant below, or for Outlook.com choose
        &ldquo;Accounts in any organizational directory and personal Microsoft accounts&rdquo; and leave the tenant as common. Add a <strong>Web</strong> redirect
        URI of <code>{redirect}</code>. Under API permissions add Microsoft Graph delegated permissions <strong>Mail.Send</strong>, User.Read and
        offline_access. Under Certificates &amp; secrets make a client secret and paste its value below. The CRM&apos;s email sync uses the same app.
      </Notice>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Application (client) ID">
          <input value={clientId} onChange={(event) => setClientId(event.target.value)} maxLength={300} autoComplete="off" />
        </Field>
        <Field label="Client secret" hint={settings.microsoftApp.secretSaved ? "Saved, and never shown again. Leave blank to keep it." : "Stored encrypted on this server."}>
          <input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} maxLength={500} autoComplete="new-password" />
        </Field>
        <Field label="Tenant" hint="common, or your domain (like glimmers.onmicrosoft.com).">
          <input value={tenant} onChange={(event) => setTenant(event.target.value)} maxLength={100} />
        </Field>
      </div>
      <div className={ui.actions}>
        <Button type="submit" variant="secondary" disabled={!settings.secretsAvailable}>
          Save Microsoft app
        </Button>
      </div>
    </form>
  );
}

/** Step 2: signing in to the mailbox, its from name and reply-to, and disconnecting. */
function MicrosoftMailbox({ organisationId, settings, onSaved }: { organisationId: string; settings: OrganisationEmailSettings; onSaved: (message: string) => void }) {
  const [fromName, setFromName] = useState(settings.fromName ?? "");
  const [replyTo, setReplyTo] = useState(settings.replyTo ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const appReady = Boolean(settings.microsoftApp.clientId) && settings.microsoftApp.secretSaved;
  const mailbox = settings.microsoft;
  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>("/api/email/microsoft/connect", { method: "POST", body: { organisationId } });
      window.location.assign(url);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }
  async function disconnect() {
    if (!window.confirm(`Disconnect ${mailbox?.email}? Documents can't be emailed through it until it's connected again.`)) return;
    setError(null);
    try {
      await api("/api/email/microsoft/disconnect", { method: "POST", body: { organisationId } });
      onSaved(settings.smtpSaved ? "Disconnected. Documents are sent by SMTP again." : "Disconnected.");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  async function use(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      await api("/api/email/settings", { method: "PUT", body: { organisationId, sendingMethod: "microsoft", fromName, replyTo } });
      onSaved(settings.sendingMethod === "microsoft" ? "Saved." : `Documents are now sent from ${mailbox?.email}.`);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Notice tone="info">
        <strong>2. The mailbox.</strong> An admin signs in to the mailbox documents should come from, once. Tohyee can then only send as it (Mail.Send);
        it can&apos;t read it. Sent emails also appear in its Sent Items.
      </Notice>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {mailbox ? (
        <>
          <p style={{ margin: 0 }}>
            Connected: <strong>{mailbox.email}</strong>{" "}
            <span className={ui.muted}>
              by {personName(mailbox, "connectedBy")} on {formatDateTime(mailbox.connectedAt)}
            </span>
          </p>
          {!mailbox.tokensReadable ? <Notice tone="warning">The mailbox&apos;s sign-in can&apos;t be read on this server any more. Connect it again.</Notice> : null}
          <form onSubmit={(event) => void use(event)} style={{ display: "grid", gap: 12 }}>
            <div className={ui.grid2}>
              <Field label="From name" hint="Microsoft shows the mailbox's own display name; this is used in Tohyee's emails and history.">
                <input value={fromName} onChange={(event) => setFromName(event.target.value)} maxLength={100} required />
              </Field>
              <Field label="Reply-to address" hint="Optional. Where replies go, if not the mailbox.">
                <input type="email" value={replyTo} onChange={(event) => setReplyTo(event.target.value)} maxLength={254} />
              </Field>
            </div>
            <div className={ui.actions}>
              <Button type="submit">{settings.sendingMethod === "microsoft" ? "Save" : "Send from this mailbox"}</Button>
              <Button variant="secondary" onClick={() => void connect()} disabled={busy || !appReady}>
                Connect another mailbox
              </Button>
              <Button variant="danger" onClick={() => void disconnect()}>
                Disconnect
              </Button>
            </div>
          </form>
        </>
      ) : (
        <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
          <Button onClick={() => void connect()} disabled={busy || !appReady || !settings.secretsAvailable}>
            Connect Microsoft account
          </Button>
          {!appReady ? <span className={ui.muted}>Save the Microsoft app first.</span> : null}
        </div>
      )}
    </div>
  );
}

function TestEmail({ organisationId, settings, onTested }: { organisationId: string; settings: OrganisationEmailSettings; onTested: () => void }) {
  const { user } = useWorkspace();
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; error: string | null; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api<{ ok: boolean; error: string | null; to: string }>("/api/email/settings/test", { method: "POST", body: { organisationId, to: to || null } }));
      onTested();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Send a test email" description="Checks the account works by sending a short email now.">
      {settings.lastTest ? (
        <p className={ui.muted} style={{ margin: 0 }}>
          Last test {formatDateTime(settings.lastTest.at)}: {settings.lastTest.ok ? "sent" : `failed. ${settings.lastTest.error ?? ""}`}
        </p>
      ) : null}
      <div className={ui.inlineForm}>
        <Field label="Send it to" hint={`Blank sends it to you${user?.email ? ` (${user.email})` : ""}.`}>
          <input type="email" value={to} onChange={(event) => setTo(event.target.value)} />
        </Field>
        <Button onClick={() => void send()} disabled={busy || !settings.configured}>
          {busy ? "Sending…" : "Send test email"}
        </Button>
      </div>
      {result?.ok ? <Notice tone="success">Sent to {result.to}. Check that it arrived (and isn&apos;t in spam).</Notice> : null}
      {result && !result.ok ? <Notice tone="error">{result.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Card>
  );
}

function TemplateForm({ organisationId, template, onSaved }: { organisationId: string; template: EmailTemplate; onSaved: (message: string) => void }) {
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [error, setError] = useState<string | null>(null);
  async function save(reset: boolean) {
    setError(null);
    try {
      await api("/api/email/templates", { method: "PUT", body: { organisationId, kind: template.kind, subject, body, reset } });
      onSaved(reset ? `${EMAIL_KIND_LABELS[template.kind]}: back to Tohyee's template.` : `${EMAIL_KIND_LABELS[template.kind]}: template saved.`);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  return (
    <section style={{ display: "grid", gap: 8, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
      <h3 style={{ margin: 0, fontSize: "1rem" }}>
        {EMAIL_KIND_LABELS[template.kind]} {template.isDefault ? <Badge>Tohyee&apos;s template</Badge> : <Badge tone="blue">Changed</Badge>}
      </h3>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Subject">
        <input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={250} />
      </Field>
      <Field label="Message" hint={`Fills in: ${PLACEHOLDERS[template.kind].map((name) => `{${name}}`).join(", ")}`}>
        <textarea rows={8} value={body} onChange={(event) => setBody(event.target.value)} maxLength={10000} />
      </Field>
      <div className={ui.actions}>
        <Button size="small" onClick={() => void save(false)}>
          Save template
        </Button>
        {!template.isDefault ? (
          <Button size="small" variant="secondary" onClick={() => void save(true)}>
            Use Tohyee&apos;s template
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function EmailSettings({ organisationId }: { organisationId: string }) {
  const loaded = useApiData<{ settings: OrganisationEmailSettings; templates: EmailTemplate[] }>("/api/email/settings", { organisationId });
  const [message, setMessage] = useState<string | null>(null);
  const [choice, setChoice] = useState<SendingMethod | null>(null);
  // Coming back from Microsoft's sign-in (?connected= or ?error=).
  const params = useSearchParams();
  const connected = params.get("connected");
  const problem = message ? null : params.get("error");
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  const { settings, templates } = loaded.data;
  const method = choice ?? settings.sendingMethod;
  const saved = (text: string) => {
    setMessage(text);
    loaded.reload();
  };
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {!message && connected ? <Notice tone="success">Connected {connected}. Documents are now sent from it; send a test email to check.</Notice> : null}
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      <Card
        title="Email account"
        description="Invoices, quotes, credit notes, purchase orders and statements are emailed from this account, so they come from your address and replies come back to you."
        actions={settings.configured ? <Badge tone="green">Sending with {settings.sendingMethod === "microsoft" ? "Microsoft" : "SMTP"}</Badge> : <Badge tone="amber">Not set up</Badge>}
      >
        {settings.updatedAt ? (
          <p className={ui.muted} style={{ margin: 0 }}>
            Saved by {personName(settings, "updatedBy")} on {formatDateTime(settings.updatedAt)}.
          </p>
        ) : null}
        <Field label="How documents are sent">
          <select value={method} onChange={(event) => setChoice(event.target.value as SendingMethod)}>
            {(Object.keys(METHOD_LABELS) as SendingMethod[]).map((value) => (
              <option key={value} value={value}>
                {METHOD_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
        {method === "microsoft" ? (
          <div style={{ display: "grid", gap: 16 }}>
            <MicrosoftAppForm key={`app:${settings.microsoftApp.clientId ?? ""}:${settings.microsoftApp.tenant}`} organisationId={organisationId} settings={settings} onSaved={saved} />
            <MicrosoftMailbox key={`mailbox:${settings.updatedAt ?? "new"}`} organisationId={organisationId} settings={settings} onSaved={saved} />
            <p className={ui.muted} style={{ margin: 0 }}>
              Google accounts can&apos;t sign in this way yet: use SMTP with an app password for Gmail.
            </p>
          </div>
        ) : (
          <AccountForm key={settings.updatedAt ?? "new"} organisationId={organisationId} settings={settings} onSaved={saved} />
        )}
      </Card>
      <TestEmail key={`test-${settings.updatedAt ?? "new"}`} organisationId={organisationId} settings={settings} onTested={loaded.reload} />
      <Card
        title="Email templates"
        description="The subject and message each email starts with. The person sending can still change them. Words in braces are filled in from the document."
      >
        {templates.map((template) => (
          <TemplateForm key={`${template.kind}:${template.subject}:${template.body}`} organisationId={organisationId} template={template} onSaved={saved} />
        ))}
      </Card>
    </>
  );
}

export default function EmailSettingsPage() {
  return (
    <Page>
      <PageHeader title="Email" description="Send documents from the organisation's own email account." />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <EmailSettings organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
