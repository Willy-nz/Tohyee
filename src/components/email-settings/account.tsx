"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ChoiceTiles } from "@/components/choice-tiles";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { InfoPara, InfoTip } from "@/components/info-tip";
import { SetupProgress } from "@/components/store-setup";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import {
  accountProblem,
  appSaved,
  EMAIL_SETUP_STEPS,
  type EmailSetupStep,
  emailStepNames,
  firstSetupStep,
  PROVIDER_NAMES,
  sendingAddress,
} from "@/lib/email/setup";
import type { OrganisationEmailSettings, SendingMethod, SmtpSecurity } from "@/lib/email/settings";
import { formatDateTime } from "@/lib/format";
import wizard from "@/components/store-setup.module.css";
import styles from "./email-settings.module.css";

/**
 * Settings › Email › Account (decisions 1391-1394): how the organisation's
 * documents are sent. Not set up yet, it's a guided setup, one step at a
 * time (provider, the provider's app or server, signing in to the mailbox,
 * a test email, done); each step saves only when its own action works, with
 * the same APIs as before. Set up, it's one summary line with Send test
 * email, Change (the same steps) and Disconnect.
 */

type Settings = OrganisationEmailSettings;
type Loaded = { settings: Settings };
type Preset = "gmail" | "microsoft" | "other";
type SmtpDraft = { preset: Preset; host: string; port: string; security: SmtpSecurity };

const SIGN_IN_KEY = "tohyee.emailSignIn";

const PRESETS: Record<Exclude<Preset, "other">, { host: string; port: number; security: SmtpSecurity }> = {
  gmail: { host: "smtp.gmail.com", port: 465, security: "ssl" },
  microsoft: { host: "smtp.office365.com", port: 587, security: "starttls" },
};

const SECURITY_LABELS: Record<SmtpSecurity, string> = {
  ssl: "SSL/TLS (usually port 465)",
  starttls: "STARTTLS (usually port 587)",
  none: "None (a mail server on this computer only)",
};

const PROVIDER_TILES: Record<SendingMethod, { title: string; text: string }> = {
  microsoft: { title: "Microsoft 365", text: "Outlook and Microsoft 365 mailboxes. Sign in." },
  google: { title: "Google", text: "Gmail and Google Workspace. Sign in." },
  smtp: { title: "Any provider (SMTP)", text: "Any email account, with a password." },
};

function presetOf(host: string | null): Preset {
  if (host === PRESETS.gmail.host) return "gmail";
  if (host === PRESETS.microsoft.host) return "microsoft";
  return host ? "other" : "gmail";
}

function smtpDraft(settings: Settings): SmtpDraft {
  const preset = presetOf(settings.host);
  return {
    preset,
    host: settings.host ?? PRESETS.gmail.host,
    port: String(settings.port ?? PRESETS.gmail.port),
    security: settings.security ?? PRESETS.gmail.security,
  };
}

function rememberedSignIn(): "microsoft" | "google" | null {
  try {
    const value = window.sessionStorage.getItem(SIGN_IN_KEY);
    return value === "microsoft" || value === "google" ? value : null;
  } catch {
    return null;
  }
}

export function EmailAccount({ organisationId }: { organisationId: string }) {
  const loaded = useApiData<Loaded>("/api/email/settings", { organisationId });
  const [fresh, setFresh] = useState<Settings | null>(null);
  const [editing, setEditing] = useState(false);
  const [finished, setFinished] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const params = useSearchParams();
  const router = useRouter();
  // Coming back from Microsoft's or Google's sign-in (?connected= or ?error=).
  const returned = finished ? null : params.get("connected") ? "connected" : params.get("error") ? "error" : null;
  const settings = fresh ?? loaded.data?.settings ?? null;

  async function refresh(): Promise<Settings> {
    const data = await api<Loaded>("/api/email/settings", { query: { organisationId } });
    setFresh(data.settings);
    return data.settings;
  }

  if (loaded.error && !settings) return <Notice tone="error">{loaded.error}</Notice>;
  if (!settings) return <p className={ui.muted}>Loading…</p>;

  const close = (text: string | null) => {
    setEditing(false);
    setFinished(true);
    setMessage(text);
    if (returned) router.replace("/operations/settings/email");
  };

  if (editing || !settings.configured || returned) {
    return (
      <Card title="Email account">
        <EmailSetup
          organisationId={organisationId}
          settings={settings}
          refresh={async () => {
            // Once a step has saved, the account counts as set up: keep the steps open until the person finishes.
            setEditing(true);
            return refresh();
          }}
          returned={returned ? { kind: returned, text: params.get(returned) ?? "" } : null}
          changing={settings.configured}
          onClose={close}
        />
      </Card>
    );
  }
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <AccountSummary
        organisationId={organisationId}
        settings={settings}
        refresh={refresh}
        onChange={() => {
          setMessage(null);
          setEditing(true);
        }}
        onMessage={setMessage}
      />
    </>
  );
}

