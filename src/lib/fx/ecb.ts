import { ACCOUNTING_ON_SQL } from "@/lib/organisations/accounting-switch";
import { writeAuditEvent } from "@/lib/audit";
import { setRateSource } from "@/lib/fx/sources";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { dec, divide, toPlainString } from "@/lib/money/decimal";
import { listAllOrganisations } from "@/lib/organisations/admin";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { optionalBoolean, requireArray } from "@/lib/validation";

/**
 * Daily exchange rates from the European Central Bank (FX1, decision 437;
 * Jess, 5 Oct 2026), like NetSuite's Currency Exchange Rate Integration. An
 * admin turns it on for an organisation; each working day Tohyee reads the
 * ECB's euro reference rates (free, no account; reuse allowed with
 * attribution; the ECB says they're for information) and adds a rate for
 * each foreign currency the organisation uses to its exchange rates list
 * (MC48), worked out through the euro and rounded to 6 decimal places. A rate
 * already in the list for a currency and date (one someone typed) is never
 * replaced. Tohyee only reads the ECB's public file: nothing is sent to it.
 */

export const ECB_SOURCE = "European Central Bank";
export const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
const ACTOR: Actor = { userId: null, email: "exchange rates job" };

export type EcbDay = { date: string; rates: Map<string, string> };

type Fetcher = (url: string) => Promise<Response>;
let fetcher: Fetcher = (url) => fetch(url, { headers: { accept: "application/xml" }, signal: AbortSignal.timeout(30_000) });

export function setEcbFetchForTests(next: Fetcher | null): void {
  fetcher = next ?? ((url) => fetch(url, { headers: { accept: "application/xml" }, signal: AbortSignal.timeout(30_000) }));
}

/** The days in an ECB reference rates file, newest first: per day, currency -> units per 1 EUR. */
export function parseEcbXml(xml: string): EcbDay[] {
  const days: EcbDay[] = [];
  const dayPattern = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g;
  for (const match of xml.matchAll(dayPattern)) {
    const rates = new Map<string, string>();
    for (const rate of match[2].matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/>/g)) {
      rates.set(rate[1], rate[2]);
    }
    if (rates.size > 0) days.push({ date: match[1], rates });
  }
  return days.sort((left, right) => right.date.localeCompare(left.date));
}

/**
 * The rate for `currency` in `base` (base per 1 unit of currency) on an ECB
 * day: (base per EUR) / (currency per EUR), 6 decimal places, half up. Null
 * when the ECB doesn't publish either.
 */
export function ecbCrossRate(day: EcbDay, base: string, currency: string): string | null {
  const perEuro = (code: string) => (code === "EUR" ? "1" : (day.rates.get(code) ?? null));
  const basePerEuro = perEuro(base);
  const currencyPerEuro = perEuro(currency);
  if (!basePerEuro || !currencyPerEuro) return null;
  return toPlainString(divide(dec(basePerEuro), dec(currencyPerEuro), 6));
}

export async function fetchEcbDays(): Promise<EcbDay[]> {
  const response = await fetcher(ECB_URL);
  if (!response.ok) throw new Error(`The European Central Bank's rates couldn't be read (HTTP ${response.status}).`);
  const days = parseEcbXml(await response.text());
  if (days.length === 0) throw new Error("The European Central Bank's file had no rates in it.");
  return days;
}

// ---------------------------------------------------------------- settings

export type EcbSettings = {
  enabled: boolean;
  enabledOn: string | null;
  extraCurrencies: string[];
  /** The currencies rates are brought in for: those used, plus the extras. */
  currencies: string[];
  lastRunAt: string | null;
  lastRatesDate: string | null;
  lastError: string | null;
  updatedByEmail: string | null;
};

/** Currencies the organisation uses: its contacts', accounts', documents' and exchange rates list's, other than its own. */
async function usedCurrencies(tx: OrgTx): Promise<string[]> {
  const found = await tx.query<{ code: string }>(
    `select distinct code from (
       select currency_code as code from contacts where currency_code is not null
       union select currency_code from accounts where currency_code is not null
       union select currency_code from currency_exchange_rates where archived_at is null
       union select currency_code from sales_invoices
       union select currency_code from bills
     ) used where code <> $1 order by code`,
    [tx.baseCurrency],
  );
  return found.rows.map((row) => row.code);
}

export async function getEcbSettings(tx: OrgTx): Promise<EcbSettings> {
  const row = (
    await tx.query<{ enabled: boolean; enabled_on: string | null; extra_currencies: string[]; last_run_at: string | null; last_rates_date: string | null; last_error: string | null; updated_by_email: string | null }>(
      "select enabled, enabled_on::text, extra_currencies, last_run_at, last_rates_date::text, last_error, updated_by_email from ecb_rate_settings where id = true",
    )
  ).rows[0];
  const used = await usedCurrencies(tx);
  return {
    enabled: row.enabled,
    enabledOn: row.enabled_on,
    extraCurrencies: row.extra_currencies,
    currencies: [...new Set([...used, ...row.extra_currencies])].filter((code) => code !== tx.baseCurrency).sort(),
    lastRunAt: row.last_run_at,
    lastRatesDate: row.last_rates_date,
    lastError: row.last_error,
    updatedByEmail: row.updated_by_email,
  };
}

