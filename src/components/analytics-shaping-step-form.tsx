"use client";

import { useState } from "react";
import { Button, Field, ui } from "@/components/ui";
import {
  AGGREGATE_LABELS,
  COLUMN_KIND_LABELS,
  columnNameForValue,
  DATE_PART_LABELS,
  datePartName,
  TEST_LABELS,
} from "@/lib/analytics/shaping-labels";
import { DATE_PARTS, type ShapeColumn, type ShapeOutput, type ShapeStep, type ShapeTest } from "@/lib/analytics/shaping";
import styles from "./analytics-shaping.module.css";

/** The steps with a form; the others are edited as their settings (JSON), as before. */
export const FORM_STEPS = new Set<ShapeStep["type"]>(["pivot", "unpivot", "fill", "replace", "distinct", "conditional", "dateParts", "sort", "index", "formula"]);

type Props = {
  step: ShapeStep;
  /** The columns the step can use: the ones after the step above it. */
  columns: ShapeColumn[];
  disabled: boolean;
  onChange: (step: ShapeStep) => void;
  /** The distinct values of a column at this step (up to 100), for Pivot column. */
  valuesOf: (column: string) => Promise<string[]>;
};

const TESTS = Object.keys(TEST_LABELS) as ShapeTest[];
const isNumber = (type: string) => /^(DECIMAL|BIGINT|INTEGER|SMALLINT|TINYINT|HUGEINT|UBIGINT|UINTEGER|USMALLINT|UTINYINT)/.test(type);
const isDate = (type: string) => type === "DATE" || type.startsWith("TIMESTAMP");

