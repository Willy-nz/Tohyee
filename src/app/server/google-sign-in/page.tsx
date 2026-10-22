"use client";

import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { GoogleSignInSettings } from "@/lib/auth/google-sign-in";
import { formatDateTime } from "@/lib/format";

type Loaded = { settings: GoogleSignInSettings; organisations: { id: string; displayName: string }[] };

function SettingsForm({ settings, onSaved }: { settings: GoogleSignInSettings; onSaved: (next: GoogleSignInSettings) => void }) {
  const [clientId, setClientId] = useState(settings.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [enabled, setEnabled] = useState(settings.enabled);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<Loaded>("/api/admin/google-sign-in", { method: "PUT", body: { enabled, clientId, clientSecret: clientSecret || undefined } });
      setClientSecret("");
      onSaved(result.settings);
      setMessage({ tone: "success", text: enabled ? "Saved. Sign in with Google is on." : "Saved. Sign in with Google is off." });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)} style={{ display: "grid", gap: 12 }} autoComplete="off">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <div className={ui.grid2}>
        <Field label="Client ID" hint="Ends in .apps.googleusercontent.com.">
          <input value={clientId} onChange={(event) => setClientId(event.target.value.trim())} spellCheck={false} />
        </Field>
        <Field label="Client secret" hint={settings.hasSecret ? "Saved. Leave blank to keep it." : undefined}>
          <input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} />
        </Field>
      </div>
      <label className={ui.checkbox}>
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        Let invited people sign in with Google
      </label>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !settings.secretsAvailable}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function CopyFromOrganisation({ organisations, onSaved }: { organisations: Loaded["organisations"]; onSaved: (next: GoogleSignInSettings) => void }) {
  const [organisationId, setOrganisationId] = useState(organisations[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  if (organisations.length === 0) return null;

  async function copy() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ settings: GoogleSignInSettings }>("/api/admin/google-sign-in/copy", { method: "POST", body: { organisationId } });
      onSaved(result.settings);
      setMessage({ tone: "success", text: "Copied that organisation's Google app. Add the sign-in address below to it, then turn Sign in with Google on." });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <div className={ui.grid2}>
        <Field label="Use an organisation's Google app" hint="The one in its Settings › Email, also used for Gmail and Google Analytics. You must be an admin there.">
          <select value={organisationId} onChange={(event) => setOrganisationId(event.target.value)}>
            {organisations.map((organisation) => (
              <option key={organisation.id} value={organisation.id}>
                {organisation.displayName}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className={ui.actions}>
        <Button variant="secondary" onClick={() => void copy()} disabled={busy || !organisationId}>
          {busy ? "Copying…" : "Use this organisation's app"}
        </Button>
      </div>
    </div>
  );
}

/** Sign in with Google for invited people (#424): the server's Google app and where Google sends people back. */
export default function GoogleSignInPage() {
  const { user } = useWorkspace();
  const loaded = useApiData<Loaded>(user.isServerAdmin ? "/api/admin/google-sign-in" : null);
  const [current, setCurrent] = useState<GoogleSignInSettings | null>(null);
  if (!user.isServerAdmin) {
    return (
      <Page>
        <PageHeader title="Sign in with Google" />
        <Notice tone="warning">Only server admins can set up Sign in with Google.</Notice>
      </Page>
    );
  }
  const settings = current ?? loaded.data?.settings ?? null;
  const usable = settings?.addresses.filter((address) => !address.problem) ?? [];

  return (
    <Page>
      <PageHeader
        title="Sign in with Google"
        description="Invited people can sign in with their Google account instead of a password and authenticator app. A Google account that wasn't invited can never make a login."
      />
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {settings ? (
        <>
          <Card
            title="Google app"
            description={
              <>
                {settings.ready ? <Badge tone="green">On</Badge> : <Badge tone="neutral">Off</Badge>}{" "}
                {settings.copiedFromOrganisationId ? `Copied from ${settings.copiedFromOrganisationId}'s Google app. ` : ""}
                {settings.updatedAt ? `Saved ${formatDateTime(settings.updatedAt)}${settings.updatedByEmail ? ` by ${settings.updatedByEmail}` : ""}.` : "Not set up yet."}
              </>
            }
          >
            {!settings.secretsAvailable ? (
              <Notice tone="error">This server has no TOHYEE_SECRET_KEY, so it can&apos;t keep the Google app&apos;s secret. Set it and restart Tohyee.</Notice>
            ) : null}
            {settings.secretUnreadable ? (
              <Notice tone="warning">The saved client secret can&apos;t be read with this server&apos;s secret key. Enter it again.</Notice>
            ) : null}
            <CopyFromOrganisation organisations={loaded.data?.organisations ?? []} onSaved={setCurrent} />
            <SettingsForm key={settings.updatedAt ?? "new"} settings={settings} onSaved={setCurrent} />
          </Card>
          <Card title="Sign-in address for the Google app" description="Google only sends people back to addresses listed in the app.">
            <div style={{ display: "grid", gap: 10 }}>
              {settings.addresses.map((address) => (
                <div key={address.uri} style={{ display: "grid", gap: 4 }}>
                  <span className={ui.fieldLabel}>{address.label}</span>
                  <code style={{ overflowWrap: "anywhere" }}>{address.uri}</code>
                  {address.problem ? <Notice tone="warning">{address.problem}</Notice> : null}
                </div>
              ))}
              {usable.length === 0 ? (
                <Notice tone="warning">
                  Google needs a proper web address: Tohyee&apos;s address or your own, set up under Remote access. A server reached only by a
                  home-network address (like 192.168.1.20) can&apos;t use Sign in with Google from other computers.
                </Notice>
              ) : null}
            </div>
          </Card>
          <Card title="Setting up the Google app">
            <ol className={ui.muted} style={{ display: "grid", gap: 6, margin: 0, paddingLeft: 20 }}>
              <li>
                In the Google Cloud console (console.cloud.google.com), open the project with your Google app (the one an organisation already uses for
                Gmail or Google Analytics is fine), or make a new one.
              </li>
              <li>
                Under Google Auth Platform › Clients, open the OAuth client of type <strong>Web application</strong> (or create one) and add the sign-in
                address above to <strong>Authorised redirect URIs</strong>.
              </li>
              <li>
                Tohyee only asks for <code>openid</code>, <code>email</code> and <code>profile</code>: who the person is, nothing in their mailbox or
                files. These are Google&apos;s basic permissions, so the app doesn&apos;t need Google to verify it for them.
              </li>
              <li>
                If the app&apos;s audience is <strong>Internal</strong>, only accounts in your Google Workspace can sign in. For personal Gmail accounts,
                use <strong>External</strong> and publish the app (In production); while it&apos;s in Testing only its test users can sign in.
              </li>
              <li>Paste the client ID and secret above (or use an organisation&apos;s app), tick the box and save.</li>
            </ol>
          </Card>
          <Card title="How it works">
            <ul className={ui.muted} style={{ display: "grid", gap: 6, margin: 0, paddingLeft: 20 }}>
              <li>A setup link offers Continue with Google, for the Google account with the invited email address.</li>
              <li>People with a password can link a Google account on Your account, and unlink it while they still have their password.</li>
              <li>A Google sign-in relies on Google&apos;s own checks; password sign-ins still use two-step. Every sign-in shows under Sign-ins.</li>
              <li>Server admins always keep a password, so a Google outage can&apos;t lock anyone out of the server.</li>
              <li>Disabling a login, or removing Google from it under Users, stops its Google sign-in.</li>
            </ul>
          </Card>
        </>
      ) : loaded.error ? null : (
        <p className={ui.muted}>Loading…</p>
      )}
    </Page>
  );
}
