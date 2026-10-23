"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DashboardView } from "@/components/analytics-dashboards";
import { AnalyticsEmbedContext, type AnalyticsEmbed } from "@/components/analytics/embed-context";
import { BrandMark } from "@/components/brand-mark";
import { Button, Field, Notice } from "@/components/ui";
import { WorkspaceProvider } from "@/components/workspace";
import { ApiError, setApiTransport, type ApiOptions } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import { OfficeAuth, SignedOutError } from "@/lib/office/client/auth";
import { activeView, officeReady, openInBrowser, saveSettings, type OfficeGlobal } from "@/lib/office/client/office-js";
import { snapshotElement, whenSettled } from "@/lib/office/client/snapshot";
import { officeApiPath } from "@/lib/office/paths";
import { parseSlideChoice, parseSlideSnapshot, reportAddress, SLIDE_SETTING, SNAPSHOT_SETTING, type SlideChoice, type SlideSnapshot } from "@/lib/office/settings";
import type { Role } from "@/lib/auth/roles";
import styles from "./office.module.css";

/*
 * Tohyee's PowerPoint add-in on a slide (#429, decisions 838-843): a live,
 * interactive Analytics report (or one tile) for whoever is looking at the
 * slide, signed in as themselves, like Power BI's add-in. Someone who isn't
 * signed in sees the picture saved the last time someone signed in saw it,
 * with "Sign in to see live data". What the slide shows is kept in the
 * presentation (the add-in's settings); tokens never are.
 */

type Me = { user: { email: string; displayName: string }; organisations: Array<{ id: string; displayName: string; role: Role }> };
type ReportSummary = { id: string; name: string; description: string | null; pages: Array<{ id: string; name: string }>; tiles: Array<{ id: string; title: string; visual: string; page: string }> };

type Ready = { office: OfficeGlobal | null; auth: OfficeAuth };

/** The slide page: waits for Office, then shows the report, the setup or the saved picture. */
export function PowerPointAddin({ origin }: { origin: string }) {
  useState(installTransport);
  const [ready, setReady] = useState<Ready | null>(null);
  const [outside, setOutside] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void officeReady().then((found) => {
      if (cancelled) return;
      const office = found && found.host ? found.office : null;
      if (!office) setOutside(true);
      const auth = new OfficeAuth(office, origin);
      pageAuth = auth;
      setReady({ office, auth });
    });
    return () => {
      cancelled = true;
    };
  }, [origin]);
  if (!ready) return <p className={styles.quiet} role="status">Starting…</p>;
  return <Slide office={ready.office} auth={ready.auth} origin={origin} outside={outside} />;
}

