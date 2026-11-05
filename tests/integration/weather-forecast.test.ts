import { afterAll, beforeAll, expect, it } from "vitest";
import * as weatherRoute from "@/app/api/farming/weather/route";
import * as compareRoute from "@/app/api/farming/weather/compare/route";
import * as forecastRoute from "@/app/api/farming/weather/forecast/route";
import * as keyRoute from "@/app/api/farming/weather/key/route";
import * as recordsRoute from "@/app/api/farming/weather/records/route";
import * as refreshRoute from "@/app/api/farming/weather/refresh/route";
import * as testRoute from "@/app/api/farming/weather/test/route";
import { findAiTool } from "@/lib/ai/catalogue";
import { readWeatherTables } from "@/lib/analytics/farm-weather";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { addGauge, addRainReading } from "@/lib/farming/rainfall";
import { latestRainDay } from "@/lib/farming/rainfall-rules";
import { todayIsoDate } from "@/lib/dates";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { getOrganisation } from "@/lib/organisations/registry";
import { FAKE_KEYS, fakeProvider, setWeatherProviderForTests, type WeatherProvider } from "@/lib/weather/provider";
import { runDueWeatherRefreshes, WEATHER_ACTOR } from "@/lib/weather/scheduler";
import { encryptSecret } from "@/lib/secrets";
import { keptForecastCount, refreshWeather, sweepOldForecasts } from "@/lib/weather/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

type Handler = (request: Request, context: never) => Promise<Response>;
const ORG = "weather-co";
const OTHER = "weather-other-co";
const KEY = "mskey-Example-Made-Up-0123456789abcdef";

