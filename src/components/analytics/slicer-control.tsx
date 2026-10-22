"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { Button, ui } from "@/components/ui";
import { booleanText } from "@/lib/analytics/display";
import { rangeText, type SlicerRange, type SlicerSetting } from "@/lib/analytics/slicers";
import styles from "./slicer-control.module.css";

/**
 * A slicer in the report's filter bar (#376 phase 3, decision 757): tick
 * boxes in a menu (as before), a search box, a drop-down or buttons for one
 * value, a number or date range, relative dates, or two levels.
 */
export function SlicerControl({
  organisationId,
  dashboardId,
  slicer,
  chosen,
  childChosen,
  range,
  onChange,
  onChildChange,
  onRange,
  settings,
}: {
  organisationId: string;
  dashboardId: string;
  slicer: SlicerSetting;
  chosen: string[];
  /** A hierarchy slicer's second level. */
  childChosen?: string[];
  range?: SlicerRange;
  onChange: (values: string[]) => void;
  onChildChange?: (values: string[]) => void;
  onRange: (range: SlicerRange | undefined) => void;
  /** Edit mode: the slicer's settings. */
  settings?: ReactNode;
}) {
  const style = slicer.style ?? "list";
  const ranged = style === "range" || style === "dates" || style === "relative";
  const hierarchy = style === "hierarchy" && slicer.child;
  const values = useApiData<{ values: string[]; type?: string }>(ranged || hierarchy ? null : "/api/analytics/values", { organisationId, dashboardId, table: slicer.table, field: slicer.field });
  const pairs = useApiData<{ pairs: Array<[string, string]> }>(hierarchy ? "/api/analytics/values" : null, { organisationId, dashboardId, table: slicer.table, field: slicer.field, child: slicer.child ?? "" });
  // Yes/No columns show Yes and No; what's sent stays true and false (decision 577).
  const show = (value: string) => (values.data?.type === "BOOLEAN" ? booleanText(value) : value);
  const list = values.data?.values ?? [];
  const className = [styles.slicer, slicer.look?.size === "small" ? styles.small : slicer.look?.size === "large" ? styles.large : "", slicer.look?.width === "wide" ? styles.wide : ""].filter(Boolean).join(" ");
  const label = <span className={styles.slicerLabel} id={`slicer-${slicer.table}-${slicer.field}`}>{slicer.label}</span>;
  const labelId = `slicer-${slicer.table}-${slicer.field}`;

  let control: ReactNode;
  if (style === "dropdown") {
    control = (
      <select aria-labelledby={labelId} value={chosen[0] ?? ""} onChange={(event) => onChange(event.target.value ? [event.target.value] : [])}>
        <option value="">All</option>
        {list.map((value) => <option key={value} value={value}>{show(value)}</option>)}
      </select>
    );
  } else if (style === "single") {
    control = (
      <div className={styles.buttons} role="group" aria-labelledby={labelId}>
        <button type="button" aria-pressed={chosen.length === 0} onClick={() => onChange([])}>All</button>
        {list.slice(0, 30).map((value) => (
          <button key={value} type="button" aria-pressed={chosen[0] === value} onClick={() => onChange(chosen[0] === value ? [] : [value])}>{show(value)}</button>
        ))}
      </div>
    );
  } else if (style === "range") {
    control = <NumberRange labelId={labelId} range={range} onRange={onRange} />;
  } else if (style === "dates") {
    control = (
      <div className={styles.range} role="group" aria-labelledby={labelId}>
        <DateInput aria-label={`${slicer.label} from`} value={range?.min ?? ""} onChange={(event) => onRange(tidy({ ...range, min: event.target.value || undefined }))} />
        <span>to</span>
        <DateInput aria-label={`${slicer.label} to`} value={range?.max ?? ""} onChange={(event) => onRange(tidy({ ...range, max: event.target.value || undefined }))} />
      </div>
    );
  } else if (style === "relative") {
    const last = range?.last;
    control = (
      <div className={styles.range} role="group" aria-labelledby={labelId}>
        <span>Last</span>
        <input aria-label={`${slicer.label}: how many`} inputMode="numeric" value={last?.count ?? ""} placeholder="All" onChange={(event) => {
          const count = Number(event.target.value.replace(/\D/g, ""));
          onRange(count >= 1 ? { last: { count: Math.min(count, last?.unit === "months" || !last ? 120 : 3660), unit: last?.unit ?? "months" } } : undefined);
        }} />
        <select aria-label={`${slicer.label}: days or months`} value={last?.unit ?? "months"} onChange={(event) => onRange(last ? { last: { count: last.count, unit: event.target.value as "days" | "months" } } : undefined)}>
          <option value="days">days</option>
          <option value="months">months</option>
        </select>
      </div>
    );
  } else {
    // Tick boxes in a menu, with a search box for "search" and two levels for "hierarchy".
    const summary = ranged ? rangeText(style, range) : chosen.length + (childChosen?.length ?? 0) === 0 ? "All" : chosen.length === 1 && !childChosen?.length ? show(chosen[0]) : `${chosen.length + (childChosen?.length ?? 0)} chosen`;
    control = (
      <Menu label={slicer.label} summary={summary}>
        {hierarchy ? (
          <Hierarchy pairs={pairs.data?.pairs ?? []} chosen={chosen} childChosen={childChosen ?? []} onChange={onChange} onChildChange={onChildChange ?? (() => undefined)} />
        ) : (
          <Ticks values={list} show={show} chosen={chosen} onChange={onChange} search={style === "search"} label={slicer.label} />
        )}
        {chosen.length || childChosen?.length ? (
          <Button size="small" variant="secondary" onClick={() => { onChange([]); onChildChange?.([]); }}>
            Show all
          </Button>
        ) : null}
      </Menu>
    );
  }
  return (
    <div className={className}>
      {label}
      {control}
      {settings}
    </div>
  );
}

