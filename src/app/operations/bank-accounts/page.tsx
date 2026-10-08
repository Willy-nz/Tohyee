"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { ACCOUNT_TYPE_LABELS, FeedBadge } from "@/components/bank/common";
import { CurrencyMoney } from "@/components/bank/foreign";
import { SimpleFinSettingsCard } from "@/components/bank/simplefin";
import { PayPalSettingsCard } from "@/components/bank/paypal";
import { StripeSettingsCard } from "@/components/bank/stripe";
import { WiseSettingsCard } from "@/components/bank/wise";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BankAccount } from "@/lib/bank/accounts";
import type { AkahuLogin, AkahuSettings } from "@/lib/bank/akahu/settings";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime } from "@/lib/format";
import { CURRENCY_MINOR_UNITS } from "@/lib/money/currency";
import { useConfirm } from "@/components/confirm-dialog";

function AddAccountForm({ organisationId, onAdded }: { organisationId: string; onAdded: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [accountType, setAccountType] = useState<BankAccount["accountType"]>("bank");
  const [description, setDescription] = useState("");
  const base = useWorkspace().current?.baseCurrency ?? "NZD";
  const [currencyCode, setCurrencyCode] = useState(base);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/bank-accounts", {
        method: "POST",
        body: { organisationId, code, name, accountType, description: description || undefined, currencyCode: currencyCode === base ? undefined : currencyCode },
      });
      setCode("");
      setName("");
      setDescription("");
      onAdded();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }} autoComplete="off">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid4}>
        <Field label="Type">
          <select value={accountType} onChange={(event) => setAccountType(event.target.value as BankAccount["accountType"])}>
            <option value="bank">Bank account</option>
            <option value="credit_card">Credit card</option>
          </select>
        </Field>
        <Field label="Code" hint="The chart of accounts code, e.g. 1020.">
          <input value={code} onChange={(event) => setCode(event.target.value)} maxLength={20} required />
        </Field>
        <Field label="Name">
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required placeholder="ANZ Business Visa" />
        </Field>
        <Field label="Description" hint="Optional, e.g. the account number.">
          <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} />
        </Field>
        <Field label="Currency" hint={currencyCode === base ? undefined : `Statement lines and matching are in this currency, with ${base} beside them. No Akahu feed.`}>
          <select value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value)}>
            {[base, ...Object.keys(CURRENCY_MINOR_UNITS).filter((code) => code !== base)].map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add account"}
        </Button>
      </div>
    </form>
  );
}

/**
 * The organisation's Akahu personal apps (#182, BK30-BK35): one or more
 * logins, each named, with its own tokens and sync hours. Each linked account
 * syncs with its own login's tokens.
 */
