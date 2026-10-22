"use client";

import { useState } from "react";
import { Button, Field, Notice, ui } from "@/components/ui";
import type { FieldSettings } from "@/lib/analytics/field-settings";
import { fieldLabel } from "@/lib/analytics/labels";
import type { Aggregate, ColumnInfo } from "@/lib/analytics/query";
import { api, errorMessage } from "@/lib/client/api";
import styles from "./chart-format-panel.module.css";

const SUMMARISE: Array<{ value: Aggregate | "none"; label: string }> = [
  { value: "sum", label: "Total" },
  { value: "avg", label: "Average" },
  { value: "min", label: "Smallest" },
  { value: "max", label: "Largest" },
  { value: "count", label: "Count" },
  { value: "count_distinct", label: "Count of different values" },
  { value: "none", label: "Don't add it up (it's for grouping)" },
];

const isNumber = (type: string) => /^(DECIMAL|BIGINT|INTEGER|SMALLINT|TINYINT|HUGEINT|DOUBLE|FLOAT|UBIGINT|UINTEGER)/.test(type);
const isDate = (type: string) => type === "DATE" || type.startsWith("TIMESTAMP");

/**
 * A data source's field settings (decision 775; Power BI's column
 * properties): sort a field by another column, how it's added up when it's
 * chosen as a value, its format, and its folder and description in the
 * field list. Saved on the table for every report.
 */
export function FieldSettingsPanel({ organisationId, table, columns, canEdit, onChanged }: { organisationId: string; table: string; columns: ColumnInfo[]; canEdit: boolean; onChanged: () => void }) {
  const own = columns.filter((column) => !(column as { related?: unknown }).related);
  const [field, setField] = useState("");
  const [draft, setDraft] = useState<FieldSettings>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const chosen = own.find((column) => column.name === field);
  const set = (patch: Partial<FieldSettings>) => setDraft((current) => ({ ...current, ...patch }));
  const choose = (name: string) => {
    setField(name);
    setDraft(own.find((column) => column.name === name)?.settings ?? {});
    setError(null);
    setMessage(null);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/analytics/field-settings", { method: "PUT", body: { organisationId, table, field, settings: draft } });
      setMessage(`Saved ${fieldLabel(field)}'s settings for every report.`);
      onChanged();
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  };
  if (!table) return null;
  const withSettings = own.filter((column) => column.settings && Object.keys(column.settings).length).length;
  return (
    <details className={styles.meaning} style={{ gridColumn: "1 / -1" }}>
      <summary>Field settings ({withSettings})</summary>
      <p className={ui.muted}>Sort a field by another column (month names by month number), how it&apos;s added up when you choose it, its number format, and its folder and description in the field list.</p>
      {message ? <p role="status" className={ui.muted}>{message}</p> : null}
      <Field label="Field">
        <select value={field} onChange={(event) => choose(event.target.value)}>
          <option value="">Choose a field</option>
          {own.map((column) => (
            <option key={column.name} value={column.name}>
              {fieldLabel(column.name)}
              {column.settings && Object.keys(column.settings).length ? " (has settings)" : ""}
            </option>
          ))}
        </select>
      </Field>
      {chosen ? (
        <div className={styles.fieldForm}>
          {!isDate(chosen.type) ? (
            <Field label="Sort its groups by" hint="One value of that column for each value of this one, as each month name has one month number.">
              <select value={draft.sortBy ?? ""} disabled={!canEdit} onChange={(event) => set({ sortBy: event.target.value || undefined })}>
                <option value="">Itself (A to Z)</option>
                {own.filter((column) => column.name !== chosen.name).map((column) => <option key={column.name} value={column.name}>{fieldLabel(column.name)}</option>)}
              </select>
            </Field>
          ) : null}
          <Field label="When it's chosen as a value">
            <select value={draft.summarise ?? ""} disabled={!canEdit} onChange={(event) => set({ summarise: (event.target.value || undefined) as FieldSettings["summarise"] })}>
              <option value="">As usual</option>
              {SUMMARISE.filter((entry) => isNumber(chosen.type) || !["sum", "avg"].includes(entry.value)).map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </select>
          </Field>
          {isNumber(chosen.type) ? (
            <div className={styles.fieldActions}>
              <Field label="Shown as">
                <select value={draft.number?.style ?? ""} disabled={!canEdit} onChange={(event) => set({ number: event.target.value ? { ...draft.number, style: event.target.value as "currency" } : undefined })}>
                  <option value="">As usual</option>
                  <option value="currency">Money</option>
                  <option value="plain">A number</option>
                  <option value="percent">A percentage</option>
                </select>
              </Field>
              <Field label="Decimal places">
                <input inputMode="numeric" value={draft.number?.decimals ?? ""} disabled={!canEdit || !draft.number} onChange={(event) => set({ number: draft.number ? { ...draft.number, decimals: event.target.value === "" ? undefined : Number(event.target.value) } : undefined })} style={{ width: "5rem" }} />
              </Field>
            </div>
          ) : null}
          <Field label="Folder in the field list">
            <input value={draft.folder ?? ""} maxLength={40} disabled={!canEdit} onChange={(event) => set({ folder: event.target.value || undefined })} />
          </Field>
          <Field label="Description">
            <input value={draft.description ?? ""} maxLength={300} disabled={!canEdit} onChange={(event) => set({ description: event.target.value || undefined })} />
          </Field>
          {error ? <Notice tone="error">{error}</Notice> : null}
          {canEdit ? (
            <div className={styles.fieldActions}>
              <Button size="small" onClick={save} disabled={busy}>{busy ? "Checking…" : "Save field settings"}</Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
