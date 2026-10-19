"use client";

import { useEffect, useRef, useState } from "react";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { Button, ui } from "@/components/ui";
import { booleanText } from "@/lib/analytics/display";
import { changeFilter, columnKind, opsFor, valueKind } from "@/lib/analytics/filters";
import { fieldLabel } from "@/lib/analytics/labels";
import type { ColumnInfo, Filter, FilterOp } from "@/lib/analytics/query";
import styles from "./tile-filters.module.css";

const OLD_OP_LABELS: Partial<Record<FilterOp, string>> = { contains: "contains", gt: "more than", gte: "at least", lt: "less than", lte: "at most", in: "is one of" };

/**
 * A tile's "Only include rows where" filters (decision 578): tests that fit
 * each column, a pick list of the column's own values for "is one of",
 * ranges, dates relative to today, and "or" to make a group of filters where
 * any one will do.
 */
export function TileFilters({
  organisationId,
  table,
  columns,
  filters,
  onChange,
}: {
  organisationId: string;
  table: string;
  columns: ColumnInfo[];
  filters: Filter[];
  onChange: (filters: Filter[]) => void;
}) {
  const set = (index: number, patch: Partial<Filter>) =>
    onChange(filters.map((filter, at) => (at === index ? changeFilter(filter, patch, columns) : filter)));
  const hasOr = filters.some((filter, index) => index > 0 && filter.join === "or");
  return (
    <>
      {filters.length > 1 ? (
        <p className={`${ui.muted} ${styles.explain}`}>
          Rows must pass every filter{hasOr ? ", except that filters joined by “or” are a group where passing one is enough" : ". Choose “or” to make a group where passing one is enough"}.
        </p>
      ) : null}
      {filters.map((filter, index) => {
        const type = columns.find((column) => column.name === filter.field)?.type ?? "VARCHAR";
        const ops = opsFor(type);
        // A saved filter using a test from before decision 578 on another kind of column still shows.
        if (!ops.some((op) => op.value === filter.op)) ops.push({ value: filter.op, label: OLD_OP_LABELS[filter.op] ?? filter.op });
        const n = index + 1;
        const or = index > 0 && filter.join === "or";
        return (
          <div key={index} className={`${styles.row} ${or ? styles.orRow : ""}`} role="group" aria-label={`Filter ${n}`}>
            {index > 0 ? (
              <select
                aria-label={`Filter ${n} joins the one before with`}
                className={styles.join}
                value={or ? "or" : "and"}
                onChange={(event) => set(index, { join: event.target.value === "or" ? "or" : undefined })}
              >
                <option value="and">and</option>
                <option value="or">or</option>
              </select>
            ) : null}
            <select aria-label={`Filter ${n} column`} value={filter.field} onChange={(event) => set(index, { field: event.target.value })}>
              {columns.map((column) => (
                <option key={column.name} value={column.name} title={column.name}>
                  {fieldLabel(column.name)}
                </option>
              ))}
            </select>
            <select aria-label={`Filter ${n} test`} value={filter.op} onChange={(event) => set(index, { op: event.target.value as FilterOp })}>
              {ops.map((op) => (
                <option key={op.value} value={op.value}>
                  {op.label}
                </option>
              ))}
            </select>
            <FilterValue
              organisationId={organisationId}
              table={table}
              filter={filter}
              type={type}
              label={`Filter ${n}`}
              onChange={(value) => set(index, { value })}
            />
            <Button size="small" variant="danger" aria-label={`Remove filter ${n}`} onClick={() => onChange(filters.filter((_entry, at) => at !== index))}>
              Remove
            </Button>
          </div>
        );
      })}
      <div className={styles.add}>
        <Button
          size="small"
          variant="secondary"
          disabled={!columns.length || filters.length >= 20}
          onClick={() => onChange([...filters, { field: columns[0].name, op: "eq", value: "" }])}
        >
          Add a filter
        </Button>
      </div>
    </>
  );
}

