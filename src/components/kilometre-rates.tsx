"use client";

import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { MileageRateRow } from "@/lib/expense-claims/mileage";
import { formatKmRate, incomeYearEnding, incomeYearLabel, VEHICLE_TYPE_LABELS, VEHICLE_TYPES, type VehicleType } from "@/lib/expense-claims/mileage-types";
import { formatDateTime, todayInBrowser } from "@/lib/format";

/**
 * Kilometre rates for mileage on expense claims (MI1): IRD's rates per
 * income year and vehicle type. Admins enter a year's rates when IRD
 * publishes them; a year an approved claim used can't change.
 */

type Rates = Record<VehicleType, { tier1Rate: string; tier2Rate: string }>;

function ratesFor(rows: MileageRateRow[], yearEnding: number): Rates | null {
  const year = rows.filter((row) => row.yearEnding === yearEnding);
  if (year.length === 0) return null;
  return Object.fromEntries(
    VEHICLE_TYPES.map((type) => {
      const row = year.find((entry) => entry.vehicleType === type);
      return [type, { tier1Rate: row?.tier1Rate ?? "", tier2Rate: row?.tier2Rate ?? "" }];
    }),
  ) as Rates;
}

function RatesForm({ organisationId, rows, onSaved }: { organisationId: string; rows: MileageRateRow[]; onSaved: (rows: MileageRateRow[], message: string) => void }) {
  const thisYear = incomeYearEnding(todayInBrowser());
  const latest = rows[0]?.yearEnding ?? thisYear;
  const choices = [...new Set([thisYear + 1, thisYear, thisYear - 1, latest])].sort((left, right) => right - left);
  const [yearEnding, setYearEnding] = useState(rows.some((row) => row.yearEnding === thisYear) ? thisYear + 1 : thisYear);
  // A year not entered yet starts blank: the rates are typed from IRD's statement, never carried over.
  const blank = Object.fromEntries(VEHICLE_TYPES.map((type) => [type, { tier1Rate: "", tier2Rate: "" }])) as Rates;
  const [rates, setRates] = useState<Rates>(ratesFor(rows, yearEnding) ?? blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = rows.some((row) => row.yearEnding === yearEnding && row.used);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const result = await api<{ rates: MileageRateRow[]; draftsRecalculated: number }>("/api/mileage-rates", {
            method: "PUT",
            body: { organisationId, yearEnding, rates },
          });
          onSaved(
            result.rates,
            `Saved the ${incomeYearLabel(yearEnding)} rates.${result.draftsRecalculated ? ` ${result.draftsRecalculated} draft ${result.draftsRecalculated === 1 ? "claim's" : "claims'"} mileage was worked out again.` : ""}`,
          );
        } catch (caught) {
          setError(errorMessage(caught));
        } finally {
          setBusy(false);
        }
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Income year" hint="1 April to 31 March.">
          <select
            value={yearEnding}
            onChange={(event) => {
              const next = Number(event.target.value);
              setYearEnding(next);
              setRates(ratesFor(rows, next) ?? blank);
            }}
          >
            {choices.map((year) => (
              <option key={year} value={year}>
                {incomeYearLabel(year)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {locked ? <Notice tone="info">An approved claim used the {incomeYearLabel(yearEnding)} rates, so they can&apos;t change.</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Vehicle</th>
              <th className={ui.num}>Tier 1 (a km)</th>
              <th className={ui.num}>Tier 2 (a km)</th>
            </tr>
          </thead>
          <tbody>
            {VEHICLE_TYPES.map((type) => (
              <tr key={type}>
                <td data-label="Vehicle">{VEHICLE_TYPE_LABELS[type]}</td>
                {(["tier1Rate", "tier2Rate"] as const).map((tier) => (
                  <td key={tier} data-label={tier === "tier1Rate" ? "Tier 1" : "Tier 2"} className={ui.num}>
                    <input
                      aria-label={`${VEHICLE_TYPE_LABELS[type]} ${tier === "tier1Rate" ? "tier 1" : "tier 2"} rate`}
                      inputMode="decimal"
                      size={7}
                      value={rates[type][tier]}
                      disabled={locked}
                      onChange={(event) => setRates({ ...rates, [type]: { ...rates[type], [tier]: event.target.value } })}
                      required
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
        <Button type="submit" disabled={busy || locked}>
          {busy ? "Saving…" : `Save ${incomeYearLabel(yearEnding)} rates`}
        </Button>
      </div>
    </form>
  );
}

export function KilometreRates({ organisationId, canEdit }: { organisationId: string; canEdit: boolean }) {
  const loaded = useApiData<{ rates: MileageRateRow[] }>("/api/mileage-rates", { organisationId });
  const [rows, setRows] = useState<MileageRateRow[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  const rates = rows ?? loaded.data?.rates;
  if (!rates) return <p className={ui.muted}>Loading…</p>;
  const years = [...new Set(rates.map((row) => row.yearEnding))];
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <Card
        title="Kilometre rates"
        description="Mileage lines on expense claims are paid at these rates: tier 1 for the first 14,000 km of a person's mileage for a vehicle type in an income year, tier 2 after that. No GST. When a year's rates aren't entered, the latest rates are used and the line says so."
      >
        {years.map((year) => {
          const yearRows = rates.filter((row) => row.yearEnding === year);
          return (
            <div key={year} className={ui.tableWrap}>
              <table className={`${ui.table} ${ui.stackOnPhone}`}>
                <caption style={{ textAlign: "left", fontWeight: 600, padding: "8px 0", whiteSpace: "nowrap" }}>
                  {incomeYearLabel(year)} {yearRows.some((row) => row.used) ? <Badge tone="neutral">Used by approved claims</Badge> : null}
                </caption>
                <thead>
                  <tr>
                    <th>Vehicle</th>
                    <th className={ui.num}>Tier 1 (a km)</th>
                    <th className={ui.num}>Tier 2 (a km)</th>
                    <th>Entered</th>
                  </tr>
                </thead>
                <tbody>
                  {yearRows.map((row) => (
                    <tr key={row.vehicleType}>
                      <td data-label="Vehicle">{VEHICLE_TYPE_LABELS[row.vehicleType]}</td>
                      <td data-label="Tier 1" className={ui.num}>
                        {formatKmRate(row.tier1Rate)}
                      </td>
                      <td data-label="Tier 2" className={ui.num}>
                        {formatKmRate(row.tier2Rate)}
                      </td>
                      <td data-label="Entered" className={ui.muted}>
                        {row.updatedByEmail === "tohyee" ? "IRD's published rates, included with Tohyee" : `${row.updatedByEmail ?? ""}, ${formatDateTime(row.updatedAt)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </Card>
      {canEdit ? (
        <Card title="Enter a year's rates" description="IRD publishes each year's kilometre rates after the year ends. Check IRD's operational statement and enter them here. Draft claims are worked out again; submitted and approved claims keep their rates.">
          <RatesForm
            organisationId={organisationId}
            rows={rates}
            onSaved={(next, text) => {
              setRows(next);
              setMessage(text);
            }}
          />
        </Card>
      ) : null}
    </>
  );
}