function AkahuSettingsCard({ organisationId }: { organisationId: string }) {
  const confirm = useConfirm();
  const { can } = useWorkspace();
  const settings = useApiData<{ akahu: AkahuSettings }>("/api/bank-feeds/akahu/settings", { organisationId });
  // Which form is open: a new login, or new tokens for one login.
  const [form, setForm] = useState<{ mode: "add" } | { mode: "edit"; login: AkahuLogin } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const akahu = settings.data?.akahu ?? null;

  async function remove(login: AkahuLogin) {
    const accounts = login.linkedAccounts.map((account) => `${account.code} ${account.name}`).join(", ");
    if (
      !(await confirm(
        `Remove ${login.name}? Its tokens are deleted${accounts ? ` and ${accounts} stop${login.linkedAccounts.length === 1 ? "s" : ""} syncing` : ""}. Lines already brought in stay. Other logins carry on.`,
      ))
    )
      return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await api("/api/bank-feeds/akahu/settings", { method: "DELETE", query: { organisationId, connectionId: login.connectionId } });
      settings.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (settings.error) return <Notice tone="error">{settings.error}</Notice>;
  if (!akahu) return <p className={ui.muted}>Loading…</p>;
  const showAdd = can("admin") && (form?.mode === "add" || !akahu.configured);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {saved ? <Notice tone="success">{saved}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!akahu.secretsAvailable ? (
        <Notice tone="warning">
          This server has no TOHYEE_SECRET_KEY, so Akahu tokens can&apos;t be stored. The server admin needs to set it (the Windows
          installer does this when it updates Tohyee).
        </Notice>
      ) : null}
      {akahu.logins.length === 0 ? <p className={ui.muted}>Not set up yet.</p> : null}
      {akahu.logins.map((login) => (
        <div key={login.connectionId} style={{ display: "grid", gap: 8 }}>
          <p style={{ margin: 0 }}>
            <strong>{login.name}</strong>{" "}
            {login.tokenProblem ? <Badge tone="red">{login.tokenProblem}</Badge> : <Badge tone="green">Set up</Badge>} App {login.appTokenHint}, syncing
            every {login.syncEveryHours} {login.syncEveryHours === 1 ? "hour" : "hours"}
            <span className={ui.muted}>
              {" "}
              · saved {formatDateTime(login.createdAt)}
              {login.createdByEmail ? ` by ${login.createdByEmail}` : ""}
              {login.linkedAccounts.length
                ? ` · linked to ${login.linkedAccounts.map((account) => `${account.code} ${account.name}`).join(", ")}`
                : " · no accounts linked yet"}
            </span>
          </p>
          {form?.mode === "edit" && form.login.connectionId === login.connectionId ? (
            <AkahuTokensForm
              organisationId={organisationId}
              login={login}
              secretsAvailable={akahu.secretsAvailable}
              onCancel={() => setForm(null)}
              onSaved={(message) => {
                setSaved(message);
                setForm(null);
                settings.reload();
              }}
            />
          ) : can("admin") ? (
            <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
              <Button variant="secondary" size="small" onClick={() => setForm({ mode: "edit", login })}>
                New tokens or sync hours
              </Button>
              <Button variant="secondary" size="small" onClick={() => void remove(login)} disabled={busy}>
                Remove
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      {showAdd ? (
        <AkahuTokensForm
          organisationId={organisationId}
          login={null}
          first={!akahu.configured}
          secretsAvailable={akahu.secretsAvailable}
          onCancel={akahu.configured ? () => setForm(null) : undefined}
          onSaved={(message) => {
            setSaved(message);
            setForm(null);
            settings.reload();
          }}
        />
      ) : can("admin") && akahu.configured && form === null ? (
        <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
          <Button variant="secondary" onClick={() => setForm({ mode: "add" })}>
            Add another login
          </Button>
        </div>
      ) : null}
      {!can("admin") && !akahu.configured ? <p className={ui.muted}>An organisation admin can set up bank feeds.</p> : null}
    </div>
  );
}

/** Adds an Akahu login (`login` null) or saves new tokens or sync hours for one. */
function AkahuTokensForm({
  organisationId,
  login,
  first = false,
  secretsAvailable,
  onCancel,
  onSaved,
}: {
  organisationId: string;
  login: AkahuLogin | null;
  first?: boolean;
  secretsAvailable: boolean;
  onCancel?: () => void;
  onSaved: (message: string) => void;
}) {
  const [name, setName] = useState(first ? "Akahu" : "");
  const [appToken, setAppToken] = useState("");
  const [userToken, setUserToken] = useState("");
  const [syncEveryHours, setSyncEveryHours] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ akahu: AkahuSettings; accountCount: number }>("/api/bank-feeds/akahu/settings", {
        method: "PUT",
        body: {
          organisationId,
          ...(login ? { connectionId: login.connectionId } : { add: true, name: name.trim() }),
          appToken: appToken || undefined,
          userToken: userToken || undefined,
          syncEveryHours: syncEveryHours || undefined,
        },
      });
      onSaved(
        `Saved ${login?.name ?? name.trim()}. Akahu shares ${result.accountCount} ${result.accountCount === 1 ? "account" : "accounts"} with it; link each one on its bank account's Bank feed tab.`,
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void save(event)} style={{ display: "grid", gap: 12 }} autoComplete="off">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {login ? null : (
        <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}>
          <li>Sign in at my.akahu.nz with the Akahu login that has these bank logins, and connect its banks.</li>
          <li>Open Developers and create a personal app.</li>
          <li>Copy the App ID token and the user token into the boxes below.</li>
        </ol>
      )}
      <div className={ui.grid4}>
        {login ? null : (
          <Field label="Name" hint="Whose bank logins these are, e.g. Will's BNZ login.">
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required />
          </Field>
        )}
        <Field label="App ID token" hint={login ? "Leave blank to keep the saved one." : "Starts with app_token_."}>
          <input value={appToken} onChange={(event) => setAppToken(event.target.value.trim())} required={!login} />
        </Field>
        <Field label="User token" hint={login ? "Leave blank to keep the saved one." : "Starts with user_token_."}>
          <input type="password" value={userToken} onChange={(event) => setUserToken(event.target.value.trim())} required={!login} />
        </Field>
        <Field label="Sync every (hours)" hint="Akahu itself refreshes from the banks about once a day.">
          <input
            type="number"
            min={1}
            max={24}
            placeholder={String(login?.syncEveryHours ?? 6)}
            value={syncEveryHours}
            onChange={(event) => setSyncEveryHours(event.target.value)}
          />
        </Field>
      </div>
      <div className={ui.actions}>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={busy || !secretsAvailable}>
          {busy ? "Checking with Akahu…" : login ? `Save ${login.name}` : "Add login"}
        </Button>
      </div>
      <p className={ui.muted}>
        The tokens are checked with Akahu, then stored encrypted. They&apos;re never shown again.
        {login ? " Accounts the new tokens can't see stop syncing until they're linked again." : ""}
      </p>
    </form>
  );
}

function BankAccounts({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const list = useApiData<{ bankAccounts: BankAccount[] }>("/api/bank-accounts", {
    organisationId,
    includeArchived: includeArchived ? "true" : null,
  });
  const accounts = list.data?.bankAccounts ?? [];
  const toReconcile = accounts.reduce((sum, account) => sum + account.unreconciledCount, 0);

  return (
    <>
      <Card
        title="Bank and credit card accounts"
        description={`Statement balance is the latest balance the bank gave (from a file or the feed). Balance in Tohyee is what's posted to the account. ${toReconcile} statement ${toReconcile === 1 ? "line is" : "lines are"} waiting to be reconciled.`}
        actions={
          can("admin") ? (
            <Button variant={adding ? "secondary" : "primary"} onClick={() => setAdding((value) => !value)}>
              {adding ? "Close" : "Add account"}
            </Button>
          ) : null
        }
      >
        {adding ? (
          <AddAccountForm
            organisationId={organisationId}
            onAdded={() => {
              setAdding(false);
              list.reload();
            }}
          />
        ) : null}
        {list.error ? <Notice tone="error">{list.error}</Notice> : null}
        {!list.data && !list.error ? <p className={ui.muted}>Loading…</p> : null}
        {list.data && accounts.length === 0 ? (
          <Empty>No bank or credit card accounts yet. Add one, or add them in the chart of accounts.</Empty>
        ) : null}
        {accounts.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th className={ui.num}>Statement balance</th>
                  <th className={ui.num}>Balance in Tohyee</th>
                  <th>Latest line</th>
                  <th>To reconcile</th>
                  <th>Bank feed</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.id}>
                    <td>
                      <Link href={`/operations/bank-accounts/${account.id}`}>
                        {account.code} · {account.name}
                      </Link>
                      {account.isActive ? null : (
                        <>
                          {" "}
                          <Badge>Archived</Badge>
                        </>
                      )}
                      {account.currencyCode ? <div className={ui.muted}>{account.currencyCode}</div> : null}
                    </td>
                    <td>{ACCOUNT_TYPE_LABELS[account.accountType]}</td>
                    <td className={ui.num}>
                      {account.statementBalance !== null ? (
                        <span title={account.statementBalanceAt ? `As at ${formatDateTime(account.statementBalanceAt)}` : undefined}>
                          {account.isForeign ? <CurrencyMoney currency={account.statementCurrency} value={account.statementBalance} /> : <Money value={account.statementBalance} />}
                        </span>
                      ) : (
                        <span className={ui.muted}>—</span>
                      )}
                    </td>
                    <td className={ui.num}>
                      {account.isForeign ? (
                        <>
                          <CurrencyMoney currency={account.statementCurrency} value={account.foreignBalance} />
                          <div className={ui.muted}>
                            <Money value={account.ledgerBalance} />
                          </div>
                        </>
                      ) : (
                        <Money value={account.ledgerBalance} />
                      )}
                    </td>
                    <td>{account.lastLineDate ? formatDate(account.lastLineDate) : <span className={ui.muted}>None yet</span>}</td>
                    <td>
                      {account.unreconciledCount > 0 ? (
                        <Link href={`/operations/bank-accounts/${account.id}`}>Reconcile {account.unreconciledCount}</Link>
                      ) : (
                        <span className={ui.muted}>Nothing</span>
                      )}
                    </td>
                    <td>
                      <FeedBadge feed={account.feed} simplefin={account.simplefin} stripe={account.stripe} paypal={account.paypal} wise={account.wise} />
                      {account.feed.akahuAccountName ? <div className={ui.muted}>{account.feed.akahuAccountName}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />
          Show archived accounts
        </label>
      </Card>
      <Card
        title="Akahu bank feeds"
        description="This organisation's own Akahu personal app, which brings in its bank and credit card transactions automatically."
      >
        <AkahuSettingsCard organisationId={organisationId} />
      </Card>
      <Card
        title="SimpleFIN bank feeds"
        description="For overseas bank accounts (mostly US banks): this organisation's own SimpleFIN Bridge account brings in their transactions. NZ banks use Akahu."
      >
        <SimpleFinSettingsCard organisationId={organisationId} />
      </Card>
      <Card
        title="Stripe"
        description="This organisation's Stripe balance as a bank account: charges, Stripe's fees, refunds, disputes and payouts come in as statement lines."
      >
        <StripeSettingsCard organisationId={organisationId} />
      </Card>
      <Card
        title="PayPal"
        description="This organisation's PayPal balance as a bank account: payments, PayPal's fees, refunds, chargebacks, conversions and withdrawals come in as statement lines."
      >
        <PayPalSettingsCard organisationId={organisationId} />
      </Card>
      <Card
        title="Wise"
        description="Each currency balance in this organisation's Wise business account as a bank account: money received, card payments, transfers, conversions and Wise's fees come in as statement lines."
      >
        <WiseSettingsCard organisationId={organisationId} />
      </Card>
    </>
  );
}

export default function BankAccountsPage() {
  return (
    <Page>
      <PageHeader
        title="Bank accounts"
        description="Bank and credit card accounts: import statements or bring them in with a bank feed, then reconcile each line."
      />
      <RequireOrganisation>{(organisationId) => <BankAccounts key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
