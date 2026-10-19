"use client";

import Link from "next/link";
import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import type { GaProperty, GaStatus } from "@/lib/analytics/google-analytics";
import { GA_DEFAULT_HISTORY_MONTHS, GA_MAX_HISTORY_MONTHS } from "@/lib/analytics/google-analytics-reports";
import { tableDescription, tableLabel } from "@/lib/analytics/labels";
import type { LoadRun } from "@/lib/analytics/sources";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";

function rows(value: string | null): string {
  return value === null ? "" : Number(value).toLocaleString("en-NZ");
}

/** What an admin sets up in Google before connecting (decision 606). Honest about Testing apps' 7-day sign-ins. */
function SetupHelp({ callbackPath }: { callbackPath: string }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <details style={{ overflowWrap: "anywhere" }}>
      <summary>What an admin sets up in Google first</summary>
      <ol style={{ paddingLeft: 20 }}>
        <li>
          Tohyee signs in with the Google app saved under <Link href="/operations/settings/email">Settings › Email</Link>. Add{" "}
          <code style={{ wordBreak: "break-all" }}>{origin}{callbackPath}</code> to that app&apos;s authorised redirect URIs in Google Cloud.
        </li>
        <li>In the same Google Cloud project, enable the <strong>Google Analytics Data API</strong> and the <strong>Google Analytics Admin API</strong> (APIs &amp; Services › Library).</li>
        <li>
          On the app&apos;s consent screen (Google Auth Platform › Data access), add the scope <code style={{ wordBreak: "break-all" }}>https://www.googleapis.com/auth/analytics.readonly</code>.
        </li>
        <li>
          While the app&apos;s publishing status is <strong>Testing</strong>, only its test users can sign in, and Google ends each sign-in after 7 days, so
          nightly loads stop and you&apos;ll need to connect again. Publishing the app (Google may ask to verify it) or an Internal app in Google Workspace
          avoids this.
        </li>
        <li>The Google account that signs in needs at least Viewer access to the GA4 property.</li>
      </ol>
    </details>
  );
}

/**
 * Google Analytics in Analytics › Data sources (decisions 606-609): sign in
 * with Google, choose a GA4 property, load its daily reports, refresh or
 * disconnect. `onlyIfConnected` shows nothing until it's connected (the
 * Connected sources list).
 */