// The connected summary ---------------------------------------------------------------

function AccountSummary({
  organisationId,
  settings,
  refresh,
  onChange,
  onMessage,
}: {
  organisationId: string;
  settings: Settings;
  refresh: () => Promise<Settings>;
  onChange: () => void;
  onMessage: (text: string | null) => void;
}) {
  const confirm = useConfirm();
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const method = settings.sendingMethod;
  const address = sendingAddress(settings) ?? "";
  const problem = accountProblem(settings);
  const via = method === "smtp" && settings.host ? `SMTP (${settings.host})` : PROVIDER_NAMES[method];

  async function disconnect() {
    const ok = await confirm(
      method === "smtp"
        ? `Disconnect ${address}? This removes the saved email account. Documents can't be emailed until one is set up again.`
        : `Disconnect ${address}? Documents can't be emailed through it until it's connected again.`,
      { title: "Disconnect email account", confirmLabel: "Disconnect", danger: true },
    );
    if (!ok) return;
    setError(null);
    try {
      if (method === "smtp") {
        await api("/api/email/settings", { method: "PUT", body: { organisationId, clear: true } });
        await refresh();
        onMessage("Disconnected.");
      } else {
        await api(`/api/email/${method}/disconnect`, { method: "POST", body: { organisationId } });
        const after = await refresh();
        onMessage(after.configured ? `Disconnected. Documents are sent by ${PROVIDER_NAMES[after.sendingMethod]} now.` : "Disconnected.");
      }
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Card title="Email account">
      <div className={styles.summary}>
        <div className={styles.summaryText}>
          <p className={styles.summaryLine}>
            Sending as <strong>{address}</strong> via {via} · {problem ? <Badge tone="amber">Needs attention</Badge> : <Badge tone="green">Connected</Badge>}
          </p>
          <p className={styles.summaryMeta}>
            From name: {settings.fromName}
            {settings.replyTo ? ` · Replies to ${settings.replyTo}` : ""}
            {settings.lastTest?.ok ? ` · Tested ${formatDateTime(settings.lastTest.at)}` : ""}
          </p>
        </div>
        <div className={ui.actions}>
          <Button variant="secondary" onClick={() => setTesting((open) => !open)} aria-expanded={testing}>
            Send test email
          </Button>
          <Button variant="secondary" onClick={onChange}>
            Change
          </Button>
          <Button variant="danger" onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </div>
      </div>
      {problem ? <Notice tone="warning">{problem}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {testing ? <TestEmailForm organisationId={organisationId} settings={settings} onTested={() => void refresh().catch(() => undefined)} inline /> : null}
    </Card>
  );
}

// The guided setup ----------------------------------------------------------------------

function EmailSetup({
  organisationId,
  settings,
  refresh,
  returned,
  changing: wasSetUp,
  onClose,
}: {
  organisationId: string;
  settings: Settings;
  refresh: () => Promise<Settings>;
  returned: { kind: "connected" | "error"; text: string } | null;
  /** An account is already set up: the person can cancel, and it's used until they finish. */
  changing: boolean;
  onClose: (message: string | null) => void;
}) {
  const confirm = useConfirm();
  const [changing] = useState(wasSetUp);
  const [start] = useState(() => firstSetupStep(settings, returned?.kind ?? null, returned ? rememberedSignIn() : null));
  const [step, setStep] = useState<EmailSetupStep>(start.step);
  const [provider, setProvider] = useState<SendingMethod>(start.provider);
  const [smtp, setSmtp] = useState<SmtpDraft>(() => smtpDraft(settings));
  const [tested, setTested] = useState(false);
  const [returnNotice, setReturnNotice] = useState(returned);
  const heading = useRef<HTMLHeadingElement>(null);
  const names = emailStepNames(provider);
  const at = EMAIL_SETUP_STEPS.indexOf(step);

  // Each new step's heading takes focus, so a screen reader hears where it is.
  const shown = useRef(step);
  useEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    heading.current?.focus();
  }, [step]);

  const go = (next: EmailSetupStep) => {
    setReturnNotice(null);
    setStep(next);
  };
  const back = at > 0 && step !== "done" ? () => go(EMAIL_SETUP_STEPS[at - 1]) : undefined;
  const cancel = changing && step !== "done"
    ? async () => {
        if (step !== "provider" && step !== "test" && !(await confirm("Stop changing the email account? Anything not saved yet is lost.", { confirmLabel: "Stop" }))) return;
        onClose(null);
      }
    : undefined;
  const nav: StepNav = { back, cancel: cancel ? () => void cancel() : undefined };
  const stillSending = changing && provider !== settings.sendingMethod && (step === "details" || step === "mailbox");

  let body: ReactNode;
  if (step === "provider") {
    body = <ProviderStep provider={provider} onChange={setProvider} nav={nav} onNext={() => go("details")} />;
  } else if (step === "details") {
    body =
      provider === "smtp" ? (
        <SmtpServerStep draft={smtp} onChange={setSmtp} nav={nav} onNext={() => go("mailbox")} />
      ) : (
        <AppStep key={provider} provider={provider} organisationId={organisationId} settings={settings} refresh={refresh} nav={nav} onNext={() => go("mailbox")} />
      );
  } else if (step === "mailbox") {
    body =
      provider === "smtp" ? (
        <SmtpAccountStep organisationId={organisationId} settings={settings} server={smtp} refresh={refresh} nav={nav} onNext={() => go("test")} />
      ) : (
        <MailboxStep key={provider} provider={provider} organisationId={organisationId} settings={settings} refresh={refresh} nav={nav} onNext={() => go("test")} />
      );
  } else if (step === "test") {
    body = (
      <>
        <TestEmailForm
          organisationId={organisationId}
          settings={settings}
          primary={!tested}
          onTested={(ok) => {
            if (ok) setTested(true);
            void refresh().catch(() => undefined);
          }}
        />
        <StepFooter nav={nav}>
          <Button variant={tested ? "primary" : "secondary"} onClick={() => go("done")}>
            {tested ? "Next" : "Skip"}
          </Button>
        </StepFooter>
      </>
    );
  } else {
    body = <DoneStep settings={settings} onFinish={() => onClose(`Email is set up. Documents are sent from ${sendingAddress(settings) ?? "the new account"}.`)} />;
  }

  const done = (candidate: EmailSetupStep) => EMAIL_SETUP_STEPS.indexOf(candidate) < at;

  return (
    <div className={wizard.wizard}>
      <SetupProgress steps={EMAIL_SETUP_STEPS} names={names} current={step} done={done} />
      {returnNotice?.kind === "connected" ? <Notice tone="success">Signed in as {returnNotice.text}.</Notice> : null}
      {returnNotice?.kind === "error" ? <Notice tone="error">{returnNotice.text}</Notice> : null}
      {stillSending ? <Notice tone="info">Still sending with {PROVIDER_NAMES[settings.sendingMethod]} until you finish.</Notice> : null}
      {!settings.secretsAvailable ? (
        <Notice tone="error">
          This server can&apos;t keep passwords safely yet.{" "}
          <InfoTip label="Server key missing">The server has no TOHYEE_SECRET_KEY. A server admin needs to set it before email can be set up.</InfoTip>
        </Notice>
      ) : null}
      <div className={styles.stepHead}>
        <h3 className={wizard.stepTitle} ref={heading} tabIndex={-1}>
          {stepTitle(step, provider)}
        </h3>
        <AdminBadge step={step} provider={provider} preset={smtp.preset} />
      </div>
      {body}
    </div>
  );
}

