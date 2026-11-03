"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AccountPicker } from "@/components/account-picker";
import { daysBefore } from "@/components/bank/common";
import { useAccounts } from "@/components/books";
import { ChoiceTiles } from "@/components/choice-tiles";
import { useConfirm } from "@/components/confirm-dialog";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { InfoPara, InfoTip } from "@/components/info-tip";
import { SetupProgress } from "@/components/store-setup";
import { Button, Field, Notice, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import type { BankAccount } from "@/lib/bank/accounts";
import type { AkahuLogin, AkahuSettings } from "@/lib/bank/akahu/settings";
import { akahuLinkability, describeSchedule, describeSyncResult, type LinkChoice, linkChoiceGaps, suggestTohyeeAccount } from "@/lib/bank/akahu/setup";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, todayInBrowser } from "@/lib/format";
import { nextFreeCode } from "@/lib/sales-platforms/setup";
import styles from "@/components/store-setup.module.css";
import own from "./akahu-setup.module.css";

/**
 * The guided Akahu bank feed setup (#543, decisions 1288-1291), built like
 * the shop setup: one step at a time. Connecting checks the tokens with Akahu
 * and saves the login (it only reads). Choosing accounts and the start date
 * change nothing; the accounts are linked on the "Check" step, and the first
 * sync runs straight after, with what each account brought in.
 */

type Step = "connect" | "accounts" | "start" | "check" | "sync";

const STEPS: Step[] = ["connect", "accounts", "start", "check", "sync"];
const STEP_NAMES: Record<Step, string> = {
  connect: "Connect",
  accounts: "Choose accounts",
  start: "Start date",
  check: "Check",
  sync: "First sync",
};

export type AkahuAccountOption = {
  id: string;
  name: string;
  formattedAccount: string | null;
  type: string | null;
  status: string | null;
  attributes: string[] | null;
  connectionName: string | null;
  balance: string | null;
  linkedAccountId: string | null;
  connectionId: string;
  loginName: string;
  label: string;
};

type Choice = { link: boolean; accountId: string };
type StartChoice = "year" | "month" | "custom";
type SyncRow = { accountId: string; label: string; target: string; state: "waiting" | "syncing" | "ok" | "failed"; text: string; added: number };

const HOURS = [1, 2, 3, 4, 6, 8, 12, 24];

function optionLabel(option: AkahuAccountOption): string {
  return [option.name, option.formattedAccount].filter(Boolean).join(" · ");
}

