import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { getOrganisation } from "@/lib/organisations/registry";
import { fakeProvider, setWeatherProviderForTests, type WeatherProvider, WeatherProviderError } from "@/lib/weather/provider";
import { runDueWeatherRefreshes, WEATHER_ACTOR } from "@/lib/weather/scheduler";
import {
  getWeatherSetup,
  refreshWeather,
  removeWeatherKey,
  saveWeatherChoices,
  saveWeatherKey,
  saveWeatherLocations,
  setWeatherEnabled,
  testWeatherConnection,
} from "@/lib/weather/service";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "weather-guards-co";
const KEY = "mskey-Example-Made-Up-guards-0123456789";
const NEW_KEY = "mskey-Example-Made-Up-guards-replacement-9876";

/**
 * Issue #619 findings 2 and 3: a refresh or connection test that's still
 * waiting on MetService when the settings change mustn't write the old
 * answer back, and a replaced key isn't used until it passes Test
 * connection. Made-up farms, people and keys.
 */
describeWithDatabase("MetService refresh guards (#619)", () => {
  let server: TestServer;
  let owner: SessionUser;
  const farms: string[] = [];
  let calls: Array<{ apiKey: string; choices: readonly string[] }> = [];
  // When set, each call waits here until the test lets it answer.
  let gate: { reached: () => void; release: Promise<void> } | null = null;
  let failNext: WeatherProviderError | null = null;
  const provider: WeatherProvider = {
    fetchForecast: async (input) => {
      calls.push({ apiKey: input.apiKey, choices: input.choices });
      if (gate) {
        const current = gate;
        gate = null;
        current.reached();
        await current.release;
      }
      if (failNext) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      return fakeProvider.fetchForecast(input);
    },
  };
  /** Holds the next provider call; resolves `reached` once it's waiting. */
  const holdNextCall = () => {
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => (reached = resolve));
    gate = { reached, release: new Promise<void>((resolve) => (release = resolve)) };
    return { waiting, release };
  };
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const organisation = async () => (await getOrganisation(ORG))!;
  const actor = () => ({ userId: owner.id, email: owner.email });
  const cacheRows = () => as((tx) => tx.query<{ farm_id: string; choices: string[] }>("select farm_id::text, choices from weather_forecast_cache order by farm_id")).then((result) => result.rows);
  let clock = Date.now();
  const later = () => new Date((clock += 24 * 3_600_000));

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "weather-guards-test-secret-key-32-characters!";
    setWeatherProviderForTests(provider);
    server = await startTestServer();
    owner = await createTestUser("weather-guards-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    farms.push((await as((tx) => saveFarm(tx, { name: "Top farm" })))[0].id);
    farms.push((await as((tx) => saveFarm(tx, { name: "Bottom farm" }))).find((farm) => farm.name === "Bottom farm")!.id);
  });

  afterAll(async () => {
    setWeatherProviderForTests(null);
    await server?.teardown();
  });

  // Each test starts with a tested key, both farms pinned, weather on and nothing kept.
  beforeEach(async () => {
    gate = null;
    failNext = null;
    await as((tx) => saveWeatherKey(tx, KEY));
    expect((await testWeatherConnection(await organisation(), actor())).status).toBe("ok");
    await as((tx) => saveWeatherLocations(tx, [{ farmId: farms[0], point: [169.9, -46.1] }, { farmId: farms[1], point: [170.1, -46.2] }]));
    await as((tx) => saveWeatherChoices(tx, { choices: ["rain", "temperature", "wind"] }));
    await as((tx) => setWeatherEnabled(tx, true));
    await as((tx) => tx.query("delete from weather_forecast_cache"));
    calls = [];
  });

  it("removing the key while a refresh waits on MetService: nothing is written back", async () => {
    const held = holdNextCall();
    const run = refreshWeather(await organisation(), WEATHER_ACTOR, { now: later() });
    await held.waiting;
    await as(removeWeatherKey);
    held.release();
    const result = await run;
    expect(await cacheRows()).toEqual([]);
    // The second farm isn't asked for either.
    expect(calls).toHaveLength(1);
    expect(result.refreshed).toBe(0);
    const setup = await as(getWeatherSetup);
    expect(setup).toMatchObject({ hasKey: false, enabled: false, status: "not_tested" });
  });

  it("replacing the key while a refresh waits: the old key's answer isn't kept, and its refusal doesn't mark the new key", async () => {
    const held = holdNextCall();
    failNext = new WeatherProviderError("bad_key", "MetService answered 401.");
    const run = refreshWeather(await organisation(), WEATHER_ACTOR, { now: later() });
    await held.waiting;
    await as((tx) => saveWeatherKey(tx, NEW_KEY));
    held.release();
    await run;
    expect(await cacheRows()).toEqual([]);
    const setup = await as(getWeatherSetup);
    // Still waiting for its own test: not paused or marked refused by the old key's answer.
    expect(setup.status).toBe("not_tested");
    expect(setup.pausedAt).toBeNull();
  });

  it("turning weather off while a refresh waits: nothing is written back", async () => {
    const held = holdNextCall();
    const run = refreshWeather(await organisation(), WEATHER_ACTOR, { now: later() });
    await held.waiting;
    await as((tx) => setWeatherEnabled(tx, false));
    held.release();
    await run;
    expect(await cacheRows()).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("turning weather off and on again while a refresh waits: the old run still stops", async () => {
    const held = holdNextCall();
    const run = refreshWeather(await organisation(), WEATHER_ACTOR, { now: later() });
    await held.waiting;
    await as((tx) => setWeatherEnabled(tx, false));
    await as((tx) => setWeatherEnabled(tx, true));
    held.release();
    await run;
    expect(await cacheRows()).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("changing what's fetched while a refresh waits: the old variables aren't kept", async () => {
    const held = holdNextCall();
    const run = refreshWeather(await organisation(), WEATHER_ACTOR, { now: later() });
    await held.waiting;
    await as((tx) => saveWeatherChoices(tx, { choices: ["rain"] }));
    held.release();
    await run;
    expect(await cacheRows()).toEqual([]);
    expect(calls).toHaveLength(1);
    // The next run fetches the new choice for both farms.
    const next = await refreshWeather(await organisation(), WEATHER_ACTOR, { now: later() });
    expect(next.refreshed).toBe(2);
    expect((await cacheRows()).map((row) => row.choices)).toEqual([["rain"], ["rain"]]);
  });

  it("a replaced key gets no scheduled or manual calls until its connection test passes", async () => {
    await as((tx) => saveWeatherKey(tx, NEW_KEY));
    expect((await as(getWeatherSetup)).enabled).toBe(true);
    await runDueWeatherRefreshes(later());
    expect((await refreshWeather(await organisation(), WEATHER_ACTOR, { now: later() })).skipped).toBe("not_tested");
    expect((await refreshWeather(await organisation(), actor(), { manual: true, now: later() })).skipped).toBe("not_tested");
    expect(calls.filter((call) => call.apiKey === NEW_KEY)).toEqual([]);
    expect((await testWeatherConnection(await organisation(), actor())).status).toBe("ok");
    calls = [];
    expect((await refreshWeather(await organisation(), WEATHER_ACTOR, { now: later() })).refreshed).toBe(2);
    expect(calls.every((call) => call.apiKey === NEW_KEY)).toBe(true);
  });

  it("a connection test still waiting when the key is replaced doesn't pass the new key", async () => {
    await as((tx) => saveWeatherKey(tx, NEW_KEY));
    const held = holdNextCall();
    const test = testWeatherConnection(await organisation(), actor());
    await held.waiting;
    await as((tx) => saveWeatherKey(tx, KEY));
    held.release();
    await test;
    const setup = await as(getWeatherSetup);
    expect(setup.status).toBe("not_tested");
    calls = [];
    expect((await refreshWeather(await organisation(), WEATHER_ACTOR, { now: later() })).skipped).toBe("not_tested");
    expect(calls).toEqual([]);
  });

  it("a passing-glitch error after the key was tested still retries at the next refresh", async () => {
    failNext = new WeatherProviderError("error", "MetService couldn't be reached.");
    const first = await refreshWeather(await organisation(), WEATHER_ACTOR, { now: later() });
    expect(first.status).toBe("error");
    const next = await refreshWeather(await organisation(), WEATHER_ACTOR, { now: later() });
    expect(next.skipped).toBeUndefined();
    expect(next.refreshed).toBe(2);
  });
});