function stepTitle(step: EmailSetupStep, provider: SendingMethod): string {
  switch (step) {
    case "provider":
      return "Who provides your email?";
    case "details":
      return provider === "microsoft" ? "Microsoft app details" : provider === "google" ? "Google app details" : "Mail server";
    case "mailbox":
      return provider === "smtp" ? "Account and sender" : "Sign in to the mailbox";
    case "test":
      return "Send a test email";
    case "done":
      return "All set";
  }
}

/** Which steps need someone with admin rights at the email provider (not in Tohyee: everyone here is a Tohyee admin). */
function AdminBadge({ step, provider, preset }: { step: EmailSetupStep; provider: SendingMethod; preset: Preset }) {
  if (step === "details" && provider === "microsoft") {
    return (
      <span>
        <Badge tone="blue">Microsoft 365 admin</Badge>{" "}
        <InfoTip label="Who does this step">
          Registering an app in Microsoft Entra needs a Microsoft 365 admin. Anyone with the mailbox&apos;s password can do the other steps.
        </InfoTip>
      </span>
    );
  }
  if (step === "details" && provider === "google") {
    return (
      <span>
        <Badge tone="blue">Google admin</Badge>{" "}
        <InfoTip label="Who does this step">
          For Google Workspace, a Workspace admin sets up the app. For a personal Gmail account, the account&apos;s owner does. Anyone with the mailbox&apos;s password can do the other steps.
        </InfoTip>
      </span>
    );
  }
  if (step === "details" && provider === "smtp" && preset === "microsoft") {
    return (
      <span>
        <Badge tone="blue">Microsoft 365 admin</Badge>{" "}
        <InfoTip label="Who does this step">A Microsoft 365 admin must turn on Authenticated SMTP for the mailbox first.</InfoTip>
      </span>
    );
  }
  return null;
}

