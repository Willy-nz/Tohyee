"use client";

import Link from "next/link";
import { FarmSafety } from "@/components/farm-safety";
import { useApiData } from "@/components/hooks";
import { Badge, Card, Notice, ui } from "@/components/ui";
import type { Farm, FarmingSettings } from "@/lib/farming/paddocks";
import { addDays } from "@/lib/farming/farm-words";
import { formatDate, todayInBrowser } from "@/lib/format";
import type { safetyToday } from "@/lib/safety/today";

/*
 * The Safety tab and Today's safety card in the farmer's workspace (#447,
 * decision 910; built by #446, decision 962). The workspace imports these
 * two names with these props.
 */

/** The whole of Safety for the farm being worked on (the farm bar chooses it). */
export function FarmSafetyTab({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const settings = useApiData<{ settings: FarmingSettings }>("/api/farming/settings", { organisationId });
  return <FarmSafety organisationId={organisationId} farm={farm} imageryKey={settings.data?.settings.imageryKey ?? null} equipmentId={null} />;
}

type Today = Awaited<ReturnType<typeof safetyToday>>;

/** What Today shows from Safety: your actions, important hazards, machines, training and inductions (decision 962). */
export function FarmSafetyToday({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const data = useApiData<Today>("/api/farming/safety/today", { organisationId, farmId: farm.id });
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return null;
  const today = data.data;
  const rows: Array<{ key: string; text: React.ReactNode }> = [
    ...today.myActions.map((action) => ({ key: `a${action.id}`, text: <>{action.state === "overdue" ? <Badge tone="red">Overdue</Badge> : <Badge tone="blue">Yours</Badge>} {action.title}{action.due ? ` · by ${formatDate(action.due)}` : ""}</> })),
    ...today.overdueActions.filter((action) => !today.myActions.some((mine) => mine.id === action.id)).map((action) => ({ key: `o${action.id}`, text: <><Badge tone="red">Overdue</Badge> {action.title}</> })),
    ...today.actionsToCheck.map((action) => ({ key: `c${action.id}`, text: <><Badge tone="amber">To check</Badge> {action.title}</> })),
    ...today.outOfUse.map((item) => ({ key: `u${item.id}`, text: <><Badge tone="red">Out of use</Badge> {item.name}: don&apos;t use it</> })),
    ...today.toSign.map((induction) => ({ key: `s${induction.id}`, text: <><Badge tone="amber">Sign</Badge> {induction.title}: {induction.reason}</> })),
    ...today.training.map((record) => ({ key: `t${record.id}`, text: <><Badge tone={record.state === "expired" ? "red" : "amber"}>{record.state === "expired" ? "Expired" : "Renew"}</Badge> {record.who}: {record.what}{record.expiresOn ? ` (${formatDate(record.expiresOn)})` : ""}</> })),
    ...today.reviewsDue.map((hazard) => ({ key: `r${hazard.id}`, text: <><Badge tone="amber">Review</Badge> {hazard.title}</> })),
  ];
  return (
    <Card title="Safety" description={today.importantHazards.length ? `Watch for: ${today.importantHazards.map((hazard) => `${hazard.title}${hazard.noGo ? " (no-go)" : ""}`).join(", ")}.` : undefined}>
      {rows.length ? (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
          {rows.slice(0, 10).map((row) => (
            <li key={row.key}>{row.text}</li>
          ))}
        </ul>
      ) : (
        <p>Nothing needs doing for safety today.</p>
      )}
      {today.notCheckedToday.length ? <p className={ui.muted}>Not checked today: {today.notCheckedToday.map((item) => item.name).join(", ")}. Do a pre-start check before using them.</p> : null}
      <p>
        <Link href="/operations/farm/safety">Open Safety</Link> · <Link href="/operations/farm/log?record=hazard">Report something</Link>
      </p>
    </Card>
  );
}

/** Safety dates on the farm calendar for the next 30 days (decision 962): actions due, training expiring, hazard reviews. */
export function FarmSafetyDue({ organisationId }: { organisationId: string }) {
  const from = todayInBrowser();
  const to = addDays(from, 30);
  const data = useApiData<{ items: Array<{ date: string; title: string; kind: string }> }>("/api/farming/safety/due", { organisationId, from, to });
  if (data.error || !data.data || !data.data.items.length) return null;
  return (
    <Card title="Safety due" description="From Safety: actions due, training to renew and hazard reviews, the next 30 days.">
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {data.data.items.map((item, index) => (
          <li key={`${item.date}-${index}`}>
            <strong>{formatDate(item.date)}</strong> {item.title}
          </li>
        ))}
      </ul>
      <p>
        <Link href="/operations/farm/safety">Open Safety</Link>
      </p>
    </Card>
  );
}