function Slide({ office, auth, origin, outside }: { office: OfficeGlobal | null; auth: OfficeAuth; origin: string; outside: boolean }) {
  const settings = office?.context.document?.settings ?? null;
  const [choice, setChoice] = useState<SlideChoice | null>(() => parseSlideChoice(settings?.get(SLIDE_SETTING)));
  const [snapshot, setSnapshot] = useState<SlideSnapshot | null>(() => parseSlideSnapshot(settings?.get(SNAPSHOT_SETTING)));
  const [signedIn, setSignedIn] = useState(auth.signedIn());
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<"edit" | "read">("edit");
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => auth.onChange(setSignedIn), [auth]);

  // Edit or slide show (decision 841). PowerPoint on the web starts the slide show as a new
  // session, so the view is read when the add-in loads; it's checked again every few seconds
  // rather than with the ActiveViewChanged event, which needs the add-in to have write access.
  useEffect(() => {
    if (!office) return;
    let stopped = false;
    const check = () => void activeView(office).then((next) => !stopped && setView(next));
    check();
    const timer = window.setInterval(check, 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [office]);

  // Who's signed in, and their organisations.
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    auth
      .fetch("/api/office/me")
      .then(async (response) => {
        if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "Tohyee didn't answer.");
        const body = (await response.json()) as Me;
        if (!cancelled) setMe(body);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (!(caught instanceof SignedOutError)) setError(caught instanceof Error ? caught.message : "Tohyee can't be reached.");
      });
    return () => {
      cancelled = true;
    };
  }, [auth, signedIn]);

  async function signIn() {
    setError(null);
    setBusy(true);
    try {
      await auth.signIn();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Signing in didn't work.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await auth.signOut();
    setMe(null);
  }

  async function choose(next: SlideChoice) {
    setChoice(next);
    setChanging(false);
    if (!settings || !office) return;
    settings.set(SLIDE_SETTING, next);
    // A different report: the old picture isn't of it.
    if (!choice || choice.dashboardId !== next.dashboardId || choice.organisationId !== next.organisationId || choice.pageId !== next.pageId || choice.tileId !== next.tileId || !next.keepSnapshot) {
      settings.remove(SNAPSHOT_SETTING);
      setSnapshot(null);
    }
    if (!(await saveSettings(office))) setError("PowerPoint didn't keep the choice in the presentation. Try again, or save the presentation.");
  }

  const keepSnapshot = useCallback(
    async (image: string) => {
      if (!settings || !office) return;
      const next = { image, takenAt: new Date().toISOString() };
      settings.set(SNAPSHOT_SETTING, next);
      setSnapshot(next);
      // In a slide show PowerPoint may not keep it; the next time someone views it while editing, it will.
      await saveSettings(office);
    },
    [settings, office],
  );

  const otherServer = choice !== null && choice.server !== origin;

  if (outside) {
    return (
      <Panel title="Tohyee Analytics for PowerPoint">
        <p>This page is the slide side of Tohyee&apos;s PowerPoint add-in. It works inside PowerPoint: install the add-in from Tohyee&apos;s Settings › PowerPoint add-in, then add it to a slide.</p>
      </Panel>
    );
  }
  if (otherServer) {
    return (
      <SavedPicture snapshot={snapshot} choice={choice}>
        This slide shows a report from another Tohyee server ({choice.server}). Add that server&apos;s PowerPoint add-in to see it live.
      </SavedPicture>
    );
  }
  if (!signedIn) {
    if (choice && snapshot) {
      return (
        <SavedPicture snapshot={snapshot} choice={choice} error={error}>
          <Button size="small" onClick={() => void signIn()} disabled={busy}>
            {busy ? "Signing in…" : "Sign in to see live data"}
          </Button>
        </SavedPicture>
      );
    }
    return (
      <Panel title={choice ? choice.reportName : "Tohyee Analytics"}>
        <p>{choice ? `A live report from ${choice.organisationName}. Sign in to Tohyee to see it: you'll see what you can see in Tohyee.` : "Put a live Tohyee Analytics report on this slide. Sign in with your Tohyee sign-in (password and two-step, or Google)."}</p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div>
          <Button onClick={() => void signIn()} disabled={busy}>
            {busy ? "Signing in…" : "Sign in to Tohyee"}
          </Button>
        </div>
      </Panel>
    );
  }
  if (!me) {
    return error ? (
      <SavedPicture snapshot={snapshot} choice={choice} error={error}>
        <Button size="small" variant="secondary" onClick={() => window.location.reload()}>Try again</Button>
      </SavedPicture>
    ) : (
      <p className={styles.quiet} role="status">Signing in…</p>
    );
  }
  if (!choice || changing) {
    if (view === "read") return <Panel title="Tohyee Analytics"><p>This add-in hasn&apos;t been set up yet. Leave the slide show to choose a report.</p></Panel>;
    return <Chooser auth={auth} me={me} origin={origin} current={choice} onChoose={(next) => void choose(next)} onCancel={choice ? () => setChanging(false) : null} onSignOut={() => void signOut()} />;
  }
  return (
    <LiveReport
      key={`${choice.organisationId}:${choice.dashboardId}:${choice.pageId}:${choice.tileId}`}
      auth={auth}
      office={office}
      me={me}
      choice={choice}
      view={view}
      onChange={() => setChanging(true)}
      onToggleFilters={() => void choose({ ...choice, showFilters: !choice.showFilters })}
      onSignOut={() => void signOut()}
      onSnapshot={keepSnapshot}
    />
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className={styles.panelScreen}>
      <section className={styles.panel} aria-labelledby="addin-title">
        <div className={styles.brand}>
          <BrandMark size={24} />
          <span>Tohyee</span>
        </div>
        <h1 id="addin-title" className={styles.title}>{title}</h1>
        {children}
      </section>
    </main>
  );
}

