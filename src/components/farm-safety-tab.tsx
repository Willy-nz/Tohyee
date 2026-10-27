"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type CachedEmergency, EmergencyCard, HazardsCard, type Overview, readCache, RecordsCard, writeCache } from "@/components/farm-safety";
import { ChemicalsCard, EquipmentCard, TrainingCard } from "@/components/farm-safety-equipment";
import { InductionsAndSignIn } from "@/components/farm-safety-inductions";
import { ReportsCard, ReportSomething, RestrictedAccessCard, useReports, WaitingToSend } from "@/components/farm-safety-reports";
import { useApiData } from "@/components/hooks";
import { Badge, Card, Notice, ui } from "@/components/ui";
import type { Farm, FarmingSettings, Paddock } from "@/lib/farming/paddocks";
import { addDays } from "@/lib/farming/farm-words";
import { formatDate, formatDateTime, todayInBrowser } from "@/lib/format";
import type { EquipmentView } from "@/lib/safety/equipment";
import type { ChemicalView } from "@/lib/safety/register";
import { emptyLink, linkAnchor, linkedRecord, needsDoing, NEEDS_DOING_SHOWN, type NeedsDoingItem, SAFETY_SCREEN_TITLES, type SafetyLink, type SafetyScreen, type SafetyTodayData, safetyHref } from "@/lib/safety/screens";
import { hazardState, INVITE_CONTRACTORS } from "@/lib/safety/shared";
import styles from "./farm-safety.module.css";

/*
 * Safety in the farmer's workspace (#446, layout follow-up; decisions
 * 976-989): a small overview (the farm's emergency strip, three everyday
 * actions, what needs doing, and links to the registers) and focused
 * screens, each with its own address. Today's Safety card shares the same
 * "needs doing" list. The workspace imports FarmSafetyTab and
 * FarmSafetyToday with these props.
 */

/** The farm's Safety: the overview, or the screen the link asks for. */
export function FarmSafetyTab({ organisationId, farm, link = emptyLink() }: { organisationId: string; farm: Farm; link?: SafetyLink }) {
  const anchor = linkAnchor(link, farm.id);
  useScrollTo(anchor);
  if (!link.screen) return <SafetyOverview organisationId={organisationId} farm={farm} />;
  return (
    <Screen farm={farm} screen={link.screen}>
      <ScreenBody organisationId={organisationId} farm={farm} link={link} screen={link.screen} />
    </Screen>
  );
}

