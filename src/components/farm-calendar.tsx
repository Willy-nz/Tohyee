"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { api, errorMessage } from "@/lib/client/api";
import type { CalendarItem, FarmMailbox } from "@/lib/farming/calendar";
import { FARM_MAIL_KIND_LABELS, FARM_MAIL_KINDS, type FarmMailKind } from "@/lib/farming/mail-rules";
import type { Farm } from "@/lib/farming/paddocks";
import { formatDate, todayInBrowser } from "@/lib/format";
import styles from "./farm-calendar.module.css";

/**
 * The farm calendar from email (#319; FC1-FC16): Today, Week, Month and
 * Needs checking, filtered by farm and sender, from the member's own
 * connected mailboxes. Everything here is the signed-in member's own.
 */

const VIEWS = ["today", "week", "month", "check"] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABELS: Record<View, string> = { today: "Today", week: "Week", month: "Month", check: "Needs checking" };

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
const weekday = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
const mondayOf = (date: string) => addDays(date, -weekday(date));
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
function monthEnd(date: string): string {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}
const longDay = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const monthLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-NZ", { month: "long", year: "numeric", timeZone: "UTC" });

function time12(value: string | null): string {
  if (!value) return "";
  const [hour, minute] = value.split(":").map(Number);
  const suffix = hour >= 12 ? "pm" : "am";
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `${shown}${minute ? `:${String(minute).padStart(2, "0")}` : ""}${suffix}`;
}
const timeText = (item: CalendarItem) => (item.startTime ? `${time12(item.startTime)}${item.endTime ? `–${time12(item.endTime)}` : ""}` : "Any time");

function range(view: View, anchor: string): { from: string; to: string; label: string } {
  if (view === "today") return { from: anchor, to: anchor, label: longDay(anchor) };
  if (view === "week") {
    const from = mondayOf(anchor);
    const to = addDays(from, 6);
    return { from, to, label: `${formatDate(from)} – ${formatDate(to)}` };
  }
  return { from: mondayOf(monthStart(anchor)), to: addDays(mondayOf(monthEnd(anchor)), 6), label: monthLabel(anchor) };
}

function badges(item: CalendarItem) {
  if (item.state === "moved") return <Badge tone="neutral">{item.stateNote ?? "Moved"}</Badge>;
  if (item.state === "cancelled") return <Badge tone="red">Cancelled</Badge>;
  return (
    <>
      {item.needsChecking ? <Badge tone="amber">Needs checking</Badge> : item.checked ? <Badge tone="green">Checked by you</Badge> : <Badge tone="neutral">From email</Badge>}
      {item.tentative && !item.checked ? <Badge tone="blue">Tentative</Badge> : null}
      {!item.startTime && item.date ? <span>No time given</span> : null}
    </>
  );
}

type Loaded<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void };

/** One request's state (finding 1 of #323): an error with Retry, never an empty "nothing here" while loading or after a failure. */
function LoadState<T>({ result, children }: { result: Loaded<T>; children: (data: T) => ReactNode }) {
  if (result.error) {
    return (
      <Notice tone="error">
        Couldn&apos;t load the calendar: {result.error}{" "}
        <Button size="small" variant="secondary" onClick={result.reload}>Retry</Button>
      </Notice>
    );
  }
  if (!result.data) return <p className={ui.muted} role="status">Loading…</p>;
  return <>{children(result.data)}</>;
}

