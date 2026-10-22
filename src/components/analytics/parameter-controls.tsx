"use client";

import { useState } from "react";
import { Button, Field, Notice, ui } from "@/components/ui";
import { parseParameters, type NumberParameter, type TileSwitches } from "@/lib/analytics/parameters";
import type { Grain } from "@/lib/analytics/query";
import { add, dec, divide, mul, sub, toPlainString } from "@/lib/money/decimal";
import styles from "../analytics-dashboards.module.css";

/** A slider's steps and values, worked out exactly from the decimal text: min + steps × step. */
function stepCount(parameter: NumberParameter): number {
  return Number(toPlainString(divide(sub(dec(parameter.max), dec(parameter.min)), dec(parameter.step), 0)));
}
function valueAt(parameter: NumberParameter, steps: number): string {
  return toPlainString(add(dec(parameter.min), mul(dec(String(steps)), dec(parameter.step))));
}
function stepOf(parameter: NumberParameter, value: string): number {
  try {
    return Number(toPlainString(divide(sub(dec(value), dec(parameter.min)), dec(parameter.step), 0)));
  } catch {
    return 0;
  }
}

/**
 * The report's what-if parameters (decision 773): a slider for each, with
 * its value beside it. In edit mode, Parameter settings adds, changes and
 * removes them; formulas use them as @name.
 */
