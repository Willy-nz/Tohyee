"use client";

import Link from "next/link";
import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import type { GscSite, GscStatus } from "@/lib/analytics/search-console";
import { GSC_POSITION_TEXT, GSC_SEARCH_TYPES, type GscSearchType } from "@/lib/analytics/search-console-reports";
import { tableDescription, tableLabel } from "@/lib/analytics/labels";
import type { LoadRun } from "@/lib/analytics/sources";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime } from "@/lib/format";

export const SEARCH_CONSOLE_HELP_PATH = "/analytics/sources/search-console-help";

function rows(value: string | null): string {
  return value === null ? "" : Number(value).toLocaleString("en-NZ");
}

const PERMISSION: Record<string, string> = { siteOwner: "owner", siteFullUser: "full user", siteRestrictedUser: "restricted user" };

/** What an admin sets up in Google Cloud first (decision 1180): the same app and return address as Google Analytics. */
function CloudHelp({ callbackPath }: { callbackPath: string }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <details style={{ overflowWrap: "anywhere" }}>
      <summary>What an admin sets up in Google Cloud first</summary>
      <ol style={{ paddingLeft: 20 }}>
        <li>
          Tohyee signs in with the Google app saved under <Link href="/operations/settings/email">Settings › Email</Link>, returning to the same address as
          Google Analytics: <code style={{ wordBreak: "break-all" }}>{origin}{callbackPath}</code>. If Google Analytics is already connected, it&apos;s there already.
        </li>
        <li>In the same Google Cloud project, enable the <strong>Google Search Console API</strong> (APIs &amp; Services › Library).</li>
        <li>
          On the consent screen (Google Auth Platform › Data access), add the scope <code style={{ wordBreak: "break-all" }}>https://www.googleapis.com/auth/webmasters.readonly</code>.
          Tohyee asks only for that: it can read Search Console, never change it.
        </li>
        <li>
          While the app&apos;s publishing status is <strong>Testing</strong>, Google ends each sign-in after 7 days and you&apos;ll need to connect again. Publishing
          the app, or an Internal app in Google Workspace, avoids this.
        </li>
      </ol>
    </details>
  );
}

/**
 * Google Search Console in Analytics › Data sources (#512, decisions
 * 1180-1189): sign in with Google, choose a verified property, load its
 * search data by day, refresh or disconnect. `onlyIfConnected` shows
 * nothing until it's connected (the Connected sources list).
 */
