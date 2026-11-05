import { describe, expect, it } from "vitest";
import { COPERNICUS, createCopernicusProvider, EVALSCRIPT, passesFromItems, processRequest } from "@/lib/farming/vegetation/copernicus";
import { createDemoProvider, demoPicture } from "@/lib/farming/vegetation/fake-provider";
import { bandsFromPicture } from "@/lib/farming/vegetation/provider";
import type { Grid } from "@/lib/farming/vegetation/raster";
import { attributionText, changeText, estimateUnits, farmState, ndviText, paddockQuality } from "@/lib/farming/vegetation/rules";

/* Satellite vegetation rules, the demo provider and the Copernicus adapter with a pretend fetch (#612). Nothing here calls Copernicus. */

describe("states", () => {
  const base = { connected: true, reconnect: false, farmEnabled: true, paused: false, jobsWaiting: false, lastUsableOn: "2026-11-01", lastSceneOn: "2026-11-03", today: "2026-11-05" };
  it("ready with a clear picture in the last 20 days", () => expect(farmState(base)).toBe("ready"));
  it("not set up until connected and on for the farm", () => {
    expect(farmState({ ...base, connected: false })).toBe("not_set_up");
    expect(farmState({ ...base, farmEnabled: false })).toBe("not_set_up");
  });
  it("reconnect and paused win over the pictures", () => {
    expect(farmState({ ...base, reconnect: true })).toBe("reconnect");
    expect(farmState({ ...base, paused: true })).toBe("quota_paused");
  });
  it("checking until the first date arrives", () => expect(farmState({ ...base, lastUsableOn: null, lastSceneOn: null })).toBe("checking"));
  it("cloudy when recent dates were all cloud, stale when nothing clear for 20 days", () => {
    expect(farmState({ ...base, lastUsableOn: null })).toBe("cloudy");
    expect(farmState({ ...base, lastUsableOn: "2026-10-01", lastSceneOn: "2026-10-02" })).toBe("stale");
    expect(farmState({ ...base, lastUsableOn: "2026-10-01" })).toBe("cloudy");
  });
});

describe("quality thresholds", () => {
  const t = { minCoveragePct: 80, minValidPixels: 20 };
  it("good, partly hidden, too small and no data", () => {
    expect(paddockQuality({ totalPixels: 100, validPixels: 90, edgePixels: 20 }, t)).toEqual({ quality: "good", coveragePct: 90, flags: [] });
    expect(paddockQuality({ totalPixels: 100, validPixels: 70, edgePixels: 20 }, t).quality).toBe("low_coverage");
    expect(paddockQuality({ totalPixels: 15, validPixels: 15, edgePixels: 15 }, t)).toEqual({ quality: "too_small", coveragePct: 100, flags: ["small", "narrow_or_edge"] });
    expect(paddockQuality({ totalPixels: 100, validPixels: 0, edgePixels: 20 }, t)).toEqual({ quality: "no_data", coveragePct: 0, flags: [] });
  });
});

describe("words", () => {
  it("attribution exactly as the licence asks, and never for made-up pictures", () => {
    expect(attributionText("copernicus", [2026])).toBe("Contains modified Copernicus Sentinel data 2026");
    expect(attributionText("copernicus", [2026, 2025, 2026])).toBe("Contains modified Copernicus Sentinel data 2025–2026");
    expect(attributionText("demo", [2026])).toBe("Made-up demo pictures, not satellite data.");
  });
  it("numbers", () => {
    expect(ndviText(null)).toBe("No clear view");
    expect(ndviText("0.7123")).toBe("0.71");
    expect(changeText("-0.1234")).toBe("−0.12");
    expect(changeText(0.05)).toBe("+0.05");
    expect(changeText(null)).toBe("Can't compare");
  });
  it("estimates processing units from the published rule (512 × 512 × 3 bands is 1)", () => {
    expect(estimateUnits(512, 512)).toBe(1);
    expect(estimateUnits(200, 150)).toBe(0.1144);
    expect(estimateUnits(2, 2)).toBe(0.01);
  });
});

const GRID: Grid = { crs: "EPSG:3857", pixel: 14.5, minX: 18_894_000, maxY: -5_816_000, width: 40, height: 30 };

describe("the demo provider", () => {
  it("finds a pass every 5 days and gives the same picture each time", async () => {
    const provider = createDemoProvider();
    const dates = await provider.search({ box: [169.7, -46.3, 169.8, -46.2], from: "2026-10-01T00:00:00Z", to: "2026-11-05T00:00:00Z", maxSceneCloudPct: 80 });
    expect(dates.length).toBe(7);
    expect(dates[0].acquiredAt).toMatch(/T22:35:00Z$/);
    const a = await provider.fetch({ grid: GRID, candidate: dates[0] });
    const b = await provider.fetch({ grid: GRID, candidate: dates[0] });
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(true);
  });

  it("has cloudy, half-cloudy and clear dates", async () => {
    const dates = await createDemoProvider().search({ box: [0, 0, 1, 1], from: "2026-09-01T00:00:00Z", to: "2026-11-05T00:00:00Z", maxSceneCloudPct: 80 });
    const kinds = new Set(
      dates.map((date) => {
        const scl = bandsFromPicture(demoPicture(GRID, Date.parse(date.acquiredAt)), GRID).scl;
        const cloud = scl.filter((value) => value === 8 || value === 9).length / scl.length;
        return cloud > 0.95 ? "cloudy" : cloud > 0.1 ? "half" : "clear";
      }),
    );
    expect([...kinds].sort()).toEqual(["clear", "cloudy", "half"]);
  });
});

