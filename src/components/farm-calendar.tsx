"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { api, errorMessage } from "@/lib/client/api";
import type { CalendarLinkStatus, FarmMailbox } from "@/lib/farming/calendar";
import type { MailFolder } from "@/lib/farming/mail-providers";
import { CALENDAR_KIND_LABELS, CALENDAR_KINDS, type CalendarItem, type CalendarKind, folderSummary, REPEAT_LABELS, REPEATS, type Repeat, teamView } from "@/lib/farming/calendar-shared";
import type { Farm } from "@/lib/farming/paddocks";
import { formatDate, todayInBrowser } from "@/lib/format";
import styles from "./farm-calendar.module.css";

/**
 * The farm calendar from email (#319; FC1-FC16): Today, Week, Month and
 * Needs checking, filtered by farm and sender, from the member's own
 * connected mailboxes; with items people add, repeats, items shared with
 * the farm team and a calendar link (FC17-FC23). Everything is the
 * signed-in member's own, except what others chose to share.
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

const repeatText = (item: CalendarItem) => (item.repeat ? `Repeats ${REPEAT_LABELS[item.repeat]}${item.repeatUntil ? ` until ${formatDate(item.repeatUntil)}` : ""}` : null);

function badges(item: CalendarItem) {
  if (item.state === "moved") return <Badge tone="neutral">{item.stateNote ?? "Moved"}</Badge>;
  if (item.state === "cancelled") return <Badge tone="red">Cancelled</Badge>;
  if (!item.mine) return <Badge tone="blue">Shared by {item.sharedByName}</Badge>;
  return (
    <>
      {item.needsChecking ? (
        <Badge tone="amber">Needs checking</Badge>
      ) : item.source === "own" ? (
        <Badge tone="neutral">Added by you</Badge>
      ) : item.checked ? (
        <Badge tone="green">Checked by you</Badge>
      ) : (
        <Badge tone="neutral">From email</Badge>
      )}
      {item.shared ? <Badge tone="blue">Shared with the team</Badge> : null}
      {item.tentative && !item.checked ? <Badge tone="blue">Tentative</Badge> : null}
      {item.repeat ? <span>{repeatText(item)}</span> : null}
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
  const [open, setOpen] = useState<"mailboxes" | "add" | "link" | null>(null);
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
  const selected = chosen ? (items ? (items.find((item) => item.key === chosen.key) ?? items.find((item) => item.id === chosen.id) ?? null) : chosen) : null;
  const selectedId = selected?.key ?? null;
  const setSelectedId = (key: string | null) => setChosen(key ? (items?.find((item) => item.key === key) ?? null) : null);
  const problems = (mailboxes.data?.mailboxes ?? []).filter((mailbox) => mailbox.status === "paused" || mailbox.lastError);
  // FC25, FC30: a mailbox with no folders chosen isn't read.
  const noFolders = (mailboxes.data?.mailboxes ?? []).filter((mailbox) => mailbox.folders.length === 0);
  const [picking, setPicking] = useState<string | null>(searchParams.get("folders"));
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
      {connected ? <Notice tone="success">{connected} is connected. Choose the folders Tohyee reads: nothing is read until you do. Then they&apos;re read now and every 15 minutes.</Notice> : null}
      {noFolders.map((mailbox) => (
        <Notice key={`folders-${mailbox.id}`} tone="warning">
          {mailbox.email}: Tohyee isn&apos;t reading this mailbox until you choose which folders to read.
          {mailbox.items ? " What it read before stays until you choose; then anything not in those folders is removed at the next check." : ""}{" "}
          <Button size="small" variant="secondary" onClick={() => { setOpen("mailboxes"); setPicking(mailbox.id); }}>Choose folders</Button>
        </Notice>
      ))}
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
        <div className={ui.rowButtons}>
          <Button size="small" aria-expanded={open === "add"} aria-controls="farm-calendar-add" onClick={() => setOpen(open === "add" ? null : "add")}>
            Add an item
          </Button>
          <Button variant="secondary" size="small" aria-expanded={open === "link"} aria-controls="farm-calendar-link" onClick={() => setOpen(open === "link" ? null : "link")}>
            Calendar link
          </Button>
          <Button variant="secondary" size="small" aria-expanded={open === "mailboxes"} aria-controls="farm-mailbox-settings" onClick={() => setOpen(open === "mailboxes" ? null : "mailboxes")}>
            Manage mailboxes
          </Button>
        </div>
      </div>
      {open === "add" ? (
        <div id="farm-calendar-add">
          <AddItem
            organisationId={organisationId}
            farms={activeFarms}
            date={view === "today" ? anchor : todayInBrowser()}
            onClose={() => setOpen(null)}
            onAdded={(item) => {
              setOpen(null);
              if (item.date) setAnchor(item.date);
              if (view === "check") setView("week");
              setChosen(item);
              reload();
            }}
          />
        </div>
      ) : null}
      {open === "link" ? (
        <div id="farm-calendar-link">
          <CalendarLink organisationId={organisationId} onClose={() => setOpen(null)} />
        </div>
      ) : null}
      {noMailbox && open !== "mailboxes" ? (
        <div className={styles.connectPrompt}>
          <p>Connect your email to bring arrangements like stock agent bookings into your calendar. It stays private to you.</p>
          <Button size="small" variant="secondary" aria-controls="farm-mailbox-settings" aria-expanded={false} onClick={() => setOpen("mailboxes")}>
            Connect a mailbox
          </Button>
        </div>
      ) : null}
      {open === "mailboxes" || (picking && open === null) ? (
        <div id="farm-mailbox-settings">
          <Mailboxes organisationId={organisationId} mailboxes={mailboxes.data?.mailboxes ?? null} error={mailboxes.error} farms={activeFarms} onChanged={reload} picking={picking} onPick={setPicking} />
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
        <Field label="Email sender" hint="Who the email came from, not who does the work.">
          <select value={sender} onChange={(event) => setSender(event.target.value)}>
            <option value="">Anyone</option>
            {(calendar.data?.senders ?? []).map((entry) => <option key={entry.email} value={entry.email}>{entry.name ? `${entry.name} (${entry.email})` : entry.email}</option>)}
          </select>
        </Field>
      </div>
      <p className={ui.muted}>Private to you: nobody else in the organisation sees what&apos;s read from your email or what you add, unless you share an item with the farm team.</p>
      <div className={`${styles.layout} ${selected ? styles.hasSelection : ""}`}>
        <div className={styles.schedule}>
          <LoadState result={active as Loaded<{ items: CalendarItem[] }>}>
            {(data) =>
              view === "check" ? (
                <CheckList items={data.items} selectedId={selectedId} onSelect={setSelectedId} />
              ) : view === "month" ? (
                <MonthGrid anchor={anchor} from={shown.from} to={shown.to} items={data.items} selectedId={selectedId} onSelect={setSelectedId} />
              ) : (
                <Agenda from={shown.from} to={shown.to} items={data.items} selectedId={selectedId} onSelect={setSelectedId} onAdd={() => setOpen("add")} />
              )
            }
          </LoadState>
        </div>
        {selected ? (
          <aside className={styles.detail} aria-label="Selected item">
            <ItemPanel
              key={selected.key}
              organisationId={organisationId}
              item={selected}
              farms={activeFarms}
              others={(calendar.data?.items ?? []).filter((other, index, all) => other.mine && other.id !== selected.id && other.state === "open" && all.findIndex((entry) => entry.id === other.id) === index)}
              onClose={close}
              onChanged={reload}
              onDeleted={() => {
                setChosen(null);
                reload();
              }}
            />
          </aside>
        ) : null}
      </div>
    </>
  );
}

function ItemButton({ item, selected, onSelect }: { item: CalendarItem; selected: boolean; onSelect: (id: string) => void }) {
  const classes = [styles.item, styles[item.kind], selected ? styles.selected : "", item.state !== "open" ? styles.faded : "", item.state === "cancelled" ? styles.struck : ""].join(" ");
  return (
    <button type="button" className={classes} onClick={() => onSelect(item.key)} aria-pressed={selected} data-item-id={item.key}>
      <span className={styles.time}>{timeText(item)}</span>
      <span className={styles.title}>{item.title}</span>
      <span className={styles.meta}>
        <span>{CALENDAR_KIND_LABELS[item.kind]}</span>
        {item.farmName ? <span>{item.farmName}</span> : null}
        {item.senderEmail ? <span>Sender: {item.senderName ?? item.senderEmail}</span> : null}
        {badges(item)}
      </span>
    </button>
  );
}

function Agenda({ from, to, items, selectedId, onSelect, onAdd }: { from: string; to: string; items: CalendarItem[]; selectedId: string | null; onSelect: (id: string) => void; onAdd?: () => void }) {
  const today = todayInBrowser();
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  if (items.length === 0) {
    return (
      <Empty>
        <p>Nothing on the calendar for these days.</p>
        {onAdd ? (
          <Button size="small" variant="secondary" onClick={onAdd}>
            Add an item
          </Button>
        ) : null}
      </Empty>
    );
  }
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
                {dayItems.map((item) => <li key={item.key}><ItemButton item={item} selected={item.key === selectedId} onSelect={onSelect} /></li>)}
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
                        key={item.key}
                        type="button"
                        data-item-id={item.key}
                        aria-pressed={item.key === selectedId}
                        className={`${styles.chip} ${styles[item.kind]} ${item.state !== "open" ? styles.faded : ""} ${item.key === selectedId ? styles.selected : ""}`}
                        onClick={() => onSelect(item.key)}
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
        <li key={item.key}>
          <ItemButton item={item} selected={item.key === selectedId} onSelect={onSelect} />
          <ul className={styles.reasons}>{item.checkReasons.length ? item.checkReasons.map((reason) => <li key={reason}>{reason}</li>) : <li>No exact date</li>}</ul>
        </li>
      ))}
    </ul>
  );
}

type ItemFields = { date: string; startTime: string; endTime: string; kind: CalendarKind; title: string; farmId: string; notes: string; repeat: Repeat | ""; repeatUntil: string };

/** The fields people fill in for an item (FC14, FC17, FC18). */
function ItemFieldset({ value, onChange, farms }: { value: ItemFields; onChange: (next: ItemFields) => void; farms: Farm[] }) {
  const set = <K extends keyof ItemFields>(key: K, next: ItemFields[K]) => onChange({ ...value, [key]: next });
  return (
    <>
      <div className={ui.grid2}>
        <Field label="What"><input value={value.title} maxLength={200} required onChange={(event) => set("title", event.target.value)} /></Field>
        <Field label={value.repeat ? "First date" : "Date"}><DateInput value={value.date} onChange={(event) => set("date", event.target.value)} /></Field>
        <Field label="Start" hint="Optional"><input type="time" value={value.startTime} onChange={(event) => set("startTime", event.target.value)} /></Field>
        <Field label="End" hint="Optional"><input type="time" value={value.endTime} onChange={(event) => set("endTime", event.target.value)} /></Field>
        <Field label="Kind">
          <select value={value.kind} onChange={(event) => set("kind", event.target.value as CalendarKind)}>
            {CALENDAR_KINDS.map((entry) => <option key={entry} value={entry}>{CALENDAR_KIND_LABELS[entry]}</option>)}
          </select>
        </Field>
        <Field label="Farm">
          <select value={value.farmId} onChange={(event) => set("farmId", event.target.value)}>
            <option value="">No farm</option>
            {farms.map((farm) => <option key={farm.id} value={farm.id}>{farm.name}</option>)}
          </select>
        </Field>
        <Field label="Repeats">
          <select value={value.repeat} onChange={(event) => set("repeat", event.target.value as Repeat | "")}>
            <option value="">Doesn&apos;t repeat</option>
            {REPEATS.map((entry) => <option key={entry} value={entry}>{REPEAT_LABELS[entry][0].toUpperCase() + REPEAT_LABELS[entry].slice(1)}</option>)}
          </select>
        </Field>
        {value.repeat ? (
          <Field label="Until" hint={value.repeat === "monthly" ? "Optional. In shorter months it's the last day." : "Optional"}>
            <DateInput value={value.repeatUntil} onChange={(event) => set("repeatUntil", event.target.value)} />
          </Field>
        ) : null}
      </div>
      <Field label="Notes" hint="Only you see these. They're never shared or put in the calendar link.">
        <textarea rows={2} maxLength={2000} value={value.notes} onChange={(event) => set("notes", event.target.value)} />
      </Field>
    </>
  );
}