export function AkahuSetup({
  organisationId,
  login: given,
  first,
  secretsAvailable,
  onClose,
}: {
  organisationId: string;
  /** A saved login: the setup starts at choosing its accounts. */
  login?: AkahuLogin;
  /** No login yet: the name can be left as "Akahu". */
  first: boolean;
  secretsAvailable: boolean;
  /** Called when the person finishes or leaves; `message` says what was done. */
  onClose: (message: string | null) => void;
}) {
  const confirm = useConfirm();
  const today = todayInBrowser();
  const [step, setStep] = useState<Step>(given ? "accounts" : "connect");
  const [login, setLogin] = useState<{ connectionId: string; name: string; syncEveryHours: number } | null>(
    given ? { connectionId: given.connectionId, name: given.name, syncEveryHours: given.syncEveryHours } : null,
  );
  const [form, setForm] = useState({ name: first ? "Akahu" : "", appToken: "", userToken: "", hours: "6" });
  const [choices, setChoices] = useState<Record<string, Choice> | null>(null);
  const [start, setStart] = useState<StartChoice>("year");
  const [customDate, setCustomDate] = useState(daysBefore(today, 365));
  const [rows, setRows] = useState<SyncRow[]>([]);
  const [added, setAdded] = useState<Account[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gaps, setGaps] = useState<string[]>([]);
  const [connected, setConnected] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const options = useApiData<{ accounts: AkahuAccountOption[] }>(login && step !== "connect" ? "/api/bank-feeds/akahu/accounts" : null, {
    organisationId,
    connectionId: login?.connectionId ?? null,
  });
  const chart = useAccounts(organisationId);
  const bank = useApiData<{ bankAccounts: BankAccount[] }>("/api/bank-accounts", { organisationId });

  const allAccounts = useMemo(() => {
    const list = chart.data?.accounts ?? [];
    return [...list, ...added.filter((extra) => !list.some((account) => account.id === extra.id))];
  }, [chart.data, added]);

  // Bank and credit card accounts that can take an Akahu feed: active, base currency, no other feed.
  const free = useMemo(() => {
    const ids = new Set(added.map((account) => account.id));
    for (const account of bank.data?.bankAccounts ?? []) {
      if (account.isActive && !account.currencyCode && !account.feed.active && !account.simplefin && !account.stripe && !account.paypal && !account.wise) ids.add(account.id);
    }
    return ids;
  }, [bank.data, added]);

  // The answers start from what fits best, once Akahu and the chart have answered; nothing is chosen that's already linked.
  useEffect(() => {
    if (choices || !options.data || !chart.data || !bank.data) return;
    const candidates = (chart.data.accounts ?? []).filter((account) => free.has(account.id));
    const taken = new Set<string>();
    const next: Record<string, Choice> = {};
    for (const option of options.data.accounts) {
      if (option.linkedAccountId) continue;
      const fit = akahuLinkability(option);
      const suggested = fit.canLink ? suggestTohyeeAccount(option, candidates.filter((account) => !taken.has(account.id))) : null;
      if (suggested) taken.add(suggested);
      next[option.id] = { link: fit.canLink && fit.linkByDefault, accountId: suggested ?? "" };
    }
    // Set once from loaded data; later changes are the person's.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChoices(next);
  }, [choices, options.data, chart.data, bank.data, free]);

  // Each new step's heading takes focus, so a screen reader hears where it is.
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    heading.current?.focus();
  }, [step]);

  const go = (next: Step) => {
    setError(null);
    setGaps([]);
    setStep(next);
  };

  const akahuAccounts = options.data?.accounts ?? [];
  const linkChoices: LinkChoice[] = akahuAccounts
    .filter((option) => choices?.[option.id])
    .map((option) => ({ akahuAccountId: option.id, label: option.name, link: choices![option.id].link, accountId: choices![option.id].accountId }));
  const chosen = linkChoices.filter((choice) => choice.link);
  const startDate = start === "year" ? daysBefore(today, 365) : start === "month" ? `${today.slice(0, 8)}01` : customDate;
  const accountName = (id: string) => {
    const account = allAccounts.find((candidate) => candidate.id === id);
    return account ? `${account.code} ${account.name}` : "";
  };
  const typing = step === "connect" && (form.appToken !== "" || form.userToken !== "");
  const unsaved = typing || ((step === "start" || step === "check") && chosen.length > 0);

  async function leave() {
    if (unsaved && !(await confirm("Leave the setup? Nothing you chose here has been linked yet."))) return;
    onClose(rows.length ? summary(rows) : connected);
  }

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ akahu: AkahuSettings; connectionId: string; accountCount: number }>("/api/bank-feeds/akahu/settings", {
        method: "PUT",
        body: { organisationId, add: true, name: form.name.trim(), appToken: form.appToken, userToken: form.userToken, syncEveryHours: form.hours },
      });
      const saved = result.akahu.logins.find((entry) => entry.connectionId === result.connectionId);
      setLogin({ connectionId: result.connectionId, name: saved?.name ?? form.name.trim(), syncEveryHours: saved?.syncEveryHours ?? Number(form.hours) });
      setForm({ ...form, appToken: "", userToken: "" });
      setConnected(`Connected ${saved?.name ?? "Akahu"}. No accounts are linked yet.`);
      go("accounts");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function linkAndSync() {
    if (!login) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/bank-feeds/akahu/links", {
        method: "POST",
        body: { organisationId, connectionId: login.connectionId, startDate, links: chosen.map((choice) => ({ akahuAccountId: choice.akahuAccountId, accountId: choice.accountId })) },
      });
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
      return;
    }
    // Linked: the first sync runs one account at a time, each showing how it went.
    const first: SyncRow[] = chosen.map((choice) => ({ accountId: choice.accountId, label: choice.label, target: accountName(choice.accountId), state: "waiting", text: "Waiting", added: 0 }));
    setRows(first);
    go("sync");
    const update = (at: number, change: Partial<SyncRow>) => setRows((current) => current.map((row, index) => (index === at ? { ...row, ...change } : row)));
    for (let index = 0; index < first.length; index += 1) {
      update(index, { state: "syncing", text: "Bringing in transactions…" });
      try {
        const { result } = await api<{ result: { added: number; duplicates: number; possibleDuplicates: number } }>(`/api/bank-accounts/${first[index].accountId}/feed/sync`, {
          method: "POST",
          body: { organisationId },
        });
        update(index, { state: "ok", text: describeSyncResult(result), added: result.added });
      } catch (caught) {
        update(index, { state: "failed", text: errorMessage(caught) });
      }
    }
    setBusy(false);
  }

  const doneStep = (candidate: Step) => (candidate === "connect" ? login !== null : STEPS.indexOf(candidate) < STEPS.indexOf(step));
  const previous: Step | undefined = step === "start" ? "accounts" : step === "check" ? "start" : undefined;

  let body: ReactNode;
  let next: ReactNode = null;
  if (step === "connect") {
    body = <ConnectStep first={first} form={form} onChange={setForm} />;
    next = (
      <Button disabled={busy || !secretsAvailable || !form.appToken || !form.userToken || (!first && !form.name.trim())} onClick={() => void connect()}>
        {busy ? "Checking with Akahu…" : "Check tokens and connect"}
      </Button>
    );
  } else if (step === "accounts") {
    body = (
      <AccountsStep
        organisationId={organisationId}
        loginName={login?.name ?? "this login"}
        options={akahuAccounts}
        loading={!(options.error ?? chart.error ?? bank.error) && (!options.data || !choices)}
        loadError={options.error ?? chart.error ?? bank.error}
        onRetry={() => {
          setChoices(null);
          options.reload();
        }}
        choices={choices ?? {}}
        setChoice={(id, change) => {
          setGaps([]);
          setChoices((current) => ({ ...(current ?? {}), [id]: { ...(current?.[id] ?? { link: false, accountId: "" }), ...change } }));
        }}
        accounts={allAccounts}
        free={free}
        accountName={accountName}
        onAdded={(account) => {
          setAdded((list) => [...list, account]);
          chart.reload();
          bank.reload();
        }}
      />
    );
    const offerable = akahuAccounts.some((option) => !option.linkedAccountId && akahuLinkability(option).canLink);
    next = offerable ? (
      <Button
        onClick={() => {
          const missing = linkChoiceGaps(linkChoices);
          if (missing.length) setGaps(missing);
          else go("start");
        }}
      >
        Next: start date
      </Button>
    ) : null;
  } else if (step === "start") {
    body = (
      <StartStep
        start={start}
        setStart={setStart}
        customDate={customDate}
        setCustomDate={setCustomDate}
        today={today}
        startDate={startDate}
        withLines={chosen
          .map((choice) => bank.data?.bankAccounts.find((account) => account.id === choice.accountId))
          .filter((account): account is BankAccount => Boolean(account?.lastLineDate))}
      />
    );
    next = (
      <Button
        disabled={!startDate || startDate > today}
        onClick={() => go("check")}
      >
        Next: check
      </Button>
    );
  } else if (step === "check") {
    body = (
      <>
        <p className={styles.lead}>Here&apos;s what will be linked. Nothing is linked yet.</p>
        <dl className={styles.summary}>
          <dt>Akahu login</dt>
          <dd>{login?.name}</dd>
          {chosen.map((choice) => {
            const option = akahuAccounts.find((entry) => entry.id === choice.akahuAccountId);
            return (
              <div key={choice.akahuAccountId} style={{ display: "contents" }}>
                <dt>{option ? optionLabel(option) : choice.label}</dt>
                <dd>Into {accountName(choice.accountId)}</dd>
              </div>
            );
          })}
          <dt>Transactions from</dt>
          <dd>{formatDate(startDate)}</dd>
          <dt>Schedule</dt>
          <dd>{describeSchedule(login?.syncEveryHours ?? 6)}</dd>
        </dl>
        <p className={ui.muted} style={{ margin: 0 }}>
          The first sync runs straight away. Lines come in unreconciled; nothing is posted.{" "}
          <InfoTip label="Running it again">
            <InfoPara>Each line keeps Akahu&apos;s own id, so syncing again never adds it twice.</InfoPara>
            <InfoPara>A line already imported from a statement file is flagged as a possible duplicate, not added twice.</InfoPara>
          </InfoTip>
        </p>
      </>
    );
    next = (
      <Button disabled={busy} onClick={() => void linkAndSync()}>
        {busy ? "Linking…" : `Link ${chosen.length} ${chosen.length === 1 ? "account" : "accounts"} and sync`}
      </Button>
    );
  } else {
    body = <SyncStep rows={rows} />;
    next = busy ? null : <Button onClick={() => onClose(summary(rows))}>Done</Button>;
  }

  return (
    <div className={styles.wizard}>
      <SetupProgress steps={STEPS} names={STEP_NAMES} current={step} done={doneStep} />
      {connected && step === "accounts" ? <Notice tone="success">{connected}</Notice> : null}
      <h3 className={styles.stepTitle} ref={heading} tabIndex={-1}>
        {stepTitle(step)}
      </h3>
      {body}
      {gaps.length > 0 ? (
        <Notice tone="warning">
          <strong>Before you go on:</strong>
          <ul className={styles.gaps}>
            {gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={styles.footer}>
        <div className={ui.actions}>
          {previous ? (
            <Button variant="secondary" onClick={() => go(previous)} disabled={busy}>
              Back
            </Button>
          ) : null}
          {step === "sync" ? null : (
            <Button variant="secondary" onClick={() => void leave()} disabled={busy}>
              {login && step === "accounts" && !given ? "Finish, link accounts later" : "Cancel"}
            </Button>
          )}
        </div>
        <div className={styles.footerRight}>{next}</div>
      </div>
    </div>
  );
}

function summary(rows: SyncRow[]): string {
  const ok = rows.filter((row) => row.state === "ok");
  const failed = rows.length - ok.length;
  const added = ok.reduce((sum, row) => sum + row.added, 0);
  return `Linked ${rows.length} ${rows.length === 1 ? "account" : "accounts"}. ${added} new ${added === 1 ? "line" : "lines"} brought in.${failed ? ` ${failed} didn't sync: see below.` : ""}`;
}

function stepTitle(step: Step): string {
  switch (step) {
    case "connect":
      return "Connect your Akahu account";
    case "accounts":
      return "Which bank accounts should come in?";
    case "start":
      return "From when?";
    case "check":
      return "Check and link";
    case "sync":
      return "First sync";
  }
}

function ConnectStep({
  first,
  form,
  onChange,
}: {
  first: boolean;
  form: { name: string; appToken: string; userToken: string; hours: string };
  onChange: (form: { name: string; appToken: string; userToken: string; hours: string }) => void;
}) {
  const set = (change: Partial<typeof form>) => onChange({ ...form, ...change });
  return (
    <>
      <ol className={styles.lead} style={{ paddingLeft: 20 }}>
        <li>Sign in at my.akahu.nz and connect your bank.</li>
        <li>
          Open Developers and make a personal app.{" "}
          <InfoTip label="About the personal app">
            <InfoPara>A personal app reads your own Akahu account, so no one else&apos;s app sees your banking.</InfoPara>
            <InfoPara>Akahu asks you to agree to its developer terms and turn on two-step sign-in first.</InfoPara>
            <InfoPara>If you set IP address ranges for the app, include this server&apos;s address.</InfoPara>
          </InfoTip>
        </li>
        <li>Copy its App ID token and user token here.</li>
      </ol>
      <div className={ui.grid2}>
        <Field label="Name" hint={first ? "Change it if you'll add other people's logins later." : "Whose bank logins these are, e.g. Will's BNZ login."}>
          <input value={form.name} onChange={(event) => set({ name: event.target.value })} maxLength={100} autoComplete="off" />
        </Field>
        <Field label="Check for new transactions">
          <select value={form.hours} onChange={(event) => set({ hours: event.target.value })}>
            {HOURS.map((hours) => (
              <option key={hours} value={String(hours)}>
                {hours === 1 ? "Every hour" : `Every ${hours} hours`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="App ID token" hint="Starts with app_token_.">
          <input value={form.appToken} onChange={(event) => set({ appToken: event.target.value.trim() })} maxLength={200} autoComplete="off" />
        </Field>
        <Field label="User token" hint="Starts with user_token_.">
          <input type="password" value={form.userToken} onChange={(event) => set({ userToken: event.target.value.trim() })} maxLength={500} autoComplete="new-password" />
        </Field>
      </div>
      <p className={ui.muted} style={{ margin: 0 }}>
        Akahu checks the tokens first. They&apos;re stored encrypted and never shown again. Connecting only reads; no account is linked yet.{" "}
        <InfoTip label="How often">Akahu itself refreshes from most banks about once a day, so checking more often rarely finds more.</InfoTip>
      </p>
    </>
  );
}

function AccountsStep({
  organisationId,
  loginName,
  options,
  loading,
  loadError,
  onRetry,
  choices,
  setChoice,
  accounts,
  free,
  accountName,
  onAdded,
}: {
  organisationId: string;
  loginName: string;
  options: AkahuAccountOption[];
  loading: boolean;
  loadError: string | null;
  onRetry: () => void;
  choices: Record<string, Choice>;
  setChoice: (id: string, change: Partial<Choice>) => void;
  accounts: Account[];
  free: Set<string>;
  accountName: (id: string) => string;
  onAdded: (account: Account) => void;
}) {
  if (loading) return <p className={ui.muted}>Asking Akahu which accounts it shares…</p>;
  if (loadError) {
    return (
      <Notice tone="error">
        {loadError}{" "}
        <Button size="small" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      </Notice>
    );
  }
  if (options.length === 0) {
    return (
      <Notice tone="warning">
        <strong>Akahu isn&apos;t sharing any accounts with {loginName} yet.</strong>
        <ol className={styles.gaps}>
          <li>At my.akahu.nz, connect your bank (or reconnect it).</li>
          <li>Check the personal app can see its accounts.</li>
          <li>Come back and look again.</li>
        </ol>
        <Button size="small" variant="secondary" onClick={onRetry}>
          Look again
        </Button>
      </Notice>
    );
  }
  const unlinked = options.filter((option) => !option.linkedAccountId);
  return (
    <>
      <p className={styles.lead}>
        Tick each account to bring in, and choose its account in Tohyee. Or add one here.{" "}
        <InfoTip label="Which account in Tohyee">
          <InfoPara>We&apos;ve picked a Tohyee account with the same bank account number or name, where there is one.</InfoPara>
          <InfoPara>Only bank and credit card accounts with no other feed are offered. Each Akahu account goes into its own account.</InfoPara>
        </InfoTip>
      </p>
      {unlinked.length === 0 ? <Notice tone="info">Every account Akahu shares with {loginName} is already linked. Nothing to do here.</Notice> : null}
      <ul className={own.accounts}>
        {options.map((option) => {
          const fit = akahuLinkability(option);
          const choice = choices[option.id] ?? { link: false, accountId: "" };
          const checkboxId = `akahu-${option.id}`;
          return (
            <li key={option.id} className={own.account} data-linked={option.linkedAccountId ? "yes" : "no"}>
              <div className={own.accountHead}>
                {option.linkedAccountId || !fit.canLink ? null : (
                  <input id={checkboxId} type="checkbox" checked={choice.link} onChange={(event) => setChoice(option.id, { link: event.target.checked })} />
                )}
                <label htmlFor={option.linkedAccountId || !fit.canLink ? undefined : checkboxId} className={own.accountName}>
                  <strong>{option.name}</strong>
                  <span className={ui.muted}>
                    {[option.formattedAccount, option.connectionName, option.balance !== null ? `balance ${option.balance}` : null].filter(Boolean).join(" · ")}
                  </span>
                </label>
              </div>
              {option.linkedAccountId ? (
                <p className={own.note}>
                  Already linked to{" "}
                  <Link href={`/operations/bank-accounts/${option.linkedAccountId}`}>{accountName(option.linkedAccountId) || "a bank account"}</Link>. That stays as it is.
                </p>
              ) : !fit.canLink ? (
                <p className={own.note}>Can&apos;t be linked: {fit.reason}</p>
              ) : choice.link ? (
                <AccountPicker
                  organisationId={organisationId}
                  label={`Tohyee account for ${option.name}`}
                  accounts={accounts}
                  value={accounts.find((account) => account.id === choice.accountId)?.code ?? ""}
                  onChange={(code) => setChoice(option.id, { accountId: accounts.find((account) => account.code === code)?.id ?? "" })}
                  filter={(account) =>
                    free.has(account.id) && !Object.entries(choices).some(([id, other]) => id !== option.id && other.link && other.accountId === account.id)
                  }
                  types={fit.accountType === "credit_card" ? ["credit_card", "bank"] : ["bank", "credit_card"]}
                  suggestion={{
                    code: nextFreeCode(fit.accountType === "credit_card" ? "2100" : "1000", accounts),
                    name: newName(option.name, accounts),
                    accountType: fit.accountType,
                  }}
                  canAdd
                  onAdded={onAdded}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** A new account's suggested name: Akahu's, unless the chart has it already. */
function newName(name: string, accounts: Account[]): string {
  const base = name.trim().slice(0, 90) || "Bank account";
  return accounts.some((account) => account.name.toLowerCase() === base.toLowerCase()) ? `${base} (Akahu)` : base;
}

function StartStep({
  start,
  setStart,
  customDate,
  setCustomDate,
  today,
  startDate,
  withLines,
}: {
  start: StartChoice;
  setStart: (value: StartChoice) => void;
  customDate: string;
  setCustomDate: (value: string) => void;
  today: string;
  startDate: string;
  withLines: BankAccount[];
}) {
  return (
    <>
      <p className={styles.lead}>
        The first sync brings in transactions from this date, as far back as the bank allows.{" "}
        <InfoTip label="How far back">
          Akahu&apos;s default is up to 2 years, but some banks give less (about 12 months for ASB, 180 days for Kiwibank credit cards, about 6 months for SBS).
        </InfoTip>
      </p>
      <ChoiceTiles<StartChoice>
        label="Bring in transactions from"
        value={start}
        onChange={setStart}
        options={[
          { value: "year", title: "A year back", text: `From ${formatDate(daysBefore(today, 365))}. Good for a new set of books.` },
          { value: "month", title: "This month", text: `From ${formatDate(`${today.slice(0, 8)}01`)}. When earlier months are already done.` },
          { value: "custom", title: "Pick a date", text: "Your cutover date: the day after your last imported statement." },
        ]}
      />
      {start === "custom" ? (
        <Field label="Bring in transactions from">
          <DateInput value={customDate} max={today} onChange={(event) => setCustomDate(event.target.value)} />
        </Field>
      ) : null}
      {withLines.length ? (
        <Notice tone="info">
          {withLines.map((account) => `${account.code} ${account.name} has lines up to ${formatDate(account.lastLineDate!)}.`).join(" ")} Lines already there are flagged as possible
          duplicates, not added twice.
        </Notice>
      ) : null}
      {startDate > today ? <Notice tone="warning">Choose a date that isn&apos;t in the future.</Notice> : null}
    </>
  );
}

function SyncStep({ rows }: { rows: SyncRow[] }) {
  return (
    <>
      <p className={styles.lead}>Linked. Each account&apos;s first sync:</p>
      <ul className={own.accounts} aria-live="polite">
        {rows.map((row) => (
          <li key={row.accountId} className={own.account} data-state={row.state}>
            <div className={own.accountName}>
              <strong>{row.label}</strong>
              <span className={ui.muted}>Into {row.target}</span>
            </div>
            <p className={own.result} data-state={row.state}>
              {row.state === "ok" ? "✓ " : row.state === "failed" ? "Failed: " : ""}
              {row.text}
              {row.state === "ok" && row.added === 0 ? ". Akahu may not have refreshed from the bank yet; the next check will look again." : ""}
            </p>
            {row.state === "ok" && row.added > 0 ? <Link href={`/operations/bank-accounts/${row.accountId}`}>Reconcile them</Link> : null}
            {row.state === "failed" ? <Link href={`/operations/bank-accounts/${row.accountId}`}>Open the account to try again</Link> : null}
          </li>
        ))}
      </ul>
    </>
  );
}
