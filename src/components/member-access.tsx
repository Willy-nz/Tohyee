"use client";

import { useState } from "react";
import { DateInput } from "@/components/date-input";
import { InfoTip } from "@/components/info-tip";
import { Badge, Button, Field, ui } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { type AccessState, formatClock, type LocalMoment } from "@/lib/organisations/access-window";

/*
 * Time-limited access on People and roles (decisions 1466-1474): the dates
 * fields, used when inviting and when changing a member's dates, and the
 * short label each person's row shows.
 */

export type AccessFormValue = { from: string; fromTime: string; until: string; untilTime: string };

export const NO_ACCESS_LIMIT: AccessFormValue = { from: "", fromTime: "", until: "", untilTime: "" };

export function accessFormFrom(from: LocalMoment | null, until: LocalMoment | null): AccessFormValue {
  return { from: from?.date ?? "", fromTime: from?.time ?? "", until: until?.date ?? "", untilTime: until?.time ?? "" };
}

/** The body the API takes (decision 1466). */
export function accessBody(value: AccessFormValue) {
  return {
    accessFrom: value.from || null,
    accessFromTime: value.from && value.fromTime ? value.fromTime : null,
    accessUntil: value.until || null,
    accessUntilTime: value.until && value.untilTime ? value.untilTime : null,
  };
}

export function AccessDateFields({ value, onChange, idPrefix }: { value: AccessFormValue; onChange: (value: AccessFormValue) => void; idPrefix: string }) {
  const set = (patch: Partial<AccessFormValue>) => onChange({ ...value, ...patch });
  return (
    <div className={ui.inlineForm}>
      <Field label="Access from" hint="Empty: from now.">
        <DateInput id={`${idPrefix}-from`} value={value.from} onChange={(event) => set({ from: event.target.value })} />
      </Field>
      <Field label="Start time (optional)">
        <input id={`${idPrefix}-from-time`} type="time" value={value.fromTime} disabled={!value.from} onChange={(event) => set({ fromTime: event.target.value })} />
      </Field>
      <Field label="Access until" hint="Empty: no end. Without a time, it lasts to the end of that day.">
        <DateInput id={`${idPrefix}-until`} value={value.until} onChange={(event) => set({ until: event.target.value })} />
      </Field>
      <Field label="End time (optional)">
        <input id={`${idPrefix}-until-time`} type="time" value={value.untilTime} disabled={!value.until} onChange={(event) => set({ untilTime: event.target.value })} />
      </Field>
    </div>
  );
}

/** The (i) help about access dates. */
export function AccessHelp() {
  return (
    <InfoTip label="About access dates">
      Use dates for someone you hire for a set time, such as a bookkeeper for a month. Before the start and after the end,
      Tohyee refuses everything they try: pages, AI keys, AI apps and farm app keys. Times are New Zealand time. They and
      the owners and admins are reminded 3 days before the end. Nothing they did is removed when it ends.
    </InfoTip>
  );
}

function shortDate(moment: LocalMoment): string {
  const full = formatDate(moment.date);
  // "12 Dec 2026" -> "12 Dec" this year, so the list stays short.
  const thisYear = String(new Date().getFullYear());
  const text = full.endsWith(` ${thisYear}`) ? full.slice(0, -5) : full;
  return moment.time ? `${text}, ${formatClock(moment.time)}` : text;
}

/** What a row shows: "Access until 12 Dec", "Ended 12 Dec", "Starts 1 Dec" or nothing. */
export function AccessLabel({ state, from, until }: { state: AccessState; from: LocalMoment | null; until: LocalMoment | null }) {
  if (state === "not_started" && from) return <Badge tone="blue">Starts {shortDate(from)}</Badge>;
  if (state === "ended" && until) return <Badge tone="neutral">Ended {shortDate(until)}</Badge>;
  if (state === "ending" && until) return <Badge tone="amber">Access until {shortDate(until)}</Badge>;
  if (state === "current" && until) return <span>Access until {shortDate(until)}</span>;
  return <span className={ui.muted}>No end date</span>;
}

/** A filter on the members list (decision 1472). */
export type AccessFilter = "all" | "ending" | "limited" | "ended";

export function matchesAccessFilter(state: AccessState, filter: AccessFilter): boolean {
  if (filter === "all") return true;
  if (filter === "ending") return state === "ending";
  if (filter === "ended") return state === "ended";
  return state !== "open";
}

export function useAccessForm(initial: AccessFormValue = NO_ACCESS_LIMIT) {
  return useState<AccessFormValue>(initial);
}

export function AccessQuickActions({
  name,
  state,
  disabled,
  onAction,
  onChooseDates,
}: {
  name: string;
  state: AccessState;
  disabled: boolean;
  onAction: (action: "extend_week" | "extend_month" | "end_now") => void;
  onChooseDates: () => void;
}) {
  const limited = state !== "open";
  return (
    <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
      {limited ? (
        <>
          <Button variant="secondary" size="small" disabled={disabled} aria-label={`Extend ${name}'s access by a week`} onClick={() => onAction("extend_week")}>
            +1 week
          </Button>
          <Button variant="secondary" size="small" disabled={disabled} aria-label={`Extend ${name}'s access by a month`} onClick={() => onAction("extend_month")}>
            +1 month
          </Button>
        </>
      ) : null}
      <Button variant="secondary" size="small" disabled={disabled} aria-label={`Choose access dates for ${name}`} onClick={onChooseDates}>
        {limited ? "Dates" : "Set dates"}
      </Button>
      {state !== "ended" ? (
        <Button variant="secondary" size="small" disabled={disabled} aria-label={`End ${name}'s access now`} onClick={() => onAction("end_now")}>
          End now
        </Button>
      ) : null}
    </span>
  );
}