const fieldsBody = (value: ItemFields) => ({
  date: value.date,
  startTime: value.startTime,
  endTime: value.endTime,
  kind: value.kind,
  title: value.title,
  farmId: value.farmId || null,
  notes: value.notes,
  repeat: value.repeat || null,
  repeatUntil: value.repeat ? value.repeatUntil : null,
});

/** FC20: exactly what the farm team will see, before it's shared. */
function TeamCard({ item }: { item: CalendarItem }) {
  return (
    <div className={styles.preview}>
      <strong>{item.title}</strong>
      <span>{CALENDAR_KIND_LABELS[item.kind]}{item.date ? `, ${longDay(item.date)}` : ""}, {timeText(item)}</span>
      {item.farmName ? <span>{item.farmName}</span> : null}
      {item.repeat ? <span>{repeatText(item)}</span> : null}
      {item.tentative && !item.checked ? <span>Tentative</span> : null}
      <span>{item.sharedByName ? `Shared by ${item.sharedByName}` : "Shared by you (they see your name)"}</span>
    </div>
  );
}

function ItemPanel({
  organisationId,
  item,
  farms,
  others,
  onClose,
  onChanged,
  onDeleted,
}: {
  organisationId: string;
  item: CalendarItem;
  farms: Farm[];
  others: CalendarItem[];
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const confirm = useConfirm();
  const [fields, setFields] = useState<ItemFields>({
    date: item.repeatFrom ?? item.date ?? "",
    startTime: item.startTime ?? "",
    endTime: item.endTime ?? "",
    kind: item.kind,
    title: item.title,
    farmId: item.farmId ?? "",
    notes: item.notes ?? "",
    repeat: item.repeat ?? "",
    repeatUntil: item.repeatUntil ?? "",
  });
  const [replacesId, setReplacesId] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = item.mine && item.state === "open";
  const panel = useRef<HTMLDivElement>(null);
  // Focus moves to the details when an item is chosen (finding 2); on a phone they replace the schedule.
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const send = async (work: () => Promise<unknown>, after: () => void = onChanged) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      after();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const patch = (body: Record<string, unknown>) => send(() => api(`/api/farming/calendar/${item.id}`, { method: "PATCH", body: { organisationId, ...body } }));
  const save = (event: FormEvent) => {
    event.preventDefault();
    void patch(fieldsBody(fields));
  };
  const remove = async () => {
    if (!(await confirm(`Delete "${item.title}"${item.repeat ? " and all its dates" : ""}?`, { confirmLabel: "Delete", danger: true }))) return;
    void send(() => api(`/api/farming/calendar/${item.id}?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" }), onDeleted);
  };
  const description = `${CALENDAR_KIND_LABELS[item.kind]}${item.date ? `, ${longDay(item.date)}` : ", no date yet"}${item.startTime ? `, ${timeText(item)}` : ""}`;
  return (
    <div ref={panel} tabIndex={-1} className={styles.panelFocus} aria-label={`${item.title}, details`}>
      <Button variant="secondary" size="small" className={styles.back} onClick={onClose}>‹ Back to the calendar</Button>
      <Card title={item.title} description={description} actions={<Button variant="secondary" size="small" onClick={onClose}>Close</Button>}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {!item.mine ? (
          <>
            <p>
              Shared with the farm team by {item.sharedByName}.{item.farmName ? ` ${item.farmName}.` : ""} {item.repeat ? `${repeatText(item)}.` : ""}
            </p>
            <p className={ui.muted}>Only {item.sharedByName} can change it.</p>
          </>
        ) : null}
        {item.mine && item.source === "email" ? (
          <>
            <p>
              From {item.senderName ? `${item.senderName} (${item.senderEmail})` : item.senderEmail}
              {item.sentAt ? `, ${formatDate(item.sentAt.slice(0, 10))}` : ""}
              {item.subject ? `: "${item.subject}"` : ""}
              {item.webLink ? <> · <a href={item.webLink} target="_blank" rel="noreferrer noopener">Open the email</a></> : null}
            </p>
            <blockquote className={styles.excerpt}>{item.excerpt}</blockquote>
          </>
        ) : null}
        {item.mine && item.source === "own" ? <p className={ui.muted}>Added by you.</p> : null}
        {item.checkReasons.length && item.needsChecking ? <ul className={styles.reasons}>{item.checkReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
        {item.alsoSeen ? <p className={ui.muted}>Also in {item.alsoSeen} later email{item.alsoSeen === 1 ? "" : "s"}.</p> : null}
        {editable ? (
          <form onSubmit={save}>
            {item.repeat ? <p className={ui.muted}>Changes here apply to every date it repeats on.</p> : null}
            <ItemFieldset value={fields} onChange={setFields} farms={farms} />
            <div className={ui.actions}>
              <Button type="submit" disabled={busy}>{item.checked ? "Save" : "Save as checked"}</Button>
              {item.repeat && item.date ? (
                <Button variant="secondary" disabled={busy} onClick={() => void patch({ action: "skip", date: item.date })}>
                  Skip {formatDate(item.date)} only
                </Button>
              ) : null}
              {item.source === "email" ? (
                <Button variant="secondary" disabled={busy} onClick={() => void patch({ action: "dismiss" })}>Not a farm arrangement</Button>
              ) : (
                <Button variant="secondary" disabled={busy} onClick={() => void remove()}>Delete</Button>
              )}
            </div>
            <div className={styles.share}>
              {item.shared ? (
                <>
                  <p><strong>Shared with the farm team.</strong> Everyone in the organisation sees what&apos;s below, and your changes straight away.</p>
                  <TeamCard item={teamView(item, item.sharedByName)} />
                  <Button variant="secondary" size="small" disabled={busy} onClick={() => void patch({ action: "unshare" })}>Stop sharing</Button>
                </>
              ) : previewing ? (
                <>
                  <p><strong>Everyone in the organisation will see this, and nothing more:</strong></p>
                  <TeamCard item={teamView({ ...item, checked: true }, null)} />
                  <p className={ui.muted}>Not the sender, subject, the email, its link or your notes. Sharing marks it checked, so a later email won&apos;t change it.</p>
                  <div className={ui.rowButtons}>
                    <Button
                      size="small"
                      disabled={busy || !item.date}
                      onClick={() =>
                        void send(
                          () => api(`/api/farming/calendar/${item.id}`, { method: "PATCH", body: { organisationId, action: "share" } }),
                          () => {
                            setPreviewing(false);
                            onChanged();
                          },
                        )
                      }
                    >
                      Share
                    </Button>
                    <Button size="small" variant="secondary" onClick={() => setPreviewing(false)}>Cancel</Button>
                  </div>
                </>
              ) : (
                <Button variant="secondary" size="small" disabled={busy || !item.date} onClick={() => setPreviewing(true)}>Share with the farm team…</Button>
              )}
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
        ) : item.mine ? (
          <p className={ui.muted}>{item.state === "dismissed" ? "Hidden: not a farm arrangement." : `${item.stateNote ?? "Changed"}. It can't be edited now.`}</p>
        ) : null}
      </Card>
    </div>
  );
}

/** FC17: an item the member adds. */
function AddItem({ organisationId, farms, date, onClose, onAdded }: { organisationId: string; farms: Farm[]; date: string; onClose: () => void; onAdded: (item: CalendarItem) => void }) {
  const [fields, setFields] = useState<ItemFields>({ date, startTime: "", endTime: "", kind: "other", title: "", farmId: farms.length === 1 ? farms[0].id : "", notes: "", repeat: "", repeatUntil: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { item } = await api<{ item: CalendarItem }>("/api/farming/calendar", { method: "POST", body: { organisationId, ...fieldsBody(fields) } });
      onAdded(item);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };
  return (
    <Card title="Add an item" description="Something not in your email: it's yours alone until you share it." actions={<Button variant="secondary" size="small" onClick={onClose}>Close</Button>}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form onSubmit={submit}>
        <ItemFieldset value={fields} onChange={setFields} farms={farms} />
        <div className={ui.actions}>
          <Button type="submit" disabled={busy}>Add</Button>
        </div>
      </form>
    </Card>
  );
}

/** FC22, FC23: a private link for Google, Apple or Outlook to subscribe to. */
function CalendarLink({ organisationId, onClose }: { organisationId: string; onClose: () => void }) {
  const confirm = useConfirm();
  const status = useApiData<{ link: CalendarLinkStatus }>("/api/farming/calendar/link", { organisationId });
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = status.data?.link.on ?? false;
  const make = async () => {
    if (on && !(await confirm("Make a new link? The old one stops working, so calendars using it stop updating.", { confirmLabel: "Make a new link" }))) return;
    setBusy(true);
    setError(null);
    try {
      const { link } = await api<{ link: CalendarLinkStatus & { url: string } }>("/api/farming/calendar/link", { method: "POST", body: { organisationId } });
      setUrl(link.url);
      setCopied(false);
      status.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async () => {
    if (!(await confirm("Turn the calendar link off? Calendars using it stop updating.", { confirmLabel: "Turn off", danger: true }))) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/farming/calendar/link?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" });
      setUrl(null);
      status.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("Couldn't copy it: select the address and copy it instead.");
    }
  };
  return (
    <Card
      title="Calendar link"
      description="A private address your phone, Google Calendar, Apple Calendar or Outlook can subscribe to, so these items show there too. It only reads: changes made there don't come back."
      actions={<Button variant="secondary" size="small" onClick={onClose}>Close</Button>}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {status.error ? <Notice tone="error">Couldn&apos;t load the link: {status.error}</Notice> : null}
      {url ? (
        <div className={styles.linkBox}>
          <Field label="Your calendar link" hint="Shown once. Anyone with it can see these items, so keep it like a password.">
            <input readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
          </Field>
          <Button size="small" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</Button>
          <ul className={styles.steps}>
            <li><strong>Google Calendar</strong> (on a computer): Other calendars, +, From URL, paste it.</li>
            <li><strong>iPhone</strong>: Settings, Calendar, Accounts, Add Account, Other, Add Subscribed Calendar.</li>
            <li><strong>Outlook</strong>: Add calendar, Subscribe from web.</li>
          </ul>
        </div>
      ) : status.data ? (
        <p>{on ? `You have a link, made ${formatDate(status.data.link.createdAt!.slice(0, 10))}${status.data.link.lastUsedAt ? `, last read ${new Date(status.data.link.lastUsedAt).toLocaleString("en-NZ")}` : ", not read yet"}. It's only shown when it's made.` : "You don't have a link."}</p>
      ) : (
        <p className={ui.muted} role="status">Loading…</p>
      )}
      <p className={ui.muted}>
        It carries what this calendar shows you from 60 days ago on: titles, kinds, farms and times, never anything from the email or your notes. Calendar apps check it when they choose; Google Calendar can take several hours, sometimes a day, to show a change.
      </p>
      <div className={ui.rowButtons}>
        <Button size="small" disabled={busy || !status.data} onClick={() => void make()}>{on ? "Make a new link" : "Make a link"}</Button>
        {on ? <Button size="small" variant="secondary" disabled={busy} onClick={() => void turnOff()}>Turn off</Button> : null}
      </div>
    </Card>
  );
}

/**
 * FC25-FC27: ticks the folders (Outlook) or labels (Gmail) a mailbox reads,
 * from the mailbox's list now, each with its subfolders if wanted. Taking
 * one off asks first, as what was taken from it is deleted.
 */
function FolderPicker({ organisationId, mailbox, onClose, onSaved }: { organisationId: string; mailbox: FarmMailbox; onClose: () => void; onSaved: (message: string) => void }) {
  const confirm = useConfirm();
  const list = useApiData<{ folders: MailFolder[] }>(`/api/farming/mail/${mailbox.id}/folders`, { organisationId });
  const [chosen, setChosen] = useState<Map<string, boolean>>(() => new Map(mailbox.folders.map((folder) => [folder.externalId, folder.includeSubfolders])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = mailbox.provider === "google" ? "labels" : "folders";
  const folders = list.data?.folders ?? [];
  const hasChildren = (id: string) => folders.some((folder) => folder.parentId === id);
  const toggle = (id: string, on: boolean) => {
    const next = new Map(chosen);
    if (on) next.set(id, next.get(id) ?? false);
    else next.delete(id);
    setChosen(next);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const removed = mailbox.folders.filter((folder) => !chosen.has(folder.externalId));
    if (removed.length) {
      const names = removed.map((folder) => folder.name).join(", ");
      const ok = await confirm(
        chosen.size
          ? `Stop reading ${names}? Everything Tohyee took only from ${removed.length === 1 ? "it" : "them"} is deleted, including items you shared. Your mailbox isn't touched.`
          : `Stop reading this mailbox? Everything Tohyee took from it is deleted, including items you shared. Your mailbox isn't touched.`,
        { confirmLabel: "Stop reading", danger: true },
      );
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/farming/mail/${mailbox.id}/folders`, { method: "PUT", body: { organisationId, folders: [...chosen].map(([id, includeSubfolders]) => ({ id, includeSubfolders })) } });
      if (chosen.size && mailbox.status === "active") {
        await api(`/api/farming/mail/${mailbox.id}/check`, { method: "POST", body: { organisationId } });
        onSaved(`Saved. Tohyee reads only the ${kind} you chose.`);
      } else onSaved(chosen.size ? "Saved." : "Saved. Nothing is read from this mailbox now.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={styles.folderPicker} onSubmit={save} aria-labelledby={`folders-${mailbox.id}`}>
      <h3 id={`folders-${mailbox.id}`} className={styles.folderHeading}>Which {kind} to read in {mailbox.email}</h3>
      <p className={ui.muted}>
        Tohyee reads only the {kind} you tick, and nothing until you tick one. Moving an email out of them takes it off your calendar at the next check;
        moving one in adds it, if it&apos;s no older than {mailbox.historyDays} days before you connected. Only you see these names.
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {list.error ? (
        <Notice tone="error">Couldn&apos;t get the {kind}: {list.error} <Button size="small" variant="secondary" onClick={list.reload}>Retry</Button></Notice>
      ) : !list.data ? (
        <p className={ui.muted} role="status">Getting the {kind} from your mailbox…</p>
      ) : folders.length === 0 ? (
        <p className={ui.muted}>The mailbox has no {kind} to choose.</p>
      ) : (
        <fieldset className={styles.folderList}>
          <legend className={styles.visuallyHidden}>{kind === "labels" ? "Labels" : "Folders"}</legend>
          {folders.map((folder) => (
            <div key={folder.id} className={styles.folderRow} style={{ paddingLeft: `${folder.depth * 1.25}rem` }}>
              <label className={ui.checkbox}>
                <input type="checkbox" checked={chosen.has(folder.id)} disabled={busy} onChange={(event) => toggle(folder.id, event.target.checked)} />
                <span>{folder.name}</span>
              </label>
              {chosen.has(folder.id) && hasChildren(folder.id) ? (
                <label className={`${ui.checkbox} ${styles.subfolders}`}>
                  <input
                    type="checkbox"
                    checked={chosen.get(folder.id) === true}
                    disabled={busy}
                    onChange={(event) => setChosen(new Map(chosen).set(folder.id, event.target.checked))}
                    aria-label={`Include the ${kind === "labels" ? "labels" : "folders"} inside ${folder.path}`}
                  />
                  <span>and its sub{kind}</span>
                </label>
              ) : null}
            </div>
          ))}
          {mailbox.folders.filter((folder) => !folders.some((entry) => entry.id === folder.externalId)).map((folder) => (
            <div key={folder.externalId} className={styles.folderRow}>
              <label className={ui.checkbox}>
                <input type="checkbox" checked={chosen.has(folder.externalId)} disabled={busy} onChange={(event) => toggle(folder.externalId, event.target.checked)} />
                <span>{folder.name} (not found in the mailbox: untick it)</span>
              </label>
            </div>
          ))}
        </fieldset>
      )}
      <div className={ui.rowButtons}>
        <Button type="submit" disabled={busy || !list.data || [...chosen.keys()].some((id) => !folders.some((folder) => folder.id === id))}>{busy ? "Saving…" : "Save"}</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

function Mailboxes({
  organisationId,
  mailboxes,
  error,
  farms,
  onChanged,
  picking,
  onPick,
}: {
  organisationId: string;
  mailboxes: FarmMailbox[] | null;
  error: string | null;
  farms: Farm[];
  onChanged: () => void;
  picking: string | null;
  onPick: (id: string | null) => void;
}) {
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
      description="Connect your own Gmail or Microsoft mailbox, then choose the folders or labels Tohyee reads: only those, nothing else. Tohyee only reads (nothing is sent, changed or deleted) and keeps only each arrangement's sentence, subject, sender and a link. Your mailboxes, their folders and this calendar are only yours: nobody else in the organisation sees them, admins included."
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
                    <br />
                    {mailbox.folders.length ? <small>{folderSummary(mailbox.folders)}</small> : <Badge tone="amber">Not reading: choose folders</Badge>}{" "}
                    <Button size="small" variant="secondary" disabled={busy} aria-expanded={picking === mailbox.id} onClick={() => onPick(picking === mailbox.id ? null : mailbox.id)}>
                      {mailbox.folders.length ? "Change folders" : "Choose folders"}
                    </Button>
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
                      <Button size="small" variant="secondary" disabled={busy || mailbox.status === "paused" || mailbox.folders.length === 0} onClick={() => void act(() => api(`/api/farming/mail/${mailbox.id}/check`, { method: "POST", body: { organisationId } }), "Checked.")}>Check now</Button>
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={busy}
                        onClick={async () => {
                          const shared = mailbox.shared ? ` That includes ${mailbox.shared} item${mailbox.shared === 1 ? "" : "s"} you shared with the farm team.` : "";
                          if (!(await confirm(`Disconnect ${mailbox.email}? Everything Tohyee read from it is deleted.${shared} The mailbox itself isn't touched.`, { confirmLabel: "Disconnect", danger: true }))) return;
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
      {(() => {
        const mailbox = mailboxes?.find((entry) => entry.id === picking);
        return mailbox ? (
          <FolderPicker
            key={mailbox.id}
            organisationId={organisationId}
            mailbox={mailbox}
            onClose={() => onPick(null)}
            onSaved={(text) => {
              onPick(null);
              setMessage({ tone: "success", text });
              onChanged();
            }}
          />
        ) : null;
      })()}
      <form className={ui.inlineForm} onSubmit={connect}>
        <Field label="Email provider">
          <select value={provider} onChange={(event) => setProvider(event.target.value as "google" | "microsoft")}>
            <option value="google">Gmail</option>
            <option value="microsoft">Microsoft 365 or Outlook</option>
          </select>
        </Field>
        <Field label="Read back (days)" hint="30 to 365">
          <input inputMode="numeric" value={historyDays} onChange={(event) => setHistoryDays(event.target.value)} />
        </Field>
        {farms.length > 1 ? (
          <Field label="Farm when none is named" hint="A guess: those items wait in Needs checking until you check them.">
            <select value={defaultFarmId} onChange={(event) => setDefaultFarmId(event.target.value)}>
              <option value="">No farm</option>
              {farms.map((farm) => <option key={farm.id} value={farm.id}>{farm.name}</option>)}
            </select>
          </Field>
        ) : null}
        <Button type="submit" disabled={busy}>Connect</Button>
      </form>
      <p className={ui.muted}>
        An administrator sets up the connection under <Link href="/operations/settings/email">Settings › Email</Link>.
        Attachments aren&apos;t read, and repeats aren&apos;t read from an email&apos;s wording: set them on the item.
      </p>
    </Card>
  );
}