/** MetService forecasts with the organisation's own key (WX1-WX10; decisions 1541-1550, not yet reviewed). Made-up farms, people and keys. */
describeWithDatabase("MetService weather forecast", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let outsider: SessionUser;
  let worker: SessionUser;
  let farmId = "";
  let calls = 0;
  const counting: WeatherProvider = {
    fetchForecast: (input) => {
      calls += 1;
      return fakeProvider.fetchForecast(input);
    },
  };
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);

  const call = async (user: SessionUser, handler: Handler, url: string, method = "GET", body?: Record<string, unknown>, org = ORG) => {
    const response = await handler(
      apiRequest(method === "GET" || method === "DELETE" ? `${url}${url.includes("?") ? "&" : "?"}organisationId=${org}` : url, { method, cookie: await sessionCookieFor(user), body: body ? { organisationId: org, ...body } : undefined }),
      { params: Promise.resolve({}) } as never,
    );
    const text = await response.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are checked field by field
    return { status: response.status, text, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
  };

  const organisation = async () => (await getOrganisation(ORG))!;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "weather-integration-test-secret-key-32-characters";
    setWeatherProviderForTests(counting);
    server = await startTestServer();
    owner = await createTestUser("weather-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("weather-viewer@example.com");
    worker = await createTestUser("weather-staff@example.com");
    outsider = await createTestUser("weather-outsider@example.com");
    await createTestOrganisation(owner, ORG);
    await createTestOrganisation(outsider, OTHER);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer'), ($1, $3, 'farm_worker')", [ORG, viewer.id, worker.id]);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    farmId = (await as((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
  });

  afterAll(async () => {
    setWeatherProviderForTests(null);
    await server?.teardown();
  });

  it("WX1, WX2 an admin saves the key; no answer, audit entry or stored column has it", async () => {
    const saved = await call(owner, keyRoute.PUT as Handler, "/api/farming/weather/key", "PUT", { key: KEY });
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(KEY);
    expect(saved.body.setup).toMatchObject({ hasKey: true, status: "not_tested", enabled: false, keySavedByEmail: "weather-owner@example.com" });
    const setup = await call(owner, weatherRoute.GET as Handler, "/api/farming/weather");
    expect(setup.text).not.toContain(KEY);
    const stored = await as((tx) => tx.query<{ api_key_ciphertext: string }>("select api_key_ciphertext from weather_settings"));
    expect(stored.rows[0].api_key_ciphertext).toMatch(/^v2:/);
    expect(stored.rows[0].api_key_ciphertext).not.toContain(KEY);
    const audit = await as((tx) => tx.query<{ details: unknown }>("select details from audit_events where event_type like 'weather.%'"));
    expect(JSON.stringify(audit.rows)).not.toContain(KEY);
    expect((await call(owner, keyRoute.PUT as Handler, "/api/farming/weather/key", "PUT", { key: "short" })).status).toBe(400);
  });

  it("WX1 the setup is admins' only, and another organisation's is refused", async () => {
    expect((await call(viewer, weatherRoute.GET as Handler, "/api/farming/weather")).status).toBe(403);
    expect((await call(viewer, keyRoute.PUT as Handler, "/api/farming/weather/key", "PUT", { key: KEY })).status).toBe(403);
    expect((await call(worker, testRoute.POST as Handler, "/api/farming/weather/test", "POST", {})).status).toBe(403);
    // Someone from another organisation can't reach this one's setup, forecast or key.
    expect([403, 404]).toContain((await call(outsider, weatherRoute.GET as Handler, "/api/farming/weather")).status);
    expect([403, 404]).toContain((await call(outsider, forecastRoute.GET as Handler, `/api/farming/weather/forecast?farmId=${farmId}`)).status);
    expect([403, 404]).toContain((await call(outsider, keyRoute.DELETE as Handler, "/api/farming/weather/key", "DELETE")).status);
    // Their own organisation has no key from this one.
    const theirs = await call(outsider, weatherRoute.GET as Handler, "/api/farming/weather", "GET", undefined, OTHER);
    expect([200, 400]).toContain(theirs.status);
    if (theirs.status === 200) expect(theirs.body.setup.hasKey).toBe(false);
  });

  it("WX7 Test connection: one unit; a refused key says so in plain words", async () => {
    const before = calls;
    const test = await call(owner, testRoute.POST as Handler, "/api/farming/weather/test", "POST", {});
    expect(test.body.test).toMatchObject({ status: "ok", statusText: "Connected.", unitsCharged: 1 });
    expect(calls - before).toBe(1);
    await call(owner, keyRoute.PUT as Handler, "/api/farming/weather/key", "PUT", { key: FAKE_KEYS.badKey });
    const bad = await call(owner, testRoute.POST as Handler, "/api/farming/weather/test", "POST", {});
    expect(bad.body.test.status).toBe("bad_key");
    expect(bad.body.test.statusText).toContain("didn't accept the key");
    await call(owner, keyRoute.PUT as Handler, "/api/farming/weather/key", "PUT", { key: KEY });
    expect((await call(owner, testRoute.POST as Handler, "/api/farming/weather/test", "POST", {})).body.test.status).toBe("ok");
  });

  it("WX1 farms, choices and turning on: needs a tested key and a pin; units are estimated", async () => {
    expect((await call(owner, weatherRoute.PATCH as Handler, "/api/farming/weather", "PATCH", { enabled: true })).status).toBe(409);
    const placed = await call(owner, weatherRoute.PATCH as Handler, "/api/farming/weather", "PATCH", { locations: [{ farmId, point: [169.9, -46.1] }] });
    expect(placed.body.setup.locations).toEqual([{ farmId, farmName: "Home farm", point: { latitude: "-46.100000", longitude: "169.900000" }, centre: null }]);
    expect((await call(owner, weatherRoute.PATCH as Handler, "/api/farming/weather", "PATCH", { choices: ["rain", "snow"] })).status).toBe(400);
    expect((await call(owner, weatherRoute.PATCH as Handler, "/api/farming/weather", "PATCH", { refreshHours: 2 })).status).toBe(400);
    const chosen = await call(owner, weatherRoute.PATCH as Handler, "/api/farming/weather", "PATCH", { choices: ["rain", "temperature", "wind"], refreshHours: 3 });
    expect(chosen.body.setup.estimate).toMatchObject({ perRefresh: 4, perDay: 32, per30Days: 960 });
    const step = await call(owner, weatherRoute.PATCH as Handler, "/api/farming/weather", "PATCH", { step: "choose" });
    expect(step.body.setup.step).toBe("choose");
    const on = await call(owner, weatherRoute.PATCH as Handler, "/api/farming/weather", "PATCH", { enabled: true });
    expect(on.body.setup.enabled).toBe(true);
  });

  it("WX3, WX4 a refresh keeps only the latest forecast; farm staff see it with the attribution; the key isn't in it", async () => {
    const empty = await call(worker, forecastRoute.GET as Handler, `/api/farming/weather/forecast?farmId=${farmId}`);
    expect(empty.body.forecast).toMatchObject({ enabled: true, placed: true, forecast: null, canRefresh: false });
    const first = await refreshWeather(await organisation(), WEATHER_ACTOR, { now: new Date() });
    expect(first).toMatchObject({ refreshed: 1, failed: 0, status: "ok" });
    const second = await refreshWeather(await organisation(), WEATHER_ACTOR, { now: new Date(Date.now() + 4 * 3_600_000) });
    expect(second.refreshed).toBe(1);
    expect(await as(keptForecastCount)).toEqual({ cache: 1, records: 0 });
    const seen = await call(worker, forecastRoute.GET as Handler, `/api/farming/weather/forecast?farmId=${farmId}`);
    expect(seen.status).toBe(200);
    expect(seen.text).not.toContain(KEY);
    expect(seen.body.forecast.attribution).toBe("This data was provided by MetService Limited.");
    expect(seen.body.forecast.forecast.hours.length).toBeGreaterThan(40);
    expect(seen.body.forecast.forecast.hours.length).toBeLessThanOrEqual(48);
    expect(seen.body.forecast.forecast.days.length).toBeLessThanOrEqual(7);
    expect(seen.body.forecast.forecast.hours[0]).toHaveProperty("gustKmh", null);
    // A refresh not yet due does nothing.
    expect((await refreshWeather(await organisation(), WEATHER_ACTOR, { now: new Date(Date.now() + 4 * 3_600_000 + 60_000) })).skipped).toBe("not_due");
  });

  it("WX6 the Refresh button: bookkeepers and up, at most once every 15 minutes", async () => {
    expect((await call(worker, refreshRoute.POST as Handler, "/api/farming/weather/refresh", "POST", {})).status).toBe(403);
    const first = await call(owner, refreshRoute.POST as Handler, "/api/farming/weather/refresh", "POST", {});
    expect(first.status).toBe(200);
    const again = await call(owner, refreshRoute.POST as Handler, "/api/farming/weather/refresh", "POST", {});
    expect(again.status).toBe(429);
    expect(again.body.error).toContain("Try again in");
  });

  it("WX7 no units left stops refreshing until the connection is tested again (the spending guard)", async () => {
    await as((tx) => tx.query("update weather_settings set api_key_ciphertext = $1", [encryptSecret(FAKE_KEYS.noUnits)]));
    const run = await refreshWeather(await organisation(), WEATHER_ACTOR, { now: new Date(Date.now() + 9 * 3_600_000) });
    expect(run.status).toBe("no_units");
    const before = calls;
    const skipped = await refreshWeather(await organisation(), WEATHER_ACTOR, { now: new Date(Date.now() + 20 * 3_600_000) });
    expect(skipped.skipped).toBe("paused");
    await runDueWeatherRefreshes(new Date(Date.now() + 21 * 3_600_000));
    expect(calls).toBe(before);
    const seen = await call(worker, forecastRoute.GET as Handler, `/api/farming/weather/forecast?farmId=${farmId}`);
    expect(seen.body.forecast).toMatchObject({ paused: true, status: "no_units" });
    // A new key, tested, starts it again.
    await call(owner, keyRoute.PUT as Handler, "/api/farming/weather/key", "PUT", { key: KEY });
    expect((await call(owner, testRoute.POST as Handler, "/api/farming/weather/test", "POST", {})).body.test.status).toBe("ok");
    const setup = await call(owner, weatherRoute.GET as Handler, "/api/farming/weather");
    expect(setup.body.setup.pausedAt).toBeNull();
  });

  it("WX2, WX6 the kept forecast goes when the key is removed, and at 24 hours", async () => {
    await refreshWeather(await organisation(), WEATHER_ACTOR, { now: new Date(Date.now() + 30 * 3_600_000) });
    expect((await as(keptForecastCount)).cache).toBe(1);
    // At 24 hours old it's no longer shown, and the sweep deletes it.
    await as((tx) => tx.query("update weather_forecast_cache set fetched_at = now() - interval '25 hours'"));
    const old = await call(worker, forecastRoute.GET as Handler, `/api/farming/weather/forecast?farmId=${farmId}`);
    expect(old.body.forecast.forecast).toBeNull();
    expect(await as((tx) => sweepOldForecasts(tx))).toBe(1);
    expect((await as(keptForecastCount)).cache).toBe(0);
    await refreshWeather(await organisation(), WEATHER_ACTOR, { now: new Date(Date.now() + 100 * 3_600_000) });
    expect((await as(keptForecastCount)).cache).toBe(1);
    const removed = await call(owner, keyRoute.DELETE as Handler, "/api/farming/weather/key", "DELETE");
    expect(removed.body.setup).toMatchObject({ hasKey: false, enabled: false });
    expect((await as(keptForecastCount)).cache).toBe(0);
    const audit = await as((tx) => tx.query<{ details: { forecastsDeleted: number } }>("select details from audit_events where event_type = 'weather.key_removed'"));
    expect(audit.rows[0].details.forecastsDeleted).toBe(1);
  });

  it("WX8 records are kept only with the permission switch on, which is recorded with who and when", async () => {
    await call(owner, keyRoute.PUT as Handler, "/api/farming/weather/key", "PUT", { key: KEY });
    await call(owner, testRoute.POST as Handler, "/api/farming/weather/test", "POST", {});
    await call(owner, weatherRoute.PATCH as Handler, "/api/farming/weather", "PATCH", { enabled: true });
    await refreshWeather(await organisation(), WEATHER_ACTOR, { now: new Date(Date.now() + 200 * 3_600_000) });
    expect((await as(keptForecastCount)).records).toBe(0);
    const form = new FormData();
    form.set("organisationId", ORG);
    form.set("grantedOn", "2026-10-01");
    form.set("reference", "Email from MetService, 1 October");
    form.set("file", new Blob([new TextEncoder().encode("%PDF-1.4 made-up permission")], { type: "application/pdf" }), "permission.pdf");
    const refused = await recordsRoute.POST(new Request("http://tohyee.test/api/farming/weather/records", { method: "POST", headers: { cookie: await sessionCookieFor(viewer), origin: "http://tohyee.test" }, body: form }), undefined as never);
    expect(refused.status).toBe(403);
    const form2 = new FormData();
    for (const [name, value] of form.entries()) form2.set(name, value);
    const response = await recordsRoute.POST(new Request("http://tohyee.test/api/farming/weather/records", { method: "POST", headers: { cookie: await sessionCookieFor(owner), origin: "http://tohyee.test" }, body: form2 }), undefined as never);
    expect(response.status).toBe(200);
    const setup = ((await response.json()) as { setup: { permission: Record<string, unknown> } }).setup;
    expect(setup.permission).toMatchObject({ keepRecords: true, grantedOn: "2026-10-01", reference: "Email from MetService, 1 October", setByEmail: "weather-owner@example.com", combine: false, file: { fileName: "permission.pdf" } });
    const audit = await as((tx) => tx.query<{ actor_email: string; details: { grantedOn: string } }>("select actor_email, details from audit_events where event_type = 'weather.records_turned_on'"));
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_email: "weather-owner@example.com", details: { grantedOn: "2026-10-01" } });
    await refreshWeather(await organisation(), WEATHER_ACTOR, { now: new Date(Date.now() + 210 * 3_600_000) });
    await refreshWeather(await organisation(), WEATHER_ACTOR, { now: new Date(Date.now() + 220 * 3_600_000) });
    expect(await as(keptForecastCount)).toEqual({ cache: 1, records: 2 });
  });

  it("WX9 combining (forecast vs gauge, Analytics, the AI) needs both switches", async () => {
    const tool = findAiTool("weather_forecast_records")!;
    expect(tool.level).toBe("read");
    // Records on, combining off: nothing combined.
    expect((await call(worker, compareRoute.GET as Handler, `/api/farming/weather/compare?farmId=${farmId}`)).status).toBe(409);
    await expect(as((tx) => tool.run(tx, { farmId }, {} as never))).rejects.toThrow("covers keeping and combining");
    expect(await as(readWeatherTables)).toEqual([]);
    const seen = await call(worker, forecastRoute.GET as Handler, `/api/farming/weather/forecast?farmId=${farmId}`);
    expect(seen.body.forecast.combine).toBe(false);
    // Combining can't be on without records.
    const combine = await call(owner, weatherRoute.PATCH as Handler, "/api/farming/weather", "PATCH", { combine: true });
    expect(combine.body.setup.permission.combine).toBe(true);
    const gauge = await as((tx) => addGauge(tx, { farmId, name: "Cowshed" }));
    await as((tx) => addRainReading(tx, { gaugeId: gauge.id, readOn: latestRainDay(todayIsoDate()), mm: "4.5" }));
    const compared = await call(worker, compareRoute.GET as Handler, `/api/farming/weather/compare?farmId=${farmId}&days=7`);
    expect(compared.status).toBe(200);
    expect(compared.body.comparison.gauge.name).toBe("Cowshed");
    expect(compared.body.comparison.days).toHaveLength(7);
    expect(compared.body.comparison.days.at(-1)).toMatchObject({ rainDay: latestRainDay(todayIsoDate()), gaugeMm: "4.5" });
    const answer = (await as((tx) => tool.run(tx, { farmId }, {} as never))) as { attribution: string; records: unknown[] };
    expect(answer.attribution).toBe("This data was provided by MetService Limited.");
    expect(answer.records).toHaveLength(2);
    const tables = await as(readWeatherTables);
    expect(tables[0].name).toBe("tohyee_farm_weather_forecasts");
    const rows = tables[0].rows as unknown[][];
    expect(rows.length).toBe(2 * 168);
    expect(rows[0].at(-1)).toBe("This data was provided by MetService Limited.");
    const audit = await as((tx) => tx.query("select 1 from audit_events where event_type = 'weather.combine_turned_on' and actor_email = 'weather-owner@example.com'"));
    expect(audit.rowCount).toBe(1);
  });

  it("WX10 turning records off deletes them by default, and turns combining off", async () => {
    expect((await call(viewer, recordsRoute.PATCH as Handler, "/api/farming/weather/records", "PATCH", {})).status).toBe(403);
    const off = await call(owner, recordsRoute.PATCH as Handler, "/api/farming/weather/records", "PATCH", {});
    expect(off.status).toBe(200);
    expect(off.body.setup.recordsDeleted).toBe(2);
    expect(off.body.setup.permission).toMatchObject({ keepRecords: false, combine: false, records: 0 });
    expect(await as(keptForecastCount)).toEqual({ cache: 1, records: 0 });
    expect((await call(worker, compareRoute.GET as Handler, `/api/farming/weather/compare?farmId=${farmId}`)).status).toBe(409);
    expect(await as(readWeatherTables)).toEqual([]);
    await refreshWeather(await organisation(), WEATHER_ACTOR, { now: new Date(Date.now() + 300 * 3_600_000) });
    expect((await as(keptForecastCount)).records).toBe(0);
    // Combining needs records on.
    expect((await call(owner, weatherRoute.PATCH as Handler, "/api/farming/weather", "PATCH", { combine: true })).status).toBe(409);
    const audit = await as((tx) => tx.query<{ details: { recordsDeleted: number } }>("select details from audit_events where event_type = 'weather.records_turned_off'"));
    expect(audit.rows[0].details.recordsDeleted).toBe(2);
  });
});
