"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { PinnedAnalyticsTile } from "@/components/analytics/pinned-tile";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Chart } from "@/components/analytics/chart";
import { DashboardCardChooser, PageDashboardFrame, useDashboardPreferences } from "@/components/page-dashboard";
import { Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Dashboard } from "@/lib/analytics/dashboards";
import { parseAnalyticsTileReference } from "@/lib/dashboard/analytics-tile-reference";
import { defaultsNote } from "@/lib/dashboard/defaults";
import { dashboardPage, defaultDashboardTileIds, maxTilesFor } from "@/lib/dashboard/pages";
import { CALENDAR_KIND_LABELS, type CalendarItem } from "@/lib/farming/calendar-shared";
import type { FarmHome, FarmHomeCatchUpItem, FarmHomePasture, FarmHomeFertiliser, FarmHomePerformance, FarmHomeSeasonCash, FarmHomeStock, FarmHomeCalendar, FarmHomeNotebook } from "@/lib/farming/home";
import { formatDate, formatQuantity } from "@/lib/format";
import type { HomeSummary } from "@/lib/reports/home";
import { GST_BASIS_LABELS } from "@/lib/tax/categories";
import homeStyles from "./home.module.css";
import styles from "./farm-home.module.css";

/*
 * The farm Home (#341; FH1-FH11): Home for organisations with Farming on.
 * Cards come from records Tohyee keeps; a card with nothing to show is
 * hidden rather than showing zeros. Customise turns cards on and off and
 * orders them, per person, and Analytics tiles can be pinned here too.
 */

const PAGE = dashboardPage("farm_home")!;
const CARDS = PAGE.cards;
const DEFAULT_IDS = defaultDashboardTileIds(PAGE);
const MAX_TILES = maxTilesFor(PAGE);
type CardId = (typeof CARDS)[number]["id"];

const int = new Intl.NumberFormat("en-NZ", { maximumFractionDigits: 0 });
const shortDay = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-NZ", { month: "long", timeZone: "UTC" });

function time12(value: string | null): string {
  if (!value) return "";
  const [hour, minute] = value.split(":").map(Number);
  return `${hour % 12 === 0 ? 12 : hour % 12}${minute ? `:${String(minute).padStart(2, "0")}` : ""}${hour >= 12 ? "pm" : "am"}`;
}

function Card({ title, href, linkLabel, children, wide = false, aside }: { title: string; href: string; linkLabel: string; children: ReactNode; wide?: boolean; aside?: ReactNode }) {
  return (
    <section className={`${homeStyles.tile} ${wide ? styles.wide : ""}`} aria-label={title}>
      <div className={homeStyles.tileTitle}>
        <h2 className={styles.cardTitle}><Link href={href}>{title}</Link></h2>
        {aside}
      </div>
      {children}
      <Link className={styles.more} href={href}>{linkLabel}</Link>
    </section>
  );
}

function CalendarCard({ data }: { data: FarmHomeCalendar }) {
  const byDay = new Map<string, CalendarItem[]>();
  for (const item of data.items) if (item.date) byDay.set(item.date, [...(byDay.get(item.date) ?? []), item]);
  return (
    <Card title="This week on the farm" href="/operations/farming/calendar" linkLabel="Open the farm calendar" wide aside={<span className={homeStyles.kind}>Private to you</span>}>
      {data.needsChecking ? (
        <p className={styles.attention}>
          <Link href="/operations/farming/calendar">{data.needsChecking} {data.needsChecking === 1 ? "item needs" : "items need"} checking</Link>
        </p>
      ) : null}
      {data.items.length === 0 ? (
        <p className={ui.muted}>Nothing on from {shortDay(data.from)} to {shortDay(data.to)}.</p>
      ) : (
        <>
          {byDay.has(data.from) ? null : <p className={ui.muted}>Nothing on today.</p>}
          <Agenda byDay={byDay} from={data.from} />
        </>
      )}
    </Card>
  );
}