export function ParameterControls({
  parameters,
  values,
  onChange,
  editing,
  onSettings,
}: {
  parameters: NumberParameter[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  editing: boolean;
  onSettings: (parameters: NumberParameter[] | undefined) => void;
}) {
  return (
    <>
      {parameters.map((parameter) => {
        const value = values[parameter.name] ?? parameter.value;
        return (
          <div key={parameter.id} className={styles.parameter}>
            <label htmlFor={`parameter-${parameter.id}`} className={styles.bookmarkLabel}>
              {parameter.label}
            </label>
            <div className={styles.parameterRow}>
              <input
                id={`parameter-${parameter.id}`}
                type="range"
                min={0}
                max={stepCount(parameter)}
                step={1}
                value={stepOf(parameter, value)}
                aria-valuetext={value}
                onChange={(event) => onChange({ ...values, [parameter.name]: valueAt(parameter, Number(event.target.value)) })}
              />
              <output htmlFor={`parameter-${parameter.id}`} className={styles.parameterValue}>
                {value}
              </output>
            </div>
            <span className={ui.muted}>@{parameter.name}</span>
          </div>
        );
      })}
      {editing ? <ParameterSettings parameters={parameters} onSettings={onSettings} /> : null}
    </>
  );
}

const GRAIN_WORDS: Record<string, string> = { day: "by day", week: "by week", month: "by month", quarter: "by quarter", year: "by year", fquarter: "by financial quarter", fyear: "by financial year" };

const BLANK = { name: "", label: "", min: "0", max: "1", step: "0.05", value: "0" };

function ParameterSettings({ parameters, onSettings }: { parameters: NumberParameter[]; onSettings: (parameters: NumberParameter[] | undefined) => void }) {
  const [draft, setDraft] = useState<Omit<NumberParameter, "id"> & { id?: string }>(BLANK);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const others = parameters.filter((parameter) => parameter.id !== draft.id);
    try {
      // Checked as the server will check it, so a bad one is explained before Save.
      const next = parseParameters([...others, draft]);
      onSettings(next);
      setDraft(BLANK);
      setError(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  };
  const set = (patch: Partial<NumberParameter>) => setDraft((current) => ({ ...current, ...patch }));
  return (
    <details className={styles.slicerSettings}>
      <summary>Parameter settings</summary>
      <div className={styles.slicerSettingsBody}>
        <p className={ui.muted}>A number the reader chooses with a slider, used in a calculated value&apos;s formula as @name, e.g. [Sales] * (1 + @growth).</p>
        {parameters.map((parameter) => (
          <div key={parameter.id} className={styles.parameterRow}>
            <span>
              {parameter.label} (@{parameter.name}): {parameter.min} to {parameter.max}, steps of {parameter.step}, starting at {parameter.value}
            </span>
            <Button size="small" variant="secondary" onClick={() => setDraft(parameter)} aria-label={`Change ${parameter.label}`}>
              Change
            </Button>
            <Button size="small" variant="danger" onClick={() => onSettings(parameters.filter((entry) => entry.id !== parameter.id).length ? parameters.filter((entry) => entry.id !== parameter.id) : undefined)} aria-label={`Remove ${parameter.label}`}>
              Remove
            </Button>
          </div>
        ))}
        <fieldset className={styles.slicerPages}>
          <legend>{draft.id ? `Change ${draft.label}` : "Add a parameter"}</legend>
          <Field label="Name in formulas" hint="e.g. growth, used as @growth">
            <input value={draft.name} maxLength={31} onChange={(event) => set({ name: event.target.value })} />
          </Field>
          <Field label="Label">
            <input value={draft.label} maxLength={60} onChange={(event) => set({ label: event.target.value })} />
          </Field>
          <div className={styles.parameterRow}>
            <Field label="Smallest">
              <input inputMode="decimal" value={draft.min} onChange={(event) => set({ min: event.target.value })} />
            </Field>
            <Field label="Largest">
              <input inputMode="decimal" value={draft.max} onChange={(event) => set({ max: event.target.value })} />
            </Field>
            <Field label="Step">
              <input inputMode="decimal" value={draft.step} onChange={(event) => set({ step: event.target.value })} />
            </Field>
            <Field label="Starting value">
              <input inputMode="decimal" value={draft.value} onChange={(event) => set({ value: event.target.value })} />
            </Field>
          </div>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className={styles.parameterRow}>
            <Button size="small" onClick={save} disabled={!draft.name.trim()}>
              {draft.id ? "Change parameter" : "Add parameter"}
            </Button>
            {draft.id ? (
              <Button size="small" variant="secondary" onClick={() => setDraft(BLANK)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </fieldset>
      </div>
    </details>
  );
}

/**
 * What the reader can switch on this tile (decision 773; Power BI's field
 * parameters): show one of its values at a time, and group it by one of the
 * other fields chosen here. Only these choices can be made.
 */
export function SwitchSettings({
  switches,
  onChange,
  values,
  grouped,
  canSwitchValues,
  columns,
  groupBy,
  drills,
}: {
  switches: TileSwitches | undefined;
  onChange: (switches: TileSwitches | undefined) => void;
  values: number;
  grouped: boolean;
  canSwitchValues: boolean;
  columns: Array<{ name: string; type: string }>;
  groupBy: { field: string; grain?: string } | null;
  drills: boolean;
}) {
  const set = (patch: Partial<TileSwitches>) => {
    const next: TileSwitches = { ...switches, ...patch };
    if (!next.values) delete next.values;
    if (!next.groupings?.length) delete next.groupings;
    onChange(next.values || next.groupings ? next : undefined);
  };
  const chosen = switches?.groupings ?? [];
  const isDate = (type: string) => type === "DATE" || type.startsWith("TIMESTAMP");
  return (
    <fieldset className={styles.slicerPages}>
      <legend>What the reader can switch</legend>
      {canSwitchValues ? (
        <label className={ui.checkbox}>
          <input type="checkbox" checked={switches?.values === true} disabled={values < 2 && !switches?.values} onChange={(event) => set({ values: event.target.checked ? true : undefined })} /> Show one value at a time, chosen from this chart&apos;s values
          {values < 2 ? " (add another value first)" : ""}
        </label>
      ) : null}
      {grouped && !drills ? (
        <>
          <span className={ui.muted}>Also let the reader group it by:</span>
          <div className={styles.hiddenList}>
            {columns
              .filter((column) => column.name !== groupBy?.field || isDate(column.type))
              .map((column) => {
                const on = chosen.some((entry) => entry.field === column.name);
                return (
                  <label key={column.name} className={ui.checkbox}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!on && chosen.length >= 8}
                      onChange={(event) =>
                        set({ groupings: event.target.checked ? [...chosen, { field: column.name, ...(isDate(column.type) ? { grain: (groupBy?.field === column.name && groupBy.grain === "month" ? "quarter" : "month") as Grain } : {}) }] : chosen.filter((entry) => entry.field !== column.name) })
                      }
                    />{" "}
                    {column.name.replaceAll("_", " ")}
                    {isDate(column.type) ? ` (${GRAIN_WORDS[chosen.find((entry) => entry.field === column.name)?.grain ?? "month"] ?? "by month"})` : ""}
                  </label>
                );
              })}
          </div>
        </>
      ) : grouped ? (
        <span className={ui.muted}>A chart that drills down can&apos;t switch its grouping too.</span>
      ) : null}
    </fieldset>
  );
}