export function FarmCalendarHome({ organisationId }: { organisationId: string }) {
  const searchParams = useSearchParams();
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState(todayInBrowser());
  const [farmId, setFarmId] = useState("");
  const [sender, setSender] = useState("");
  const [chosen, setChosen] = useState<CalendarItem | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const farms = useApiData<{ farms: Farm[] }>("/api/farming/farms", { organisationId });
  const mailboxes = useApiData<{ mailboxes: FarmMailbox[] }>("/api/farming/mail", { organisationId });
  const shown = range(view === "check" ? "week" : view, anchor);
  const calendar = useApiData<{ items: CalendarItem[]; needsChecking: number; senders: Array<{ email: string; name: string | null }> }>("/api/farming/calendar", {
    organisationId,
    from: shown.from,
    to: shown.to,
    farmId: farmId || undefined,
    sender: sender || undefined,
  });
  const toCheck = useApiData<{ items: CalendarItem[] }>(view === "check" ? "/api/farming/calendar" : null, { organisationId, view: "check", farmId: farmId || undefined, sender: sender || undefined });
  const reload = () => {
    calendar.reload();
    toCheck.reload();
    mailboxes.reload();
  };
  const connected = searchParams.get("connected");
  const connectError = searchParams.get("error");
  const activeFarms = (farms.data?.farms ?? []).filter((farm) => farm.isActive);
  const active = view === "check" ? toCheck : calendar;
  const items = active.data?.items ?? null;
  // The selection stays while its item still exists, including while the list reloads after a change.
  const selected = chosen ? (items ? (items.find((item) => item.id === chosen.id) ?? null) : chosen) : null;
  const selectedId = selected?.id ?? null;
  const setSelectedId = (id: string | null) => setChosen(id ? (items?.find((item) => item.id === id) ?? null) : null);
  const problems = (mailboxes.data?.mailboxes ?? []).filter((mailbox) => mailbox.status === "paused" || mailbox.lastError);
  const noMailbox = mailboxes.data !== null && mailboxes.data.mailboxes.length === 0;
  const step = (direction: 1 | -1) => {
    if (view === "today") setAnchor(addDays(anchor, direction));
    else if (view === "week") setAnchor(addDays(anchor, 7 * direction));
    else {
      const [year, month] = anchor.split("-").map(Number);
      setAnchor(new Date(Date.UTC(year, month - 1 + direction, 1)).toISOString().slice(0, 10));
    }
  };
  /** Back to the item that was chosen, so keyboard and screen reader users keep their place (finding 2). */
  const close = () => {
    const id = selectedId;
    setSelectedId(null);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-item-id="${id}"]`)?.focus());
  };

  return (
    <>
      {connected ? <Notice tone="success">{connected} is connected. Its emails are read now and every 15 minutes.</Notice> : null}
      {connectError ? <Notice tone="error">{connectError}</Notice> : null}
      {problems.map((mailbox) => (
        <Notice key={mailbox.id} tone="warning">
          {mailbox.email}: {mailbox.status === "paused" ? "paused after failed checks. Connect it again under Mailbox settings." : `the last check didn't work (${mailbox.lastError}).`}
        </Notice>
      ))}
      <div className={styles.header}>
        <div className={ui.tabs} role="group" aria-label="Calendar view">
          {VIEWS.map((entry) => (
            <button key={entry} type="button" aria-pressed={entry === view} className={`${ui.tab} ${entry === view ? ui.tabActive : ""}`} onClick={() => setView(entry)}>
              {VIEW_LABELS[entry]}
              {entry === "check" && calendar.data?.needsChecking ? ` (${calendar.data.needsChecking})` : ""}
            </button>
          ))}
        </div>
        <Button variant="secondary" size="small" aria-expanded={settingsOpen} aria-controls="farm-mailbox-settings" onClick={() => setSettingsOpen(!settingsOpen)}>
          Mailbox settings
        </Button>
      </div>
      {settingsOpen || noMailbox ? (
        <div id="farm-mailbox-settings">
          <Mailboxes organisationId={organisationId} mailboxes={mailboxes.data?.mailboxes ?? null} error={mailboxes.error} farms={activeFarms} onChanged={reload} />
        </div>
      ) : null}
      <div className={styles.toolbar}>
        {view !== "check" ? (
          <div className={styles.range}>
            <Button variant="secondary" size="small" onClick={() => step(-1)} aria-label={`Earlier ${view === "month" ? "month" : view === "week" ? "week" : "day"}`}>‹</Button>
            <Button variant="secondary" size="small" onClick={() => setAnchor(todayInBrowser())}>Today</Button>
            <Button variant="secondary" size="small" onClick={() => step(1)} aria-label={`Later ${view === "month" ? "month" : view === "week" ? "week" : "day"}`}>›</Button>
            <span className={styles.rangeLabel} aria-live="polite">{shown.label}</span>
          </div>
        ) : null}
        <Field label="Farm">
          <select value={farmId} onChange={(event) => setFarmId(event.target.value)}>
            <option value="">All farms</option>
            {activeFarms.map((farm) => <option key={farm.id} value={farm.id}>{farm.name}</option>)}
            <option value="none">No farm</option>
          </select>
        </Field>
        <Field label="Sender" hint="Who the email came from, not who does the work.">
          <select value={sender} onChange={(event) => setSender(event.target.value)}>
            <option value="">Anyone</option>
            {(calendar.data?.senders ?? []).map((entry) => <option key={entry.email} value={entry.email}>{entry.name ? `${entry.name} (${entry.email})` : entry.email}</option>)}
          </select>
        </Field>
      </div>
      <p className={ui.muted}>Private to you: what&apos;s read from your email isn&apos;t shown to anyone else in the organisation.</p>
      <div className={`${styles.layout} ${selected ? styles.hasSelection : ""}`}>
        <div className={styles.schedule}>
          <LoadState result={active as Loaded<{ items: CalendarItem[] }>}>
            {(data) =>
              view === "check" ? (
                <CheckList items={data.items} selectedId={selectedId} onSelect={setSelectedId} />
              ) : view === "month" ? (
                <MonthGrid anchor={anchor} from={shown.from} to={shown.to} items={data.items} selectedId={selectedId} onSelect={setSelectedId} />
              ) : (
                <Agenda from={shown.from} to={shown.to} items={data.items} selectedId={selectedId} onSelect={setSelectedId} />
              )
            }
          </LoadState>
        </div>
        {selected ? (
          <aside className={styles.detail} aria-label="Selected item">
            <ItemPanel key={selected.id} organisationId={organisationId} item={selected} farms={activeFarms} others={(calendar.data?.items ?? []).filter((other) => other.id !== selected.id && other.state === "open")} onClose={close} onChanged={reload} />
          </aside>
        ) : null}
      </div>
    </>
  );
}