export function SearchConsoleCard({
  organisationId,
  canManage,
  onlyIfConnected = false,
  returned,
  onChanged,
}: {
  organisationId: string;
  canManage: boolean;
  onlyIfConnected?: boolean;
  returned?: { ok: boolean; message: string } | null;
  onChanged: () => void;
}) {
  const status = useApiData<GscStatus>("/api/analytics/google/search-console", { organisationId });
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
      const { url } = await api<{ url: string }>("/api/analytics/google/search-console", { method: "POST", body: { organisationId } });
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
      const { run } = await api<{ run: LoadRun }>("/api/analytics/google/search-console/load", { method: "POST", body: { organisationId } });
      setMessage(run.status === "ok" ? { tone: "success", text: `Loaded ${rows(run.rowsLoaded)} rows from Search Console.` } : { tone: "error", text: `Search Console didn't load: ${run.error}` });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
      status.reload();
      onChanged();
    }
  }

  async function disconnect() {
    const ok = await confirm(
      "Tohyee deletes the Google sign-in and every Search Console table it loaded, including days Google no longer keeps. Reports that use them will show no data. Nothing changes in Search Console itself. The load history stays.",
      { title: "Disconnect Google Search Console?", confirmLabel: "Disconnect", danger: true },
    );
    if (!ok) return;
    setBusy("disconnect");
    setMessage(null);
    try {
      await api("/api/analytics/google/search-console", { method: "DELETE", query: { organisationId } });
      setMessage({ tone: "success", text: "Google Search Console is disconnected and its data removed." });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
      status.reload();
      onChanged();
    }
  }

  const run = data.lastLoad;
  const needsSite = Boolean(connection && !connection.siteUrl);
  const searchLabel = GSC_SEARCH_TYPES.find((entry) => entry.id === connection?.searchType)?.label ?? "Web";
  return (
    <Card
      title="Google Search Console"
      description="How a website does in Google search, by day: what people searched for, clicks, impressions, average position, pages, countries and devices."
      actions={
        canManage && connection && connection.siteUrl && !connection.needsReconnect ? (
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
          <p className={ui.muted}>
            Not connected. An admin signs in with a Google account that can see the website in Search Console; Tohyee only asks to read it. New to Search
            Console? <Link href={SEARCH_CONSOLE_HELP_PATH}>How to add your website and sitemap</Link> (including Shopify).
          </p>
          {canManage ? (
            <>
              <CloudHelp callbackPath={data.callbackPath} />
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
          <p className={ui.muted} style={{ overflowWrap: "anywhere" }}>
            {connection.siteUrl ? (
              <>
                <strong>{connection.siteLabel}</strong>
                {connection.permissionLevel && PERMISSION[connection.permissionLevel] ? ` (you're a ${PERMISSION[connection.permissionLevel]})` : ""}
                {` · ${searchLabel}`}
              </>
            ) : (
              "Signed in. Choose the property to load."
            )}
            {connection.googleEmail ? ` · Signed in as ${connection.googleEmail}` : ""}
            {` · ${connection.reloadDaily ? "loads nightly after 4am" : "loads by hand only"}`}
          </p>
          {connection.loadedThrough ? (
            <p className={ui.muted}>
              Loaded {formatDate(connection.loadedFrom)} to {formatDate(connection.loadedThrough)} (Google&apos;s days, Pacific time).
              {connection.changingFrom ? ` From ${formatDate(connection.changingFrom)} the figures may still change; Tohyee fetches those days again each load.` : ""}
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
            ) : connection.siteUrl ? (
              "Not loaded yet."
            ) : null}
          </p>
          {connection.siteUrl ? (
            <details style={{ overflowWrap: "anywhere" }}>
              <summary>View the {data.tables.length} tables and what the figures mean</summary>
              <p>Google keeps about 16 months of search data, and the newest days arrive 2 to 3 days late. The first load goes back as far as Google allows; after that each load fetches only the new days and the ones that may still change. Days Google has deleted stay in Tohyee until you disconnect.</p>
              <p>{GSC_POSITION_TEXT}</p>
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
          {canManage && (choosing || needsSite) && !connection.needsReconnect ? (
            <SiteChooser
              organisationId={organisationId}
              current={connection}
              onCancel={needsSite ? undefined : () => setChoosing(false)}
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
              {connection.needsReconnect ? <CloudHelp callbackPath={data.callbackPath} /> : null}
              <div className={ui.rowButtons}>
                {connection.needsReconnect ? (
                  <Button onClick={() => void signIn()} disabled={busy !== null}>{busy === "connect" ? "Opening Google…" : "Connect again"}</Button>
                ) : null}
                {connection.siteUrl && !choosing && !connection.needsReconnect ? (
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

function SiteChooser({
  organisationId,
  current,
  onCancel,
  onSaved,
}: {
  organisationId: string;
  current: NonNullable<GscStatus["connection"]>;
  onCancel?: () => void;
  onSaved: (text: string, tone: "success" | "error") => void;
}) {
  const list = useApiData<{ sites: GscSite[] }>("/api/analytics/google/search-console/sites", { organisationId });
  const [siteUrl, setSiteUrl] = useState(current.siteUrl ?? "");
  const [searchType, setSearchType] = useState<GscSearchType>(current.searchType);
  const [reloadDaily, setReloadDaily] = useState(current.reloadDaily);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sites = list.data?.sites ?? [];
  const chosen = siteUrl || sites[0]?.siteUrl || "";
  const startsAgain = Boolean(current.loadedThrough) && (chosen !== current.siteUrl || searchType !== current.searchType);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/analytics/google/search-console", {
        method: "PATCH",
        body: { organisationId, ...(chosen !== current.siteUrl ? { siteUrl: chosen } : {}), searchType, reloadDaily },
      });
      const { run } = await api<{ run: LoadRun }>("/api/analytics/google/search-console/load", { method: "POST", body: { organisationId } });
      onSaved(run.status === "ok" ? `Saved, and loaded ${rows(run.rowsLoaded)} rows from Search Console.` : `Saved, but Search Console didn't load: ${run.error}`, run.status === "ok" ? "success" : "error");
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
      {list.data && sites.length === 0 ? (
        <Notice tone="warning">
          This Google account has no verified Search Console properties. <Link href={SEARCH_CONSOLE_HELP_PATH}>Add and verify your website</Link>, or sign in with an
          account that has access.
        </Notice>
      ) : null}
      {sites.length ? (
        <div className={ui.grid3}>
          <Field label="Search Console property" hint="A whole domain, or one web address (URL prefix).">
            <select value={chosen} onChange={(event) => setSiteUrl(event.target.value)}>
              {sites.map((site) => (
                <option key={site.siteUrl} value={site.siteUrl}>
                  {site.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Search type" hint="Web is what most people mean by Google search.">
            <select value={searchType} onChange={(event) => setSearchType(event.target.value as GscSearchType)}>
              {GSC_SEARCH_TYPES.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}
      {sites.length ? (
        <label className={ui.checkbox}>
          <input type="checkbox" checked={reloadDaily} onChange={(event) => setReloadDaily(event.target.checked)} /> Load again every night after 4am
        </label>
      ) : null}
      {startsAgain ? <Notice tone="warning">Changing the property or search type deletes what&apos;s loaded and loads the new one from the start.</Notice> : null}
      {sites.length && !current.loadedThrough ? <p className={ui.muted}>The first load goes back 16 months, as far as Google keeps, one day at a time. It can take a few minutes.</p> : null}
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
