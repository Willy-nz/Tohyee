"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { AkahuSetup } from "@/components/bank/akahu-setup";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { Badge, Button, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { AkahuLogin, AkahuSettings } from "@/lib/bank/akahu/settings";
import { akahuLoginStatus, describeSchedule, describeSyncResult, type LinkedFeed } from "@/lib/bank/akahu/setup";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import own from "./akahu-setup.module.css";

/**
 * The Akahu bank feeds card on Bank accounts (#182, #543): each login with
 * its own status, schedule, last successful sync and linked accounts, and
 * the next thing to do right there ("Link bank accounts" when none are
 * linked). Setting up and linking go through the guided setup.
 */
export function AkahuFeedsCard({ organisationId, onChanged }: { organisationId: string; onChanged?: () => void }) {
  const confirm = useConfirm();
  const { can } = useWorkspace();
  const settings = useApiData<{ akahu: AkahuSettings }>("/api/bank-feeds/akahu/settings", { organisationId });
  const [setup, setSetup] = useState<{ login?: AkahuLogin } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const akahu = settings.data?.akahu ?? null;

  const changed = () => {
    settings.reload();
    onChanged?.();
  };

  async function remove(login: AkahuLogin) {
    const accounts = login.linkedAccounts.map((account) => `${account.code} ${account.name}`).join(", ");
    if (
      !(await confirm(
        `Remove ${login.name}? Its tokens are deleted${accounts ? ` and ${accounts} stop${login.linkedAccounts.length === 1 ? "s" : ""} syncing` : ""}. Lines already brought in stay. Other logins carry on.`,
      ))
    )
      return;
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/bank-feeds/akahu/settings", { method: "DELETE", query: { organisationId, connectionId: login.connectionId } });
      changed();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  /** Syncs each of the login's working feeds in turn, then says what came in. */
  async function syncLogin(login: AkahuLogin) {
    setSyncing(login.connectionId);
    setMessage(null);
    let added = 0;
    const failed: string[] = [];
    for (const account of login.linkedAccounts.filter((feed) => feed.feedActive)) {
      try {
        const { result } = await api<{ result: { added: number } }>(`/api/bank-accounts/${account.accountId}/feed/sync`, { method: "POST", body: { organisationId } });
        added += result.added;
      } catch (caught) {
        failed.push(`${account.code}: ${errorMessage(caught)}`);
      }
    }
    setSyncing(null);
    setMessage(
      failed.length
        ? { tone: "error", text: `Sync failed for ${failed.join(" ")}` }
        : { tone: "success", text: added ? `Synced ${login.name}: ${added} new ${added === 1 ? "line" : "lines"}.` : `Synced ${login.name}: nothing new.` },
    );
    changed();
  }

  if (settings.error) return <Notice tone="error">{settings.error}</Notice>;
  if (!akahu) return <p className={ui.muted}>Loading…</p>;

  if (setup && can("admin")) {
    return (
      <AkahuSetup
        organisationId={organisationId}
        login={setup.login}
        first={!akahu.configured}
        secretsAvailable={akahu.secretsAvailable}
        onClose={(text) => {
          setSetup(null);
          if (text) setMessage({ tone: "success", text });
          changed();
        }}
      />
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {!akahu.secretsAvailable ? (
        <Notice tone="warning">
          This server has no TOHYEE_SECRET_KEY, so Akahu tokens can&apos;t be stored. The server admin needs to set it (the Windows installer does this when it
          updates Tohyee).
        </Notice>
      ) : null}
      {akahu.logins.length === 0 ? (
        <div className={own.callout} style={{ background: "var(--surface-sunken)", borderColor: "var(--border)", color: "var(--text)" }}>
          <p>
            <strong>Not set up yet.</strong> Connect Akahu once, then choose which bank accounts come in. About 5 minutes.
          </p>
          {can("admin") ? (
            <Button onClick={() => setSetup({})} disabled={!akahu.secretsAvailable}>
              Set up bank feeds
            </Button>
          ) : (
            <p className={ui.muted}>An organisation admin can set up bank feeds.</p>
          )}
        </div>
      ) : null}
      {akahu.logins.map((login) =>
        editing === login.connectionId ? (
          <div key={login.connectionId} className={own.login}>
            <h3 style={{ margin: 0, fontSize: "1rem" }}>{login.name}: new tokens or schedule</h3>
            <AkahuTokensForm
              organisationId={organisationId}
              login={login}
              secretsAvailable={akahu.secretsAvailable}
              onCancel={() => setEditing(null)}
              onSaved={(text) => {
                setMessage({ tone: "success", text });
                setEditing(null);
                changed();
              }}
            />
          </div>
        ) : (
          <LoginBlock
            key={login.connectionId}
            login={login}
            canAdmin={can("admin")}
            canSync={can("bookkeeper")}
            syncing={syncing === login.connectionId}
            busy={busy || syncing !== null}
            onLink={() => setSetup({ login })}
            onSync={() => void syncLogin(login)}
            onEdit={() => setEditing(login.connectionId)}
            onRemove={() => void remove(login)}
          />
        ),
      )}
      {can("admin") && akahu.configured ? (
        <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
          <Button variant="secondary" onClick={() => setSetup({})}>
            Add another login
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function feedLine(feed: LinkedFeed): string {
  if (!feed.feedActive) return `Stopped: ${feed.lastSyncError ?? "link it again to carry on."}`;
  if (feed.lastSyncStatus === "failed") return `Last sync failed: ${feed.lastSyncError ?? "no reason given."}`;
  if (!feed.lastSyncOkAt) return "Not synced yet";
  return `${formatDateTime(feed.lastSyncOkAt)}: ${describeSyncResult({ added: feed.lastSyncAdded })}`;
}

function LoginBlock({
  login,
  canAdmin,
  canSync,
  syncing,
  busy,
  onLink,
  onSync,
  onEdit,
  onRemove,
}: {
  login: AkahuLogin;
  canAdmin: boolean;
  canSync: boolean;
  syncing: boolean;
  busy: boolean;
  onLink: () => void;
  onSync: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const status = akahuLoginStatus(login);
  const working = login.linkedAccounts.filter((feed) => feed.feedActive);
  const total = login.linkedAccounts.reduce((sum, feed) => sum + feed.linesBroughtIn, 0);
  return (
    <section className={own.login} aria-label={`Akahu login ${login.name}`}>
      <div className={own.loginHead}>
        <h3>{login.name}</h3>
        <Badge tone={syncing ? "blue" : status.tone}>{syncing ? "Syncing…" : status.label}</Badge>
      </div>
      {status.state === "needs_linking" ? (
        <div className={own.callout}>
          <p>
            <strong>Accounts need linking.</strong> Akahu is connected, but no bank account brings transactions in yet.
          </p>
          {canAdmin ? <Button onClick={onLink}>Link bank accounts</Button> : <p>An organisation admin can link them.</p>}
        </div>
      ) : null}
      {status.state === "tokens_refused" ? (
        <Notice tone="error">
          {login.tokenProblem} Get new tokens from the Developers page at my.akahu.nz.{" "}
          {canAdmin ? (
            <Button size="small" onClick={onEdit}>
              Enter new tokens
            </Button>
          ) : null}
        </Notice>
      ) : null}
      <dl className={own.facts}>
        <dt>Tokens</dt>
        <dd>
          {login.tokenProblem ? "Refused by Akahu" : login.tokensCheckedAt ? `Accepted by Akahu ${formatDateTime(login.tokensCheckedAt)}` : "Saved"}{" "}
          <span className={ui.muted}>· app {login.appTokenHint}</span>
        </dd>
        <dt>Schedule</dt>
        <dd>
          {describeSchedule(login.syncEveryHours)}{" "}
          <InfoTip label="About the schedule">
            This is when Tohyee looks for new transactions, not proof that any came in. Akahu itself refreshes from most banks about once a day.
          </InfoTip>
        </dd>
        <dt>Last successful sync</dt>
        <dd>{status.lastSuccessAt ? formatDateTime(status.lastSuccessAt) : login.linkedAccounts.length ? "Never yet" : "Nothing linked"}</dd>
        {login.linkedAccounts.length ? (
          <>
            <dt>Linked accounts</dt>
            <dd>
              <ul className={own.feeds}>
                {login.linkedAccounts.map((feed) => (
                  <li key={feed.accountId}>
                    <Link href={`/operations/bank-accounts/${feed.accountId}`}>
                      {feed.code} {feed.name}
                    </Link>
                    <div className={feed.feedActive && feed.lastSyncStatus !== "failed" ? ui.muted : undefined} style={feed.feedActive && feed.lastSyncStatus !== "failed" ? undefined : { color: "var(--danger-text)" }}>
                      {feedLine(feed)}
                    </div>
                    <div className={ui.muted}>
                      {feed.linesBroughtIn} {feed.linesBroughtIn === 1 ? "line" : "lines"} brought in
                    </div>
                  </li>
                ))}
              </ul>
            </dd>
            {login.linkedAccounts.length > 1 ? (
              <>
                <dt>All told</dt>
                <dd>
                  {total} {total === 1 ? "line" : "lines"} brought in
                </dd>
              </>
            ) : null}
          </>
        ) : null}
      </dl>
      <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
        {canSync && working.length ? (
          <Button onClick={onSync} disabled={busy || Boolean(login.tokenProblem)} variant={status.state === "ready" ? "primary" : "secondary"}>
            {syncing ? "Syncing…" : "Sync now"}
          </Button>
        ) : null}
        {canAdmin && login.linkedAccounts.length ? (
          <Button variant="secondary" onClick={onLink} disabled={busy || Boolean(login.tokenProblem)}>
            {status.state === "failed" && working.length < login.linkedAccounts.length ? "Link accounts again" : "Link more accounts"}
          </Button>
        ) : null}
        {canAdmin ? (
          <>
            <Button variant="secondary" onClick={onEdit} disabled={busy}>
              New tokens or schedule
            </Button>
            <Button variant="secondary" onClick={onRemove} disabled={busy}>
              Remove
            </Button>
          </>
        ) : null}
      </div>
    </section>
  );
}

/** New tokens or a new schedule for a login (blank tokens keep the saved ones). */
function AkahuTokensForm({
  organisationId,
  login,
  secretsAvailable,
  onCancel,
  onSaved,
}: {
  organisationId: string;
  login: AkahuLogin;
  secretsAvailable: boolean;
  onCancel: () => void;
  onSaved: (message: string) => void;
}) {
  const [appToken, setAppToken] = useState("");
  const [userToken, setUserToken] = useState("");
  const [syncEveryHours, setSyncEveryHours] = useState(String(login.syncEveryHours));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ accountCount: number }>("/api/bank-feeds/akahu/settings", {
        method: "PUT",
        body: { organisationId, connectionId: login.connectionId, appToken: appToken || undefined, userToken: userToken || undefined, syncEveryHours },
      });
      onSaved(`Saved ${login.name}. Akahu shares ${result.accountCount} ${result.accountCount === 1 ? "account" : "accounts"} with it.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void save(event)} style={{ display: "grid", gap: 12 }} autoComplete="off">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid2}>
        <Field label="App ID token" hint="Leave blank to keep the saved one.">
          <input value={appToken} onChange={(event) => setAppToken(event.target.value.trim())} maxLength={200} />
        </Field>
        <Field label="User token" hint="Leave blank to keep the saved one.">
          <input type="password" value={userToken} onChange={(event) => setUserToken(event.target.value.trim())} maxLength={500} autoComplete="new-password" />
        </Field>
        <Field label="Check for new transactions">
          <select value={syncEveryHours} onChange={(event) => setSyncEveryHours(event.target.value)}>
            {[...new Set([1, 2, 3, 4, 6, 8, 12, 24, login.syncEveryHours])].sort((a, b) => a - b).map((hours) => (
              <option key={hours} value={String(hours)}>
                {hours === 1 ? "Every hour" : `Every ${hours} hours`}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className={ui.actions}>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !secretsAvailable}>
          {busy ? "Checking with Akahu…" : `Save ${login.name}`}
        </Button>
      </div>
      <p className={ui.muted} style={{ margin: 0 }}>
        Akahu checks the tokens first. Accounts the new tokens can&apos;t see stop syncing until they&apos;re linked again.
      </p>
    </form>
  );
}