function tidy(range: SlicerRange): SlicerRange | undefined {
  return range.min || range.max || range.last ? range : undefined;
}

/** Number boxes for a range; typed text is kept until it's a number. */
function NumberRange({ labelId, range, onRange }: { labelId: string; range?: SlicerRange; onRange: (range: SlicerRange | undefined) => void }) {
  const [draft, setDraft] = useState<{ min?: string; max?: string }>({});
  const box = (bound: "min" | "max", text: string) => (
    <input
      aria-label={bound === "min" ? "From" : "To"}
      inputMode="decimal"
      placeholder={bound === "min" ? "Lowest" : "Highest"}
      value={draft[bound] ?? range?.[bound] ?? ""}
      aria-invalid={draft[bound] !== undefined && draft[bound] !== "" && !/^-?\d+(\.\d+)?$/.test(draft[bound]!) ? true : undefined}
      onChange={(event) => {
        const value = event.target.value.trim();
        setDraft({ ...draft, [bound]: value });
        if (value === "" || /^-?\d+(\.\d+)?$/.test(value)) onRange(tidy({ ...range, [bound]: value || undefined }));
      }}
      onBlur={() => setDraft({ ...draft, [bound]: undefined })}
      title={text}
    />
  );
  return (
    <div className={styles.range} role="group" aria-labelledby={labelId}>
      {box("min", "At least")}
      <span>to</span>
      {box("max", "At most")}
    </div>
  );
}

function Ticks({ values, show, chosen, onChange, search, label }: { values: string[]; show: (value: string) => string; chosen: string[]; onChange: (values: string[]) => void; search: boolean; label: string }) {
  const [text, setText] = useState("");
  const shown = search && text.trim() ? values.filter((value) => show(value).toLowerCase().includes(text.trim().toLowerCase())) : values;
  return (
    <>
      {search ? <input type="search" className={styles.search} aria-label={`Search ${label}`} placeholder="Search…" value={text} onChange={(event) => setText(event.target.value)} /> : null}
      {shown.map((value) => (
        <label key={value} className={ui.checkbox}>
          <input type="checkbox" checked={chosen.includes(value)} onChange={(event) => onChange(event.target.checked ? [...chosen, value] : chosen.filter((entry) => entry !== value))} /> {show(value)}
        </label>
      ))}
      {search && !shown.length ? <span className={ui.muted}>Nothing matches.</span> : null}
    </>
  );
}

/** Two levels: ticking a first-level value chooses all of it; its second-level values can be chosen one by one. */
function Hierarchy({ pairs, chosen, childChosen, onChange, onChildChange }: { pairs: Array<[string, string]>; chosen: string[]; childChosen: string[]; onChange: (values: string[]) => void; onChildChange: (values: string[]) => void }) {
  const parents = [...new Set(pairs.map(([parent]) => parent))];
  const [open, setOpen] = useState<string[]>([]);
  return (
    <>
      {parents.map((parent) => {
        const children = pairs.filter(([entry]) => entry === parent).map(([, child]) => child);
        const expanded = open.includes(parent);
        return (
          <div key={parent}>
            <span className={styles.parentRow}>
              <button type="button" className={styles.toggle} aria-expanded={expanded} aria-label={`${expanded ? "Close" : "Open"} ${parent}`} onClick={() => setOpen(expanded ? open.filter((entry) => entry !== parent) : [...open, parent])}>
                {expanded ? "−" : "+"}
              </button>
              <label className={ui.checkbox}>
                <input type="checkbox" checked={chosen.includes(parent)} onChange={(event) => onChange(event.target.checked ? [...chosen, parent] : chosen.filter((entry) => entry !== parent))} /> {parent}
              </label>
            </span>
            {expanded ? (
              <div className={styles.children}>
                {children.map((child) => (
                  <label key={child} className={ui.checkbox}>
                    <input type="checkbox" checked={childChosen.includes(child)} onChange={(event) => onChildChange(event.target.checked ? [...childChosen, child] : childChosen.filter((entry) => entry !== child))} /> {child}
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/** The menu a tick-box slicer opens; a click elsewhere or Escape closes it (#330). */
function Menu({ label, summary, children }: { label: string; summary: string; children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
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
  return (
    <details ref={menu} className={styles.slicerMenu} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{summary}</summary>
      <div className={styles.slicerList} role="group" aria-label={label}>
        {children}
      </div>
    </details>
  );
}
