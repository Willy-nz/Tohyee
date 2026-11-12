import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import * as weatherDaysRoute from "@/app/api/farming/farms/[farmId]/weather-days/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import type { PaddockGeometry } from "@/lib/farming/geometry";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { coverCheck, turnOnCoverEstimates } from "@/lib/farming/vegetation/cover-model";
import { currentBoundaries, getFarmVegetation } from "@/lib/farming/vegetation/service";
import { farmWeatherDays, refreshFarmWeather } from "@/lib/farming/weather-history";
import { shiftDay } from "@/lib/farming/weather-history-rules";
import { getOrganisation } from "@/lib/organisations/registry";
import { encryptSecret } from "@/lib/secrets";
import { fakeProvider, setWeatherProviderForTests } from "@/lib/weather/provider";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-weather-co";
const box = (lon: number, lat: number): PaddockGeometry => ({
  type: "Polygon",
  coordinates: [[[lon, lat], [lon + 0.004, lat], [lon + 0.004, lat + 0.003], [lon, lat + 0.003], [lon, lat]]],
});
/** Hours of a New Zealand day (NZDT, UTC+13) at a rain rate. */
const dayHours = (day: string, rain: string) =>
  Array.from({ length: 24 }, (_, i) => ({ at: new Date(Date.parse(`${shiftDay(day, -1)}T11:00:00Z`) + i * 3_600_000).toISOString(), rainMm: rain, temperatureC: "12.0" }));

