"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AccountPicker } from "@/components/account-picker";
import { ChoiceTiles } from "@/components/choice-tiles";
import { ShopifyScopesCard } from "@/components/sales-platform-extras";
import { useAccounts } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { InfoPara, InfoTip } from "@/components/info-tip";
import { useModules } from "@/components/modules";
import { Button, Field, Notice, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import { formatDate, todayInBrowser } from "@/lib/format";
import {
  draftToSettings,
  fitsRole,
  LEFT_OWING,
  type PostingAccountRole,
  type PostingDraft,
  stepGaps,
  suggestAccounts,
  suggestTaxCodes,
  workedExample,
} from "@/lib/sales-platforms/setup";
import { SALES_PLATFORM_LABELS, type SalesPlatform, type SalesPlatformConnection, SHOPIFY_AUTH_METHODS, type ShopifyAuthMethod } from "@/lib/sales-platforms/types";
import type { TaxCode } from "@/lib/tax/codes";
import styles from "./store-setup.module.css";

/**
 * The guided store setup (#532 follow-up, decisions 1250-1259): one step at
 * a time, from "Which shop do you use?" to turning posting on. Connecting
 * saves the connection (it only reads the store); the posting steps change
 * nothing until the last step, where the person chooses to turn posting on
 * or save it off. Nothing is ever turned on for them.
 */

export type SetupStep = "shop" | "connect" | "import" | "start" | "accounts" | "review" | "turn_on";

const STEP_NAMES: Record<SetupStep, string> = {
  shop: "Your shop",
  connect: "Connect",
  import: "What to bring in",
  start: "Start date",
  accounts: "Accounts",
  review: "Check",
  turn_on: "Turn on",
};

/** The steps for a platform, in order. WooCommerce has no customer or product import (WC1). */
export function setupSteps(platform: SalesPlatform): SetupStep[] {
  return platform === "woocommerce" ? ["shop", "connect", "start", "accounts", "review", "turn_on"] : ["shop", "connect", "import", "start", "accounts", "review", "turn_on"];
}

/** Original drawings (no brand logos): a hosted shopfront, and a shop on your own website. */
function ShopIcon({ platform }: { platform: SalesPlatform }) {
  if (platform === "shopify") {
    return (
      <svg className={styles.shopIcon} viewBox="0 0 64 64" aria-hidden="true">
        <rect x="8" y="26" width="48" height="30" rx="3" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="2.5" />
        <path d="M6 18 L12 8 H52 L58 18 Z" fill="var(--accent)" />
        <path d="M6 18 h52 v4 a6 6 0 0 1 -13 0 a6.5 6.5 0 0 1 -13 0 a6.5 6.5 0 0 1 -13 0 a6 6 0 0 1 -13 0 Z" fill="var(--chart-3)" />
        <rect x="14" y="34" width="16" height="12" rx="1.5" fill="var(--surface)" stroke="var(--accent)" strokeWidth="2" />
        <rect x="36" y="34" width="12" height="22" rx="1.5" fill="var(--surface)" stroke="var(--accent)" strokeWidth="2" />
        <circle cx="45" cy="46" r="1.5" fill="var(--accent)" />
      </svg>
    );
  }
  return (
    <svg className={styles.shopIcon} viewBox="0 0 64 64" aria-hidden="true">
      <rect x="4" y="8" width="56" height="42" rx="4" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="2.5" />
      <path d="M4 18 H60" stroke="var(--accent)" strokeWidth="2.5" />
      <circle cx="11" cy="13" r="1.8" fill="var(--accent)" />
      <circle cx="17" cy="13" r="1.8" fill="var(--accent)" />
      <path d="M16 26 h5 l4 14 h18 l4 -10 H23" fill="none" stroke="var(--chart-2)" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="28" cy="45" r="2.6" fill="var(--chart-2)" />
      <circle cx="41" cy="45" r="2.6" fill="var(--chart-2)" />
      <path d="M26 56 h12" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function Progress({ steps, current, done }: { steps: SetupStep[]; current: SetupStep; done: (step: SetupStep) => boolean }) {
  const at = steps.indexOf(current);
  return (
    <div>
      <ol className={styles.progress} aria-label="Setup steps">
        {steps.map((step, index) => {
          const state = step === current ? "current" : done(step) ? "done" : "todo";
          return (
            <li key={step} className={styles.progressStep} data-state={state} aria-current={step === current ? "step" : undefined}>
              <span className={styles.progressNumber} aria-hidden="true">{state === "done" ? "✓" : index + 1}</span>
              {STEP_NAMES[step]}
              {state === "done" ? <span className={styles.srOnly}> (done)</span> : null}
            </li>
          );
        })}
      </ol>
      <p className={styles.progressPhone}>
        Step {at + 1} of {steps.length}: <strong>{STEP_NAMES[current]}</strong>
      </p>
      <div className={styles.progressBar} aria-hidden="true">
        <span style={{ width: `${((at + 1) / steps.length) * 100}%` }} />
      </div>
    </div>
  );
}

type ConnectForm = {
  storeDomain: string;
  authMethod: ShopifyAuthMethod;
  clientId: string;
  clientSecret: string;
  accessToken: string;
  apiSecret: string;
  consumerKey: string;
  consumerSecret: string;
  syncCustomers: boolean;
  syncProducts: boolean;
};

const EMPTY_CONNECT: ConnectForm = {
  storeDomain: "",
  authMethod: "client_credentials",
  clientId: "",
  clientSecret: "",
  accessToken: "",
  apiSecret: "",
  consumerKey: "",
  consumerSecret: "",
  syncCustomers: true,
  syncProducts: true,
};

/** The draft a connection's saved settings and the suggestions give (nothing chosen is overwritten). */
export function initialDraft(
  connection: SalesPlatformConnection,
  accounts: Account[],
  taxCodes: TaxCode[],
): PostingDraft {
  const suggested = suggestAccounts(accounts, connection.platform);
  const tax = suggestTaxCodes(taxCodes);
  const sales = connection.salesAccountCode ?? suggested.sales.existing ?? "";
  const shipping = connection.shippingAccountCode ?? "";
  return {
    startDate: connection.startDate ?? "",
    salesAccountCode: sales,
    separateShipping: Boolean(shipping && shipping !== sales),
    shippingAccountCode: shipping && shipping !== sales ? shipping : "",
    clearingAccountCode: connection.clearingAccountCode ?? suggested.clearing.existing ?? "",
    payoutAccountCode: connection.payoutAccountCode ?? suggested.payout.existing ?? "",
    feesAccountCode: connection.feesAccountCode ?? suggested.fees.existing ?? "",
    chargebacksAccountCode: connection.chargebacksAccountCode ?? suggested.chargebacks.existing ?? "",
    reserveAccountCode: connection.reserveAccountCode ?? suggested.reserve.existing ?? "",
    untaxedTaxCode: connection.untaxedTaxCode ?? tax.untaxed ?? "",
    guestContactId: connection.guestContactId ?? "",
    taxCodes: connection.taxCodes.length > 0 ? connection.taxCodes.map((entry) => ({ ...entry })) : tax.rates,
    paymentMethods: connection.paymentMethods.map((entry) => ({ method: entry.method, title: entry.title, choice: entry.leftOwing ? LEFT_OWING : (entry.accountCode ?? "") })),
  };
}

/** The draft as saved, to tell whether anything has changed. */
function savedDraft(connection: SalesPlatformConnection): string {
  return JSON.stringify(draftToSettings(initialDraft(connection, [], []), connection.platform, connection.postToAccounts));
}

export function StoreSetup({
  organisationId,
  connection: given,
  firstStep,
  onClose,
}: {
  organisationId: string;
  /** An existing connection: the setup starts at its posting steps. */
  connection?: SalesPlatformConnection;
  firstStep?: SetupStep;
  /** Called when the person finishes or leaves; `message` says what was saved. */
  onClose: (message: string | null) => void;
}) {
  const confirm = useConfirm();
  const modules = useModules(organisationId);
  const gstRegistered = Boolean(modules?.gst);
  const accounts = useAccounts(organisationId);
  const taxCodes = useApiData<{ taxCodes: TaxCode[] }>("/api/tax/codes", { organisationId });
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId });
  const [added, setAdded] = useState<Account[]>([]);
  const [platform, setPlatform] = useState<SalesPlatform>(given?.platform ?? "shopify");
  const [connection, setConnection] = useState<SalesPlatformConnection | null>(given ?? null);
  const [step, setStep] = useState<SetupStep>(firstStep ?? (given ? "start" : "shop"));
  const [connectForm, setConnectForm] = useState<ConnectForm>(EMPTY_CONNECT);
  const [edited, setEdited] = useState<PostingDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gaps, setGaps] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const steps = setupSteps(platform);
  const allAccounts = useMemo(() => {
    const list = accounts.data?.accounts ?? [];
    return [...list, ...added.filter((extra) => !list.some((account) => account.code === extra.code))];
  }, [accounts.data, added]);

  // The posting draft starts from what's saved plus the suggestions, once the chart is loaded; the person's changes go on top.
  const startingDraft = useMemo(
    () => (connection && accounts.data && taxCodes.data ? initialDraft(connection, accounts.data.accounts, taxCodes.data.taxCodes) : null),
    [connection, accounts.data, taxCodes.data],
  );
  const draft = edited ?? startingDraft;

  const dirty = Boolean(draft && connection && JSON.stringify(draftToSettings(draft, connection.platform, connection.postToAccounts)) !== savedDraft(connection));
  const typingCredentials = step === "connect" && (connectForm.storeDomain !== "" || connectForm.clientId !== "" || connectForm.consumerKey !== "");

  // Leaving the page with unsaved answers asks first.
  useEffect(() => {
    if (!dirty && !typingCredentials) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, typingCredentials]);

  // Each new step's heading takes focus, so a screen reader hears where it is (not on first showing the page).
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    heading.current?.focus();
  }, [step]);

  const go = (next: SetupStep) => {
    setError(null);
    setGaps([]);
    setStep(next);
  };
  // Once the store is connected, the connect steps are done: Back stops at the start date.
  const previous = steps[steps.indexOf(step) - 1] as SetupStep | undefined;
  const canGoBack = previous !== undefined && !(connection && (previous === "shop" || previous === "connect" || previous === "import"));
  const set = (change: Partial<PostingDraft>) => setEdited((current) => {
    const base = current ?? startingDraft;
    return base ? { ...base, ...change } : current;
  });

  async function leave() {
    if ((dirty || typingCredentials) && !(await confirm("Leave the setup? What you've chosen here hasn't been saved."))) return;
    onClose(null);
  }

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const f = connectForm;
      const body =
        platform === "woocommerce"
          ? { organisationId, platform, storeDomain: f.storeDomain, consumerKey: f.consumerKey, consumerSecret: f.consumerSecret }
          : {
              organisationId,
              platform,
              storeDomain: f.storeDomain,
              authMethod: f.authMethod,
              ...(f.authMethod === "access_token" ? { accessToken: f.accessToken, apiSecret: f.apiSecret } : { clientId: f.clientId, clientSecret: f.clientSecret }),
              syncCustomers: f.syncCustomers,
              syncProducts: f.syncProducts,
            };
      const made = (await api<{ connection: SalesPlatformConnection }>("/api/sales-platforms/connections", { method: "POST", body })).connection;
      setConnectForm({ ...EMPTY_CONNECT, syncCustomers: f.syncCustomers, syncProducts: f.syncProducts });
      setConnection(made);
      setSaved(`Connected ${made.storeName ?? made.storeDomain}.`);
      go("start");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function finish(turnOn: boolean) {
    if (!draft || !connection) return;
    setBusy(true);
    setError(null);
    try {
      const updated = (
        await api<{ connection: SalesPlatformConnection }>(`/api/sales-platforms/connections/${connection.id}`, {
          method: "PATCH",
          body: { organisationId, ...draftToSettings(draft, connection.platform, turnOn) },
        })
      ).connection;
      setConnection(updated);
      onClose(
        turnOn
          ? `Posting is on from ${formatDate(draft.startDate)}. The next sync (within 15 minutes, or "Sync now") brings paid orders in.`
          : "Saved. Posting is off: nothing is brought into the accounts until you turn it on.",
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const doneStep = (candidate: SetupStep) => {
    const order = steps.indexOf(candidate);
    if (candidate === "shop" || candidate === "connect" || candidate === "import") return connection !== null || order < steps.indexOf(step);
    return order < steps.indexOf(step);
  };

  const shop = SALES_PLATFORM_LABELS[platform];
  const isPostingStep = step === "start" || step === "accounts" || step === "review" || step === "turn_on";

  let body: ReactNode;
  let next: ReactNode = null;
  if (step === "shop") {
    body = (
      <ShopChoice platform={platform} onChoose={setPlatform} />
    );
    next = <Button onClick={() => go("connect")}>Next: connect {shop}</Button>;
  } else if (step === "connect") {
    body = <ConnectStep platform={platform} form={connectForm} onChange={setConnectForm} />;
    next =
      platform === "woocommerce" ? (
        <Button disabled={busy || !connectForm.storeDomain || !connectForm.consumerKey || !connectForm.consumerSecret} onClick={() => void connect()}>
          {busy ? "Checking with WooCommerce…" : "Connect store"}
        </Button>
      ) : (
        <Button
          disabled={
            !connectForm.storeDomain ||
            (connectForm.authMethod === "client_credentials" ? !connectForm.clientId || !connectForm.clientSecret : !connectForm.accessToken || !connectForm.apiSecret)
          }
          onClick={() => go("import")}
        >
          Next: what to bring in
        </Button>
      );
  } else if (step === "import") {
    body = <ImportStep form={connectForm} onChange={setConnectForm} />;
    next = (
      <Button disabled={busy} onClick={() => void connect()}>
        {busy ? "Checking with Shopify…" : "Connect store"}
      </Button>
    );
  } else if (!connection || !draft) {
    body = <p className={ui.muted}>Loading your accounts…</p>;
  } else if (step === "start") {
    body = <StartStep platform={platform} draft={draft} set={set} />;
    next = (
      <Button
        onClick={() => {
          const missing = stepGaps("start", draft, { platform, gstRegistered });
          if (missing.length > 0) setGaps(missing);
          else go("accounts");
        }}
      >
        Next: accounts
      </Button>
    );
  } else if (step === "accounts") {
    body = (
      <AccountsStep
        organisationId={organisationId}
        connection={connection}
        draft={draft}
        set={set}
        accounts={allAccounts}
        taxCodes={taxCodes.data?.taxCodes ?? []}
        customers={(contacts.data?.contacts ?? []).filter((contact) => contact.isCustomer)}
        gstRegistered={gstRegistered}
        onAdded={(account) => {
          setAdded((list) => [...list, account]);
          accounts.reload();
        }}
      />
    );
    next = (
      <Button
        onClick={() => {
          const missing = stepGaps("accounts", draft, { platform, gstRegistered });
          if (missing.length > 0) setGaps(missing);
          else go("review");
        }}
      >
        Next: check
      </Button>
    );
  } else if (step === "review") {
    body = <ReviewStep connection={connection} draft={draft} accounts={allAccounts} customers={contacts.data?.contacts ?? []} gstRegistered={gstRegistered} />;
    next = <Button onClick={() => go("turn_on")}>Looks right: next</Button>;
  } else {
    body = <TurnOnStep connection={connection} draft={draft} />;
    next = (
      <>
        <Button variant="secondary" disabled={busy} onClick={() => void finish(false)}>
          {connection.postToAccounts ? "Save and turn posting off" : "Save, leave posting off"}
        </Button>
        <Button disabled={busy} onClick={() => void finish(true)}>
          {busy ? "Saving…" : connection.postToAccounts ? "Save, keep posting on" : "Turn on posting"}
        </Button>
      </>
    );
  }

  return (
    <div className={styles.wizard}>
      <Progress steps={steps} current={step} done={doneStep} />
      {saved && step === "start" ? <Notice tone="success">{saved} It only reads your store. Next, choose how its sales go into your accounts, or finish here.</Notice> : null}
      {isPostingStep && connection ? (
        <div className={styles.saveState} data-state={dirty ? "unsaved" : "clean"} role="status">
          {dirty ? (
            <>
              <strong>Not saved yet.</strong> Your answers are saved on the last step. Nothing is posted until you turn posting on.
            </>
          ) : connection.postToAccounts ? (
            <>Posting is on, from {connection.startDate ? formatDate(connection.startDate) : "the start date"}. No unsaved changes.</>
          ) : (
            <>Posting is off. Nothing is brought into the accounts until you turn it on at the end.</>
          )}
        </div>
      ) : null}
      <h3 className={styles.stepTitle} ref={heading} tabIndex={-1}>
        {stepTitle(step, platform)}
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
          {canGoBack ? (
            <Button variant="secondary" onClick={() => go(previous)}>
              Back
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => void leave()}>
            {connection && step === "start" && !given ? "Finish, set up posting later" : "Cancel"}
          </Button>
        </div>
        <div className={styles.footerRight}>{next}</div>
      </div>
    </div>
  );
}

function stepTitle(step: SetupStep, platform: SalesPlatform): string {
  const shop = SALES_PLATFORM_LABELS[platform];
  switch (step) {
    case "shop":
      return "Which shop do you use?";
    case "connect":
      return `Connect your ${shop} store`;
    case "import":
      return `What should come in from ${shop}?`;
    case "start":
      return `When should ${shop} sales start in Tohyee?`;
    case "accounts":
      return "Where should the money go?";
    case "review":
      return "Check how a sale will look";
    case "turn_on":
      return "Turn on posting";
  }
}

function ShopChoice({ platform, onChoose }: { platform: SalesPlatform; onChoose: (platform: SalesPlatform) => void }) {
  return (
    <ChoiceTiles
      label="Which shop do you use?"
      value={platform}
      onChange={onChoose}
      options={[
        { value: "shopify", title: "Shopify", text: "Your shop is hosted by Shopify (an address like yourshop.myshopify.com).", icon: <ShopIcon platform="shopify" /> },
        { value: "woocommerce", title: "WooCommerce", text: "Your shop is part of your own WordPress website, using WooCommerce.", icon: <ShopIcon platform="woocommerce" /> },
      ]}
    />
  );
}

function ConnectStep({ platform, form, onChange }: { platform: SalesPlatform; form: ConnectForm; onChange: (form: ConnectForm) => void }) {
  const set = (change: Partial<ConnectForm>) => onChange({ ...form, ...change });
  if (platform === "woocommerce") {
    return (
      <>
        <ol className={styles.lead} style={{ paddingLeft: 20 }}>
          <li>In your website&apos;s WordPress admin, go to WooCommerce › Settings › Advanced › REST API.</li>
          <li>
            Add a key for Tohyee.{" "}
            <InfoTip label="Which kind of key">
              A <strong>Read</strong> key is enough to bring orders in. Webhooks (orders arriving as they happen) need <strong>Read/Write</strong>; without them the catch-up sync
              brings orders in every 15 minutes. Tohyee only reads orders. The store must use an https:// address.
            </InfoTip>
          </li>
          <li>Copy the consumer key and secret here.</li>
        </ol>
        <div className={ui.grid2}>
          <Field label="Store address" hint="Like https://shop.example.nz">
            <input value={form.storeDomain} onChange={(event) => set({ storeDomain: event.target.value })} maxLength={255} autoComplete="off" />
          </Field>
          <Field label="Consumer key" hint="Starts with ck_.">
            <input value={form.consumerKey} onChange={(event) => set({ consumerKey: event.target.value })} maxLength={200} autoComplete="off" />
          </Field>
          <Field label="Consumer secret" hint="Starts with cs_. Stored encrypted; never shown again.">
            <input type="password" value={form.consumerSecret} onChange={(event) => set({ consumerSecret: event.target.value })} maxLength={200} autoComplete="new-password" />
          </Field>
        </div>
        <p className={ui.muted} style={{ margin: 0 }}>
          Connecting only reads your store. Customers are matched by email and products by SKU when orders come in.
        </p>
      </>
    );
  }
  return (
    <>
      <ol className={styles.lead} style={{ paddingLeft: 20 }}>
        <li>
          In the Shopify Dev Dashboard (dev.shopify.com), create an app for Tohyee.{" "}
          <InfoTip label="Creating the Shopify app">
            <InfoPara>Tohyee connects through an app in your own Shopify account, so no one else&apos;s app has access.</InfoPara>
            <InfoPara>
              Give it the read-only access scopes listed under &quot;Shopify access scopes&quot; on the Sales platforms page (at least <code>read_customers</code>,{" "}
              <code>read_products</code> and, to post sales, <code>read_orders</code>). Turn on access to protected customer data (name, email, phone and address).
            </InfoPara>
            <InfoPara>
              If your store already has a custom app made in the store admin before 2026, you can use its Admin API access token and API secret key instead.
            </InfoPara>
          </InfoTip>
        </li>
        <li>Give it the access scopes below, release it and install it on your store.</li>
        <li>Copy its client ID and secret from the app&apos;s Settings into the boxes below.</li>
      </ol>
      <details className={styles.more}>
        <summary>The access scopes to give the app</summary>
        <ShopifyScopesCard />
      </details>
      <div className={ui.grid2}>
        <Field label="Store address" hint="Like glimmers.myshopify.com, or just glimmers.">
          <input value={form.storeDomain} onChange={(event) => set({ storeDomain: event.target.value })} maxLength={255} autoComplete="off" />
        </Field>
        <Field label="How the app signs in">
          <select value={form.authMethod} onChange={(event) => set({ authMethod: event.target.value as ShopifyAuthMethod })}>
            {SHOPIFY_AUTH_METHODS.map((method) => (
              <option key={method} value={method}>
                {method === "client_credentials" ? "Client ID and secret (Dev Dashboard app)" : "Admin API access token (older custom app)"}
              </option>
            ))}
          </select>
        </Field>
        {form.authMethod === "client_credentials" ? (
          <>
            <Field label="Client ID">
              <input value={form.clientId} onChange={(event) => set({ clientId: event.target.value })} maxLength={200} autoComplete="off" />
            </Field>
            <Field label="Client secret" hint="Stored encrypted on this server; never shown again.">
              <input type="password" value={form.clientSecret} onChange={(event) => set({ clientSecret: event.target.value })} maxLength={500} autoComplete="new-password" />
            </Field>
          </>
        ) : (
          <>
            <Field label="Admin API access token" hint="Starts with shpat_. Stored encrypted; never shown again.">
              <input type="password" value={form.accessToken} onChange={(event) => set({ accessToken: event.target.value })} maxLength={500} autoComplete="new-password" />
            </Field>
            <Field label="API secret key" hint="Shopify signs webhooks with it. Stored encrypted.">
              <input type="password" value={form.apiSecret} onChange={(event) => set({ apiSecret: event.target.value })} maxLength={500} autoComplete="new-password" />
            </Field>
          </>
        )}
      </div>
      <p className={ui.muted} style={{ margin: 0 }}>
        Nothing is saved yet. Next you choose what comes in; the store is connected after that. Tohyee only reads your store.
      </p>
    </>
  );
}

function ImportStep({ form, onChange }: { form: ConnectForm; onChange: (form: ConnectForm) => void }) {
  return (
    <>
      <p className={styles.lead}>
        These come in by a sync every 15 minutes, and as they change in Shopify. You can change them later.{" "}
        <InfoTip label="How records are matched">
          A customer is matched to a contact with the same email, and a product variant to an item with the same SKU (item code). Anything with no match is added. A variant
          without a SKU is skipped and the log says so.
        </InfoTip>
      </p>
      <label className={ui.checkbox}>
        <input type="checkbox" checked={form.syncCustomers} onChange={(event) => onChange({ ...form, syncCustomers: event.target.checked })} /> Customers, as contacts
      </label>
      <label className={ui.checkbox}>
        <input type="checkbox" checked={form.syncProducts} onChange={(event) => onChange({ ...form, syncProducts: event.target.checked })} /> Products, as items
      </label>
      <p className={ui.muted} style={{ margin: 0 }}>
        Sales (orders, refunds and payouts) are set up next, and stay off until you turn them on.
      </p>
    </>
  );
}

function firstOfMonth(today: string): string {
  return `${today.slice(0, 8)}01`;
}

function StartStep({ platform, draft, set }: { platform: SalesPlatform; draft: PostingDraft; set: (change: Partial<PostingDraft>) => void }) {
  const shop = SALES_PLATFORM_LABELS[platform];
  const today = todayInBrowser();
  return (
    <>
      <p className={styles.lead}>
        The first day {shop} sales should be recorded in Tohyee. Orders (and {platform === "shopify" ? "payouts" : "refunds"}) from before it are never brought in.{" "}
        <InfoTip label="Choosing the start date">
          <InfoPara>
            <strong>Moving from another system?</strong> Use your cutover date: the day after the last sale recorded there. Then no sale is counted twice, and none is missed.
          </InfoPara>
          <InfoPara>
            <strong>Starting fresh?</strong> Use the first day of a month or of your GST period, so reports line up.
          </InfoPara>
          <InfoPara>A date in a locked period can&apos;t be posted to; such orders wait until the period is unlocked.</InfoPara>
        </InfoTip>
      </p>
      <Field label="Start date">
        <DateInput value={draft.startDate} onChange={(event) => set({ startDate: event.target.value })} />
      </Field>
      <div className={styles.quickDates}>
        <Button size="small" variant="secondary" onClick={() => set({ startDate: firstOfMonth(today) })}>
          1st of this month
        </Button>
        <Button size="small" variant="secondary" onClick={() => set({ startDate: today })}>
          Today
        </Button>
      </div>
    </>
  );
}

function Role({ label, hint, info, children }: { label: string; hint: ReactNode; info?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.role}>
      <span className={styles.roleLabel}>
        {label} {info}
      </span>
      <p className={styles.roleHint}>{hint}</p>
      {children}
    </div>
  );
}

function AccountsStep({
  organisationId,
  connection,
  draft,
  set,
  accounts,
  taxCodes,
  customers,
  gstRegistered,
  onAdded,
}: {
  organisationId: string;
  connection: SalesPlatformConnection;
  draft: PostingDraft;
  set: (change: Partial<PostingDraft>) => void;
  accounts: Account[];
  taxCodes: TaxCode[];
  customers: Contact[];
  gstRegistered: boolean;
  onAdded: (account: Account) => void;
}) {
  const platform = connection.platform;
  const shop = SALES_PLATFORM_LABELS[platform];
  const suggested = suggestAccounts(accounts, platform);
  const codes = taxCodes.filter((code) => code.isActive && code.availableOn !== "purchases");
  const picker = (role: PostingAccountRole, label: string, key: keyof PostingDraft) => (
    <AccountPicker
      organisationId={organisationId}
      label={label}
      accounts={accounts}
      value={draft[key] as string}
      onChange={(code) => set({ [key]: code } as Partial<PostingDraft>)}
      filter={(account) => fitsRole(account, role)}
      types={suggested[role].types}
      suggestion={suggested[role].create}
      canAdd
      onAdded={onAdded}
    />
  );
  return (
    <>
      <p className={styles.lead}>We&apos;ve filled in the usual accounts. Change any of them, or add one here: you won&apos;t lose your place.</p>
      <section className={styles.group} aria-label="Sales">
        <h4 className={styles.groupTitle}>What customers pay</h4>
        <Role label="Sales" hint="What customers pay for your products.">
          {picker("sales", "Sales account", "salesAccountCode")}
        </Role>
        <Role label="Shipping charged to customers" hint="Usually part of sales.">
          <label className={ui.checkbox}>
            <input type="checkbox" checked={!draft.separateShipping} onChange={(event) => set({ separateShipping: !event.target.checked })} /> Record shipping in the sales account
          </label>
          {draft.separateShipping ? picker("shipping", "Shipping account", "shippingAccountCode") : null}
        </Role>
      </section>

      {platform === "shopify" ? (
        <section className={styles.group} aria-label="Money from Shopify">
          <h4 className={styles.groupTitle}>Money from Shopify</h4>
          <Role
            label="Money held by Shopify"
            hint="Money customers have paid that Shopify hasn't paid into your bank yet (a “Shopify clearing” account)."
            info={
              <InfoTip label="Why a separate account">
                <InfoPara>
                  Each paid order is recorded as paid into this account. When Shopify pays you out, the payout moves out of it into your bank, and Shopify&apos;s fees come out
                  of it too. So it always shows what Shopify still owes you, and goes back to $0 after each payout.
                </InfoPara>
                <InfoPara>
                  <strong>Why not accounts receivable?</strong> Accounts receivable is what customers still owe you. These customers have already paid; it&apos;s Shopify that
                  holds the money.
                </InfoPara>
                <InfoPara>
                  It&apos;s a bank-type account, as Xero apps that post each Shopify order set it up, so payments and transfers can go through it and a Shopify payout export can
                  be reconciled against it.
                </InfoPara>
              </InfoTip>
            }
          >
            {picker("clearing", "Money held by Shopify", "clearingAccountCode")}
          </Role>
          <Role label="Payouts arrive in" hint="The bank account Shopify pays you into.">
            {picker("payout", "Payouts arrive in", "payoutAccountCode")}
          </Role>
          <Role label="Shopify's fees" hint="Card and transaction fees Shopify keeps from each payout.">
            {picker("fees", "Shopify fees account", "feesAccountCode")}
          </Role>
        </section>
      ) : (
        <section className={styles.group} aria-label="Payment methods">
          <h4 className={styles.groupTitle}>Where each payment method&apos;s money goes</h4>
          <p className={styles.roleHint}>
            A card gateway with a bank feed (like Stripe) goes into that account, so the feed&apos;s line matches. Bank transfers are left owing for the bank feed to match.{" "}
            <InfoTip label="Payment methods appear later">
              Methods appear here once an order uses them. Until a method is chosen, its orders wait (they aren&apos;t lost); the store&apos;s card shows them, with a link back here.
            </InfoTip>
          </p>
          {draft.paymentMethods.length === 0 ? <p className={ui.muted}>No orders yet, so no payment methods. You&apos;ll choose them when the first orders arrive.</p> : null}
          {draft.paymentMethods.map((entry, index) => (
            <Field key={entry.method} label={`${entry.title ?? entry.method} (${entry.method})`}>
              <select
                value={entry.choice}
                onChange={(event) => set({ paymentMethods: draft.paymentMethods.map((other, at) => (at === index ? { ...other, choice: event.target.value } : other)) })}
              >
                <option value="">Not chosen (orders wait)</option>
                <option value={LEFT_OWING}>Left owing (bank transfer, cheque)</option>
                {accounts
                  .filter((account) => account.isActive && account.accountType === "bank")
                  .map((account) => (
                    <option key={account.code} value={account.code}>
                      Into {account.code} · {account.name}
                    </option>
                  ))}
              </select>
            </Field>
          ))}
        </section>
      )}

      {gstRegistered ? (
        <section className={styles.group} aria-label="GST">
          <h4 className={styles.groupTitle}>GST</h4>
          <Role label="Sales with no tax" hint={`Overseas orders and anything ${shop} charges no tax on.`}>
            <select aria-label="Tax code for untaxed sales" value={draft.untaxedTaxCode} onChange={(event) => set({ untaxedTaxCode: event.target.value })}>
              <option value="">Not chosen</option>
              {codes
                .filter((code) => code.category === "zero_rated" || code.category === "exempt")
                .map((code) => (
                  <option key={code.id} value={code.code}>
                    {codeLabel(code)}
                  </option>
                ))}
            </select>
          </Role>
          <Role label={`${shop}'s tax rates`} hint={`Which Tohyee tax code each rate ${shop} charges is.`}>
            {draft.taxCodes.map((entry, index) => (
              <div key={index} className={styles.rateRow}>
                <input
                  aria-label="Rate %"
                  inputMode="decimal"
                  value={entry.rate}
                  style={{ width: 70 }}
                  onChange={(event) => set({ taxCodes: draft.taxCodes.map((other, at) => (at === index ? { ...other, rate: event.target.value } : other)) })}
                />
                % is
                <select
                  aria-label="Tax code"
                  value={entry.taxCode}
                  onChange={(event) => set({ taxCodes: draft.taxCodes.map((other, at) => (at === index ? { ...other, taxCode: event.target.value } : other)) })}
                >
                  <option value="">Choose a tax code</option>
                  {codes.map((code) => (
                    <option key={code.id} value={code.code}>
                      {codeLabel(code)}
                    </option>
                  ))}
                </select>
                <Button size="small" variant="secondary" onClick={() => set({ taxCodes: draft.taxCodes.filter((_, at) => at !== index) })}>
                  Remove
                </Button>
              </div>
            ))}
            <div>
              <Button size="small" variant="secondary" onClick={() => set({ taxCodes: [...draft.taxCodes, { rate: "", taxCode: "" }] })}>
                Add a rate
              </Button>
            </div>
          </Role>
        </section>
      ) : null}

      <details className={styles.more}>
        <summary>More options{platform === "shopify" ? ": chargebacks, reserves, guest checkouts" : ": guest checkouts"}</summary>
        <div style={{ display: "grid", gap: 14 }}>
          {platform === "shopify" ? (
            <>
              <Role
                label="Chargebacks"
                hint="Money a customer's bank takes back from you when they dispute a payment. Kept in its own account so you can see it."
                info={
                  <InfoTip label="Why not sales">
                    <InfoPara>
                      The sale did happen, so the invoice and its GST stay as they were. The money taken back goes here, and the chargeback fee goes to Shopify&apos;s fees. If you
                      win the dispute, both come back.
                    </InfoPara>
                    <InfoPara>Not needed until a payout has a chargeback; until one is chosen, such a payout waits.</InfoPara>
                  </InfoTip>
                }
              >
                {picker("chargebacks", "Chargebacks account", "chargebacksAccountCode")}
              </Role>
              <Role label="Money Shopify holds back (reserve)" hint="Shopify sometimes holds part of a payout for a while. Not needed until it does.">
                {picker("reserve", "Reserve account", "reserveAccountCode")}
              </Role>
            </>
          ) : null}
          <Role label="Guest checkouts" hint={`Orders without a ${shop} customer. Not chosen: they're logged and not brought in.`}>
            <select aria-label="Guest checkouts go to" value={draft.guestContactId} onChange={(event) => set({ guestContactId: event.target.value })}>
              <option value="">Not chosen (logged, not brought in)</option>
              {customers.map((contact) => (
                <option key={contact.id} value={String(contact.id)}>
                  {contact.name}
                </option>
              ))}
            </select>
          </Role>
        </div>
      </details>
    </>
  );
}

/** "GST (15%)" rather than "GST GST (15%)": the code only when the label doesn't start with it. */
const codeLabel = (code: TaxCode) => (code.label.toUpperCase().startsWith(code.code.toUpperCase()) ? code.label : `${code.code} ${code.label}`);

const nameOf = (accounts: Account[], code: string) => {
  const account = accounts.find((candidate) => candidate.code === code);
  return account ? `${account.code} ${account.name}` : code || "Not chosen";
};

function ReviewStep({
  connection,
  draft,
  accounts,
  customers,
  gstRegistered,
}: {
  connection: SalesPlatformConnection;
  draft: PostingDraft;
  accounts: Account[];
  customers: Contact[];
  gstRegistered: boolean;
}) {
  const platform = connection.platform;
  const shop = SALES_PLATFORM_LABELS[platform];
  const receivable = accounts.find((account) => account.systemKey === "accounts_receivable");
  const gst = accounts.find((account) => account.systemKey === "gst");
  const paidInto = draft.paymentMethods.find((entry) => entry.choice && entry.choice !== LEFT_OWING);
  const example = workedExample({
    platform,
    amount: "100.00",
    fee: "3.00",
    gstRegistered,
    accounts: {
      sales: nameOf(accounts, draft.salesAccountCode),
      clearing: nameOf(accounts, draft.clearingAccountCode),
      payout: nameOf(accounts, draft.payoutAccountCode),
      fees: nameOf(accounts, draft.feesAccountCode),
      receivable: receivable ? `${receivable.code} ${receivable.name}` : undefined,
      gst: gst ? `${gst.code} ${gst.name}` : undefined,
      paidInto: paidInto ? nameOf(accounts, paidInto.choice) : undefined,
    },
  });
  const guest = customers.find((contact) => String(contact.id) === draft.guestContactId);
  const rows: Array<[string, string]> = [
    ["Start date", draft.startDate ? formatDate(draft.startDate) : "Not chosen"],
    ["Sales", nameOf(accounts, draft.salesAccountCode)],
    ["Shipping", draft.separateShipping ? nameOf(accounts, draft.shippingAccountCode) : `In sales (${nameOf(accounts, draft.salesAccountCode)})`],
    ...(platform === "shopify"
      ? ([
          ["Money held by Shopify", nameOf(accounts, draft.clearingAccountCode)],
          ["Payouts arrive in", nameOf(accounts, draft.payoutAccountCode)],
          ["Shopify's fees", nameOf(accounts, draft.feesAccountCode)],
          ["Chargebacks", draft.chargebacksAccountCode ? nameOf(accounts, draft.chargebacksAccountCode) : "Not chosen (a payout with one waits)"],
          ["Reserve", draft.reserveAccountCode ? nameOf(accounts, draft.reserveAccountCode) : "Not chosen (a payout with one waits)"],
        ] as Array<[string, string]>)
      : draft.paymentMethods.map(
          (entry): [string, string] => [
            entry.title ?? entry.method,
            entry.choice === LEFT_OWING ? "Left owing" : entry.choice ? `Into ${nameOf(accounts, entry.choice)}` : "Not chosen (orders wait)",
          ],
        )),
    ...(gstRegistered
      ? ([
          ["Untaxed sales", draft.untaxedTaxCode || "Not chosen"],
          [`${shop}'s tax rates`, draft.taxCodes.filter((entry) => entry.taxCode).map((entry) => `${entry.rate}% is ${entry.taxCode}`).join(", ") || "None"],
        ] as Array<[string, string]>)
      : []),
    ["Guest checkouts", guest ? `To ${guest.name}` : "Logged, not brought in"],
  ];
  return (
    <>
      <p className={styles.lead}>
        Here&apos;s what you chose, and where a {platform === "shopify" ? "$100 sale with a $3 Shopify fee" : "$100 sale"} would go. Nothing is saved yet.
      </p>
      <dl className={styles.summary}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: "contents" }}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <section className={styles.group} aria-label="Worked example">
        <h4 className={styles.groupTitle}>
          Example: a $100 sale{" "}
          <InfoTip label="About this example">
            {gstRegistered
              ? "Your organisation is GST registered, so $13.04 of the $100 is GST (3/23 of a GST-inclusive price), as Shopify's tax line says."
              : "Your organisation isn't GST registered, so all of the $100 is sales."}{" "}
            Each order gets its own invoice, so you can find any sale by its order number.
          </InfoTip>
        </h4>
        <div className={styles.example}>
          {example.steps.map((part, index) => (
            <div key={part.title} className={styles.exampleStep}>
              <h4>
                {index + 1}. {part.title}
              </h4>
              <p>{part.text}</p>
              <div className={ui.tableWrap}>
                <table className={styles.exampleTable}>
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th className={styles.amount}>Debit</th>
                      <th className={styles.amount}>Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {part.lines.map((line, at) => (
                      <tr key={at}>
                        <td>{line.account}</td>
                        <td className={styles.amount}>{line.debit ?? ""}</td>
                        <td className={styles.amount}>{line.credit ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {platform === "shopify" ? (
            <p style={{ margin: 0 }}>
              After the payout, {nameOf(accounts, draft.clearingAccountCode)} is back to <strong>${example.clearingAfter}</strong>.
            </p>
          ) : null}
        </div>
      </section>
    </>
  );
}

function TurnOnStep({ connection, draft }: { connection: SalesPlatformConnection; draft: PostingDraft }) {
  const shop = SALES_PLATFORM_LABELS[connection.platform];
  return (
    <>
      <p className={styles.lead}>When you turn posting on:</p>
      <ul className={styles.lead} style={{ paddingLeft: 20, display: "grid", gap: 4 }}>
        <li>
          The next sync (within 15 minutes, or when you choose &quot;Sync now&quot;) brings in {shop} orders from {draft.startDate ? formatDate(draft.startDate) : "the start date"}.
        </li>
        <li>Each paid order becomes a sales order and an invoice, paid {connection.platform === "shopify" ? "into money held by Shopify" : "the way its payment method says"}.</li>
        {connection.platform === "shopify" ? <li>Each payout moves the money to your bank, with Shopify&apos;s fees.</li> : null}
        <li>Anything Tohyee can&apos;t post is listed in the sync log with the reason, and nothing is posted twice.</li>
      </ul>
      <p className={ui.muted} style={{ margin: 0 }}>
        You can turn it off at any time; what was posted stays. Or save these settings now and turn posting on later.
      </p>
    </>
  );
}
