"use client";

import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import {
  CATEGORIES_BY_CLASS,
  categoryLabel,
  ENTITY_FIELDS,
  LIABILITY_CATEGORIES,
  ASSET_CATEGORIES,
  OPERATING_CASH_CATEGORIES,
  REPORT_FORMAT_LABELS,
  REPORT_FORMATS,
  type ReportFormat,
} from "@/lib/reports/performance-categories";
import type { AccountCategory, PerformanceSettings, ServiceActivity } from "@/lib/reports/performance-report";

type SettingsData = { settings: PerformanceSettings; suggestedAccounts: number };

/** The year-end report format, and for a not-for-profit format the entity information (NPR10). */
export function ReportFormatCard({ organisationId, onChanged }: { organisationId: string; onChanged: (format: ReportFormat) => void }) {
  const data = useApiData<SettingsData>("/api/reports/performance/settings", { organisationId });
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return null;
  return <ReportFormatEditor key={data.data.settings.format} organisationId={organisationId} loaded={data.data} onChanged={(format) => (data.reload(), onChanged(format))} />;
}

function ReportFormatEditor({ organisationId, loaded, onChanged }: { organisationId: string; loaded: SettingsData; onChanged: (format: ReportFormat) => void }) {
  const { can } = useWorkspace();
  const editable = can("bookkeeper");
  const [format, setFormat] = useState<ReportFormat>(loaded.settings.format);
  const [entity, setEntity] = useState<Record<string, string>>(loaded.settings.entity);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const nfp = format !== "special_purpose";

  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const { settings } = await api<{ settings: PerformanceSettings }>("/api/reports/performance/settings", { method: "PUT", body: { organisationId, format, entity } });
      setMessage("Saved.");
      if (settings.format !== loaded.settings.format) onChanged(settings.format);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Report format"
      description="Businesses use special purpose financial statements. Not-for-profits, such as clubs, societies and registered charities, use XRB's Tier 3 (accrual) or Tier 4 (cash) performance report. Which tier applies is set by XRB's rules, not by Tohyee."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      <Field label="Format">
        <select value={format} disabled={!editable} onChange={(event) => setFormat(event.target.value as ReportFormat)}>
          {REPORT_FORMATS.map((entry) => (
            <option key={entry} value={entry}>
              {REPORT_FORMAT_LABELS[entry]}
            </option>
          ))}
        </select>
      </Field>
      {nfp && !loaded.settings.notForProfit ? (
        <Notice tone="warning">The Not-for-profit module is off for this organisation. The report still works; turn the module on in Settings › Modules for fund tracking.</Notice>
      ) : null}
      {nfp ? (
        <>
          <h3 className={ui.cardTitle}>Entity information</h3>
          <p className={ui.muted}>Printed at the front of the performance report. Leave out anything that doesn&apos;t apply.</p>
          <div style={{ display: "grid", gap: 10 }}>
            {ENTITY_FIELDS.map((field) => (
              <Field key={field.key} label={field.label}>
                {field.long ? (
                  <textarea rows={2} value={entity[field.key] ?? ""} disabled={!editable} maxLength={2000} onChange={(event) => setEntity({ ...entity, [field.key]: event.target.value })} />
                ) : (
                  <input value={entity[field.key] ?? ""} disabled={!editable} maxLength={200} onChange={(event) => setEntity({ ...entity, [field.key]: event.target.value })} />
                )}
              </Field>
            ))}
          </div>
        </>
      ) : null}
      {nfp && loaded.suggestedAccounts > 0 && loaded.settings.format !== "special_purpose" ? (
        <Notice tone="info">
          {loaded.suggestedAccounts} account{loaded.suggestedAccounts === 1 ? " is" : "s are"} in Tohyee&apos;s suggested category. Check them under Categories below.
        </Notice>
      ) : null}
      {editable ? (
        <div className={ui.rowButtons} style={{ marginTop: 12 }}>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/** The statement of service performance for a year (NPR9): activities and their measures, this year and last. */
export function ServicePerformanceCard({ organisationId, yearEnd }: { organisationId: string; yearEnd: string }) {
  const data = useApiData<{ yearEnd: string; activities: ServiceActivity[]; saved: boolean }>("/api/reports/performance/service", { organisationId, yearEnd });
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return null;
  return <ServiceEditor key={yearEnd} organisationId={organisationId} yearEnd={yearEnd} loaded={data.data.activities} saved={data.data.saved} />;
}

function ServiceEditor({ organisationId, yearEnd, loaded, saved }: { organisationId: string; yearEnd: string; loaded: ServiceActivity[]; saved: boolean }) {
  const { can } = useWorkspace();
  const editable = can("bookkeeper");
  const [activities, setActivities] = useState<ServiceActivity[]>(loaded);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const change = (index: number, next: Partial<ServiceActivity>) => setActivities(activities.map((entry, at) => (at === index ? { ...entry, ...next } : entry)));

  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api<{ activities: ServiceActivity[] }>("/api/reports/performance/service", { method: "PUT", body: { organisationId, yearEnd, activities } });
      setActivities(result.activities);
      setMessage("Saved.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Statement of service performance"
      description={`What the entity did in the year ending ${yearEnd.split("-").reverse().join("/")}: its key activities, and measures for this year and last. ${saved ? "" : "Not written yet for this year; the PDF says so until it is."}`}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      <div style={{ display: "grid", gap: 20 }}>
        {activities.map((activity, index) => (
          <fieldset key={index} className={ui.fieldSection}>
            <legend>Activity {index + 1}</legend>
            <Field label="Activity">
              <input value={activity.name} disabled={!editable} maxLength={200} onChange={(event) => change(index, { name: event.target.value })} />
            </Field>
            <Field label="Description">
              <textarea rows={2} value={activity.description} disabled={!editable} maxLength={4000} onChange={(event) => change(index, { description: event.target.value })} />
            </Field>
            <div className={ui.tableWrap}>
              <table className={`${ui.table} ${ui.stackOnPhone}`}>
                <thead>
                  <tr>
                    <th>Measure</th>
                    <th>This year</th>
                    <th>Last year</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {activity.measures.map((measure, measureIndex) => {
                    const setMeasure = (next: Partial<typeof measure>) =>
                      change(index, { measures: activity.measures.map((entry, at) => (at === measureIndex ? { ...entry, ...next } : entry)) });
                    return (
                      <tr key={measureIndex}>
                        <td data-label="Measure">
                          <input aria-label="Measure" value={measure.label} disabled={!editable} maxLength={300} onChange={(event) => setMeasure({ label: event.target.value })} />
                        </td>
                        <td data-label="This year">
                          <input aria-label="This year" value={measure.current} disabled={!editable} maxLength={100} onChange={(event) => setMeasure({ current: event.target.value })} />
                        </td>
                        <td data-label="Last year">
                          <input aria-label="Last year" value={measure.prior} disabled={!editable} maxLength={100} onChange={(event) => setMeasure({ prior: event.target.value })} />
                        </td>
                        <td>
                          {editable ? (
                            <Button variant="secondary" size="small" onClick={() => change(index, { measures: activity.measures.filter((_, at) => at !== measureIndex) })}>
                              Remove
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {editable ? (
              <div className={ui.rowButtons}>
                <Button variant="secondary" size="small" onClick={() => change(index, { measures: [...activity.measures, { label: "", current: "", prior: "" }] })}>
                  Add a measure
                </Button>
                <Button variant="secondary" size="small" onClick={() => setActivities(activities.filter((_, at) => at !== index))}>
                  Remove activity
                </Button>
              </div>
            ) : null}
          </fieldset>
        ))}
      </div>
      {editable ? (
        <div className={ui.rowButtons} style={{ marginTop: 16 }}>
          <Button variant="secondary" onClick={() => setActivities([...activities, { name: "", description: "", measures: [{ label: "", current: "", prior: "" }] }])}>
            Add an activity
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

const CLASS_NAMES: Record<string, string> = { revenue: "Revenue", expense: "Expenses", asset: "Assets", liability: "Liabilities", equity: "Accumulated funds" };

/** Each account's XRB category (NPR "Categories"), chosen or suggested, saved as it's changed. */
export function CategoriesCard({ organisationId, tier }: { organisationId: string; tier: "tier3" | "tier4" }) {
  const { can } = useWorkspace();
  const editable = can("bookkeeper");
  const data = useApiData<{ accounts: AccountCategory[] }>("/api/reports/performance/categories", { organisationId });
  const [accounts, setAccounts] = useState<AccountCategory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlySuggested, setOnlySuggested] = useState(false);
  const list = accounts ?? data.data?.accounts ?? [];

  async function choose(account: AccountCategory, category: string, cashCategory: string | null) {
    setError(null);
    try {
      const result = await api<{ accounts: AccountCategory[] }>("/api/reports/performance/categories", {
        method: "PUT",
        body: { organisationId, accountCode: account.code, category: category || null, cashCategory: cashCategory || null },
      });
      setAccounts(result.accounts);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return null;
  const groups = ["revenue", "expense", "asset", "liability", "equity"];
  return (
    <Card
      title="Categories"
      description="Each account is printed in one of XRB's minimum categories. Tohyee suggests one from the account type until you choose. A balance sheet account can also say which operating category its cash belongs to (subscriptions received in advance, say)."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <label className={ui.checkbox}>
        <input type="checkbox" checked={onlySuggested} onChange={(event) => setOnlySuggested(event.target.checked)} /> Only accounts still on a suggestion
      </label>
      {groups.map((group) => {
        const rows = list.filter((account) => account.accountClass === group && (!onlySuggested || account.suggested));
        if (rows.length === 0) return null;
        const balanceSheet = ["asset", "liability", "equity"].includes(group);
        return (
          <section key={group} className={ui.reportSection}>
            <h3 className={ui.reportHeading}>{CLASS_NAMES[group]}</h3>
            <div className={ui.tableWrap}>
              <table className={`${ui.table} ${ui.stackOnPhone}`}>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Category</th>
                    {balanceSheet ? <th>Its cash counts as</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((account) => {
                    const options = account.accountType === "credit_card" ? [...ASSET_CATEGORIES, ...LIABILITY_CATEGORIES] : CATEGORIES_BY_CLASS[account.accountClass] ?? [];
                    return (
                      <tr key={account.accountId}>
                        <td data-label="Account">
                          {account.code} {account.name}
                        </td>
                        <td data-label="Category">
                          <select
                            aria-label={`Category for ${account.code}`}
                            value={account.category}
                            disabled={!editable}
                            onChange={(event) => void choose(account, event.target.value, account.cashCategory)}
                          >
                            {options.map((option) => (
                              <option key={option.key} value={option.key}>
                                {categoryLabel(option.key, tier)}
                              </option>
                            ))}
                          </select>{" "}
                          {account.suggested ? <Badge tone="amber">Suggested</Badge> : null}
                        </td>
                        {balanceSheet ? (
                          <td data-label="Its cash counts as">
                            <select
                              aria-label={`Cash category for ${account.code}`}
                              value={account.cashCategory ?? ""}
                              disabled={!editable}
                              onChange={(event) => void choose(account, account.category, event.target.value)}
                            >
                              <option value="">Worked out by Tohyee</option>
                              {OPERATING_CASH_CATEGORIES.map((option) => (
                                <option key={option.key} value={option.key}>
                                  {categoryLabel(option.key, tier, true)}
                                </option>
                              ))}
                            </select>
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </Card>
  );
}
