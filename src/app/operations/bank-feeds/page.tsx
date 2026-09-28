"use client";

import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { AkahuMode, AkahuServerSettings } from "@/lib/bank/akahu/settings";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";

function callbackUrl(): string {
  return `${window.location.origin}/api/bank-feeds/akahu/callback`;
}

function SettingsForm({ settings, onSaved }: { settings: AkahuServerSettings; onSaved: (settings: AkahuServerSettings) => void }) {
  const [mode, setMode] = useState<AkahuMode>(settings.mode ?? "personal");
  const [appToken, setAppToken] = useState("");
  const [userToken, setUserToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState(settings.redirectUri ?? callbackUrl());
  const [syncEveryHours, setSyncEveryHours] = useState(String(settings.syncEveryHours));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await api<{ akahu: AkahuServerSettings }>("/api/admin/bank-feeds", {
        method: "PUT",
        body: {
          mode,
          appToken: appToken || undefined,
          userToken: mode === "personal" ? userToken || undefined : undefined,
          appSecret: mode === "oauth" ? appSecret || undefined : undefined,
          redirectUri: mode === "oauth" ? redirectUri : undefined,
          syncEveryHours,
        },
      });
      setAppToken("");
      setUserToken("");
      setAppSecret("");
      setSaved(true);
      onSaved(result.akahu);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const keep = "Leave blank to keep the one saved.";
  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }} autoComplete="off">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {saved ? <Notice tone="success">Saved. Tokens are stored encrypted and never shown again.</Notice> : null}
      <Field label="Akahu app">
        <select value={mode} onChange={(event) => setMode(event.target.value as AkahuMode)}>
          <option value="personal">Personal app (one Akahu login, free)</option>
          <option value="oauth">Full app (each organisation connects its own banks)</option>
        </select>
      </Field>
      {mode === "personal" ? (
        <Notice tone="info">
          A personal app reads the accounts of the one person who made it at my.akahu.nz (Developers). Only server admins can link its
          accounts to organisations. Akahu intends personal apps for the developer&apos;s own accounts; for clients&apos; banks, use a full app.
        </Notice>
      ) : (
        <Notice tone="info">
          A full app lets each organisation&apos;s admin connect their own banks through Akahu&apos;s consent screen. Akahu has to approve the
          app first, charges per connected user, and needs this server on a public https address that matches the redirect URL.
        </Notice>
      )}
      <div className={ui.grid2}>
        <Field label="App ID token" hint={settings.appTokenHint ? `Saved: ${settings.appTokenHint}. ${keep}` : "Starts with app_token_."}>
          <input value={appToken} onChange={(event) => setAppToken(event.target.value.trim())} required={!settings.appTokenHint} />
        </Field>
        {mode === "personal" ? (
          <Field label="User token" hint={settings.hasUserToken ? `Saved. ${keep}` : "Starts with user_token_."}>
            <input
              type="password"
              value={userToken}
              onChange={(event) => setUserToken(event.target.value.trim())}
              required={!settings.hasUserToken}
            />
          </Field>
        ) : (
          <Field label="App secret" hint={settings.hasAppSecret ? `Saved. ${keep}` : "From the app's page at Akahu."}>
            <input
              type="password"
              value={appSecret}
              onChange={(event) => setAppSecret(event.target.value.trim())}
              required={!settings.hasAppSecret}
            />
          </Field>
        )}
        {mode === "oauth" ? (
          <Field label="Redirect URL" hint="Register exactly this with Akahu. It must be https and end with /api/bank-feeds/akahu/callback.">
            <input value={redirectUri} onChange={(event) => setRedirectUri(event.target.value.trim())} required />
          </Field>
        ) : null}
        <Field label="Sync every (hours)" hint="Linked accounts are synced this often while the server runs. Akahu itself refreshes from banks about daily.">
          <input type="number" min={1} max={24} value={syncEveryHours} onChange={(event) => setSyncEveryHours(event.target.value)} required />
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

export default function BankFeedsSettingsPage() {
  const { user } = useWorkspace();
  const settings = useApiData<{ akahu: AkahuServerSettings }>(user.isServerAdmin ? "/api/admin/bank-feeds" : null);
  const [current, setCurrent] = useState<AkahuServerSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  if (!user.isServerAdmin) {
    return (
      <Page>
        <PageHeader title="Bank feeds" />
        <Notice tone="warning">Only server admins can set up bank feeds.</Notice>
      </Page>
    );
  }
  const akahu = current ?? settings.data?.akahu ?? null;

  async function syncAll() {
    setBusy(true);
    setMessage(null);
    try {
      const { result } = await api<{ result: { synced: number; failed: number } }>("/api/admin/bank-feeds", { method: "POST" });
      setMessage({ tone: result.failed > 0 ? "error" : "success", text: `Synced ${result.synced} accounts${result.failed ? `; ${result.failed} failed (see each account's Bank feed tab)` : ""}.` });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!window.confirm("Remove the Akahu app from this server? Bank feeds stop syncing until it's set up again. Lines already brought in stay.")) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ akahu: AkahuServerSettings }>("/api/admin/bank-feeds", { method: "PUT", body: { clear: true } });
      setCurrent(result.akahu);
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <PageHeader
        title="Bank feeds"
        description="The Akahu app this server uses to bring in bank transactions (NZ banks). Set up once for the whole server."
      />
      {settings.error ? <Notice tone="error">{settings.error}</Notice> : null}
      {!akahu && !settings.error ? <p className={ui.muted}>Loading…</p> : null}
      {akahu ? (
        <>
          {!akahu.secretsAvailable ? (
            <Notice tone="error">
              TOHYEE_SECRET_KEY isn&apos;t set on this server, so Akahu tokens can&apos;t be stored. Set it to a random value of at least 32
              characters in the server&apos;s environment and restart Tohyee. The Windows installer does this for you.
            </Notice>
          ) : null}
          <Card
            title="Akahu app"
            description={
              akahu.mode ? (
                <>
                  <Badge tone="green">{akahu.mode === "personal" ? "Personal app" : "Full app"}</Badge>{" "}
                  {akahu.updatedAt ? `Saved ${formatDateTime(akahu.updatedAt)} by ${akahu.updatedByEmail ?? "an admin"}.` : ""}
                </>
              ) : (
                "Not set up yet. Create an app at my.akahu.nz (Developers), then enter its tokens here."
              )
            }
            actions={
              akahu.mode ? (
                <>
                  <Button variant="secondary" onClick={() => void syncAll()} disabled={busy}>
                    Sync due feeds now
                  </Button>
                  <Button variant="danger" onClick={() => void clear()} disabled={busy}>
                    Remove
                  </Button>
                </>
              ) : null
            }
          >
            {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
            <SettingsForm key={akahu.updatedAt ?? "new"} settings={akahu} onSaved={setCurrent} />
          </Card>
        </>
      ) : null}
    </Page>
  );
}