function Agenda({ byDay, from }: { byDay: Map<string, CalendarItem[]>; from: string }) {
  return (
        <ul className={styles.agenda}>
          {[...byDay.entries()].map(([date, items]) => (
            <li key={date}>
              <span className={styles.day}>{date === from ? "Today" : shortDay(date)}</span>
              <ul className={styles.dayItems}>
                {items.map((item) => (
                  <li key={item.key} className={item.state === "cancelled" ? styles.cancelled : undefined}>
                    <span className={styles.when}>{item.startTime ? time12(item.startTime) : "Any time"}</span>
                    <span>
                      {item.title}
                      <small className={homeStyles.activityMeta}>
                        {[CALENDAR_KIND_LABELS[item.kind], item.farmName, item.state === "cancelled" ? "Cancelled" : null, item.tentative && !item.checked ? "Tentative" : null, !item.mine ? `Shared by ${item.sharedByName}` : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
  );
}

function StockCard({ data }: { data: FarmHomeStock }) {
  const kinds = new Set(data.classes.map((row) => row.kind));
  return (
    <Card title="Stock" href="/operations/livestock" linkLabel="Open Livestock" aside={<span className={homeStyles.kind}>Year to {formatDate(data.yearEnd)}</span>}>
      <div className={homeStyles.figure}>{int.format(data.total)} <span className={styles.unit}>head</span></div>
      <div className={homeStyles.rows}>
        {data.classes.slice(0, 6).map((row) => (
          <div key={`${row.kind}:${row.classCode}`} className={homeStyles.row}>
            <span>{kinds.size > 1 ? `${row.kindName}: ` : ""}{row.className}</span>
            <span>{int.format(row.head)}</span>
          </div>
        ))}
        {data.classes.length > 6 ? <div className={homeStyles.row}><span>{data.classes.length - 6} more classes</span><span>{int.format(data.classes.slice(6).reduce((total, row) => total + row.head, 0))}</span></div> : null}
        <div className={homeStyles.row}><span>Movements this year</span><span>{int.format(data.movements)}</span></div>
      </div>
      {data.suggestionsWaiting ? (
        <p className={styles.attention}>
          <Link href="/operations/livestock">{data.suggestionsWaiting} suggested {data.suggestionsWaiting === 1 ? "movement" : "movements"} waiting for you</Link>
        </p>
      ) : null}
    </Card>
  );
}

function PastureCard({ farms }: { farms: FarmHomePasture[] }) {
  return (
    <Card title="Pasture and feed" href="/operations/farming/pasture" linkLabel="Open Pasture">
      {farms.map((farm) => (
        <div key={farm.farmId} className={styles.farm}>
          {farms.length > 1 ? <h3 className={styles.farmName}>{farm.farmName}</h3> : null}
          {farm.latestReading ? (
            <>
              <div className={homeStyles.figure}>{int.format(farm.averageKgDmPerHa)} <span className={styles.unit}>kg DM/ha</span></div>
              <div className={homeStyles.rows}>
                <div className={homeStyles.row}><span>Total cover</span><span>{int.format(farm.totalKgDm)} kg DM</span></div>
                {farm.growthKgDmPerHaPerDay !== null ? (
                  <div className={homeStyles.row}><span>Growth ({farm.growthPaddocks} {farm.growthPaddocks === 1 ? "paddock" : "paddocks"})</span><span>{farm.growthKgDmPerHaPerDay} kg DM/ha/day</span></div>
                ) : null}
                {farm.highest && farm.lowest && farm.highest.name !== farm.lowest.name ? (
                  <>
                    <div className={homeStyles.row}><span>Highest cover: {farm.highest.name}</span><span>{int.format(farm.highest.cover)} kg DM/ha</span></div>
                    <div className={homeStyles.row}><span>Lowest cover: {farm.lowest.name}</span><span>{int.format(farm.lowest.cover)} kg DM/ha</span></div>
                  </>
                ) : null}
                {farm.supplements.map((month) => (
                  <div key={month.month} className={homeStyles.row}><span>Supplements, {monthName(month.month)}</span><span>{formatQuantity(month.kgDm)} kg DM</span></div>
                ))}
              </div>
              <small className={ui.muted}>Latest reading {formatDate(farm.latestReading)}{farm.oldestReading && farm.oldestReading !== farm.latestReading ? `, oldest ${formatDate(farm.oldestReading)}` : ""}</small>
            </>
          ) : (
            <div className={homeStyles.rows}>
              <div className={homeStyles.row}><span>No cover readings yet</span><span /></div>
              {farm.supplements.map((month) => (
                <div key={month.month} className={homeStyles.row}><span>Supplements, {monthName(month.month)}</span><span>{formatQuantity(month.kgDm)} kg DM</span></div>
              ))}
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}

function FertiliserCard({ plans }: { plans: FarmHomeFertiliser[] }) {
  return (
    <Card title="Fertiliser" href="/operations/farming/fertiliser" linkLabel="Open the fertiliser plan">
      {plans.map((plan) => (
        <div key={plan.planId} className={styles.farm}>
          <h3 className={styles.farmName}>{plans.length > 1 ? `${plan.farmName}: ` : ""}{plan.planName}</h3>
          <div className={homeStyles.rows}>
            <div className={homeStyles.row}><span>Applied · planned</span><span>{formatQuantity(plan.appliedTonnes)} t · {formatQuantity(plan.plannedTonnes)} t</span></div>
            <div className={homeStyles.row}><span>Spent · planned</span><span><Money value={plan.appliedCost} /> · <Money value={plan.plannedCost} /></span></div>
            <div className={homeStyles.row}><span>Applications</span><span>{plan.applications}{plan.lastAppliedOn ? `, last ${formatDate(plan.lastAppliedOn)}` : ""}</span></div>
          </div>
        </div>
      ))}
    </Card>
  );
}

function PerformanceCard({ data }: { data: FarmHomePerformance }) {
  const rows: Array<[string, keyof FarmHomePerformance["workingExpenses"], string]> = [
    ["per kg MS", "perKgMs", "kgMS"],
    ["per hectare", "perHa", "ha"],
    ["per cow", "perCow", "cow"],
    ["per stock unit", "perSu", "SU"],
  ];
  const shown = rows.filter(([, key]) => data.workingExpenses[key] !== null);
  return (
    <Card title="Farm performance" href="/operations/farming/benchmarks" linkLabel="Open Farm benchmarks" aside={<span className={homeStyles.kind}>Year to {formatDate(data.yearEnd)}</span>}>
      <div>
        <div className={homeStyles.figure}><Money value={data.workingExpenses.amount} /></div>
        <small className={ui.muted}>Farm working expenses{data.previous ? ` · last year ` : ""}{data.previous ? <Money value={data.previous.amount} /> : null}</small>
      </div>
      {shown.length ? (
        <div className={homeStyles.rows}>
          {shown.map(([label, key]) => (
            <div key={key} className={homeStyles.row}>
              <span>FWE {label}</span>
              <span><Money value={data.workingExpenses[key]} />{data.previous?.[key] ? <small className={homeStyles.activityMeta}>Year before <Money value={data.previous[key]} /></small> : null}</span>
            </div>
          ))}
          {data.operatingSurplus.perKgMs ? <div className={homeStyles.row}><span>Operating surplus per kg MS</span><span><Money value={data.operatingSurplus.perKgMs} /></span></div> : null}
        </div>
      ) : (
        <p className={ui.muted}>Enter the year&apos;s kg MS, hectares, cows and stock units under Farm benchmarks to see them per unit.</p>
      )}
    </Card>
  );
}

function MoneyCard({ summary }: { summary: HomeSummary }) {
  const gst = summary.nextGstReturn;
  return (
    <Card title="Money" href="/operations/bank-accounts" linkLabel="Open Banking">
      <div className={homeStyles.figure}><Money value={summary.cashInBank} /></div>
      <small className={ui.muted}>Cash in bank · ledger balances, excluding credit cards</small>
      <div className={homeStyles.rows}>
        <div className={homeStyles.row}><span><Link href="/operations/reports?report=payables">Bills to pay</Link>{summary.billsDueThisWeek ? ` (${summary.billsDueThisWeek} this week)` : ""}</span><span><Money value={summary.billsToPay.total} /></span></div>
        <div className={homeStyles.row}><span><Link href="/operations/reports?report=aged">Owed to you</Link></span><span><Money value={summary.owedToYou.total} /></span></div>
        {gst.status === "ready" ? (
          <div className={homeStyles.row}>
            <span><Link href="/operations/gst-return">GST {gst.box15.startsWith("-") ? "refund" : "to pay"}</Link> <small className={homeStyles.activityMeta}>{GST_BASIS_LABELS[gst.basis]} estimate, {formatDate(gst.periodStart)} – {formatDate(gst.periodEnd)}</small></span>
            <span><Money value={gst.box15.replace(/^-/, "")} /></span>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What a record to catch up on says, and where it's fixed (FH9). */
export function catchUpLine(item: FarmHomeCatchUpItem): { text: string; action: string; href: string } {
  switch (item.kind) {
    case "pasture_stale":
      return { text: `${item.farmName}: last farm walk ${formatDate(item.latestReading)}, ${item.days} days ago`, action: "Add readings", href: "/operations/farming/pasture" };
    case "paddocks_unmeasured":
      return { text: `${item.farmName}: ${plural(item.count, "paddock has", "paddocks have")} no cover reading`, action: "Add readings", href: "/operations/farming/pasture" };
    case "season_figures":
      return { text: `No kg MS, hectares, cows or stock units for the year to ${formatDate(item.yearEnd)}`, action: "Enter them", href: "/operations/farming/benchmarks" };
    case "bank_lines":
      return { text: `${plural(item.count, "bank line", "bank lines")} to reconcile`, action: "Reconcile", href: "/operations/bank-accounts" };
    case "bank_feeds":
      return { text: `${plural(item.count, "bank feed needs", "bank feeds need")} reconnecting`, action: "Reconnect", href: "/operations/bank-accounts" };
    case "livestock_suggestions":
      return { text: `${plural(item.count, "suggested stock movement", "suggested stock movements")} to accept or decline`, action: "Review", href: "/operations/livestock" };
    case "calendar_checking":
      return { text: `${plural(item.count, "calendar item needs", "calendar items need")} checking`, action: "Check", href: "/operations/farming/calendar" };
  }
}

function CatchUpCard({ items }: { items: FarmHomeCatchUpItem[] }) {
  return (
    <Card title="Records to catch up on" href="/operations/farming/pasture" linkLabel="Open Pasture">
      <div className={homeStyles.rows}>
        {items.map((item, index) => {
          const line = catchUpLine(item);
          return (
            <div key={`${item.kind}-${index}`} className={homeStyles.row}>
              <span>{line.text}</span>
              <Link href={line.href}>{line.action}</Link>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function SeasonCashCard({ data }: { data: FarmHomeSeasonCash }) {
  const rows = data.months.map((month) => ({
    month: monthName(month.month).slice(0, 3),
    // This month shows its expected month end only, so the bars aren't stacked on each other.
    actual: month.forecastClosing === null ? month.closing : null,
    forecast: month.forecastClosing,
  }));
  const now = [...data.months].reverse().find((month) => month.closing !== null);
  return (
    <Card title="Cash this season" href="/operations/reports/cash-flow-forecast" linkLabel="Open the cash flow forecast" wide aside={<span className={homeStyles.kind}>{formatDate(data.yearStart)} – {formatDate(data.yearEnd)}</span>}>
      <p className={ui.muted}>In the bank at each month&apos;s end, then what the books expect. Excludes credit cards.</p>
      <Chart
        spec={{ kind: "column", category: "month", stacked: true, series: [{ field: "actual", label: "In the bank" }, { field: "forecast", label: "Expected" }], valueFormat: "money", currency: data.currencyCode, compact: true }}
        rows={rows}
        height={200}
      />
      <div className={homeStyles.rows}>
        {now && now.moneyIn !== null ? (
          <>
            <div className={homeStyles.row}>
              <span>{monthName(now.month)} so far: in · out</span>
              <span><Money value={now.moneyIn} /> · <Money value={now.moneyOut ?? "0.00"} /></span>
            </div>
            <div className={homeStyles.row}>
              <span><Link href="/operations/bank-accounts">In the bank today</Link></span>
              <span><Money value={now.closing} /></span>
            </div>
          </>
        ) : null}
        {data.lowest ? (
          <div className={homeStyles.row}>
            <span><Link href="/operations/reports/cash-flow-forecast">Lowest expected</Link>, end of {monthName(data.lowest.month)}</span>
            <span className={data.firstBelowZero ? homeStyles.bad : undefined}><Money value={data.lowest.closing} /></span>
          </div>
        ) : null}
        {data.firstBelowZero ? <p className={styles.attention}>Expected to go below zero in {monthName(data.firstBelowZero)}</p> : null}
      </div>
    </Card>
  );
}

function NotebookCard({ data }: { data: FarmHomeNotebook }) {
  const list = (notes: FarmHomeNotebook["goals"]) => (
    <ul className={styles.notes}>
      {notes.map((note) => (
        <li key={note.id}>
          <strong>{note.title}</strong>
          <small className={homeStyles.activityMeta}>{note.happenedOn ? formatDate(note.happenedOn) : formatDate(note.updatedAt.slice(0, 10))}</small>
        </li>
      ))}
    </ul>
  );
  return (
    <Card title="Farm notebook" href="/operations/farming/notebook" linkLabel="Open the farm notebook">
      {data.goals.length ? <><h3 className={styles.farmName}>Goals</h3>{list(data.goals)}</> : null}
      {data.recent.length ? <><h3 className={styles.farmName}>Recent notes</h3>{list(data.recent)}</> : null}
    </Card>
  );
}

/** Whether a card has something to show (FH6): cards without are hidden. */
export function cardHasData(id: CardId, farm: FarmHome, money: HomeSummary | null): boolean {
  if (id === "catch_up") return farm.catchUp !== null;
  if (id === "season_cash") return farm.seasonCash !== null;
  if (id === "farm_calendar") return farm.calendar !== null;
  if (id === "stock") return farm.stock !== null;
  if (id === "pasture") return farm.pasture !== null;
  if (id === "fertiliser") return farm.fertiliser !== null;
  if (id === "performance") return farm.performance !== null;
  if (id === "notebook") return farm.notebook !== null;
  return money !== null && moneyHasData(money);
}

/** Money is hidden when everything on it is nil (FH6): no cash, bills, money owed or GST estimate. */
export function moneyHasData(money: HomeSummary): boolean {
  const nil = (value: string) => /^-?0*(\.0*)?$/.test(value);
  return !nil(money.cashInBank) || !nil(money.billsToPay.total) || !nil(money.owedToYou.total) || money.nextGstReturn.status === "ready";
}

function FarmCard({ id, farm, money }: { id: CardId; farm: FarmHome; money: HomeSummary | null }) {
  if (id === "catch_up" && farm.catchUp) return <CatchUpCard items={farm.catchUp} />;
  if (id === "season_cash" && farm.seasonCash) return <SeasonCashCard data={farm.seasonCash} />;
  if (id === "farm_calendar" && farm.calendar) return <CalendarCard data={farm.calendar} />;
  if (id === "stock" && farm.stock) return <StockCard data={farm.stock} />;
  if (id === "pasture" && farm.pasture) return <PastureCard farms={farm.pasture} />;
  if (id === "fertiliser" && farm.fertiliser) return <FertiliserCard plans={farm.fertiliser} />;
  if (id === "performance" && farm.performance) return <PerformanceCard data={farm.performance} />;
  if (id === "money" && money) return <MoneyCard summary={money} />;
  if (id === "notebook" && farm.notebook) return <NotebookCard data={farm.notebook} />;
  return null;
}

export function FarmHomeTiles({ organisationId }: { organisationId: string }) {
  const { current } = useWorkspace();
  const farm = useApiData<FarmHome>("/api/farming/home", { organisationId });
  const dashboard = useDashboardPreferences({ organisationId, page: PAGE.id, defaultTiles: DEFAULT_IDS });
  const wantsMoney = dashboard.tiles.includes("money");
  const money = useApiData<HomeSummary>(wantsMoney ? "/api/home" : null, { organisationId });
  const pinned = dashboard.tiles.filter((tile) => parseAnalyticsTileReference(tile));
  const dashboards = useApiData<{ dashboards: Dashboard[] }>(pinned.length ? "/api/analytics/dashboards" : null, { organisationId });
  const pinOptions = pinned.map((tile) => {
    const reference = parseAnalyticsTileReference(tile)!;
    const source = dashboards.data?.dashboards.find((entry) => entry.id === reference.dashboardId);
    const found = source?.tiles.find((entry) => entry.id === reference.tileId);
    return { id: tile, label: found && source ? `${found.title} · ${source.name}` : "Analytics chart" };
  });
  if (farm.error) return <Notice tone="error">Couldn&apos;t load the farm Home: {farm.error}</Notice>;
  const data = farm.data;
  if (!data) return <div className={homeStyles.loading} role="status"><span>Loading the farm…</span><div className={homeStyles.skeleton} /></div>;
  const moneyData = money.data ?? null;
  const hasData = (id: string) => (parseAnalyticsTileReference(id) ? true : CARDS.some((card) => card.id === id) ? cardHasData(id as CardId, data, moneyData) : false);
  // Money shows while it loads; any other card only with something to show (FH6).
  const visible = dashboard.tiles.filter((tile) => (tile === "money" ? !money.error && (!moneyData || moneyHasData(moneyData)) : hasData(tile)));
  return (
    <>
      <p className={ui.muted}>All farms in {current?.displayName ?? "this organisation"}. Money, livestock and performance figures cover the whole organisation. <Link href="/operations/farming">Choose a farm for maps and field records</Link>.</p>
      {dashboard.error ? <Notice tone="error">{dashboard.error}</Notice> : null}
      {money.error && wantsMoney ? <Notice tone="error">Couldn&apos;t load the money figures: {money.error}</Notice> : null}
      <PageDashboardFrame
        hidden={dashboard.hidden}
        onToggleHidden={() => dashboard.setHidden(!dashboard.hidden)}
        customise={
          <DashboardCardChooser
            tiles={dashboard.tiles}
            options={[...CARDS, ...pinOptions]}
            maxTiles={MAX_TILES}
            hasData={hasData}
            saving={dashboard.saving}
            onChange={(tiles) => dashboard.setTiles(tiles)}
            intro="Choose the cards on your farm Home and their order. Only you see this choice. Cards with nothing to show yet stay hidden."
            startingNote={defaultsNote(PAGE.id, { role: current?.role ?? "viewer" })}
            customised={dashboard.customised}
            onReset={() => void dashboard.reset()}
            footer={<>Charts from Analytics can be added here with <strong>Pin to page</strong> on a dashboard tile. At most {MAX_TILES} cards.</>}
          />
        }
      >
        {visible.length === 0 ? (
          <p className={ui.muted}>
            Nothing to show yet. As you use the <Link href="/operations/farming/calendar">farm calendar</Link>, <Link href="/operations/livestock">Livestock</Link>,{" "}
            <Link href="/operations/farming/pasture">Pasture</Link> and the <Link href="/operations/farming/fertiliser">fertiliser plan</Link>, they show here.
          </p>
        ) : (
          <div className={styles.grid}>
            {visible.map((tile) => {
              const reference = parseAnalyticsTileReference(tile);
              if (reference) return <PinnedAnalyticsTile key={tile} organisationId={organisationId} dashboardId={reference.dashboardId} tileId={reference.tileId} />;
              if (tile === "money" && !moneyData) return <section key={tile} className={homeStyles.tile} aria-label="Money"><p role="status" className={ui.muted}>Loading money…</p></section>;
              return <FarmCard key={tile} id={tile as CardId} farm={data} money={moneyData} />;
            })}
          </div>
        )}
      </PageDashboardFrame>
      <p className={ui.muted}>
        <Link href="/operations?view=business">Business overview</Link>: profit by month, what needs attention and bank accounts.
      </p>
    </>
  );
}