type StepNav = { back?: () => void; cancel?: () => void };

function StepFooter({ nav, busy, children }: { nav: StepNav; busy?: boolean; children?: ReactNode }) {
  return (
    <div className={wizard.footer}>
      <div className={ui.actions}>
        {nav.back ? (
          <Button variant="secondary" onClick={nav.back} disabled={busy}>
            Back
          </Button>
        ) : null}
        {nav.cancel ? (
          <Button variant="secondary" onClick={nav.cancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
      </div>
      <div className={wizard.footerRight}>{children}</div>
    </div>
  );
}

function ProviderStep({ provider, onChange, nav, onNext }: { provider: SendingMethod; onChange: (value: SendingMethod) => void; nav: StepNav; onNext: () => void }) {
  return (
    <>
      <ChoiceTiles
        label="Email provider"
        value={provider}
        onChange={onChange}
        options={(Object.keys(PROVIDER_TILES) as SendingMethod[]).map((value) => ({ value, ...PROVIDER_TILES[value] }))}
      />
      <StepFooter nav={nav}>
        <Button onClick={onNext}>Next</Button>
      </StepFooter>
    </>
  );
}

/** Step 2 for Microsoft 365 or Google: the organisation's own app (shared with the CRM's mail sync), saved when "Save and continue" works. */
function AppStep({
  provider,
  organisationId,
  settings,
  refresh,
  nav,
  onNext,
}: {
  provider: "microsoft" | "google";
  organisationId: string;
  settings: Settings;
  refresh: () => Promise<Settings>;
  nav: StepNav;
  onNext: () => void;
}) {
  const app = provider === "microsoft" ? settings.microsoftApp : settings.googleApp;
  const savedTenant = settings.microsoftApp.tenant;
  const [clientId, setClientId] = useState(app.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [tenant, setTenant] = useState(savedTenant);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const saved = appSaved(settings, provider);
  const changed = clientId.trim() !== (app.clientId ?? "") || secret !== "" || (provider === "microsoft" && tenant.trim() !== savedTenant);
  const ready = clientId.trim() !== "" && (secret !== "" || app.secretSaved) && (provider === "google" || tenant.trim() !== "");

  async function save() {
    if (!changed && saved) {
      onNext();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/api/crm/mail/settings", {
        method: "PUT",
        body:
          provider === "microsoft"
            ? { organisationId, microsoftClientId: clientId.trim(), microsoftClientSecret: secret, microsoftTenant: tenant.trim() }
            : { organisationId, googleClientId: clientId.trim(), googleClientSecret: secret },
      });
      await refresh();
      onNext();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {provider === "microsoft" ? (
        <p className={wizard.lead}>
          Register an app in Microsoft Entra, then paste its details.{" "}
          <InfoTip label="Registering the Microsoft app">
            <InfoPara>Tohyee signs in through an app you register once, so no one else&apos;s app ever has access.</InfoPara>
            <InfoPara>
              In the Microsoft Entra admin centre (entra.microsoft.com) › App registrations › New registration: any name (&ldquo;Tohyee&rdquo;). For a business
              mailbox choose &ldquo;Accounts in this organizational directory only&rdquo; and put your domain as the tenant. For Outlook.com choose &ldquo;Accounts in
              any organizational directory and personal Microsoft accounts&rdquo; and leave the tenant as common.
            </InfoPara>
            <InfoPara>
              Add a <strong>Web</strong> redirect URI of <code>{origin}/api/email/microsoft/callback</code>. Under API permissions add the Microsoft Graph delegated
              permissions <strong>Mail.Send</strong>, User.Read and offline_access. Under Certificates &amp; secrets make a client secret and paste its value here.
            </InfoPara>
            <InfoPara>
              The CRM&apos;s email sync uses the same app. For the farm calendar&apos;s mailboxes, also add the redirect URI <code>{origin}/api/farming/mail/callback</code>{" "}
              and the delegated <strong>Mail.Read</strong> permission.
            </InfoPara>
          </InfoTip>
        </p>
      ) : (
        <>
          <p className={wizard.lead}>
            Set up an app in your Google Cloud project, then paste its client ID and secret.{" "}
            <InfoTip label="Setting up the Google app">
              <InfoPara>Tohyee signs in through an app you set up once in your own Google Cloud project, so no one else&apos;s app ever has access.</InfoPara>
              <InfoPara>
                In the Google Cloud console (console.cloud.google.com): pick or create a project. Under APIs &amp; Services › Library turn on the{" "}
                <strong>Gmail API</strong>. Set up the OAuth consent screen with the permission <code>https://www.googleapis.com/auth/gmail.send</code>. Then create an
                OAuth client of type <strong>Web application</strong> with the redirect URI <code>{origin}/api/email/google/callback</code>.
              </InfoPara>
              <InfoPara>
                The CRM&apos;s email sync uses the same app (add <code>{origin}/api/crm/mail/callback</code> too). For the farm calendar&apos;s mailboxes, add{" "}
                <code>{origin}/api/farming/mail/callback</code> and the permission <code>https://www.googleapis.com/auth/gmail.readonly</code>. To let invited people sign
                in to Tohyee with Google, add <code>{origin}/api/auth/google/callback</code>; a server admin turns it on in Server settings.
              </InfoPara>
            </InfoTip>
          </p>
          <Notice tone="info">
            Google may say it &ldquo;hasn&apos;t verified this app&rdquo;. That&apos;s expected.{" "}
            <InfoTip label="Google hasn't verified this app">
              <InfoPara>
                Sending email (gmail.send) is one of Google&apos;s &ldquo;sensitive&rdquo; permissions, not a &ldquo;restricted&rdquo; one, so no security assessment is
                needed. For Google Workspace, set the app&apos;s audience to <strong>Internal</strong>: only your organisation&apos;s accounts can use it and Google
                doesn&apos;t need to verify it.
              </InfoPara>
              <InfoPara>
                For a personal Gmail account (audience <strong>External</strong>), publish the app <strong>In production</strong> and continue past the warning when you
                sign in. Left in <strong>Testing</strong>, Google ends the connection after 7 days.
              </InfoPara>
            </InfoTip>
          </Notice>
        </>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={styles.fields}>
        <Field label={provider === "microsoft" ? "Application (client) ID" : "Client ID"} hint={provider === "google" ? "Ends in .apps.googleusercontent.com" : undefined}>
          <input value={clientId} onChange={(event) => setClientId(event.target.value)} maxLength={300} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Client secret" hint={app.secretSaved ? "Saved. Leave blank to keep it." : "Stored encrypted."}>
          <input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} maxLength={500} autoComplete="new-password" />
        </Field>
        {provider === "microsoft" ? (
          <Field label="Tenant" hint="common, or your domain, like yourcompany.onmicrosoft.com">
            <input value={tenant} onChange={(event) => setTenant(event.target.value)} maxLength={100} autoComplete="off" spellCheck={false} />
          </Field>
        ) : null}
      </div>
      <StepFooter nav={nav} busy={busy}>
        <Button onClick={() => void save()} disabled={busy || !ready || !settings.secretsAvailable}>
          {busy ? "Saving…" : changed || !saved ? "Save and continue" : "Next"}
        </Button>
      </StepFooter>
    </>
  );
}

const MAILBOX_TEXT = {
  microsoft: {
    name: "Microsoft",
    rights: "Tohyee can only send as it (Mail.Send); it can't read it. Sent emails appear in its Sent Items. A business mailbox may need a Microsoft 365 admin to approve the app the first time.",
  },
  google: {
    name: "Google",
    rights: "Tohyee can only send as it (gmail.send); it can't read it. Sent emails appear in its Sent folder.",
  },
} as const;

/** Step 3 for Microsoft 365 or Google: signing in to the mailbox, then its from name and reply-to. */
function MailboxStep({
  provider,
  organisationId,
  settings,
  refresh,
  nav,
  onNext,
}: {
  provider: "microsoft" | "google";
  organisationId: string;
  settings: Settings;
  refresh: () => Promise<Settings>;
  nav: StepNav;
  onNext: () => void;
}) {
  const { current } = useWorkspace();
  const mailbox = provider === "microsoft" ? settings.microsoft : settings.google;
  const [fromName, setFromName] = useState(settings.fromName ?? current?.displayName ?? "");
  const [replyTo, setReplyTo] = useState(settings.replyTo ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = MAILBOX_TEXT[provider];
  const ready = appSaved(settings, provider);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>(`/api/email/${provider}/connect`, { method: "POST", body: { organisationId } });
      try {
        window.sessionStorage.setItem(SIGN_IN_KEY, provider);
      } catch {
        // Only a convenience: without it, coming back guesses the provider from the saved app.
      }
      window.location.assign(url);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  async function use() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/email/settings", { method: "PUT", body: { organisationId, sendingMethod: provider, fromName, replyTo } });
      await refresh();
      onNext();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!ready ? <Notice tone="warning">Save the {text.name} app details first. Go Back to add them.</Notice> : null}
      {mailbox ? (
        <>
          <p className={wizard.lead}>
            Signed in as <strong>{mailbox.email}</strong> <Badge tone="green">Connected</Badge>{" "}
            <InfoTip label="What Tohyee can do with the mailbox">{text.rights}</InfoTip>
          </p>
          {!mailbox.tokensReadable ? <Notice tone="warning">This sign-in can&apos;t be read on this server any more. Sign in again.</Notice> : null}
          <div className={styles.fields}>
            <Field label="From name" hint="What customers see.">
              <input value={fromName} onChange={(event) => setFromName(event.target.value)} maxLength={100} required />
            </Field>
            <Field label="Reply-to" hint="Optional.">
              <input type="email" value={replyTo} onChange={(event) => setReplyTo(event.target.value)} maxLength={254} />
            </Field>
          </div>
          <div>
            <Button variant="secondary" size="small" onClick={() => void signIn()} disabled={busy || !ready || !settings.secretsAvailable}>
              Sign in to another mailbox
            </Button>
          </div>
        </>
      ) : (
        <p className={wizard.lead}>
          Sign in to the mailbox documents should come from.{" "}
          <InfoTip label="What Tohyee can do with the mailbox">{text.rights}</InfoTip>
        </p>
      )}
      <StepFooter nav={nav} busy={busy}>
        {mailbox ? (
          <Button onClick={() => void use()} disabled={busy || !fromName.trim() || !mailbox.tokensReadable}>
            {busy ? "Saving…" : "Save and continue"}
          </Button>
        ) : (
          <Button onClick={() => void signIn()} disabled={busy || !ready || !settings.secretsAvailable}>
            {busy ? "Opening…" : `Sign in with ${text.name}`}
          </Button>
        )}
      </StepFooter>
    </>
  );
}

function PresetHelp({ preset }: { preset: Preset }) {
  if (preset === "gmail") {
    return (
      <p className={wizard.lead}>
        Uses an app password. The Google tile is easier if you can set up a Google app.{" "}
        <InfoTip label="Gmail with an app password">
          <InfoPara>
            Google doesn&apos;t let other apps use your normal password. Turn on 2-Step Verification, then make an <strong>app password</strong> at{" "}
            <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
              myaccount.google.com/apppasswords
            </a>{" "}
            and paste its 16 letters on the next step. The username is the full Gmail address.
          </InfoPara>
          <InfoPara>
            To send from another address, add it in Gmail first under Settings › Accounts › &ldquo;Send mail as&rdquo;. A Google Workspace admin may need to allow app
            passwords. A personal Gmail account sends up to about 500 emails a day.
          </InfoPara>
        </InfoTip>
      </p>
    );
  }
  if (preset === "microsoft") {
    return (
      <p className={wizard.lead}>
        The Microsoft 365 tile is better where you can use it.{" "}
        <InfoTip label="Microsoft 365 with a password">
          <InfoPara>Microsoft is retiring passwords for this kind of sending, and personal Outlook.com and Hotmail accounts already refuse them.</InfoPara>
          <InfoPara>
            To use a password anyway, a Microsoft 365 admin must turn on <strong>Authenticated SMTP</strong> for the mailbox (Microsoft 365 admin centre › Users › the
            user › Mail › Manage email apps).
          </InfoPara>
        </InfoTip>
      </p>
    );
  }
  return (
    <p className={wizard.lead}>
      Use the outgoing (SMTP) server details from your provider.{" "}
      <InfoTip label="Other email providers">Usually port 465 with SSL/TLS or port 587 with STARTTLS. Use an app password if your provider offers them.</InfoTip>
    </p>
  );
}

/** Step 2 for SMTP: which server. Nothing is saved until the account step. */
function SmtpServerStep({ draft, onChange, nav, onNext }: { draft: SmtpDraft; onChange: (draft: SmtpDraft) => void; nav: StepNav; onNext: () => void }) {
  const choose = (preset: Preset) =>
    onChange(preset === "other" ? { ...draft, preset } : { preset, host: PRESETS[preset].host, port: String(PRESETS[preset].port), security: PRESETS[preset].security });
  const ready = draft.host.trim() !== "" && /^\d+$/.test(draft.port.trim());
  return (
    <>
      <div className={styles.fields}>
        <Field label="Email service">
          <select value={draft.preset} onChange={(event) => choose(event.target.value as Preset)}>
            <option value="gmail">Gmail or Google Workspace</option>
            <option value="microsoft">Microsoft 365</option>
            <option value="other">Other</option>
          </select>
        </Field>
      </div>
      <PresetHelp preset={draft.preset} />
      {draft.preset === "other" ? (
        <div className={styles.fields}>
          <Field label="SMTP server">
            <input value={draft.host} onChange={(event) => onChange({ ...draft, host: event.target.value })} autoComplete="off" spellCheck={false} required />
          </Field>
          <Field label="Port" hint="465, 587, 25 or 2525">
            <input inputMode="numeric" value={draft.port} onChange={(event) => onChange({ ...draft, port: event.target.value })} required />
          </Field>
          <Field label="Security">
            <select value={draft.security} onChange={(event) => onChange({ ...draft, security: event.target.value as SmtpSecurity })}>
              {(Object.keys(SECURITY_LABELS) as SmtpSecurity[]).map((value) => (
                <option key={value} value={value}>
                  {SECURITY_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : (
        <p className={ui.muted} style={{ margin: 0 }}>
          Server {draft.host}, port {draft.port}, {draft.security === "ssl" ? "SSL/TLS" : "STARTTLS"}.
        </p>
      )}
      <StepFooter nav={nav}>
        <Button onClick={onNext} disabled={!ready}>
          Next
        </Button>
      </StepFooter>
    </>
  );
}

/** Step 3 for SMTP: the login and the sender, saved (and the server checked) on "Save and continue". */
function SmtpAccountStep({
  organisationId,
  settings,
  server,
  refresh,
  nav,
  onNext,
}: {
  organisationId: string;
  settings: Settings;
  server: SmtpDraft;
  refresh: () => Promise<Settings>;
  nav: StepNav;
  onNext: () => void;
}) {
  const { current } = useWorkspace();
  const mailboxAddress = settings.sendingMethod !== "smtp" ? sendingAddress(settings) : null;
  const [username, setUsername] = useState(settings.username ?? "");
  const [password, setPassword] = useState("");
  const [fromName, setFromName] = useState(settings.fromName ?? current?.displayName ?? "");
  const [fromAddress, setFromAddress] = useState(settings.fromAddress && settings.fromAddress !== mailboxAddress ? settings.fromAddress : "");
  const [replyTo, setReplyTo] = useState(settings.replyTo ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keepsPassword = settings.hasPassword && settings.passwordReadable;
  const ready = username.trim() !== "" && fromName.trim() !== "" && (password !== "" || keepsPassword);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/email/settings", {
        method: "PUT",
        body: {
          organisationId,
          fromName,
          fromAddress: fromAddress || username,
          replyTo,
          host: server.host.trim(),
          port: server.port.trim(),
          security: server.security,
          username: username.trim(),
          password,
        },
      });
      await refresh();
      onNext();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {settings.hasPassword && !settings.passwordReadable ? <Notice tone="warning">The saved password can&apos;t be read on this server any more. Enter it again.</Notice> : null}
      <div className={styles.fields}>
        <Field label="Username" hint="Usually the email address.">
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" spellCheck={false} maxLength={254} required />
        </Field>
        <Field label={server.preset === "gmail" ? "App password" : "Password"} hint={keepsPassword ? "Saved. Leave blank to keep it." : "Stored encrypted."}>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" maxLength={500} />
        </Field>
      </div>
      <div className={styles.fields}>
        <Field label="From name" hint="What customers see.">
          <input value={fromName} onChange={(event) => setFromName(event.target.value)} maxLength={100} required />
        </Field>
        <Field label="From address" hint="Blank uses the username.">
          <input type="email" value={fromAddress} onChange={(event) => setFromAddress(event.target.value)} maxLength={254} placeholder={username} />
        </Field>
        <Field label="Reply-to" hint="Optional.">
          <input type="email" value={replyTo} onChange={(event) => setReplyTo(event.target.value)} maxLength={254} />
        </Field>
      </div>
      <StepFooter nav={nav} busy={busy}>
        <Button onClick={() => void save()} disabled={busy || !ready || !settings.secretsAvailable}>
          {busy ? "Checking…" : "Save and continue"}
        </Button>
      </StepFooter>
    </>
  );
}

/** Sends a test email (to the person, or an address they type). Used in the setup's test step and from the summary. */
function TestEmailForm({
  organisationId,
  settings,
  onTested,
  inline,
  primary = true,
}: {
  organisationId: string;
  settings: Settings;
  onTested: (ok: boolean) => void;
  inline?: boolean;
  primary?: boolean;
}) {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; error: string | null; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const sent = await api<{ ok: boolean; error: string | null; to: string }>("/api/email/settings/test", { method: "POST", body: { organisationId, to: to || null } });
      setResult(sent);
      onTested(sent.ok);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className={inline ? styles.testRow : undefined}>
        <div className={ui.inlineForm}>
          <Field label="Send it to" hint="Blank sends it to you.">
            <input type="email" value={to} onChange={(event) => setTo(event.target.value)} maxLength={254} />
          </Field>
          <Button variant={primary ? "primary" : "secondary"} onClick={() => void send()} disabled={busy || !settings.configured}>
            {busy ? "Sending…" : "Send test email"}
          </Button>
        </div>
      </div>
      {result?.ok ? <Notice tone="success">Sent to {result.to}. Check it arrived, and isn&apos;t in spam.</Notice> : null}
      {result && !result.ok ? <Notice tone="error">{result.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </>
  );
}

function DoneStep({ settings, onFinish }: { settings: Settings; onFinish: () => void }) {
  return (
    <>
      <dl className={wizard.summary}>
        <dt>Provider</dt>
        <dd>{settings.sendingMethod === "smtp" && settings.host ? `SMTP (${settings.host})` : PROVIDER_NAMES[settings.sendingMethod]}</dd>
        <dt>Sending as</dt>
        <dd>{sendingAddress(settings)}</dd>
        <dt>From name</dt>
        <dd>{settings.fromName}</dd>
        {settings.replyTo ? (
          <>
            <dt>Replies go to</dt>
            <dd>{settings.replyTo}</dd>
          </>
        ) : null}
        <dt>Test</dt>
        <dd>{settings.lastTest ? (settings.lastTest.ok ? "Sent" : "Failed") : "Not sent"}</dd>
      </dl>
      <StepFooter nav={{}}>
        <Button onClick={onFinish}>Finish</Button>
      </StepFooter>
    </>
  );
}