export function GoogleAnalyticsCard({
  organisationId,
  canManage,
  onlyIfConnected = false,
  returned,
  onChanged,
}: {
  organisationId: string;
  canManage: boolean;
  onlyIfConnected?: boolean;
  /** After Google sends the browser back: "connected", or an error message. */
  returned?: { ok: boolean; message: string } | null;
  onChanged: () => void;
}) {
  const status = useApiData<GaStatus>("/api/analytics/google", { organisationId });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const confirm = useConfirm();

  if (status.error) return onlyIfConnected ? null : <Notice tone="error">{status.error}</Notice>;
  const data = status.data;
  if (!data) return null;
  const connection = data.connection;
  if (onlyIfConnected && !connection) return null;

  async function signIn() {
    setBusy("connect");
    setMessage(null);
    try {
      const { url } = await api<{ url: string }>("/api/analytics/google", { method: "POST", body: { organisationId } });
      window.location.assign(url);
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
      setBusy(null);
    }
  }

  async function refresh() {
    setBusy("load");
    setMessage(null);
    try {
      const { run } = await api<{ run: LoadRun }>("/api/analytics/google/load", { method: "POST", body: { organisationId } });
      setMessage(
        run.status === "ok"
          ? { tone: "success", text: `Loaded ${rows(run.rowsLoaded)} rows from Google Analytics.` }
          : { tone: "error", text: `Google Analytics didn't load: ${run.error} The last copy is still there.` },
      );
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
      status.reload();
      onChanged();
    }
  }

  async function disconnect() {
    const ok = await confirm("Tohyee deletes the Google sign-in and every Google Analytics table it loaded. Reports that use them will show no data. Nothing changes in Google Analytics itself. The load history stays.", {
      title: "Disconnect Google Analytics?",
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!ok) return;
    setBusy("disconnect");
    setMessage(null);
    try {
      await api("/api/analytics/google", { method: "DELETE", query: { organisationId } });
      setMessage({ tone: "success", text: "Google Analytics is disconnected and its data removed." });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
      status.reload();
      onChanged();
    }
  }

  const run = data.lastLoad;
  const needsProperty = Boolean(connection && !connection.propertyId);
  return (
    <Card
      title="Google Analytics"
      description="A website's visitors, sessions, page views, traffic sources, pages, countries and devices from a GA4 property, by day, to chart beside your sales."
      actions={
        canManage && connection && connection.propertyId && !connection.needsReconnect ? (
          <Button size="small" onClick={() => void refresh()} disabled={busy !== null}>
            {busy === "load" ? "Loading…" : "Refresh now"}
          </Button>
        ) : null
      }
    >
      {returned ? <Notice tone={returned.ok ? "success" : "error"}>{returned.message}</Notice> : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {!connection ? (
        <>
          <p className={ui.muted}>Not connected. An admin signs in with a Google account that can see the website&apos;s GA4 property; Tohyee only asks to read Analytics.</p>
          {canManage ? (
            <>
              <SetupHelp callbackPath={data.callbackPath} />
              <div className={ui.rowButtons}>
                <Button onClick={() => void signIn()} disabled={busy !== null}>{busy === "connect" ? "Opening Google…" : "Sign in with Google"}</Button>
              </div>
            </>
          ) : null}
        </>
      ) : (
        <>
          {connection.needsReconnect ? (
            <Notice tone="warning">
              Google no longer accepts this sign-in, so nothing loads. {canManage ? "Connect again below." : "An admin needs to connect again."} While the organisation&apos;s
              Google app is in Testing, Google ends sign-ins after 7 days.
            </Notice>
          ) : null}
          <p className={ui.muted}>
            {connection.propertyId ? (
              <>
                <strong>{connection.propertyName}</strong> (property {connection.propertyId}{connection.accountName ? `, account ${connection.accountName}` : ""})
              </>
            ) : (
              "Signed in. Choose the property to load."
            )}
            {connection.googleEmail ? ` · Signed in as ${connection.googleEmail}` : ""}
            {` · ${connection.historyMonths} months · ${connection.reloadDaily ? "loads nightly after 4am" : "loads by hand only"}`}
          </p>
          {connection.currencyCode || connection.timeZone ? (
            <p className={ui.muted}>
              As the property is set up in Google Analytics: {connection.currencyCode ? `revenue in ${connection.currencyCode}` : ""}
              {connection.currencyCode && connection.timeZone ? ", " : ""}
              {connection.timeZone ? `days in ${connection.timeZone} time` : ""}.
            </p>
          ) : null}
          <p className={ui.muted}>
            {run ? (
              <>
                <Badge tone={run.status === "ok" ? "green" : run.status === "failed" ? "red" : "blue"}>{run.status === "ok" ? "Loaded" : run.status === "failed" ? "Failed" : "Loading…"}</Badge>{" "}
                Last load {formatDateTime(run.startedAt)}
                {run.rowsLoaded ? ` · ${rows(run.rowsLoaded)} rows` : ""}
                {run.error ? ` · ${run.error}` : ""}
              </>
            ) : connection.propertyId ? (
              "Not loaded yet."
            ) : null}
          </p>
          {connection.propertyId ? (
            <details style={{ overflowWrap: "anywhere" }}>
              <summary>View the {data.tables.length} tables</summary>
              <dl>
                {data.tables.map((table) => (
                  <div key={table}>
                    <dt>
                      <strong>{tableLabel(table)}</strong> <code>{table}</code>
                    </dt>
                    <dd style={{ margin: "0 0 8px" }}>{tableDescription(table)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}
          {canManage && (choosing || needsProperty) && !connection.needsReconnect ? (
            <PropertyChooser
              organisationId={organisationId}
              current={connection}
              onCancel={needsProperty ? undefined : () => setChoosing(false)}
              onSaved={(text, tone) => {
                setChoosing(false);
                setMessage({ tone, text });
                status.reload();
                onChanged();
              }}
            />
          ) : null}
          {canManage ? (
            <>
              {connection.needsReconnect ? <SetupHelp callbackPath={data.callbackPath} /> : null}
              <div className={ui.rowButtons}>
                {connection.needsReconnect ? (
                  <Button onClick={() => void signIn()} disabled={busy !== null}>{busy === "connect" ? "Opening Google…" : "Connect again"}</Button>
                ) : null}
                {connection.propertyId && !choosing && !connection.needsReconnect ? (
                  <Button size="small" variant="secondary" onClick={() => setChoosing(true)} disabled={busy !== null}>
                    Change property or settings
                  </Button>
                ) : null}
                <Button size="small" variant="danger" onClick={() => void disconnect()} disabled={busy !== null}>
                  {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
                </Button>
              </div>
            </>
          ) : null}
        </>
      )}
    </Card>
  );
}

function PropertyChooser({
  organisationId,
  current,
  onCancel,
  onSaved,
}: {
  organisationId: string;
  current: NonNullable<GaStatus["connection"]>;
  onCancel?: () => void;
  onSaved: (text: string, tone: "success" | "error") => void;
}) {
  const list = useApiData<{ properties: GaProperty[] }>("/api/analytics/google/properties", { organisationId });
  const [propertyId, setPropertyId] = useState(current.propertyId ?? "");
  const [months, setMonths] = useState(String(current.historyMonths || GA_DEFAULT_HISTORY_MONTHS));
  const [reloadDaily, setReloadDaily] = useState(current.reloadDaily);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const properties = list.data?.properties ?? [];
  const chosen = propertyId || properties[0]?.id || "";
  const accounts = [...new Set(properties.map((property) => property.account))];

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/analytics/google", {
        method: "PATCH",
        body: { organisationId, ...(chosen !== current.propertyId ? { propertyId: chosen } : {}), historyMonths: Number(months), reloadDaily },
      });
      // Load straight away, so there's data to look at.
      const { run } = await api<{ run: LoadRun }>("/api/analytics/google/load", { method: "POST", body: { organisationId } });
      onSaved(
        run.status === "ok" ? `Saved, and loaded ${rows(run.rowsLoaded)} rows from Google Analytics.` : `Saved, but Google Analytics didn't load: ${run.error}`,
        run.status === "ok" ? "success" : "error",
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      {list.loading ? <p className={ui.muted}>Asking Google for your properties…</p> : null}
      {list.data && properties.length === 0 ? (
        <Notice tone="warning">This Google account can&apos;t see any GA4 properties. Sign in with an account that has access, or ask the property&apos;s owner to add it.</Notice>
      ) : null}
      {properties.length ? (
        <div className={ui.grid3}>
          <Field label="GA4 property">
            <select value={chosen} onChange={(event) => setPropertyId(event.target.value)}>
              {accounts.map((account) => (
                <optgroup key={account} label={account || "Account"}>
                  {properties
                    .filter((property) => property.account === account)
                    .map((property) => (
                      <option key={property.id} value={property.id}>
                        {property.name} ({property.id})
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="Months of history" hint={`1 to ${GA_MAX_HISTORY_MONTHS}. 13 gives this month and the same month last year.`}>
            <input type="number" inputMode="numeric" min={1} max={GA_MAX_HISTORY_MONTHS} value={months} onChange={(event) => setMonths(event.target.value)} />
          </Field>
        </div>
      ) : null}
      {properties.length ? (
        <label className={ui.checkbox}>
          <input type="checkbox" checked={reloadDaily} onChange={(event) => setReloadDaily(event.target.checked)} /> Load again every night after 4am
        </label>
      ) : null}
      <div className={ui.rowButtons}>
        <Button onClick={() => void save()} disabled={busy || !chosen}>
          {busy ? "Saving and loading…" : "Save and load"}
        </Button>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}