describe("the Copernicus adapter (pretend fetch; not tried against the live service)", () => {
  it("groups catalogue items into passes and leaves out very cloudy ones", () => {
    const passes = passesFromItems(
      [
        { id: "S2B_A", properties: { datetime: "2026-10-30T22:35:19.024Z", "eo:cloud_cover": 40, "processing:version": "05.11", platform: "sentinel-2b" } },
        { id: "S2B_B", properties: { datetime: "2026-10-30T22:35:33.000Z", "eo:cloud_cover": 12 } },
        { id: "S2C_C", properties: { datetime: "2026-11-02T22:45:00Z", "eo:cloud_cover": 95 } },
        { id: "bad", properties: {} },
      ],
      80,
    );
    expect(passes).toEqual([{ acquiredAt: "2026-10-30T22:35:19Z", productIds: ["S2B_A", "S2B_B"], sceneCloudPct: 12, processingBaseline: "05.11", platform: "sentinel-2b" }]);
  });

  it("asks for the farm's grid only, with harmonised 16-bit DN", () => {
    const body = processRequest(GRID, { acquiredAt: "2026-10-30T22:35:19Z", productIds: [], sceneCloudPct: 1, processingBaseline: null, platform: null }) as { input: { bounds: { bbox: number[]; properties: { crs: string } }; data: Array<Record<string, unknown>> }; output: Record<string, unknown> };
    expect(body.input.bounds.bbox).toEqual([18_894_000, -5_816_435, 18_894_580, -5_816_000]);
    expect(body.input.bounds.properties.crs).toBe("http://www.opengis.net/def/crs/EPSG/0/3857");
    expect(body.input.data[0]).toMatchObject({ type: "sentinel-2-l2a", processing: { harmonizeValues: true } });
    expect(body.output).toMatchObject({ width: 40, height: 30 });
    expect(EVALSCRIPT).toContain('bands: ["B04", "B08", "SCL", "dataMask"]');
    expect(EVALSCRIPT).toContain('sampleType: "UINT16"');
  });

  function pretend(answers: Array<(url: string, init: RequestInit) => Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return answers[calls.length - 1](url, init);
    }) as unknown as typeof fetch;
    return { calls, fetcher };
  }

  it("Test connection: wrong secret, not activated, quota used up, fine", async () => {
    const credentials = { clientId: "sh-1234", clientSecret: "s3cret-value" };
    const wrong = pretend([() => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 })]);
    expect(await createCopernicusProvider(credentials, { fetcher: wrong.fetcher }).checkConnection()).toMatchObject({ ok: false, reason: "wrong_credentials" });
    // The secret goes to the token endpoint only, in the form body.
    expect(wrong.calls[0].url).toBe(COPERNICUS.tokenUrl);
    expect(String(wrong.calls[0].init.body)).toContain("client_secret=s3cret-value");

    const token = () => new Response(JSON.stringify({ access_token: "t", expires_in: 600 }), { status: 200 });
    const inactive = pretend([token, () => new Response("Forbidden", { status: 403 })]);
    expect(await createCopernicusProvider(credentials, { fetcher: inactive.fetcher }).checkConnection()).toMatchObject({ ok: false, reason: "not_activated" });
    expect(inactive.calls[1].init.headers).toMatchObject({ authorization: "Bearer t" });
    expect(String(inactive.calls[1].init.body)).not.toContain("s3cret");

    const quota = pretend([token, () => new Response('{"error":{"code":"ACCESS_INSUFFICIENT_PROCESSING_UNITS"}}', { status: 403 })]);
    expect(await createCopernicusProvider(credentials, { fetcher: quota.fetcher }).checkConnection()).toMatchObject({ ok: false, reason: "quota" });

    const down = pretend([() => { throw new TypeError("fetch failed"); }]);
    expect(await createCopernicusProvider(credentials, { fetcher: down.fetcher }).checkConnection()).toMatchObject({ ok: false, reason: "unreachable" });

    const fine = pretend([token, () => new Response(new Uint8Array([1]), { status: 200 })]);
    expect(await createCopernicusProvider(credentials, { fetcher: fine.fetcher }).checkConnection()).toEqual({ ok: true });
  });

  it("reads the processing units the provider says it spent, and passes on 'slow down'", async () => {
    const token = () => new Response(JSON.stringify({ access_token: "t", expires_in: 600 }), { status: 200 });
    const picture = pretend([token, () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "x-processingunits-spent": "0.0457" } })]);
    const provider = createCopernicusProvider({ clientId: "sh-1", clientSecret: "secret-1" }, { fetcher: picture.fetcher });
    const fetched = await provider.fetch({ grid: GRID, candidate: { acquiredAt: "2026-10-30T22:35:19Z", productIds: [], sceneCloudPct: 1, processingBaseline: null, platform: null } });
    expect(fetched).toMatchObject({ unitsSpent: 0.0457, dnOffset: 0, requests: 1 });
    const slow = pretend([token, () => new Response("Too many", { status: 429, headers: { "retry-after": "30" } })]);
    await expect(createCopernicusProvider({ clientId: "sh-1", clientSecret: "secret-1" }, { fetcher: slow.fetcher }).fetch({ grid: GRID, candidate: { acquiredAt: "2026-10-30T22:35:19Z", productIds: [], sceneCloudPct: 1, processingBaseline: null, platform: null } })).rejects.toMatchObject({ kind: "rate_limited", retryAfterSeconds: 30 });
  });
});