/** Turns ECB rates on or off (admins), and the extra currencies to bring in. */
export async function updateEcbSettings(tx: OrgTx, input: { enabled?: unknown; extraCurrencies?: unknown; reason?: unknown }, today: string): Promise<EcbSettings> {
  const current = await getEcbSettings(tx);
  const enabled = optionalBoolean(input.enabled, "enabled") ?? current.enabled;
  const extra =
    input.extraCurrencies === undefined
      ? current.extraCurrencies
      : [
          ...new Set(
            requireArray(input.extraCurrencies, "extraCurrencies", 50).map((code) => {
              if (typeof code !== "string" || !/^[A-Z]{3}$/.test(code.trim().toUpperCase())) throw new ValidationError("Currencies are three-letter codes like AUD.");
              return code.trim().toUpperCase();
            }),
          ),
        ].filter((code) => code !== tx.baseCurrency);
  // Turning the ECB on or off is choosing the rate source (#183, FX2): typed only when it goes off.
  if (enabled !== current.enabled) {
    await setRateSource(tx, { source: enabled ? "ecb" : "typed", reason: input.reason }, today);
  }
  await tx.query("update ecb_rate_settings set extra_currencies = $1, updated_by_email = $2, updated_at = now() where id = true", [extra, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "ecb_rates.updated", entityType: "ecb_rates", entityId: "1", details: { enabled, extraCurrencies: extra } });
  return getEcbSettings(tx);
}

/**
 * Adds the ECB's rates to the list (FX1): for each day in the file on or
 * after the day it was turned on (and always the latest day), each currency
 * the organisation uses that the ECB publishes, unless the list already has
 * a rate for that currency and date. Returns how many were added.
 */
export async function applyEcbRates(tx: OrgTx, days: EcbDay[]): Promise<{ added: number; latest: string | null }> {
  const settings = await getEcbSettings(tx);
  if (!settings.enabled || days.length === 0) return { added: 0, latest: null };
  const latest = days[0].date;
  const wanted = days.filter((day) => day.date === latest || (settings.enabledOn !== null && day.date >= settings.enabledOn));
  let added = 0;
  for (const day of [...wanted].reverse()) {
    for (const currency of settings.currencies) {
      const rate = ecbCrossRate(day, tx.baseCurrency, currency);
      if (!rate) continue;
      const exists = await tx.query("select 1 from currency_exchange_rates where currency_code = $1 and effective_date = $2 and archived_at is null", [currency, day.date]);
      if ((exists.rowCount ?? 0) > 0) continue;
      const inserted = await tx.query<{ id: string }>(
        `insert into currency_exchange_rates (command_source, idempotency_key, line_number, request_hash, currency_code, effective_date, rate, note,
                                              created_by_user_id, created_by_email)
         values ('ecb', $1, 1, 'ecb', $2, $3, $4::numeric, $5, null, $6)
         on conflict (command_source, idempotency_key, line_number) do nothing returning id::text`,
        [`ecb-${day.date}-${currency}`, currency, day.date, rate, ECB_SOURCE, ACTOR.email],
      );
      if (!inserted.rows[0]) continue;
      added += 1;
      await writeAuditEvent(tx, {
        eventType: "exchange_rate.added",
        entityType: "exchange_rate",
        entityId: inserted.rows[0].id,
        details: { currencyCode: currency, effectiveDate: day.date, rate, note: ECB_SOURCE },
      });
    }
  }
  await tx.query("update ecb_rate_settings set last_run_at = now(), last_rates_date = $1, last_error = null where id = true", [latest]);
  return { added, latest };
}

/** Reads the ECB's file (outside any transaction) and adds its rates to one organisation's list. */
export async function refreshEcbRates(organisation: OrganisationRecord, actor: Actor = ACTOR, days?: EcbDay[]): Promise<{ added: number; error: string | null }> {
  let read: EcbDay[];
  try {
    read = days ?? (await fetchEcbDays());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withOrganisationTransaction(organisation, actor, (tx) =>
      tx.query("update ecb_rate_settings set last_run_at = now(), last_error = $1 where id = true", [`${message} It's tried again at the next check.`.slice(0, 500)]),
    );
    return { added: 0, error: message };
  }
  const result = await withOrganisationTransaction(organisation, actor, (tx) => applyEcbRates(tx, read));
  return { added: result.added, error: null };
}

// ---------------------------------------------------------------- the job

let running = false;

/** Every organisation with ECB rates on whose last check was more than 6 hours ago (the file changes once a working day). */
export async function refreshDueEcbRates(): Promise<number> {
  if (running) return 0;
  running = true;
  let refreshed = 0;
  try {
    let days: EcbDay[] | null = null;
    for (const organisation of await listAllOrganisations()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      const due = await withOrganisationTransaction(organisation, ACTOR, (tx) =>
        tx.query(`select 1 from ecb_rate_settings where enabled and ${ACCOUNTING_ON_SQL} and (last_run_at is null or last_run_at < now() - interval '6 hours')`),
      ).catch(() => null);
      if (!due || (due.rowCount ?? 0) === 0) continue;
      try {
        days ??= await fetchEcbDays();
      } catch {
        days = null;
      }
      await refreshEcbRates(organisation, ACTOR, days ?? undefined).catch((error) => console.warn(`[tohyee] ECB rates for ${organisation.id}:`, error));
      refreshed += 1;
    }
  } finally {
    running = false;
  }
  return refreshed;
}

let timer: NodeJS.Timeout | null = null;

/** Checks every hour (and 5 minutes after start). Off with TOHYEE_ECB_RATES_SCHEDULER=off. */
export function startEcbRatesScheduler(): void {
  if (timer) return;
  const tick = () => {
    refreshDueEcbRates().catch((error) => console.warn("[tohyee] ECB rates:", error));
  };
  timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 5 * 60 * 1000).unref?.();
}