function ItemButton({ item, selected, onSelect }: { item: CalendarItem; selected: boolean; onSelect: (id: string) => void }) {
  const classes = [styles.item, styles[item.kind], selected ? styles.selected : "", item.state !== "open" ? styles.faded : "", item.state === "cancelled" ? styles.struck : ""].join(" ");
  return (
    <button type="button" className={classes} onClick={() => onSelect(item.id)} aria-pressed={selected} data-item-id={item.id}>
      <span className={styles.time}>{timeText(item)}</span>
      <span className={styles.title}>{item.title}</span>
      <span className={styles.meta}>
        <span>{FARM_MAIL_KIND_LABELS[item.kind]}</span>
        {item.farmName ? <span>{item.farmName}</span> : null}
        <span>Sender: {item.senderName ?? item.senderEmail}</span>
        {badges(item)}
      </span>
    </button>
  );
}

function Agenda({ from, to, items, selectedId, onSelect }: { from: string; to: string; items: CalendarItem[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const today = todayInBrowser();
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  if (items.length === 0) return <Empty>Nothing on the calendar for these days.</Empty>;
  return (
    <div>
      {days.map((day) => {
        const dayItems = items.filter((item) => item.date === day);
        if (dayItems.length === 0 && from !== to) return null;
        return (
          <section key={day} className={styles.day} aria-label={longDay(day)}>
            <h3 className={`${styles.dayHeading} ${day === today ? styles.today : ""}`}>{longDay(day)}{day === today ? " (today)" : ""}</h3>
            {dayItems.length ? (
              <ul className={styles.items}>
                {dayItems.map((item) => <li key={item.id}><ItemButton item={item} selected={item.id === selectedId} onSelect={onSelect} /></li>)}
              </ul>
            ) : <p className={ui.muted}>Nothing on.</p>}
          </section>
        );
      })}
    </div>
  );
}

/** The month as a plain table: rows of weeks, a header row of weekdays (finding 2: native semantics rather than a half-built grid). */
function MonthGrid({ anchor, from, to, items, selectedId, onSelect }: { anchor: string; from: string; to: string; items: CalendarItem[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const weeks: string[][] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (weekday(day) === 0) weeks.push([]);
    weeks[weeks.length - 1].push(day);
  }
  const month = anchor.slice(0, 7);
  const today = todayInBrowser();
  return (
    <>
      <table className={styles.month}>
        <caption className={styles.visuallyHidden}>{monthLabel(anchor)}</caption>
        <thead>
          <tr>{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((name) => <th key={name} scope="col" className={styles.weekday}><abbr title={name}>{name.slice(0, 3)}</abbr></th>)}</tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((day) => {
                const dayItems = items.filter((item) => item.date === day);
                return (
                  <td key={day} className={`${styles.cell} ${day.slice(0, 7) !== month ? styles.otherMonth : ""} ${day === today ? styles.todayCell : ""}`}>
                    <div className={styles.cellDate}>
                      <span aria-hidden="true">{Number(day.slice(8))}</span>
                      <span className={styles.visuallyHidden}>{longDay(day)}{day === today ? ", today" : ""}{dayItems.length ? `, ${dayItems.length} item${dayItems.length === 1 ? "" : "s"}` : ""}</span>
                    </div>
                    {dayItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        data-item-id={item.id}
                        aria-pressed={item.id === selectedId}
                        className={`${styles.chip} ${styles[item.kind]} ${item.state !== "open" ? styles.faded : ""} ${item.id === selectedId ? styles.selected : ""}`}
                        onClick={() => onSelect(item.id)}
                        title={`${item.title} (${timeText(item)})`}
                      >
                        {item.startTime ? `${time12(item.startTime)} ` : ""}{item.title}
                      </button>
                    ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.monthList}>
        <Agenda from={monthStart(anchor)} to={monthEnd(anchor)} items={items.filter((item) => item.date?.startsWith(month))} selectedId={selectedId} onSelect={onSelect} />
      </div>
    </>
  );
}

function CheckList({ items, selectedId, onSelect }: { items: CalendarItem[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (items.length === 0) return <Empty>Nothing to check. Items with no exact date, or something unclear, show here.</Empty>;
  return (
    <ul className={styles.items}>
      {items.map((item) => (
        <li key={item.id}>
          <ItemButton item={item} selected={item.id === selectedId} onSelect={onSelect} />
          <ul className={styles.reasons}>{item.checkReasons.length ? item.checkReasons.map((reason) => <li key={reason}>{reason}</li>) : <li>No exact date</li>}</ul>
        </li>
      ))}
    </ul>
  );
}

function ItemPanel({ organisationId, item, farms, others, onClose, onChanged }: { organisationId: string; item: CalendarItem; farms: Farm[]; others: CalendarItem[]; onClose: () => void; onChanged: () => void }) {
  const [date, setDate] = useState(item.date ?? "");
  const [startTime, setStartTime] = useState(item.startTime ?? "");
  const [endTime, setEndTime] = useState(item.endTime ?? "");
  const [kind, setKind] = useState<FarmMailKind>(item.kind);
  const [title, setTitle] = useState(item.title);
  const [farmId, setFarmId] = useState(item.farmId ?? "");
  const [replacesId, setReplacesId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = item.state === "open";
  const panel = useRef<HTMLDivElement>(null);
  // Focus moves to the details when an item is chosen (finding 2); on a phone they replace the schedule.
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/farming/calendar/${item.id}`, { method: "PATCH", body: { organisationId, ...body } });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    void patch({ date, startTime, endTime, kind, title, farmId: farmId || null });
  };
  return (
    <div ref={panel} tabIndex={-1} className={styles.panelFocus} aria-label={`${item.title}, details`}>
    <Button variant="secondary" size="small" className={styles.back} onClick={onClose}>‹ Back to the calendar</Button>
    <Card
      title={item.title}
      description={`${FARM_MAIL_KIND_LABELS[item.kind]}${item.date ? `, ${longDay(item.date)}` : ", no date yet"}${item.startTime ? `, ${timeText(item)}` : ""}`}
      actions={<Button variant="secondary" size="small" onClick={onClose}>Close</Button>}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p>
        From {item.senderName ? `${item.senderName} (${item.senderEmail})` : item.senderEmail}, {formatDate(item.sentAt.slice(0, 10))}
        {item.subject ? `: "${item.subject}"` : ""}
        {item.webLink ? <> · <a href={item.webLink} target="_blank" rel="noreferrer noopener">Open the email</a></> : null}
      </p>
      <blockquote className={styles.excerpt}>{item.excerpt}</blockquote>
      {item.checkReasons.length && item.needsChecking ? <ul className={styles.reasons}>{item.checkReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
      {item.alsoSeen ? <p className={ui.muted}>Also in {item.alsoSeen} later email{item.alsoSeen === 1 ? "" : "s"}.</p> : null}
      {editable ? (
        <form onSubmit={save}>
          <div className={ui.grid2}>
            <Field label="Date"><DateInput value={date} onChange={(event) => setDate(event.target.value)} /></Field>
            <Field label="Start"><input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} /></Field>
            <Field label="End"><input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} /></Field>
            <Field label="Kind">
              <select value={kind} onChange={(event) => setKind(event.target.value as FarmMailKind)}>
                {FARM_MAIL_KINDS.map((entry) => <option key={entry} value={entry}>{FARM_MAIL_KIND_LABELS[entry]}</option>)}
              </select>
            </Field>
            <Field label="What"><input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} /></Field>
            <Field label="Farm">
              <select value={farmId} onChange={(event) => setFarmId(event.target.value)}>
                <option value="">No farm</option>
                {farms.map((farm) => <option key={farm.id} value={farm.id}>{farm.name}</option>)}
              </select>
            </Field>
          </div>
          <div className={ui.actions}>
            <Button type="submit" disabled={busy}>{item.checked ? "Save" : "Save as checked"}</Button>
            <Button variant="secondary" disabled={busy} onClick={() => void patch({ action: "dismiss" })}>Not a farm arrangement</Button>
          </div>
          {others.length ? (
            <div className={ui.inlineForm}>
              <Field label="This replaces" hint="The earlier item is shown as moved.">
                <select value={replacesId} onChange={(event) => setReplacesId(event.target.value)}>
                  <option value="">Choose an item…</option>
                  {others.map((other) => <option key={other.id} value={other.id}>{other.title}{other.date ? `, ${formatDate(other.date)}` : ""}</option>)}
                </select>
              </Field>
              <Button variant="secondary" disabled={busy || !replacesId} onClick={() => void patch({ action: "replace", replacesId })}>Replace it</Button>
            </div>
          ) : null}
        </form>
      ) : (
        <p className={ui.muted}>{item.state === "dismissed" ? "Hidden: not a farm arrangement." : `${item.stateNote ?? "Changed"}. It can't be edited now.`}</p>
      )}
    </Card>
    </div>
  );
}

function Mailboxes({ organisationId, mailboxes, error, farms, onChanged }: { organisationId: string; mailboxes: FarmMailbox[] | null; error: string | null; farms: Farm[]; onChanged: () => void }) {
  const confirm = useConfirm();
  const [provider, setProvider] = useState<"google" | "microsoft">("google");
  const [historyDays, setHistoryDays] = useState("90");
  const [defaultFarmId, setDefaultFarmId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const act = async (work: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      if (success) setMessage({ tone: "success", text: success });
      onChanged();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  };
  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const { url } = await api<{ url: string }>("/api/farming/mail", { method: "POST", body: { organisationId, provider, historyDays: Number(historyDays), defaultFarmId: defaultFarmId || null } });
      window.location.assign(url);
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
      setBusy(false);
    }
  };
  return (
    <Card
      title="Your mailboxes"
      description="Connect your own Gmail or Microsoft mailbox. Tohyee only reads it (nothing is sent, changed or deleted) and keeps only each arrangement's sentence, subject, sender and a link. Your mailboxes and this calendar are only yours: nobody else in the organisation sees them, admins included."
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {mailboxes && mailboxes.length ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead><tr><th>Mailbox</th><th>Last checked</th><th>Items</th><th>Farm when none is named</th><th>Actions</th></tr></thead>
            <tbody>
              {mailboxes.map((mailbox) => (
                <tr key={mailbox.id}>
                  <td data-label="Mailbox">
                    {mailbox.email}
                    <br /><small>{mailbox.provider === "google" ? "Gmail" : "Microsoft"}, from {mailbox.historyDays} days back{mailbox.readingHistory ? "; still reading older emails" : ""}</small>
                    {mailbox.status === "paused" ? <><br /><Badge tone="red">Paused</Badge> <small>Connect it again to carry on.</small></> : null}
                  </td>
                  <td data-label="Last checked">{mailbox.lastCheckAt ? new Date(mailbox.lastCheckAt).toLocaleString("en-NZ") : "Not yet"}{mailbox.lastError ? <><br /><small>{mailbox.lastError}</small></> : null}</td>
                  <td data-label="Items" className={ui.num}>{mailbox.items}</td>
                  <td data-label="Farm when none is named">
                    <select value={mailbox.defaultFarmId ?? ""} disabled={busy} onChange={(event) => void act(() => api(`/api/farming/mail/${mailbox.id}`, { method: "PATCH", body: { organisationId, defaultFarmId: event.target.value || null } }))}>
                      <option value="">No farm</option>
                      {farms.map((farm) => <option key={farm.id} value={farm.id}>{farm.name}</option>)}
                    </select>
                  </td>
                  <td data-label="Actions">
                    <div className={ui.rowButtons}>
                      <Button size="small" variant="secondary" disabled={busy || mailbox.status === "paused"} onClick={() => void act(() => api(`/api/farming/mail/${mailbox.id}/check`, { method: "POST", body: { organisationId } }), "Checked.")}>Check now</Button>
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={busy}
                        onClick={async () => {
                          if (!(await confirm(`Disconnect ${mailbox.email}? Everything Tohyee read from it is deleted. The mailbox itself isn't touched.`, { confirmLabel: "Disconnect", danger: true }))) return;
                          void act(() => api(`/api/farming/mail/${mailbox.id}?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" }), "Disconnected.");
                        }}
                      >
                        Disconnect
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : mailboxes ? <p className={ui.muted}>No mailbox connected yet.</p> : null}
      <form className={ui.inlineForm} onSubmit={connect}>
        <Field label="Connect">
          <select value={provider} onChange={(event) => setProvider(event.target.value as "google" | "microsoft")}>
            <option value="google">Gmail</option>
            <option value="microsoft">Microsoft 365 or Outlook</option>
          </select>
        </Field>
        <Field label="Read back (days)" hint="30 to 365">
          <input inputMode="numeric" value={historyDays} onChange={(event) => setHistoryDays(event.target.value)} />
        </Field>
        {farms.length > 1 ? (
          <Field label="Farm when none is named">
            <select value={defaultFarmId} onChange={(event) => setDefaultFarmId(event.target.value)}>
              <option value="">No farm</option>
              {farms.map((farm) => <option key={farm.id} value={farm.id}>{farm.name}</option>)}
            </select>
          </Field>
        ) : null}
        <Button type="submit" disabled={busy}>Connect</Button>
      </form>
      <p className={ui.muted}>
        It uses the Google or Microsoft app an admin set up under <Link href="/operations/settings/email">Settings › Email</Link>, which needs this server&apos;s address followed by <code>/api/farming/mail/callback</code> added to the app&apos;s sign-in (redirect) addresses.
        Attachments, sharing with the team, repeating arrangements and adding to Google or Outlook calendars aren&apos;t done yet.
      </p>
    </Card>
  );
}