function FilterValue({
  organisationId,
  table,
  filter,
  type,
  label,
  onChange,
}: {
  organisationId: string;
  table: string;
  filter: Filter;
  type: string;
  label: string;
  onChange: (value: string | string[]) => void;
}) {
  const kind = columnKind(type);
  const single = Array.isArray(filter.value) ? "" : String(filter.value);
  const input = (value: string, aria: string, set: (value: string) => void) =>
    kind === "date" ? (
      <DateInput aria-label={aria} value={value} onChange={(event) => set(event.target.value)} />
    ) : (
      <input aria-label={aria} inputMode={kind === "number" ? "decimal" : undefined} value={value} onChange={(event) => set(event.target.value)} />
    );
  switch (valueKind(filter.op)) {
    case "none":
      return null;
    case "list":
      return (
        <ValuePicker
          organisationId={organisationId}
          table={table}
          field={filter.field}
          label={`${label} values`}
          chosen={Array.isArray(filter.value) ? filter.value : []}
          onChange={onChange}
        />
      );
    case "two": {
      const [from, to] = Array.isArray(filter.value) && filter.value.length === 2 ? filter.value : ["", ""];
      return (
        <span className={styles.range}>
          {input(from, `${label} from`, (value) => onChange([value, to]))}
          <span aria-hidden="true">and</span>
          {input(to, `${label} to`, (value) => onChange([from, value]))}
        </span>
      );
    }
    case "count":
      return (
        <span className={styles.range}>
          <input aria-label={`${label} number of ${filter.op === "last_months" ? "months" : "days"}`} inputMode="numeric" className={styles.count} value={single} onChange={(event) => onChange(event.target.value.replace(/\D/g, ""))} />
          <span>{filter.op === "last_months" ? "months" : "days"}</span>
        </span>
      );
    default:
      if (kind === "boolean") {
        return (
          <select aria-label={`${label} value`} value={single} onChange={(event) => onChange(event.target.value)}>
            <option value="">Choose</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        );
      }
      return input(single, `${label} value`, onChange);
  }
}

/** Tick the values to keep, from the column's own values (up to 500), like a slicer. */
function ValuePicker({
  organisationId,
  table,
  field,
  label,
  chosen,
  onChange,
}: {
  organisationId: string;
  table: string;
  field: string;
  label: string;
  chosen: string[];
  onChange: (values: string[]) => void;
}) {
  const values = useApiData<{ values: string[]; type?: string }>("/api/analytics/values", { organisationId, table, field });
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const show = (value: string) => (values.data?.type === "BOOLEAN" ? booleanText(value) : value);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !menu.current) return;
      menu.current.open = false;
      menu.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const all = values.data?.values ?? [];
  // Chosen values stay listed even if they're no longer in the data.
  const listed = [...chosen.filter((value) => !all.includes(value)), ...all].filter((value) => show(value).toLowerCase().includes(search.toLowerCase().trim()));
  const summary = chosen.length === 0 ? "Choose values" : chosen.length <= 2 ? chosen.map(show).join(", ") : `${chosen.length} chosen`;
  return (
    <details ref={menu} className={styles.picker} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary aria-label={`${label}: ${summary}`}>{summary}</summary>
      <div className={styles.pickerList} role="group" aria-label={label}>
        {all.length > 12 ? <input type="search" aria-label={`Find ${label.toLowerCase()}`} placeholder="Find a value…" value={search} onChange={(event) => setSearch(event.target.value)} /> : null}
        {values.error ? <p className={ui.muted}>{values.error}</p> : !values.data ? <p className={ui.muted}>Loading…</p> : null}
        {listed.map((value) => (
          <label key={value} className={ui.checkbox}>
            <input
              type="checkbox"
              checked={chosen.includes(value)}
              onChange={(event) => onChange(event.target.checked ? [...chosen, value] : chosen.filter((entry) => entry !== value))}
            />{" "}
            {show(value) || "(empty)"}
          </label>
        ))}
        {values.data && all.length >= 500 ? <p className={ui.muted}>Showing the first 500 values.</p> : null}
        {values.data && all.length === 0 ? <p className={ui.muted}>This column has no values yet.</p> : null}
      </div>
    </details>
  );
}
