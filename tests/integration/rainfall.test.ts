import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as gaugesRoute from "@/app/api/farming/farms/[farmId]/rain-gauges/route";
import * as readingsRoute from "@/app/api/farming/farms/[farmId]/rainfall/route";
import * as readingRoute from "@/app/api/farming/rainfall/[readingId]/route";
import * as summaryRoute from "@/app/api/farming/rain-gauges/[gaugeId]/summary/route";
import { findAiTool } from "@/lib/ai/catalogue";
import { readBooks } from "@/lib/analytics/books";
import { closeAnalytics, queryAnalytics, replaceTohyeeTables } from "@/lib/analytics/engine";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addGauge, addRainReading, importRainReadings, listGauges, listRainReadings, previewRainImport, rainfallSummary, removeRainReading, updateGauge } from "@/lib/farming/rainfall";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

type Handler = (request: Request, context: never) => Promise<Response>;
const ORG = "rainfall-co";
const OP = "6f0b7c1e-3b1a-4c55-9a43-0d5e2f1a9b01";

/** Rainfall (RF1-RF8; decisions 1451-1456, not yet reviewed). Made-up farms and people. */
describeWithDatabase("rainfall", () => {
  let server: TestServer;
  let owner: SessionUser;
  let worker: SessionUser;
  let root: string;
  const w = {} as Record<string, string>;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-rain-"));
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    server = await startTestServer();
    owner = await createTestUser("rain-owner@example.com", { serverAdmin: true, displayName: "Aroha" });
    worker = await createTestUser("rain-staff@example.com", { displayName: "Tama" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker')", [ORG, worker.id]);
    const run = as(owner);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await run((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await run((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    await run((tx) => setMemberFarmAccess(tx, { userId: worker.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
  });

  afterAll(async () => {
    await closeAnalytics(ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const call = async (user: SessionUser, handler: Handler, url: string, context: Record<string, string>, method = "GET", body?: Record<string, unknown>) => {
    const response = await handler(
      apiRequest(method === "GET" || method === "DELETE" ? `${url}${url.includes("?") ? "&" : "?"}organisationId=${ORG}` : url, { method, cookie: await sessionCookieFor(user), body: body ? { organisationId: ORG, ...body } : undefined }),
      params(context) as never,
    );
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };

  it("RF1 gauges: named once a farm, placed on the map if wanted, retired but kept", async () => {
    const run = as(owner);
    const gauge = await run((tx) => addGauge(tx, { farmId: w.home, name: "Cowshed", point: [170.5, -45.87] }));
    expect(gauge).toMatchObject({ name: "Cowshed", point: [170.5, -45.87], isActive: true, readings: 0, last: null });
    await expect(run((tx) => addGauge(tx, { farmId: w.home, name: "cowshed" }))).rejects.toThrow("already a rain gauge called cowshed");
    await expect(run((tx) => addGauge(tx, { farmId: w.home, name: "Hill", point: [200, 0] }))).rejects.toThrow("longitude and latitude");
    const hill = await run((tx) => addGauge(tx, { farmId: w.home, name: "Hill" }));
    await run((tx) => updateGauge(tx, hill.id, { isActive: false }));
    expect((await run((tx) => listGauges(tx, w.home))).map((entry) => entry.name)).toEqual(["Cowshed"]);
    expect((await run((tx) => listGauges(tx, w.home, { includeRetired: true }))).map((entry) => entry.name)).toEqual(["Cowshed", "Hill"]);
    await expect(run((tx) => addRainReading(tx, { gaugeId: hill.id, readOn: "2026-10-01", mm: "3" }))).rejects.toThrow("Hill is retired");
    w.gauge = gauge.id;
  });

  it("RF2 a day's reading, sent from a phone's queue, is kept once; the day can't be in the future or taken twice", async () => {
    // Farm staff record it through the route, with an operation id (a phone's queue).
    const body = { gaugeId: w.gauge, readOn: "2026-11-03", mm: "12.5", operationId: OP };
    const first = await call(worker, readingsRoute.POST as Handler, `/api/farming/farms/${w.home}/rainfall`, { farmId: w.home }, "POST", body);
    expect(first.status).toBe(201);
    expect(first.body.reading).toMatchObject({ mm: "12.5", readOn: "2026-11-03", source: "Typed", createdByEmail: "rain-staff@example.com", createdByName: "Tama" });
    const again = await call(worker, readingsRoute.POST as Handler, `/api/farming/farms/${w.home}/rainfall`, { farmId: w.home }, "POST", body);
    expect(again.status).toBe(201);
    expect((again.body.reading as { id: string }).id).toBe((first.body.reading as { id: string }).id);
    const changed = await call(worker, readingsRoute.POST as Handler, `/api/farming/farms/${w.home}/rainfall`, { farmId: w.home }, "POST", { ...body, mm: "13" });
    expect([changed.status, changed.body.error]).toEqual([409, "This rain reading was already sent with different details. Nothing was changed: check it and record it again."]);
    // The gauge isn't on the farm the phone sent it for.
    expect((await call(owner, readingsRoute.POST as Handler, `/api/farming/farms/${w.runoff}/rainfall`, { farmId: w.runoff }, "POST", { gaugeId: w.gauge, readOn: "2026-11-02", mm: "1" })).status).toBe(409);
    const run = as(owner);
    await expect(run((tx) => addRainReading(tx, { gaugeId: w.gauge, readOn: "2026-11-03", mm: "4" }))).rejects.toThrow("Cowshed already has 12.5 mm on 2026-11-03");
    // A rain day is the day before the 9 am reading (Jess, 5 Nov 2026): on 5 Nov the latest is 4 Nov.
    await expect(run((tx) => addRainReading(tx, { gaugeId: w.gauge, readOn: "2026-11-05", mm: "4" }, { today: "2026-11-05" }))).rejects.toThrow("the latest is 2026-11-04. Today's rain is read tomorrow morning.");
    await expect(run((tx) => addRainReading(tx, { gaugeId: w.gauge, readOn: "2026-11-06", mm: "4" }, { today: "2026-11-05" }))).rejects.toThrow("the latest is 2026-11-04");
    w.reading = (first.body.reading as { id: string }).id;
  });

  it("RF3 a reading is changed and backdated with who and when kept; removing needs a bookkeeper and keeps it", async () => {
    const edited = await call(worker, readingRoute.PATCH as Handler, `/api/farming/rainfall/${w.reading}`, { readingId: w.reading }, "PATCH", { readOn: "2026-11-02", mm: "14.0", note: "Overflowed a bit" });
    expect(edited.status).toBe(200);
    expect(edited.body.reading).toMatchObject({ readOn: "2026-11-02", mm: "14.0", note: "Overflowed a bit", updatedByEmail: "rain-staff@example.com" });
    const audit = await as(owner)((tx) => tx.query<{ details: { before: { mm: string } } }>("select details from audit_events where event_type = 'farming.rainfall_changed' order by id desc limit 1"));
    expect(audit.rows[0].details.before.mm).toBe("12.5");
    const removing = await call(worker, readingRoute.DELETE as Handler, `/api/farming/rainfall/${w.reading}`, { readingId: w.reading }, "DELETE");
    expect(removing.status).toBe(403);
    const run = as(owner);
    const spare = await run((tx) => addRainReading(tx, { gaugeId: w.gauge, readOn: "2026-10-30", mm: "99" }));
    await run((tx) => removeRainReading(tx, spare.id));
    expect((await run((tx) => listRainReadings(tx, { farmId: w.home, from: "2026-10-01", to: "2026-11-05" }))).map((reading) => reading.readOn)).toEqual(["2026-11-02"]);
    const kept = await run((tx) => tx.query<{ status: string; removed_by_email: string }>("select status, removed_by_email from rainfall_readings where id = $1", [spare.id]));
    expect(kept.rows[0]).toEqual({ status: "removed", removed_by_email: "rain-owner@example.com" });
    // The removed day is free again.
    await run((tx) => addRainReading(tx, { gaugeId: w.gauge, readOn: "2026-10-30", mm: "2.0" }));
  });

  it("RF4 farm staff reach only their farms' gauges", async () => {
    const runoffGauge = await as(owner)((tx) => addGauge(tx, { farmId: w.runoff, name: "Runoff gauge" }));
    expect((await call(worker, gaugesRoute.GET as Handler, `/api/farming/farms/${w.runoff}/rain-gauges`, { farmId: w.runoff })).status).toBe(404);
    expect((await call(worker, summaryRoute.GET as Handler, `/api/farming/rain-gauges/${runoffGauge.id}/summary`, { gaugeId: runoffGauge.id })).status).toBe(404);
    const added = await call(worker, gaugesRoute.POST as Handler, `/api/farming/farms/${w.home}/rain-gauges`, { farmId: w.home }, "POST", { name: "Back paddock" });
    expect(added.status).toBe(201);
  });

  it("RF7 imports a file of readings once, skipping bad rows and days already kept", async () => {
    const run = as(owner);
    const content = ["Date,Rainfall (mm)", "01/11/2025,10", "2025-11-20,40.0", "02/11/2026,5", "2026-01-10,22", "2026-01-10,1", "2025-01-10,11", "03/03/2026,lots", "2026-03-04,"].join("\n");
    const preview = await run((tx) => previewRainImport(tx, w.gauge, { fileName: "gauge.csv", content }, { today: "2026-11-05" }));
    expect(preview.columns).toEqual({ date: 0, mm: 1 });
    expect(preview.counts).toEqual({ readings: 4, errors: 4 });
    expect(preview.rows.filter((row) => row.error).map((row) => [row.line, row.error])).toEqual([
      [4, "Cowshed already has 14.0 mm on this day."],
      [6, "This day is in the file twice."],
      [8, '"lots" isn\'t millimetres from 0 to 2,000 (one decimal place at most).'],
      [9, "No rain figure. Type 0 for a dry day."],
    ]);
    expect(await run((tx) => importRainReadings(tx, w.gauge, { fileName: "gauge.csv", content }, { today: "2026-11-05" }))).toEqual({ imported: 4, skipped: 4 });
    await expect(run((tx) => importRainReadings(tx, w.gauge, { fileName: "again.csv", content }, { today: "2026-11-05" }))).rejects.toThrow("already imported for Cowshed");
  });

  it("RF5-RF6 the history: this month, season and 12 months, by month and season, with last year's", async () => {
    // 2025-11-01 10.0, 2025-11-20 40.0, 2026-01-10 22.0, 2025-01-10 11.0, 2026-10-30 2.0, 2026-11-02 14.0.
    const summary = await as(owner)((tx) => rainfallSummary(tx, { gaugeId: w.gauge, onDate: "2026-11-05" }));
    expect(summary.totals.thisMonth.current).toMatchObject({ mm: "14.0", daysRead: 1, days: 5 });
    expect(summary.totals.thisMonth.lastYear).toMatchObject({ mm: "10.0", daysRead: 1 });
    expect(summary.totals.last12Months.current.mm).toBe("78.0");
    expect(summary.totals.last12Months.lastYear.mm).toBe("21.0");
    expect(summary.seasons[0]).toMatchObject({ label: "Summer 2025-26" });
    expect([summary.seasons[0].current.mm, summary.seasons[0].lastYear.mm]).toEqual(["22.0", "11.0"]);
    expect(summary.months.find((month) => month.key === "2026-10")!.current.mm).toBe("2.0");
    expect(summary.firstReadOn).toBe("2025-01-10");
    // Through the route too, for farm staff on their farm.
    expect((await call(worker, summaryRoute.GET as Handler, `/api/farming/rain-gauges/${w.gauge}/summary?onDate=2026-11-05`, { gaugeId: w.gauge })).status).toBe(200);
  });

  it("RF8 the AI reads it and it's in Analytics as tohyee_farm_rainfall", async () => {
    const tool = findAiTool("rainfall")!;
    expect(tool.level).toBe("read");
    const answer = (await as(owner)((tx) => tool.run(tx, { farmId: w.home, onDate: "2026-11-05" }, {} as never))) as { gauges: Array<{ gauge: { name: string }; totals: { thisMonth: { current: { mm: string } } } }> };
    expect(answer.gauges.map((entry) => [entry.gauge.name, entry.totals.thisMonth.current.mm])).toEqual([
      ["Back paddock", null],
      ["Cowshed", "14.0"],
    ]);
    const days = (await as(owner)((tx) => tool.run(tx, { farmId: w.home, from: "2026-11-01", to: "2026-11-05" }, {} as never))) as { readings: Array<{ mm: string }> };
    expect(days.readings.map((reading) => reading.mm)).toEqual(["14.0"]);
    await as(owner)(async (tx) => replaceTohyeeTables(ORG, await readBooks(tx)));
    const rows = await queryAnalytics(ORG, "select gauge, cast(sum(mm) as varchar) as total, cast(count(*) as integer) as n from tohyee_farm_rainfall group by gauge");
    expect(rows).toEqual([{ gauge: "Cowshed", total: "99.0", n: 6 }]);
  });
});