/** Scrolls to a linked record once it has loaded (records load after the screen). */
function useScrollTo(anchor: string | null) {
  useEffect(() => {
    if (!anchor) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      const element = document.getElementById(anchor);
      tries += 1;
      if (element) {
        element.scrollIntoView({ block: "start" });
        element.setAttribute("tabindex", "-1");
        element.focus({ preventScroll: true });
        window.clearInterval(timer);
      } else if (tries > 40) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [anchor]);
}

function Screen({ farm, screen, children }: { farm: Farm; screen: SafetyScreen; children: ReactNode }) {
  return (
    <div className={styles.screen}>
      <div>
        <Link className={styles.back} href={safetyHref({ farmId: farm.id })}>
          <span aria-hidden="true">‹</span> Back to Safety
        </Link>
      </div>
      <div className={styles.screenHead}>
        <h2>{SAFETY_SCREEN_TITLES[screen]}</h2>
        <span className={ui.muted}>{farm.name}</span>
      </div>
      {children}
    </div>
  );
}

function ScreenBody({ organisationId, farm, link, screen }: { organisationId: string; farm: Farm; link: SafetyLink; screen: SafetyScreen }) {
  switch (screen) {
    case "emergency":
      return <EmergencyScreen organisationId={organisationId} farm={farm} />;
    case "report":
      return <ReportScreen organisationId={organisationId} farm={farm} />;
    case "equipment": {
      const machine = linkedRecord(link, "equipment", farm.id);
      return (
        <>
          <EquipmentCard key={machine ?? "all"} organisationId={organisationId} farm={farm} openEquipment={machine} />
          {machine ? (
            <p>
              <Link href={safetyHref({ farmId: farm.id, screen: "equipment" })}>All equipment on {farm.name}</Link>
            </p>
          ) : null}
        </>
      );
    }
    case "people":
      return <InductionsAndSignIn organisationId={organisationId} farm={farm} openInduction={linkedRecord(link, "induction", farm.id)} after={<TrainingCard organisationId={organisationId} farm={farm} />} />;
    case "hazards":
      return <HazardsScreen organisationId={organisationId} farm={farm} openHazard={linkedRecord(link, "hazard", farm.id)} />;
    case "reports":
      return <ReportsScreen organisationId={organisationId} farm={farm} openReport={linkedRecord(link, "report", farm.id)} />;
    case "chemicals":
      return <ChemicalsCard organisationId={organisationId} farm={farm} />;
    case "records":
      return <RecordsScreen organisationId={organisationId} farm={farm} />;
    case "needs":
      return <NeedsDoingCard organisationId={organisationId} farm={farm} all />;
  }
}

// The overview -------------------------------------------------------------------------------------------

type InductionsSummary = { onSite: { here: unknown[] }; inductions: Array<{ change: string }>; canRecord: boolean };

function SafetyOverview({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const overview = useApiData<Overview>("/api/farming/safety", { organisationId, farmId: farm.id });
  const reports = useReports(organisationId, farm.id, false);
  const equipment = useApiData<{ equipment: EquipmentView[] }>("/api/farming/safety/equipment", { organisationId, farmId: farm.id });
  const people = useApiData<InductionsSummary>("/api/farming/safety/inductions", { organisationId, farmId: farm.id });
  const chemicals = useApiData<{ chemicals: ChemicalView[] }>("/api/farming/safety/chemicals", { organisationId, farmId: farm.id });
  const access = overview.data?.access ?? reports.data?.access ?? null;
  const hazards = (overview.data?.hazards ?? []).filter((hazard) => hazardState(hazard) === "active");
  const machines = (equipment.data?.equipment ?? []).filter((item) => item.change !== "withdrawn" && !item.data.retired);
  const outOfUse = machines.filter((item) => !item.available).length;
  const chemicalList = (chemicals.data?.chemicals ?? []).filter((chemical) => chemical.change !== "withdrawn" && !chemical.data.removed);
  const sdsNeeded = chemicalList.filter((chemical) => chemical.sdsNeeded).length;
  const openReports = (reports.data?.reports ?? []).filter((report) => report.state === "open" || report.state === "actions").length;
  const openActions = reports.data ? reports.data.otherActions.length + reports.data.reports.reduce((sum, report) => sum + report.actions.filter((action) => action.change !== "withdrawn" && !action.data.verified).length, 0) : 0;
  const browse: Array<{ screen: SafetyScreen; note: string | null; count: string | null; hidden?: boolean }> = [
    { screen: "hazards", note: overview.data ? `${hazards.filter((hazard) => hazard.data.noGo).length} no-go` : null, count: overview.data ? String(hazards.length) : null },
    { screen: "equipment", note: equipment.data ? (outOfUse ? `${outOfUse} out of use` : "all in use") : null, count: equipment.data ? String(machines.length) : null },
    { screen: "people", note: people.data ? `${people.data.onSite.here.length} on site now` : null, count: people.data ? String(people.data.inductions.filter((induction) => induction.change !== "withdrawn").length) : null },
    { screen: "reports", note: reports.data ? `${openReports} open, ${openActions} action${openActions === 1 ? "" : "s"} to finish` : null, count: reports.data ? String(openReports) : null },
    { screen: "chemicals", note: chemicals.data ? (sdsNeeded ? `${sdsNeeded} need${sdsNeeded === 1 ? "s" : ""} a safety data sheet` : null) : null, count: chemicals.data ? String(chemicalList.length) : null },
    // History checks, the WorkSafe pack, the weekly copy and who sees injury details: not for farm staff (decision 961).
    { screen: "records", note: "History check, WorkSafe pack, weekly copy", count: null, hidden: !access || access.farmStaff },
  ];
  const counted: Record<string, string> = { hazards: "active hazards", equipment: "machines", people: "inductions", reports: "open reports", chemicals: "chemicals" };
  return (
    <div className={styles.overview}>
      <div className={styles.column}>
        <EmergencyStrip organisationId={organisationId} farm={farm} overview={overview.data} loadError={overview.error} canRecord={Boolean(access?.canRecord)} />
        <WaitingToSend organisationId={organisationId} onSent={reports.reload} />
        <nav aria-label="Everyday safety" className={styles.bigActions}>
          <Link className={styles.bigAction} href={safetyHref({ farmId: farm.id, screen: "report" })}>
            <span className={styles.icon} aria-hidden="true">!</span>
            <span>
              Report something
              <small>Hazard, near miss or incident</small>
            </span>
          </Link>
          <Link className={styles.bigAction} href={safetyHref({ farmId: farm.id, screen: "equipment" })}>
            <span className={styles.icon} aria-hidden="true">✓</span>
            <span>
              Check equipment
              <small>Pre-start check</small>
            </span>
          </Link>
          <Link className={styles.bigAction} href={safetyHref({ farmId: farm.id, screen: "people" })}>
            <span className={styles.icon} aria-hidden="true">→</span>
            <span>
              Sign in / induction
              <small>On site, read and sign</small>
            </span>
          </Link>
        </nav>
        <NeedsDoingCard organisationId={organisationId} farm={farm} all={false} />
      </div>
      <div className={styles.column}>
        <Card title="Browse safety">
          <ul className={styles.browse}>
            {browse
              .filter((entry) => !entry.hidden)
              .map((entry) => (
                <li key={entry.screen}>
                  <Link href={safetyHref({ farmId: farm.id, screen: entry.screen })}>
                    {entry.count !== null ? (
                      <span className={styles.count} aria-label={`${entry.count} ${counted[entry.screen]}`}>
                        {entry.count}
                      </span>
                    ) : (
                      <span className={styles.count} style={{ visibility: "hidden" }} aria-hidden="true" />
                    )}
                    <span className={styles.rowText}>
                      {SAFETY_SCREEN_TITLES[entry.screen]}
                      {entry.note ? <small>{entry.note}</small> : null}
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </Card>
        <p className={ui.muted} style={{ margin: 0 }}>
          Tohyee keeps these records; it doesn&apos;t decide what the law needs you to keep. Check WorkSafe&apos;s guidance, or ask someone who knows health and safety law.
        </p>
      </div>
    </div>
  );
}

/**
 * The emergency strip (decision 978): 111 to tap, the address and entrance,
 * and one tap to the full details. Like the full card, it keeps a copy on
 * the phone and shows that copy, with when it was saved, when Tohyee can't
 * be reached.
 */
function EmergencyStrip({ organisationId, farm, overview, loadError, canRecord }: { organisationId: string; farm: Farm; overview: Overview | null; loadError: string | null; canRecord: boolean }) {
  const cached = useMemo<CachedEmergency | null>(() => (loadError ? readCache(organisationId, farm.id) : null), [loadError, organisationId, farm.id]);
  useEffect(() => {
    if (overview) writeCache(organisationId, farm.id, { savedAt: new Date().toISOString(), farmName: farm.name, emergency: overview.emergency });
  }, [overview, organisationId, farm.id, farm.name]);
  const data = (overview ? overview.emergency : (cached?.emergency ?? null))?.data ?? null;
  const place = [data?.address, data?.entrance ? `Entrance: ${data.entrance}` : null].filter(Boolean).join(" · ");
  return (
    <section className={styles.strip} aria-labelledby="safety-emergency-title">
      <div className={styles.stripTop}>
        <a className={styles.call} href="tel:111">
          Call 111
        </a>
        <div className={styles.stripPlace}>
          <strong id="safety-emergency-title">Emergency on {farm.name}</strong>
          <div>{!overview && !loadError ? "Loading the address…" : place || (loadError && !cached ? "Couldn't load this farm's emergency details." : "No address saved for this farm yet.")}</div>
        </div>
      </div>
      {loadError && cached ? (
        <span style={{ fontSize: "var(--text-sm)" }}>
          Couldn&apos;t reach Tohyee. This is the copy saved on this phone {formatDateTime(cached.savedAt)}; it may be out of date.
        </span>
      ) : null}
      <Link className={styles.stripLink} href={safetyHref({ farmId: farm.id, screen: "emergency" })}>
        {data ? "Full emergency details: contacts, first aid, assembly point" : canRecord ? "Add this farm's emergency details" : "Emergency numbers and details"}
      </Link>
    </section>
  );
}

// Needs doing ---------------------------------------------------------------------------------------------

type Today = SafetyTodayData;

function NeedsList({ items }: { items: NeedsDoingItem[] }) {
  return (
    <ul className={styles.needs}>
      {items.map((item) => (
        <li key={item.key}>
          <Link href={item.href}>
            <Badge tone={item.tone}>{item.badge}</Badge>
            <span className={styles.rowText}>
              {item.text}
              {item.note ? <small>{item.note}</small> : null}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * What needs doing for safety on this farm (decision 979), from Today's
 * data. A failed load says so; it never shows "nothing needs doing".
 */
function NeedsDoingCard({ organisationId, farm, all }: { organisationId: string; farm: Farm; all: boolean }) {
  const today = useApiData<Today>("/api/farming/safety/today", { organisationId, farmId: farm.id });
  const items = today.data ? needsDoing(today.data, farm.id) : [];
  const shown = all ? items : items.slice(0, NEEDS_DOING_SHOWN);
  return (
    <Card title={today.data ? `Needs doing (${items.length})` : "Needs doing"}>
      {today.error ? <Notice tone="error">Couldn&apos;t load what needs doing: {today.error}</Notice> : null}
      {!today.data && !today.error ? <p className={ui.muted}>Loading…</p> : null}
      {today.data && !items.length ? <p>Nothing needs doing for safety on {farm.name} today.</p> : null}
      {shown.length ? <NeedsList items={shown} /> : null}
      {!all && items.length > shown.length ? (
        <p style={{ marginBottom: 0 }}>
          <Link href={safetyHref({ farmId: farm.id, screen: "needs" })}>View all {items.length}</Link>
        </p>
      ) : null}
      {today.data?.importantHazards.length ? (
        <p className={ui.muted} style={{ marginBottom: 0 }}>
          Watch for:{" "}
          {today.data.importantHazards.map((hazard, index) => (
            <span key={hazard.id}>
              {index ? ", " : ""}
              <Link href={safetyHref({ farmId: farm.id, screen: "hazards", hazard: hazard.id })}>
                {hazard.title}
                {hazard.noGo ? " (no-go)" : ""}
              </Link>
            </span>
          ))}
          .
        </p>
      ) : null}
      {today.data?.notCheckedToday.length ? <p className={ui.muted}>Not checked today: {today.data.notCheckedToday.map((item) => item.name).join(", ")}. Do a pre-start check before using them.</p> : null}
    </Card>
  );
}

// Focused screens -----------------------------------------------------------------------------------------

function EmergencyScreen({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const overview = useApiData<Overview>("/api/farming/safety", { organisationId, farmId: farm.id });
  return <EmergencyCard organisationId={organisationId} farm={farm} overview={overview.data} loadError={overview.error} onSaved={overview.reload} />;
}

function usePaddocks(organisationId: string, farmId: string) {
  const paddocks = useApiData<{ paddocks: Paddock[] }>(`/api/farming/farms/${farmId}/paddocks`, { organisationId });
  const names = useMemo(() => new Map((paddocks.data?.paddocks ?? []).map((paddock) => [paddock.id, paddock.name])), [paddocks.data]);
  return { list: paddocks.data?.paddocks ?? [], names };
}

function ReportScreen({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const paddocks = usePaddocks(organisationId, farm.id);
  const reports = useReports(organisationId, farm.id, false);
  return (
    <>
      <WaitingToSend organisationId={organisationId} onSent={reports.reload} />
      {reports.error ? <Notice tone="error">{reports.error}</Notice> : null}
      {!reports.data && !reports.error ? <p className={ui.muted}>Loading…</p> : null}
      {reports.data ? <ReportSomething organisationId={organisationId} farm={farm} paddocks={paddocks.list} people={reports.data.people} access={reports.data.access} onSent={reports.reload} /> : null}
      <p className={ui.muted}>
        Someone badly hurt? Call <a href="tel:111">111</a> first. <Link href={safetyHref({ farmId: farm.id, screen: "emergency" })}>Emergency details for {farm.name}</Link>
      </p>
    </>
  );
}

function HazardsScreen({ organisationId, farm, openHazard }: { organisationId: string; farm: Farm; openHazard: string | null }) {
  const [showWithdrawn, setShowWithdrawn] = useState(false);
  const overview = useApiData<Overview>("/api/farming/safety", { organisationId, farmId: farm.id, includeWithdrawn: showWithdrawn });
  const settings = useApiData<{ settings: FarmingSettings }>("/api/farming/settings", { organisationId });
  const paddocks = usePaddocks(organisationId, farm.id);
  if (overview.error) return <Notice tone="error">{overview.error}</Notice>;
  if (!overview.data) return <p className={ui.muted}>Loading…</p>;
  return (
    <HazardsCard
      organisationId={organisationId}
      farm={farm}
      openHazard={openHazard}
      hazards={overview.data.hazards}
      access={overview.data.access}
      paddocks={paddocks.list}
      paddockNames={paddocks.names}
      imageryKey={settings.data?.settings.imageryKey ?? null}
      showWithdrawn={showWithdrawn}
      onShowWithdrawn={setShowWithdrawn}
      onSaved={overview.reload}
    />
  );
}

function ReportsScreen({ organisationId, farm, openReport }: { organisationId: string; farm: Farm; openReport: string | null }) {
  const [showWithdrawn, setShowWithdrawn] = useState(false);
  const reports = useReports(organisationId, farm.id, showWithdrawn);
  const paddocks = usePaddocks(organisationId, farm.id);
  return (
    <>
      <p style={{ margin: 0 }}>
        <Link className={styles.rowButton} href={safetyHref({ farmId: farm.id, screen: "report" })}>
          Report something
        </Link>
      </p>
      {reports.error ? <Notice tone="error">{reports.error}</Notice> : null}
      {!reports.data && !reports.error ? <p className={ui.muted}>Loading…</p> : null}
      {reports.data ? <ReportsCard organisationId={organisationId} data={reports.data} openReport={openReport} paddockNames={paddocks.names} showWithdrawn={showWithdrawn} onShowWithdrawn={setShowWithdrawn} onChanged={reports.reload} /> : null}
    </>
  );
}

function RecordsScreen({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const reports = useReports(organisationId, farm.id, false);
  if (reports.error) return <Notice tone="error">{reports.error}</Notice>;
  if (!reports.data) return <p className={ui.muted}>Loading…</p>;
  // The same rule as before the redesign: not for farm staff (decision 961); a simpler layout doesn't widen access.
  if (reports.data.access.farmStaff) return <Notice tone="info">Records and settings are for the people who keep the farm&apos;s safety registers. Ask the farm manager if you need something from them.</Notice>;
  return (
    <>
      <RecordsCard organisationId={organisationId} farm={farm} />
      {reports.data.access.isOwner ? <RestrictedAccessCard organisationId={organisationId} people={reports.data.people} /> : null}
    </>
  );
}

// Today ------------------------------------------------------------------------------------------------

/** What Today shows from Safety (decision 962): the same "needs doing" list as Safety, each item opening its record (decision 979). */
export function FarmSafetyToday({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const data = useApiData<Today>("/api/farming/safety/today", { organisationId, farmId: farm.id });
  if (data.error) return <Notice tone="error">Couldn&apos;t load Safety for today: {data.error}</Notice>;
  if (!data.data) return null;
  const today = data.data;
  const items = needsDoing(today, farm.id);
  return (
    <Card title="Safety" description={today.importantHazards.length ? `Watch for: ${today.importantHazards.map((hazard) => `${hazard.title}${hazard.noGo ? " (no-go)" : ""}`).join(", ")}.` : undefined}>
      {items.length ? <NeedsList items={items.slice(0, 10)} /> : <p>Nothing needs doing for safety today.</p>}
      {items.length > 10 ? (
        <p>
          <Link href={safetyHref({ farmId: farm.id, screen: "needs" })}>View all {items.length}</Link>
        </p>
      ) : null}
      {today.selfDeclaredOnSite.length ? <p className={ui.muted}>{INVITE_CONTRACTORS}</p> : null}
      {today.notCheckedToday.length ? <p className={ui.muted}>Not checked today: {today.notCheckedToday.map((item) => item.name).join(", ")}. Do a pre-start check before using them.</p> : null}
      <p>
        <Link href={safetyHref({ farmId: farm.id })}>Open Safety</Link> · <Link href={safetyHref({ farmId: farm.id, screen: "report" })}>Report something</Link>
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
        <Link href={safetyHref()}>Open Safety</Link>
      </p>
    </Card>
  );
}