/** The saved picture, for someone who isn't signed in (Power BI's snapshot). */
function SavedPicture({ snapshot, choice, error, children }: { snapshot: SlideSnapshot | null; choice: SlideChoice | null; error?: string | null; children: React.ReactNode }) {
  return (
    <main className={styles.saved}>
      {snapshot ? (
        // eslint-disable-next-line @next/next/no-img-element -- the picture kept in the presentation, a data: address
        <img className={styles.savedImage} src={snapshot.image} alt={`Saved picture of ${choice?.reportName ?? "the report"}`} />
      ) : (
        <div className={styles.savedEmpty}>
          <BrandMark size={28} />
          <strong>{choice?.reportName ?? "Tohyee Analytics"}</strong>
        </div>
      )}
      <div className={styles.savedBar} role="region" aria-label="Live data">
        <span>{snapshot ? `Saved picture from ${formatDateTime(snapshot.takenAt)}.` : "No saved picture yet."}</span>
        {error ? <span className={styles.savedError} role="alert">{error}</span> : null}
        {children}
      </div>
    </main>
  );
}

/** Choosing what the slide shows (decision 838): organisation, report, a page or one tile, and the options. */
function Chooser({ auth, me, origin, current, onChoose, onCancel, onSignOut }: { auth: OfficeAuth; me: Me; origin: string; current: SlideChoice | null; onChoose: (choice: SlideChoice) => void; onCancel: (() => void) | null; onSignOut: () => void }) {
  const [organisationId, setOrganisationId] = useState(current?.organisationId ?? me.organisations[0]?.id ?? "");
  const [reports, setReports] = useState<{ organisationId: string; list: ReportSummary[] } | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [dashboardId, setDashboardId] = useState(current?.dashboardId ?? "");
  const [shows, setShows] = useState<"page" | "tile">(current?.tileId ? "tile" : "page");
  const [pageId, setPageId] = useState(current?.pageId ?? "");
  const [tileId, setTileId] = useState(current?.tileId ?? "");
  const [showFilters, setShowFilters] = useState(current?.showFilters ?? true);
  const [keepSnapshot, setKeepSnapshot] = useState(current?.keepSnapshot ?? true);

  useEffect(() => {
    if (!organisationId) return;
    let cancelled = false;
    auth
      .fetch(`/api/office/reports?organisationId=${encodeURIComponent(organisationId)}`)
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { reports?: ReportSummary[]; error?: string };
        if (cancelled) return;
        if (!response.ok) {
          setReportError(body.error ?? "Tohyee didn't list the reports.");
          setReports({ organisationId, list: [] });
          return;
        }
        setReportError(null);
        setReports({ organisationId, list: body.reports ?? [] });
      })
      .catch((caught: unknown) => {
        if (!cancelled) setReportError(caught instanceof Error ? caught.message : "Tohyee can't be reached.");
      });
    return () => {
      cancelled = true;
    };
  }, [auth, organisationId]);

  const list = reports?.organisationId === organisationId ? reports.list : null;
  const report = list?.find((entry) => entry.id === dashboardId) ?? list?.[0] ?? null;
  const tiles = report ? report.tiles : [];
  const tile = tiles.find((entry) => entry.id === tileId) ?? tiles[0] ?? null;
  const page = report?.pages.find((entry) => entry.id === pageId) ?? report?.pages[0] ?? null;
  const organisation = me.organisations.find((entry) => entry.id === organisationId);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!report || !organisation) return;
    onChoose({
      v: 1,
      server: origin,
      organisationId,
      organisationName: organisation.displayName,
      dashboardId: report.id,
      reportName: report.name,
      pageId: shows === "page" ? (page?.id ?? null) : null,
      tileId: shows === "tile" ? (tile?.id ?? null) : null,
      tileTitle: shows === "tile" ? (tile?.title ?? null) : null,
      showFilters,
      keepSnapshot,
    });
  }

  return (
    <main className={styles.chooser}>
      <form className={styles.chooserForm} onSubmit={submit} aria-labelledby="chooser-title">
        <div className={styles.chooserHead}>
          <div className={styles.brand}>
            <BrandMark size={22} />
            <h1 id="chooser-title" className={styles.chooserTitle}>Show a Tohyee report</h1>
          </div>
          <span className={styles.quiet}>Signed in as {me.user.email}</span>
        </div>
        {me.organisations.length === 0 ? <Notice tone="info">You don&apos;t have Analytics in any organisation on this Tohyee.</Notice> : null}
        <div className={styles.fields}>
          <Field label="Organisation">
            <select value={organisationId} onChange={(event) => { setOrganisationId(event.target.value); setDashboardId(""); setPageId(""); setTileId(""); }}>
              {me.organisations.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}
            </select>
          </Field>
          <Field label="Report">
            <select value={report?.id ?? ""} disabled={!list || list.length === 0} onChange={(event) => { setDashboardId(event.target.value); setPageId(""); setTileId(""); }}>
              {!list ? <option value="">Loading…</option> : list.length === 0 ? <option value="">No reports you can see</option> : null}
              {(list ?? []).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
          </Field>
        </div>
        {reportError ? <Notice tone="error">{reportError}</Notice> : null}
        {report ? (
          <fieldset className={styles.choices}>
            <legend>Show</legend>
            <label className={styles.check}>
              <input type="radio" name="shows" checked={shows === "page"} onChange={() => setShows("page")} /> A page of the report
            </label>
            <label className={styles.check}>
              <input type="radio" name="shows" checked={shows === "tile"} onChange={() => setShows("tile")} disabled={tiles.length === 0} /> One tile
            </label>
            {shows === "page" && report.pages.length > 1 ? (
              <Field label="Page">
                <select value={page?.id ?? ""} onChange={(event) => setPageId(event.target.value)}>
                  {report.pages.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                </select>
              </Field>
            ) : null}
            {shows === "tile" ? (
              <Field label="Tile">
                <select value={tile?.id ?? ""} onChange={(event) => setTileId(event.target.value)}>
                  {tiles.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
                </select>
              </Field>
            ) : null}
          </fieldset>
        ) : null}
        <label className={styles.check}>
          <input type="checkbox" checked={showFilters} onChange={(event) => setShowFilters(event.target.checked)} /> Show the dates and slicers
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={keepSnapshot} onChange={(event) => setKeepSnapshot(event.target.checked)} /> Keep a picture in the presentation for people who can&apos;t sign in
        </label>
        <p className={styles.hint}>Everyone who views this slide signs in and sees only what they can see in Tohyee. The picture is what the last person signed in saw, so anyone with the file can see it.</p>
        <div className={styles.actions}>
          <Button type="submit" disabled={!report || (shows === "tile" && !tile)}>Show on slide</Button>
          {onCancel ? <Button variant="secondary" onClick={onCancel}>Cancel</Button> : null}
          <Button variant="secondary" onClick={onSignOut}>Sign out</Button>
        </div>
      </form>
    </main>
  );
}

/**
 * Every `api()` call on the slide page (decision 838): Analytics' reads go to
 * the Analytics API for Office with the add-in's token; anything else is
 * refused, and nothing ever goes out with a session cookie (which would also
 * send the frame to the sign-in page on a 401). Set for the whole page
 * before anything renders, and never unset.
 */
let pageAuth: OfficeAuth | null = null;

function installTransport() {
  setApiTransport(async (path: string, options: ApiOptions) => {
    if (!pageAuth) throw new SignedOutError();
    return officeTransport(pageAuth)(path, options);
  });
}

/** Analytics' reads, sent to the Analytics API for Office with the add-in's token (src/lib/office/paths.ts). */
function officeTransport(auth: OfficeAuth) {
  return async (path: string, options: ApiOptions) => {
    const method = options.method ?? "GET";
    const mapped = officeApiPath(path, method);
    if (!mapped) throw new ApiError("That isn't available in PowerPoint. Open the report in Tohyee.", 403);
    const url = new URL(path, window.location.origin);
    const target = new URL(mapped, window.location.origin);
    target.search = url.search;
    for (const [name, value] of Object.entries(options.query ?? {})) if (value !== null && value !== undefined && value !== "") target.searchParams.set(name, String(value));
    const response = await auth.fetch(`${target.pathname}${target.search}`, {
      method,
      headers: options.body === undefined ? undefined : { "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw new ApiError(typeof payload?.error === "string" ? payload.error : `Request failed (${response.status}).`, response.status, typeof payload?.code === "string" ? payload.code : null);
    return payload;
  };
}

/** The report, live, as the signed-in person (decision 838), with a small toolbar while editing the slides. */
function LiveReport({
  auth,
  office,
  me,
  choice,
  view,
  onChange,
  onToggleFilters,
  onSignOut,
  onSnapshot,
}: {
  auth: OfficeAuth;
  office: OfficeGlobal | null;
  me: Me;
  choice: SlideChoice;
  view: "edit" | "read";
  onChange: () => void;
  onToggleFilters: () => void;
  onSignOut: () => void;
  onSnapshot: (image: string) => Promise<void>;
}) {
  const [refresh, setRefresh] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState(() => new Date().toISOString());
  const area = useRef<HTMLDivElement>(null);
  const organisation = me.organisations.find((entry) => entry.id === choice.organisationId) ?? null;

  const transportReady = true;

  const embed = useMemo<AnalyticsEmbed>(
    () => ({
      pageId: choice.pageId,
      tileId: choice.tileId,
      showFilters: choice.showFilters,
      async imageSource(path: string) {
        const url = new URL(path, window.location.origin);
        const mapped = officeApiPath(url.pathname, "GET");
        if (!mapped) throw new Error("Not available.");
        const response = await auth.fetch(`${mapped}${url.search}`);
        if (!response.ok) throw new Error("The image didn't load.");
        return URL.createObjectURL(await response.blob());
      },
    }),
    [auth, choice.pageId, choice.tileId, choice.showFilters],
  );

  // The saved picture (decision 840): once the report has drawn, after each refresh.
  useEffect(() => {
    if (!choice.keepSnapshot || !transportReady || !office) return;
    const element = area.current;
    if (!element) return;
    let cancelled = false;
    void whenSettled(element).then((settled) => {
      if (cancelled || !settled) return;
      const image = snapshotElement(element);
      if (image) void onSnapshot(image);
    });
    return () => {
      cancelled = true;
    };
  }, [refresh, choice.keepSnapshot, transportReady, office, onSnapshot]);

  const workspaceUser = useMemo(() => ({ id: "office", email: me.user.email, displayName: me.user.displayName, isServerAdmin: false }), [me.user.email, me.user.displayName]);
  // The report is shown as a reader sees it (decision 838): no editing, whatever the person's role. What they may see is still decided by the server, with their real role.
  const organisations = useMemo(
    () => (organisation ? [{ id: organisation.id, displayName: organisation.displayName, baseCurrency: "NZD", role: "report_viewer" as Role, status: "ready" }] : []),
    [organisation],
  );

  const reload = () => {
    setRefresh((value) => value + 1);
    setRefreshedAt(new Date().toISOString());
  };

  return (
    <main className={`${styles.live} ${view === "read" ? styles.showing : ""}`}>
      {view === "edit" ? (
        <div className={styles.toolbar} role="toolbar" aria-label="Tohyee report">
          <span className={styles.toolbarName}>
            <strong>{choice.tileTitle ?? choice.reportName}</strong>
            <span className={styles.quiet}> · {choice.organisationName}</span>
          </span>
          <span className={styles.toolbarButtons}>
            <Button size="small" variant="secondary" onClick={reload} title={`Last refreshed ${formatDateTime(refreshedAt)}`}>Refresh</Button>
            <Button size="small" variant="secondary" aria-pressed={choice.showFilters} onClick={onToggleFilters}>{choice.showFilters ? "Hide filters" : "Show filters"}</Button>
            <Button size="small" variant="secondary" onClick={() => openInBrowser(office, reportAddress(choice))}>Open in Tohyee</Button>
            <Button size="small" variant="secondary" onClick={onChange}>Change</Button>
            <Button size="small" variant="secondary" onClick={onSignOut}>Sign out</Button>
          </span>
        </div>
      ) : (
        <button type="button" className={styles.showRefresh} onClick={reload} aria-label="Refresh the report">↻</button>
      )}
      <div ref={area} className={styles.report}>
        {!organisation ? (
          <Notice tone="warning">You can&apos;t open {choice.organisationName} in Tohyee, so there&apos;s nothing to show you here.</Notice>
        ) : transportReady ? (
          <WorkspaceProvider user={workspaceUser} organisations={organisations}>
            <AnalyticsEmbedContext.Provider value={embed}>
              <Suspense fallback={<p className={styles.quiet}>Loading…</p>}>
                <DashboardView key={refresh} organisationId={choice.organisationId} dashboardId={choice.dashboardId} startEditing={false} />
              </Suspense>
            </AnalyticsEmbedContext.Provider>
          </WorkspaceProvider>
        ) : null}
      </div>
    </main>
  );
}