function ColumnSelect({ label, value, columns, onChange, disabled, hint }: { label: string; value: string; columns: ShapeColumn[]; onChange: (value: string) => void; disabled: boolean; hint?: string }) {
  const known = columns.some((column) => column.name === value);
  return (
    <Field label={label} hint={hint}>
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        {!known ? <option value={value}>{value || "Choose a column"} (not here)</option> : null}
        {columns.map((column) => (
          <option key={column.name} value={column.name}>
            {column.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function ColumnChecklist({ legend, chosen, columns, onChange, disabled }: { legend: string; chosen: string[]; columns: ShapeColumn[]; onChange: (value: string[]) => void; disabled: boolean }) {
  return (
    <fieldset className={styles.checklist}>
      <legend>{legend}</legend>
      {columns.map((column) => (
        <label key={column.name} className={ui.checkbox}>
          <input
            type="checkbox"
            checked={chosen.includes(column.name)}
            disabled={disabled}
            onChange={(event) =>
              onChange(event.target.checked ? columns.map((entry) => entry.name).filter((name) => name === column.name || chosen.includes(name)) : chosen.filter((name) => name !== column.name))
            }
          />
          {column.name}
        </label>
      ))}
      {chosen.filter((name) => !columns.some((column) => column.name === name)).map((name) => (
        <span key={name} className={styles.muted}>
          {name} isn&apos;t a column at this step.
        </span>
      ))}
    </fieldset>
  );
}

function TextField({ label, value, onChange, disabled, hint, inputMode }: { label: string; value: string; onChange: (value: string) => void; disabled: boolean; hint?: string; inputMode?: "numeric" }) {
  return (
    <Field label={label} hint={hint}>
      <input value={value} maxLength={500} inputMode={inputMode} onChange={(event) => onChange(event.target.value)} disabled={disabled} />
    </Field>
  );
}

function OutputEditor({ label, output, columns, onChange, disabled }: { label: string; output: ShapeOutput; columns: ShapeColumn[]; onChange: (value: ShapeOutput) => void; disabled: boolean }) {
  return (
    <div className={styles.formRow}>
      <Field label={label}>
        <select
          value={output.type}
          disabled={disabled}
          onChange={(event) => {
            const type = event.target.value as ShapeOutput["type"];
            onChange(type === "column" ? { type, name: columns[0]?.name ?? "" } : type === "value" ? { type, value: "" } : { type });
          }}
        >
          <option value="value">A value</option>
          <option value="column">A column&apos;s value</option>
          <option value="blank">Blank</option>
        </select>
      </Field>
      {output.type === "value" ? <TextField label={`${label}: value`} value={output.value} onChange={(value) => onChange({ type: "value", value })} disabled={disabled} /> : null}
      {output.type === "column" ? <ColumnSelect label={`${label}: column`} value={output.name} columns={columns} onChange={(name) => onChange({ type: "column", name })} disabled={disabled} /> : null}
    </div>
  );
}

function RowTools({ index, count, onMove, onRemove, what, disabled }: { index: number; count: number; onMove: (offset: number) => void; onRemove: () => void; what: string; disabled: boolean }) {
  if (disabled) return null;
  return (
    <div className={styles.stepTools}>
      <Button size="small" variant="secondary" aria-label={`Move ${what} ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)}>↑</Button>
      <Button size="small" variant="secondary" aria-label={`Move ${what} ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(1)}>↓</Button>
      <Button size="small" variant="danger" aria-label={`Remove ${what} ${index + 1}`} disabled={count === 1} onClick={onRemove}>×</Button>
    </div>
  );
}

function without<T extends object>(value: T, key: keyof T): T {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function moved<T>(list: T[], index: number, offset: number): T[] {
  const next = list.slice();
  [next[index], next[index + offset]] = [next[index + offset], next[index]];
  return next;
}

/** A form for one of the newer steps (#376 phase 4). Every value is checked again by the server. */
export function StepForm({ step, columns, disabled, onChange, valuesOf }: Props) {
  const [loadingValues, setLoadingValues] = useState(false);
  const [valuesError, setValuesError] = useState<string | null>(null);
  const names = new Set(columns.map((column) => column.name));
  switch (step.type) {
    case "pivot": {
      const fillValues = async () => {
        setLoadingValues(true);
        setValuesError(null);
        try {
          const values = await valuesOf(step.column);
          const taken = new Set([...columns.map((column) => column.name).filter((name) => name !== step.column && name !== step.valueColumn)]);
          const made = values.map((value) => {
            const name = columnNameForValue(value, taken);
            taken.add(name);
            return { value, name };
          });
          onChange({ ...step, columns: made.length ? made : step.columns });
          if (!made.length) setValuesError(`${step.column} has no values here.`);
        } catch (caught) {
          setValuesError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          setLoadingValues(false);
        }
      };
      return (
        <div className={styles.form}>
          <p className={styles.muted}>Each value listed becomes a column (Power Query&apos;s Pivot column). Rows are grouped by every other column. Values not listed are left out.</p>
          <div className={styles.formRow}>
            <ColumnSelect label="Column whose values become columns" value={step.column} columns={columns} onChange={(column) => onChange({ ...step, column })} disabled={disabled} />
            <ColumnSelect label="Values column" value={step.valueColumn} columns={columns} onChange={(valueColumn) => onChange({ ...step, valueColumn })} disabled={disabled} />
            <Field label="Combine values by">
              <select value={step.operation} onChange={(event) => onChange({ ...step, operation: event.target.value as typeof step.operation })} disabled={disabled}>
                {Object.entries(AGGREGATE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
          </div>
          <fieldset className={styles.checklist}>
            <legend>New columns</legend>
            {step.columns.map((entry, index) => (
              <div key={index} className={styles.formRow}>
                <TextField label={`Value ${index + 1}`} value={entry.value} onChange={(value) => onChange({ ...step, columns: step.columns.map((item, at) => (at === index ? { ...item, value } : item)) })} disabled={disabled} />
                <TextField label={`Column name ${index + 1}`} value={entry.name} onChange={(name) => onChange({ ...step, columns: step.columns.map((item, at) => (at === index ? { ...item, name } : item)) })} disabled={disabled} />
                <RowTools index={index} count={step.columns.length} what="new column" disabled={disabled} onMove={(offset) => onChange({ ...step, columns: moved(step.columns, index, offset) })} onRemove={() => onChange({ ...step, columns: step.columns.filter((_, at) => at !== index) })} />
              </div>
            ))}
            {!disabled ? (
              <div className={styles.actions}>
                <Button size="small" variant="secondary" onClick={() => onChange({ ...step, columns: [...step.columns, { value: "", name: columnNameForValue(`value ${step.columns.length + 1}`, new Set(step.columns.map((entry) => entry.name))) }] })}>
                  Add a value
                </Button>
                <Button size="small" variant="secondary" onClick={() => void fillValues()} disabled={loadingValues}>
                  {loadingValues ? "Reading values…" : `Use the values in ${step.column}`}
                </Button>
              </div>
            ) : null}
            {valuesError ? <span className={styles.muted} role="alert">{valuesError}</span> : null}
          </fieldset>
        </div>
      );
    }
    case "unpivot":
      return (
        <div className={styles.form}>
          <Field label="Unpivot">
            <select value={step.other ? "other" : "selected"} onChange={(event) => onChange(event.target.value === "other" ? { ...step, other: true } : without(step, "other"))} disabled={disabled}>
              <option value="selected">The columns ticked</option>
              <option value="other">Every column except the ones ticked (Unpivot other columns)</option>
            </select>
          </Field>
          <ColumnChecklist legend={step.other ? "Columns to keep as they are" : "Columns to unpivot (at least two)"} chosen={step.columns} columns={columns} onChange={(chosen) => onChange({ ...step, columns: chosen })} disabled={disabled} />
          <div className={styles.formRow}>
            <TextField label="Attribute column name" value={step.attributeName} onChange={(attributeName) => onChange({ ...step, attributeName })} disabled={disabled} />
            <TextField label="Value column name" value={step.valueName} onChange={(valueName) => onChange({ ...step, valueName })} disabled={disabled} />
          </div>
          <p className={styles.muted}>Blank cells are left out, as in Power Query.</p>
        </div>
      );
    case "fill":
      return (
        <div className={styles.form}>
          <Field label="Fill" hint="Blank cells take the value from the nearest row above (down) or below (up) that has one.">
            <select value={step.direction} onChange={(event) => onChange({ ...step, direction: event.target.value as "down" | "up" })} disabled={disabled}>
              <option value="down">Down</option>
              <option value="up">Up</option>
            </select>
          </Field>
          <ColumnChecklist legend="Columns to fill" chosen={step.columns} columns={columns} onChange={(chosen) => onChange({ ...step, columns: chosen })} disabled={disabled} />
        </div>
      );
    case "replace": {
      const textOnly = step.columns.every((name) => columns.find((column) => column.name === name)?.type === "VARCHAR");
      return (
        <div className={styles.form}>
          <ColumnChecklist legend="Columns" chosen={step.columns} columns={columns} onChange={(chosen) => onChange({ ...step, columns: chosen })} disabled={disabled} />
          <Field label="Match" hint={textOnly ? "Matching is case-sensitive, as in Power Query." : "Part of the text only works on text columns."}>
            <select value={step.match} onChange={(event) => onChange({ ...step, match: event.target.value as "whole" | "part", find: event.target.value === "part" && step.find === null ? "" : step.find })} disabled={disabled}>
              <option value="whole">The whole cell</option>
              <option value="part">Part of the text</option>
            </select>
          </Field>
          <div className={styles.formRow}>
            <div className={styles.form}>
              {step.find !== null ? <TextField label="Value to find" value={step.find} onChange={(find) => onChange({ ...step, find })} disabled={disabled} /> : <p className={styles.muted}>Finds blank cells.</p>}
              {step.match === "whole" ? (
                <label className={ui.checkbox}>
                  <input type="checkbox" checked={step.find === null} onChange={(event) => onChange({ ...step, find: event.target.checked ? null : "" })} disabled={disabled} />
                  Find blank cells
                </label>
              ) : null}
            </div>
            <div className={styles.form}>
              {step.replaceWith !== null ? <TextField label="Replace with" value={step.replaceWith} onChange={(replaceWith) => onChange({ ...step, replaceWith })} disabled={disabled} /> : <p className={styles.muted}>Replaces with blank.</p>}
              <label className={ui.checkbox}>
                <input type="checkbox" checked={step.replaceWith === null} onChange={(event) => onChange({ ...step, replaceWith: event.target.checked ? null : "" })} disabled={disabled} />
                Replace with blank
              </label>
            </div>
          </div>
        </div>
      );
    }
    case "distinct":
      return (
        <div className={styles.form}>
          <ColumnChecklist legend="Rows are duplicates when these columns match" chosen={step.columns} columns={columns} onChange={(chosen) => onChange({ ...step, columns: chosen })} disabled={disabled} />
          {!disabled ? (
            <div className={styles.actions}>
              <Button size="small" variant="secondary" onClick={() => onChange({ ...step, columns: columns.map((column) => column.name) })}>Tick every column</Button>
            </div>
          ) : null}
          <p className={styles.muted}>The first row of each set is kept. Blank values count as the same as each other.</p>
        </div>
      );
    case "conditional": {
      const setRule = (index: number, rule: Partial<(typeof step.rules)[number]>) => onChange({ ...step, rules: step.rules.map((entry, at) => (at === index ? { ...entry, ...rule } : entry)) });
      return (
        <div className={styles.form}>
          <div className={styles.formRow}>
            <TextField label="New column name" value={step.name} onChange={(name) => onChange({ ...step, name })} disabled={disabled} />
            <Field label="Column type" hint="Automatic uses the type of the columns it gives, or text.">
              <select value={step.kind ?? ""} onChange={(event) => onChange(event.target.value ? { ...step, kind: event.target.value as NonNullable<typeof step.kind> } : without(step, "kind"))} disabled={disabled}>
                <option value="">Automatic</option>
                {Object.entries(COLUMN_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
          </div>
          {step.rules.map((rule, index) => (
            <fieldset key={index} className={styles.checklist}>
              <legend>{index === 0 ? "If" : `Else if (rule ${index + 1})`}</legend>
              <div className={styles.formRow}>
                <ColumnSelect label="Column" value={rule.column} columns={columns} onChange={(column) => setRule(index, { column })} disabled={disabled} />
                <Field label="Test">
                  <select value={rule.test} onChange={(event) => {
                    const test = event.target.value as ShapeTest;
                    setRule(index, test === "is empty" || test === "is not empty" ? { test, value: undefined } : { test, value: rule.value ?? "" });
                  }} disabled={disabled}>
                    {TESTS.map((test) => <option key={test} value={test}>{TEST_LABELS[test]}</option>)}
                  </select>
                </Field>
                {rule.test !== "is empty" && rule.test !== "is not empty" ? <TextField label="Value" value={rule.value ?? ""} onChange={(value) => setRule(index, { value })} disabled={disabled} /> : null}
                <RowTools index={index} count={step.rules.length} what="rule" disabled={disabled} onMove={(offset) => onChange({ ...step, rules: moved(step.rules, index, offset) })} onRemove={() => onChange({ ...step, rules: step.rules.filter((_, at) => at !== index) })} />
              </div>
              <OutputEditor label="Then" output={rule.then} columns={columns} onChange={(then) => setRule(index, { then })} disabled={disabled} />
            </fieldset>
          ))}
          {!disabled ? (
            <div className={styles.actions}>
              <Button size="small" variant="secondary" onClick={() => onChange({ ...step, rules: [...step.rules, { column: columns[0]?.name ?? "", test: "is", value: "", then: { type: "value", value: "" } }] })}>Add a rule</Button>
            </div>
          ) : null}
          <OutputEditor label="Otherwise" output={step.otherwise} columns={columns} onChange={(otherwise) => onChange({ ...step, otherwise })} disabled={disabled} />
          <p className={styles.muted}>The first rule that matches gives the value. A blank cell doesn&apos;t match a comparison; use &ldquo;is blank&rdquo; for those.</p>
        </div>
      );
    }
    case "dateParts": {
      const dates = columns.filter((column) => isDate(column.type));
      return (
        <div className={styles.form}>
          <ColumnSelect label="Date column" value={step.column} columns={dates} onChange={(column) => onChange({ ...step, column })} disabled={disabled} hint={dates.length ? undefined : "There are no date columns here. Change a column's type to Date first."} />
          <fieldset className={styles.checklist}>
            <legend>Parts to add</legend>
            {DATE_PARTS.map((part) => {
              const entry = step.parts.find((item) => item.part === part);
              return (
                <div key={part} className={styles.formRow}>
                  <label className={ui.checkbox}>
                    <input
                      type="checkbox"
                      checked={Boolean(entry)}
                      disabled={disabled}
                      onChange={(event) =>
                        onChange({
                          ...step,
                          parts: event.target.checked
                            ? DATE_PARTS.flatMap((candidate) => (candidate === part ? [{ part, name: datePartName(step.column, part, new Set([...names, ...step.parts.map((item) => item.name)])) }] : step.parts.filter((item) => item.part === candidate)))
                            : step.parts.filter((item) => item.part !== part),
                        })
                      }
                    />
                    {DATE_PART_LABELS[part]}
                  </label>
                  {entry ? <TextField label={`${DATE_PART_LABELS[part]}: column name`} value={entry.name} onChange={(name) => onChange({ ...step, parts: step.parts.map((item) => (item.part === part ? { ...item, name } : item)) })} disabled={disabled} /> : null}
                </div>
              );
            })}
          </fieldset>
          <p className={styles.muted}>The financial year uses this organisation&apos;s balance date, and is named by the year it ends in (the year to 31 March 2026 is 2026). If the balance date changes, the next rebuild uses the new one.</p>
        </div>
      );
    }
    case "sort":
      return (
        <div className={styles.form}>
          {step.by.map((entry, index) => (
            <div key={index} className={styles.formRow}>
              <ColumnSelect label={index === 0 ? "Sort by" : `Then by (${index + 1})`} value={entry.column} columns={columns} onChange={(column) => onChange({ ...step, by: step.by.map((item, at) => (at === index ? { ...item, column } : item)) })} disabled={disabled} />
              <Field label="Order">
                <select value={entry.descending ? "desc" : "asc"} onChange={(event) => onChange({ ...step, by: step.by.map((item, at) => (at === index ? { ...item, descending: event.target.value === "desc" } : item)) })} disabled={disabled}>
                  <option value="asc">Ascending (A to Z, smallest first)</option>
                  <option value="desc">Descending (Z to A, largest first)</option>
                </select>
              </Field>
              <RowTools index={index} count={step.by.length} what="sort column" disabled={disabled} onMove={(offset) => onChange({ ...step, by: moved(step.by, index, offset) })} onRemove={() => onChange({ ...step, by: step.by.filter((_, at) => at !== index) })} />
            </div>
          ))}
          {!disabled && step.by.length < 10 ? (
            <div className={styles.actions}>
              <Button size="small" variant="secondary" onClick={() => onChange({ ...step, by: [...step.by, { column: columns.find((column) => !step.by.some((item) => item.column === column.name))?.name ?? "", descending: false }] })}>Add a column</Button>
            </div>
          ) : null}
          <p className={styles.muted}>Blank cells come first going up and last going down. Fill down and Index column use this order.</p>
        </div>
      );
    case "index":
      return (
        <div className={styles.form}>
          <div className={styles.formRow}>
            <TextField label="Column name" value={step.name} onChange={(name) => onChange({ ...step, name })} disabled={disabled} />
            <Field label="Start at">
              <input type="number" step={1} value={step.start} onChange={(event) => onChange({ ...step, start: Number(event.target.value) })} disabled={disabled} />
            </Field>
            <Field label="Go up by">
              <input type="number" step={1} value={step.increment} onChange={(event) => onChange({ ...step, increment: Number(event.target.value) })} disabled={disabled} />
            </Field>
          </div>
          <p className={styles.muted}>Rows are numbered in the order they were loaded, or of the last Sort step.</p>
        </div>
      );
    case "formula": {
      const numbers = columns.filter((column) => isNumber(column.type));
      return (
        <div className={styles.form}>
          <TextField label="New column name" value={step.name} onChange={(name) => onChange({ ...step, name })} disabled={disabled} />
          <Field label="Formula" hint="Number columns in square brackets, numbers, + - * / and brackets, e.g. [amount] * 1.15. Worked out exactly; dividing by zero or a blank cell gives blank.">
            <textarea className={styles.formulaEditor} value={step.formula} maxLength={500} spellCheck={false} onChange={(event) => onChange({ ...step, formula: event.target.value })} disabled={disabled} />
          </Field>
          {!disabled && numbers.length ? (
            <div className={styles.actions} aria-label="Insert a column">
              {numbers.map((column) => (
                <Button key={column.name} size="small" variant="secondary" onClick={() => onChange({ ...step, formula: `${step.formula}${step.formula && !step.formula.endsWith(" ") ? " " : ""}[${column.name}]` })}>
                  [{column.name}]
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      );
    }
    default:
      return null;
  }
}