/** FW1-FW8, MCV9 (decision 1597, not yet reviewed). Made-up farm and forecasts. */
describeWithDatabase("farm weather from kept MetService forecasts", () => {
  let server: TestServer;
  let owner: SessionUser;
  const w = {} as Record<string, string>;
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY ??= "farm-weather-test-secret-key-at-least-32-characters";
    server = await startTestServer();
    owner = await createTestUser("farm-weather-owner@example.com", { displayName: "Aroha" });
    await createTestOrganisation(owner, ORG);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await run((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    await run(async (tx) => {
      await tx.query("insert into weather_settings (id) values (true) on conflict (id) do nothing");
      await tx.query("insert into weather_locations (farm_id, latitude, longitude, updated_by_email) values ($1, -46.24, 169.73, 'owner@example.com')", [w.home]);
    });
  });
  afterEach(() => setWeatherProviderForTests(null));
  afterAll(async () => {
    await server?.teardown();
  });

  const switches = (on: { keep: boolean; combine: boolean }) =>
    run((tx) =>
      tx.query("update weather_settings set api_key_ciphertext = $1, enabled = true, key_tested = true, keep_records = $2, combine = $3 where id = true", [
        encryptSecret("made-up-key"),
        on.keep,
        on.combine,
      ]),
    );

  it("FW1: nothing while records aren't kept or combining isn't allowed", async () => {
    await switches({ keep: true, combine: false });
    const organisation = (await getOrganisation(ORG))!;
    expect(await refreshFarmWeather(organisation, { now: new Date("2026-11-10T00:00:00Z") })).toMatchObject({ farms: 0, skipped: expect.stringContaining("combined with farm data") });
    const seen = await weatherDaysRoute.GET(apiRequest(`/x?organisationId=${ORG}`, { cookie: await sessionCookieFor(owner) }), params({ farmId: w.home }));
    expect(((await seen.json()) as { weather: { on: boolean } }).weather.on).toBe(false);
  });

  it("FW2-FW4: days worked out from kept forecasts and MetService's recent history; a gauge reading comes first", async () => {
    await switches({ keep: true, combine: true });
    await run((tx) =>
      tx.query("insert into weather_forecast_history (farm_id, latitude, longitude, fetched_at, choices, hours) values ($1, -46.24, 169.73, '2026-10-31T00:00:00Z', '{rain,temperature}', $2::jsonb)", [
        w.home,
        JSON.stringify([...dayHours("2026-11-01", "0.5"), ...dayHours("2026-11-02", "0.0")]),
      ]),
    );
    let calls = 0;
    setWeatherProviderForTests({ fetchForecast: (input) => ((calls += 1), fakeProvider.fetchForecast(input)) });
    const organisation = (await getOrganisation(ORG))!;
    const result = await refreshFarmWeather(organisation, { now: new Date("2026-11-10T00:00:00Z") });
    expect(result).toMatchObject({ fetched: 1, error: null });
    expect(calls).toBe(1);
    // A second run the same day doesn't fetch the history again.
    await refreshFarmWeather(organisation, { now: new Date("2026-11-10T03:00:00Z") });
    expect(calls).toBe(1);
    const days = await run((tx) => farmWeatherDays(tx, w.home, "2026-11-01", "2026-11-09"));
    expect(days[0]).toMatchObject({ day: "2026-11-01", rainMm: "12.0", rainSource: "metservice", temperatureC: "12.0", hours: 24 });
    expect(days[1]).toMatchObject({ day: "2026-11-02", rainMm: "0.0" });
    // MetService's five days of history (5-9 Nov) fill days no forecast covered.
    expect(days.some((day) => day.day === "2026-11-06" && day.hours === 24)).toBe(true);

    // A gauge reading on 1 Nov wins, with MetService's shown beside it.
    await run(async (tx) => {
      const gauge = (await tx.query<{ id: string }>("insert into rain_gauges (farm_id, name, created_by_email) values ($1, 'House', 'owner@example.com') returning id::text", [w.home])).rows[0].id;
      await tx.query("insert into rainfall_readings (farm_id, gauge_id, read_on, mm, source, created_by_email) values ($1, $2, '2026-11-01', 9.5, 'test', 'owner@example.com')", [w.home, gauge]);
    });
    expect((await run((tx) => farmWeatherDays(tx, w.home, "2026-11-01", "2026-11-01")))[0]).toMatchObject({ rainMm: "9.5", rainSource: "gauge", metserviceRainMm: "12.0" });
  });

  it("MCV9: rain before the picture is used for modelled cover only when it was closer", async () => {
    // Four paddocks, six clear dates; each date's 14 days before have a known rain; cover = 500 + 3000 × greenness + 20 × that rain.
    const paddocks: string[] = [];
    for (let i = 0; i < 4; i += 1) paddocks.push((await run((tx) => addPaddock(tx, { farmId: w.home, name: String(i + 1), geometry: box(169.73 + i * 0.005, -46.24) }))).id);
    const ndvis = ["0.40", "0.55", "0.70", "0.85"];
    const rates = ["0.0", "0.2", "0.1", "0.3", "0.0", "0.15"];
    const dates = ["2026-07-20", "2026-08-10", "2026-08-31", "2026-09-21", "2026-10-12", "2026-10-31"];
    for (const [d, on] of dates.entries()) {
      await run(async (tx) => {
        for (let back = 1; back <= 14; back += 1) {
          await tx.query(
            "insert into farm_weather_days (farm_id, day, source, rain_mm, temperature_c, hours) values ($1, $2, 'metservice', $3::numeric, 10, 24) on conflict do nothing",
            [w.home, shiftDay(on, -back), (Number(rates[d]) * 24).toFixed(1)],
          );
        }
        const scene = (
          await tx.query<{ id: string }>(
            `insert into vegetation_scenes (farm_id, provider, acquired_at, retrieved_at, product_ids, processor_version, licence, grid, usable, farm_valid_pct)
             values ($1, 'demo', ($2::date + time '11:00') at time zone 'Pacific/Auckland', now(), '{demo}', 'tohyee-ndvi-1', 'Made-up', '{}'::jsonb, true, 100) returning id::text`,
            [w.home, on],
          )
        ).rows[0].id;
        const boundaries = await currentBoundaries(tx, w.home);
        for (const [i, paddock] of paddocks.entries()) {
          await tx.query(
            `insert into vegetation_observations (scene_id, farm_id, paddock_id, boundary_id, processor_version, acquired_at, total_pixels, valid_pixels, edge_pixels, coverage_pct, mean_ndvi, median_ndvi, quality)
             values ($1, $2, $3, $4, 'tohyee-ndvi-1', ($5::date + time '11:00') at time zone 'Pacific/Auckland', 100, 100, 10, 100, $6::numeric, $6::numeric, 'good')`,
            [scene, w.home, paddock, boundaries.find((entry) => entry.paddockId === paddock)!.boundaryId, on, ndvis[i]],
          );
          const rain14 = Number(rates[d]) * 24 * 14;
          await tx.query("insert into pasture_readings (farm_id, paddock_id, measured_on, cover, method, source, created_by_email) values ($1, $2, $3, $4, 'plate_meter', 'test', 'owner@example.com')", [
            w.home,
            paddock,
            on,
            Math.round(500 + 3000 * Number(ndvis[i]) + 20 * rain14),
          ]);
        }
      });
    }
    const check = await run((tx) => coverCheck(tx, w.home));
    expect(check.validation.weather).toMatchObject({ pairs: 24, dates: 6, best: "rain" });
    const model = await run((tx) => turnOnCoverEstimates(tx, w.home, { acceptableError: 100 }));
    expect(model.line).toMatchObject({ slope: "3000.0000", rain: "20.0000" });
    const latest = await run((tx) => getFarmVegetation(tx, w.home));
    // 31 Oct: 0.15 mm/h for 14 days = 50.4 mm; paddock 3 (0.70): 500 + 2100 + 1008 = 3608 → 3610.
    expect(latest.observations.find((observation) => observation.paddockId === paddocks[2])!.modelledCover).toMatchObject({ cover: 3610 });
  });
});
