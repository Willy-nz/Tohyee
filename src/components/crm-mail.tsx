"use client";

import { useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { ConnectedAccount, MailSettings } from "@/lib/crm/mail/service";
import { formatDateTime } from "@/lib/format";

/**
 * CRM › Email and calendar (examples MAIL1-MAIL9): the organisation's Google
 * and Microsoft app (admins), and each member's connected mailboxes.
 */
const PROVIDER_LABELS = { google: "Gmail and Google Calendar", microsoft: "Microsoft 365" } as const;

function AppSettings({ organisationId }: { organisationId: string }) {
  const loaded = useApiData<{ settings: MailSettings }>("/api/crm/mail/settings", { organisationId });
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  const settings = loaded.data.settings;
  const values = draft ?? {
    googleClientId: settings.google.clientId ?? "",
    googleClientSecret: "",
    microsoftClientId: settings.microsoft.clientId ?? "",
    microsoftClientSecret: "",
    microsoftTenant: settings.microsoft.tenant,
  };
  const set = (patch: Record<string, string>) => setDraft({ ...values, ...patch });
  const redirect = `${typeof window === "undefined" ? "" : window.location.origin}${settings.redirectPath}`;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api("/api/crm/mail/settings", { method: "PUT", body: { organisationId, ...values } });
      setDraft(null);
      setMessage("Saved.");
      loaded.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      title="Your organisation's Google and Microsoft app"
      description="Like bank feeds, each organisation uses its own app. Create one in the Google Cloud console (OAuth client, web application, with the Gmail and Google Calendar APIs turned on) and/or in Microsoft Entra (app registration, with Mail.Read, Calendars.Read, User.Read and offline_access), then enter its client ID and secret here. Tohyee only ever reads."
    >
      {!settings.secretsAvailable ? (
        <Notice tone="warning">The server has no TOHYEE_SECRET_KEY, so it can&apos;t store secrets. A server admin needs to set it first.</Notice>
      ) : null}
      <Notice tone="info">
        Register this redirect address with Google and Microsoft: <code>{redirect}</code>. If people reach Tohyee at more than one address (for
        example the local network and remote access), register each one.
      </Notice>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      <form style={{ display: "grid", gap: 12 }} onSubmit={(event) => void save(event)} autoComplete="off">
        <div className={ui.grid3}>
          <Field label="Google client ID">
            <input value={values.googleClientId} maxLength={300} onChange={(event) => set({ googleClientId: event.target.value })} />
          </Field>
          <Field label="Google client secret" hint={settings.google.secretSaved ? "Saved. Leave blank to keep it." : undefined}>
            <input type="password" value={values.googleClientSecret} maxLength={500} onChange={(event) => set({ googleClientSecret: event.target.value })} />
          </Field>
        </div>
        <div className={ui.grid3}>
          <Field label="Microsoft client ID">
            <input value={values.microsoftClientId} maxLength={300} onChange={(event) => set({ microsoftClientId: event.target.value })} />
          </Field>
          <Field label="Microsoft client secret" hint={settings.microsoft.secretSaved ? "Saved. Leave blank to keep it." : undefined}>
            <input type="password" value={values.microsoftClientSecret} maxLength={500} onChange={(event) => set({ microsoftClientSecret: event.target.value })} />
          </Field>
          <Field label="Microsoft tenant" hint="common, or your organisation's tenant ID or domain.">
            <input value={values.microsoftTenant} maxLength={100} onChange={(event) => set({ microsoftTenant: event.target.value })} />
          </Field>
        </div>
        <div className={ui.actions}>
          <Button type="submit" disabled={busy || !settings.secretsAvailable}>
            {busy ? "Saving…" : "Save app details"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function AccountRow({ organisationId, account, isAdmin, onChanged }: { organisationId: string; account: ConnectedAccount; isAdmin: boolean; onChanged: (accounts?: ConnectedAccount[]) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(what: string, work: () => Promise<{ accounts: ConnectedAccount[] }>) {
    setBusy(what);
    setError(null);
    try {
      onChanged((await work()).accounts);
    } catch (caught) {
      setError(errorMessage(caught));
      onChanged();
    } finally {
      setBusy(null);
    }
  }
  return (
    <tr>
      <td>
        <strong>{account.email}</strong>
        <div className={ui.muted}>
          {PROVIDER_LABELS[account.provider]} · connected by {account.isMine ? "you" : (account.ownerName ?? "a former member")}
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {account.lastError ? <div className={ui.muted}>Last error: {account.lastError}</div> : null}
      </td>
      <td>
        {account.status === "active" ? <Badge tone="green">Syncing</Badge> : <Badge tone="red">Paused</Badge>}
        <div className={ui.muted}>{account.lastSyncAt ? `Last sync ${formatDateTime(account.lastSyncAt)}` : "Not synced yet"}</div>
      </td>
      <td className={ui.num}>
        {account.messages} emails · {account.meetings} meetings
      </td>
      <td>
        {account.isMine ? (
          <select
            aria-label={`What the team sees from ${account.email}`}
            value={account.visibility}
            disabled={busy !== null}
            onChange={(event) =>
              void run("visibility", () =>
                api(`/api/crm/mail/accounts/${account.id}`, { method: "PATCH", body: { organisationId, visibility: event.target.value } }),
              )
            }
          >
            <option value="subject">Team sees subject and preview</option>
            <option value="metadata">Team sees only that it happened</option>
          </select>
        ) : account.visibility === "subject" ? (
          "Subject and preview"
        ) : (
          "Only that it happened"
        )}
      </td>
      <td className={ui.num}>
        <span className={ui.rowButtons}>
          {(account.isMine || isAdmin) && account.status === "active" ? (
            <Button
              size="small"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => void run("sync", () => api(`/api/crm/mail/accounts/${account.id}/sync`, { method: "POST", body: { organisationId } }))}
            >
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </Button>
          ) : null}
          {account.isMine || isAdmin ? (
            <Button
              size="small"
              variant="danger"
              disabled={busy !== null}
              onClick={() => {
                if (!window.confirm(`Disconnect ${account.email}? Tohyee's copies of its emails and meetings are deleted (your mailbox isn't touched).`)) return;
                void run("disconnect", () =>
                  api(`/api/crm/mail/accounts/${account.id}?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" }),
                );
              }}
            >
              Disconnect
            </Button>
          ) : null}
        </span>
      </td>
    </tr>
  );
}

export function MailPage({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const params = useSearchParams();
  const loaded = useApiData<{ accounts: ConnectedAccount[] }>("/api/crm/mail/accounts", { organisationId });
  const [accounts, setAccounts] = useState<ConnectedAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = accounts ?? loaded.data?.accounts ?? [];
  async function connect(provider: "google" | "microsoft") {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>("/api/crm/mail/connect", { method: "POST", body: { organisationId, provider } });
      window.location.assign(url);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }
  return (
    <>
      {params.get("connected") ? <Notice tone="success">Connected {params.get("connected")}. The first sync starts within a few minutes, or use Sync now.</Notice> : null}
      {params.get("error") ? <Notice tone="error">{params.get("error")}</Notice> : null}
      <Card
        title="Connected mailboxes"
        description="Connect your own mailbox and calendar. Only emails and meetings with people and companies in the CRM are kept, with their subject and a short preview; never full emails or attachments. Syncs every 15 minutes."
        actions={
          can("bookkeeper") ? (
            <span className={ui.actions}>
              <Button size="small" disabled={busy} onClick={() => void connect("google")}>
                Connect Gmail
              </Button>
              <Button size="small" disabled={busy} onClick={() => void connect("microsoft")}>
                Connect Microsoft 365
              </Button>
            </span>
          ) : null
        }
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
        {loaded.data && list.length === 0 ? <Empty>No mailboxes connected yet.</Empty> : null}
        {list.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Mailbox</th>
                  <th>Status</th>
                  <th className={ui.num}>Kept</th>
                  <th>What the team sees</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((account) => (
                  <AccountRow
                    key={account.id}
                    organisationId={organisationId}
                    account={account}
                    isAdmin={can("admin")}
                    onChanged={(next) => (next ? setAccounts(next) : loaded.reload())}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      {can("admin") ? <AppSettings organisationId={organisationId} /> : null}
    </>
  );
}
