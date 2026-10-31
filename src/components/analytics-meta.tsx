"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import type { MetaAccounts, MetaAppSettings, MetaCheck, MetaStatus } from "@/lib/analytics/meta";
import { META_PERMISSION_TEXT } from "@/lib/analytics/meta-reports";
import { tableDescription, tableLabel } from "@/lib/analytics/labels";
import type { LoadRun } from "@/lib/analytics/sources";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime } from "@/lib/format";

export const META_SETUP_PATH = "/analytics/sources/meta-setup";

/** Buttons that wrap onto a second line on a phone. */
const buttonRow = { display: "flex", flexWrap: "wrap" as const, gap: 8, alignItems: "center", marginTop: 12 };

function rows(value: string | null): string {
  return value === null ? "" : Number(value).toLocaleString("en-NZ");
}

/**
 * Meta in Analytics › Data sources (#516, decisions 1190-1209): set up the
 * Meta app (on its own page), sign in with Facebook asking only to read,
 * choose the Page (its Instagram account comes with it) and maybe an ad
 * account, load, refresh, reconnect or disconnect. `onlyIfConnected` shows
 * nothing until it's connected (the Connected sources list).
 */
export function MetaCard({
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
  const status = useApiData<MetaStatus>("/api/analytics/meta", { organisationId });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [withAds, setWithAds] = useState(false);
  const confirm = useConfirm();

  if (status.error) return onlyIfConnected ? null : <Notice tone="error">{status.error}</Notice>;
  const data = status.data;
  if (!data) return null;
  const connection = data.connection;
  if (onlyIfConnected && !connection) return null;

  async function signIn(ads: boolean) {
    setBusy("connect");
    setMessage(null);
    try {
      const { url } = await api<{ url: string }>("/api/analytics/meta", { method: "POST", body: { organisationId, withAds: ads } });
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
      const { run } = await api<{ run: LoadRun }>("/api/analytics/meta/load", { method: "POST", body: { organisationId } });
      setMessage(run.status === "ok" ? { tone: "success", text: `Loaded ${rows(run.rowsLoaded)} rows from Meta.` } : { tone: "error", text: `Meta didn't load: ${run.error}` });
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
      "Tohyee deletes the Facebook sign-in and every Meta table it loaded, including days Meta no longer keeps. Reports that use them will show no data. Nothing changes on Facebook or Instagram. The saved Meta app and the load history stay.",
      { title: "Disconnect Meta?", confirmLabel: "Disconnect", danger: true },
    );
    if (!ok) return;
    setBusy("disconnect");
    setMessage(null);
    try {
      await api("/api/analytics/meta", { method: "DELETE", query: { organisationId } });
      setMessage({ tone: "success", text: "Meta is disconnected and its data removed." });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
      status.reload();
      onChanged();
    }
  }

  const run = data.lastLoad;
  const needsPage = Boolean(connection && !connection.pageId);
  const adsBox = (
    <label className={ui.checkbox}>
      <input type="checkbox" checked={withAds} onChange={(event) => setWithAds(event.target.checked)} /> Also load ads (asks to read your ad accounts&apos; results)
    </label>
  );
  return (
    <Card
      title="Meta (Facebook and Instagram)"
      description="A Facebook Page and its Instagram account: followers, reach, views and engagement by day, and each post's figures. Optionally, ad spend and results by campaign."
      actions={
        canManage && connection && connection.pageId && !connection.needsReconnect ? (
          <Button size="small" onClick={() => void refresh()} disabled={busy !== null}>
            {busy === "load" ? "Loading…" : "Refresh now"}
          </Button>
        ) : null
      }
    >
      {returned ? <Notice tone={returned.ok ? "success" : "error"}>{returned.message}</Notice> : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {!connection ? (
        !data.appReady ? (
          <>
            <p className={ui.muted}>
              Meta needs a free Meta app of your own first. It takes about 10 minutes, and can stay in development mode for your own Page and Instagram: no Meta review
              needed.
            </p>
            {canManage ? (
              <div style={buttonRow}>
                <Link className={`${ui.button} ${ui.primary}`} href={META_SETUP_PATH}>
                  Set up Meta
                </Link>
              </div>
            ) : (
              <p className={ui.muted}>An admin needs to set it up.</p>
            )}
          </>
        ) : (
          <>
            <p className={ui.muted}>
              Not connected. An admin signs in with the Facebook account that manages the Page. Tohyee asks only to read: it can never post, reply or change anything.
            </p>
            {canManage ? (
              <>
                {adsBox}
                <div style={buttonRow}>
                  <Button onClick={() => void signIn(withAds)} disabled={busy !== null}>
                    {busy === "connect" ? "Opening Facebook…" : "Connect Meta"}
                  </Button>
                  <Link className={`${ui.button} ${ui.secondary}`} href={META_SETUP_PATH}>
                    Setup and Check setup
                  </Link>
                </div>
              </>
            ) : null}
          </>
        )
      ) : (
        <>
          {connection.needsReconnect ? (
            <Notice tone="warning">
              Meta no longer accepts this sign-in{connection.reconnectReason ? ` (${connection.reconnectReason})` : ""}, so nothing loads. What&apos;s loaded is kept.{" "}
              {canManage ? "Connect again below: the Page and settings stay." : "An admin needs to connect again."}
            </Notice>
          ) : connection.signInEndsSoon && connection.signInEndsAt ? (
            <Notice tone="warning">
              Meta ends this sign-in on {formatDate(connection.signInEndsAt.slice(0, 10))}.{" "}
              {connection.adAccountId ? "Ads stop loading then" : "Choosing another Page needs it"}; the Page and Instagram carry on. {canManage ? "Connect again to renew it." : "An admin can connect again to renew it."}
            </Notice>
          ) : null}
          <p className={ui.muted} style={{ overflowWrap: "anywhere" }}>
            {connection.pageId ? (
              <>
                <strong>{connection.pageName}</strong>
                {connection.instagramUsername ? ` · Instagram @${connection.instagramUsername}` : " · no Instagram account linked"}
                {connection.adAccountName ? ` · ads: ${connection.adAccountName}${connection.adCurrency ? ` (${connection.adCurrency})` : ""}` : ""}
              </>
            ) : (
              "Signed in. Choose the Page to load."
            )}
            {connection.facebookName ? ` · Signed in as ${connection.facebookName}` : ""}
            {` · ${connection.reloadDaily ? "loads nightly after 4am" : "loads by hand only"}`}
          </p>
          {connection.declined.length ? (
            <p className={ui.muted}>Not allowed when signing in: {connection.declined.map((name) => META_PERMISSION_TEXT[name] ?? name).join("; ")}.</p>
          ) : null}
          {connection.facebookLoadedThrough || connection.instagramLoadedThrough || connection.adsLoadedThrough ? (
            <p className={ui.muted}>
              Loaded up to{" "}
              {[
                connection.facebookLoadedThrough ? `${formatDate(connection.facebookLoadedThrough)} for the Page` : null,
                connection.instagramLoadedThrough ? `${formatDate(connection.instagramLoadedThrough)} for Instagram` : null,
                connection.adsLoadedThrough ? `${formatDate(connection.adsLoadedThrough)} for ads` : null,
              ]
                .filter(Boolean)
                .join(", ")}
              . The last two days may still change; Tohyee fetches them again each load.
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
            ) : connection.pageId ? (
              "Not loaded yet."
            ) : null}
          </p>
          {connection.pageId ? (
            <details style={{ overflowWrap: "anywhere" }}>
              <summary>View the tables and what the figures mean</summary>
              <p>
                Meta keeps Instagram account figures for 90 days and Page and post figures for 2 years. The first load goes back that far; after that each load
                fetches only the new days and the last two again. Days Meta has deleted stay in Tohyee until you disconnect.
              </p>
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
          {canManage && (choosing || needsPage) && !connection.needsReconnect ? (
            <MetaChooser
              organisationId={organisationId}
              current={connection}
              onCancel={needsPage ? undefined : () => setChoosing(false)}
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
              {!connection.canReadAds ? adsBox : null}
              <div style={buttonRow}>
                {connection.needsReconnect || connection.signInEndsSoon ? (
                  <Button onClick={() => void signIn(withAds || connection.canReadAds)} disabled={busy !== null}>
                    {busy === "connect" ? "Opening Facebook…" : "Connect again"}
                  </Button>
                ) : null}
                {!connection.needsReconnect && !connection.signInEndsSoon && !connection.canReadAds && withAds ? (
                  <Button onClick={() => void signIn(true)} disabled={busy !== null}>
                    {busy === "connect" ? "Opening Facebook…" : "Connect again with ads"}
                  </Button>
                ) : null}
                {connection.pageId && !choosing && !connection.needsReconnect ? (
                  <Button size="small" variant="secondary" onClick={() => setChoosing(true)} disabled={busy !== null}>
                    Change Page or settings
                  </Button>
                ) : null}
                <Link className={`${ui.button} ${ui.secondary} ${ui.small}`} href={META_SETUP_PATH}>
                  Check setup
                </Link>
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

function MetaChooser({
  organisationId,
  current,
  onCancel,
  onSaved,
}: {
  organisationId: string;
  current: NonNullable<MetaStatus["connection"]>;
  onCancel?: () => void;
  onSaved: (text: string, tone: "success" | "error") => void;
}) {
  const list = useApiData<MetaAccounts>("/api/analytics/meta/accounts", { organisationId });
  const [pageId, setPageId] = useState(current.pageId ?? "");
  const [adAccountId, setAdAccountId] = useState(current.adAccountId ?? "");
  const [reloadDaily, setReloadDaily] = useState(current.reloadDaily);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pages = list.data?.pages ?? [];
  const chosenId = pageId || pages[0]?.id || "";
  const chosen = pages.find((page) => page.id === chosenId);
  const startsAgain = (Boolean(current.facebookLoadedThrough) && chosenId !== current.pageId) || (Boolean(current.adsLoadedThrough) && adAccountId !== (current.adAccountId ?? ""));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/analytics/meta", {
        method: "PATCH",
        body: { organisationId, ...(chosenId !== current.pageId ? { pageId: chosenId } : {}), ...(adAccountId !== (current.adAccountId ?? "") ? { adAccountId: adAccountId || null } : {}), reloadDaily },
      });
      const { run } = await api<{ run: LoadRun }>("/api/analytics/meta/load", { method: "POST", body: { organisationId } });
      onSaved(run.status === "ok" ? `Saved, and loaded ${rows(run.rowsLoaded)} rows from Meta.` : `Saved, but Meta didn't load: ${run.error}`, run.status === "ok" ? "success" : "error");
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
      {list.loading ? <p className={ui.muted}>Asking Meta for your Pages…</p> : null}
      {list.data && pages.length === 0 ? (
        <Notice tone="warning">
          Meta lists no Pages for this sign-in. Connect again and tick your Page when Meta asks which Pages Tohyee can use. <Link href={META_SETUP_PATH}>Check setup</Link> says
          what else to look at.
        </Notice>
      ) : null}
      {pages.length ? (
        <div className={ui.grid3}>
          <Field label="Facebook Page" hint="Its linked Instagram account loads with it.">
            <select value={chosenId} onChange={(event) => setPageId(event.target.value)}>
              {pages.map((page) => (
                <option key={page.id} value={page.id}>
                  {page.name}
                  {page.instagram ? ` (Instagram @${page.instagram.username})` : " (no Instagram linked)"}
                </option>
              ))}
            </select>
          </Field>
          {list.data?.canReadAds ? (
            <Field label="Ad account" hint="Optional. Spend is in the account's own currency.">
              <select value={adAccountId} onChange={(event) => setAdAccountId(event.target.value)}>
                <option value="">No ads</option>
                {list.data.adAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} ({account.currency || "?"}){account.active ? "" : " – not active"}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
      ) : null}
      {chosen && !chosen.instagram ? (
        <Notice tone="info">
          {chosen.name} has no Instagram account linked, so only the Page loads. To add Instagram, make it a professional account and link it to this Page (
          <Link href={`${META_SETUP_PATH}#instagram`}>how</Link>), then connect again.
        </Notice>
      ) : null}
      {chosen && !chosen.canAnalyse ? <Notice tone="warning">Your role on {chosen.name} can&apos;t see its insights. Ask the Page&apos;s admin for full control or the Insights task.</Notice> : null}
      {pages.length ? (
        <label className={ui.checkbox}>
          <input type="checkbox" checked={reloadDaily} onChange={(event) => setReloadDaily(event.target.checked)} /> Load again every night after 4am
        </label>
      ) : null}
      {startsAgain ? <Notice tone="warning">Changing the Page or ad account deletes what&apos;s loaded for it and loads the new one from the start.</Notice> : null}
      {pages.length && !current.facebookLoadedThrough ? (
        <p className={ui.muted}>The first load reads two years of the Page and its posts, 90 days of Instagram, and 13 months of ads. It can take a few minutes.</p>
      ) : null}
      <div style={buttonRow}>
        <Button onClick={() => void save()} disabled={busy || !chosenId || (chosen ? !chosen.canAnalyse : false)}>
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

/** The Meta app's form on the setup page (decision 1191): App ID, App secret (never shown again) and the optional configuration ID. Admins only. */
export function MetaAppForm({ organisationId, onSaved }: { organisationId: string; onSaved: () => void }) {
  const app = useApiData<MetaAppSettings>("/api/analytics/meta/app", { organisationId });
  if (app.error) return <Notice tone="error">{app.error}</Notice>;
  if (!app.data) return null;
  return <MetaAppFields key={`${app.data.appId ?? ""}:${app.data.configId ?? ""}`} organisationId={organisationId} saved={app.data} onSaved={() => { app.reload(); onSaved(); }} />;
}

function MetaAppFields({ organisationId, saved, onSaved }: { organisationId: string; saved: MetaAppSettings; onSaved: () => void }) {
  const [appId, setAppId] = useState(saved.appId ?? "");
  const [appSecret, setAppSecret] = useState("");
  const [configId, setConfigId] = useState(saved.configId ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/analytics/meta/app", { method: "PUT", body: { organisationId, appId, appSecret, configId } });
      setAppSecret("");
      setMessage({ tone: "success", text: "Saved. Now choose Check setup, or go back to Data sources and choose Connect Meta." });
      onSaved();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)}>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="App ID" hint="Only digits.">
          <input value={appId} inputMode="numeric" autoComplete="off" onChange={(event) => setAppId(event.target.value)} />
        </Field>
        <Field label="App secret" hint={saved.secretSaved ? "Saved, and never shown again. Leave blank to keep it." : "Stored encrypted on this server."}>
          <input type="password" value={appSecret} autoComplete="new-password" onChange={(event) => setAppSecret(event.target.value)} />
        </Field>
        <Field label="Configuration ID (optional)" hint="From Facebook Login for Business › Configurations, if you made one.">
          <input value={configId} inputMode="numeric" autoComplete="off" onChange={(event) => setConfigId(event.target.value)} />
        </Field>
      </div>
      <div style={buttonRow}>
        <Button type="submit" disabled={busy || !appId.trim()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

const CHECK_TONE: Record<MetaCheck["state"], "green" | "red" | "amber" | "neutral"> = { ok: "green", problem: "red", warning: "amber", skipped: "neutral" };
const CHECK_WORD: Record<MetaCheck["state"], string> = { ok: "OK", problem: "Fix this", warning: "Check", skipped: "Not yet" };

/** Check setup (decision 1201): asks Meta about each part and says plainly what to fix. */
export function MetaCheckSetup({ organisationId }: { organisationId: string }) {
  const [checks, setChecks] = useState<MetaCheck[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setChecks((await api<{ checks: MetaCheck[] }>("/api/analytics/meta/check", { query: { organisationId } })).checks);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={buttonRow}>
        <Button onClick={() => void run()} disabled={busy}>
          {busy ? "Checking with Meta…" : "Check setup"}
        </Button>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {checks ? (
        <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 10 }} aria-live="polite">
          {checks.map((check) => (
            <li key={check.id} style={{ overflowWrap: "anywhere" }}>
              <Badge tone={CHECK_TONE[check.state]}>{CHECK_WORD[check.state]}</Badge> <strong>{check.label}.</strong> {check.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
