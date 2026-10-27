import { afterAll, beforeAll, expect, it } from "vitest";
import * as keysRoute from "@/app/api/farming/app-keys/route";
import * as revokeRoute from "@/app/api/farming/app-keys/[keyId]/revoke/route";
import * as farmsRoute from "@/app/api/farm-apps/v1/farms/route";
import * as meRoute from "@/app/api/farm-apps/v1/me/route";
import * as openApiRoute from "@/app/api/farm-apps/v1/openapi.json/route";
import * as coverRoute from "@/app/api/farm-apps/v1/pasture/cover/route";
import * as readingsRoute from "@/app/api/farm-apps/v1/pasture/readings/route";
import * as soilPaddocksRoute from "@/app/api/farm-apps/v1/soil/paddocks/route";
import * as samplesRoute from "@/app/api/farm-apps/v1/soil/samples/route";
import * as testsRoute from "@/app/api/farm-apps/v1/soil/tests/route";
import * as mcpRoute from "@/app/api/mcp/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { listReadings } from "@/lib/farming/pasture";
import { addSoilTest } from "@/lib/farming/soil";
import { listSoilSamples } from "@/lib/farming/soil-samples";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-apps-co";
const BASE = "http://tohyee.test/api/farm-apps/v1";
type Json = Record<string, unknown>;
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const context = { params: Promise.resolve({}) };

async function app(handler: Handler, key: string | null, path: string, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const response = await handler(new Request(`${BASE}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), context);
  return { status: response.status, headers: response.headers, body: (await response.json()) as Json };
}

/** The Farming API for people's own apps (FA1-FA8, decision 561; not yet reviewed). */
describeWithDatabase("the Farming API for people's own apps", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  let farmId = "";
  let twelveId = "";

  async function makeKey(user: SessionUser, name: string, scopes: string[]) {
    const response = await keysRoute.POST(apiRequest("/api/farming/app-keys", { method: "POST", cookie: await sessionCookieFor(user), body: { organisationId: ORG, name, scopes } }), undefined as unknown);
    return { status: response.status, body: (await response.json()) as Json };
  }

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("farm-apps-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("farm-apps-viewer@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    farmId = (await as((tx) => saveFarm(tx, { name: "Home block" })))[0].id;
    twelveId = (await as((tx) => addPaddock(tx, { farmId, name: "12", effectiveHa: "20.0", onDate: "2026-07-01" }))).id;
    await as((tx) => addPaddock(tx, { farmId, name: "14", effectiveHa: "15.0", onDate: "2026-07-01" }));
    await as((tx) => addSoilTest(tx, { paddockId: twelveId, sampledOn: "2026-08-15", results: [{ measure: "Olsen P", value: "28", unit: "mg/L" }] }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("FA1, FA2 keys with scopes; a viewer can't make a recording key; the key is shown once", async () => {
    const refused = await makeKey(viewer, "Viewer sampler", ["read_soil", "record_soil_samples"]);
    expect([refused.status, refused.body.error]).toEqual([403, "Recording needs the bookkeeper role or higher."]);
    expect((await makeKey(owner, "Nothing", [])).status).toBe(400);
    expect((await makeKey(owner, "Odd", ["read_books"])).status).toBe(400);
    const made = await makeKey(owner, "Soil sampler", ["record_soil_samples", "read_farm", "read_soil", "read_soil"]);
    expect(made.status).toBe(201);
    expect(made.body.key).toMatch(/^tohyee_app_[A-Za-z0-9_-]{43}$/);
    expect(made.body.appKey).toMatchObject({ name: "Soil sampler", scopes: ["read_farm", "read_soil", "record_soil_samples"], revokedAt: null });
    const listed = await keysRoute.GET(apiRequest(`/api/farming/app-keys?organisationId=${ORG}`, { cookie: await sessionCookieFor(owner) }), undefined as unknown);
    const text = await listed.text();
    expect(text).not.toContain(made.body.key as string);
    expect(JSON.parse(text).keys).toHaveLength(1);
  });

  it("FA3-FA5 an app reads paddocks and soil, and records a sample marked with the app", async () => {
    const key = (await makeKey(owner, "Soil sampler 2", ["read_farm", "read_soil", "record_soil_samples"])).body.key as string;
    const me = await app(meRoute.GET, key, "/me");
    expect(me.body).toMatchObject({ organisation: { id: ORG }, key: "Soil sampler 2", scopes: ["read_farm", "read_soil", "record_soil_samples"] });
    const farms = await app(farmsRoute.GET, key, "/farms");
    expect(((farms.body.farms as Json[])[0].paddocks as Json[]).map((paddock) => paddock.name)).toEqual(["12", "14"]);
    // FA5: never tested first, then oldest; no "due" rule.
    const paddocks = await app(soilPaddocksRoute.GET, key, "/soil/paddocks");
    expect((paddocks.body.paddocks as Json[]).map((paddock) => [paddock.paddockName, paddock.lastSampledOn])).toEqual([["14", null], ["12", "2026-08-15"]]);
    expect(((await app(testsRoute.GET, key, `/soil/tests?paddockId=${twelveId}`)).body.tests as Json[]).length).toBe(1);
    const sample = await app(samplesRoute.POST, key, "/soil/samples", { method: "POST", body: { paddockId: twelveId, takenOn: "2026-10-19", sampleName: "12-A", depth: "0-75 mm", latitude: -46.123456, longitude: 169.987654 } });
    expect(sample.status).toBe(201);
    expect(sample.body.sample).toMatchObject({ paddockName: "12", sampleName: "12-A", latitude: "-46.123456", longitude: "169.987654", recordedVia: 'app "Soil sampler 2"', createdByEmail: owner.email });
    expect((await app(samplesRoute.POST, key, "/soil/samples", { method: "POST", body: { paddockId: twelveId, takenOn: "2026-10-19", latitude: -46.1 } })).body.error).toBe("Give both latitude and longitude, or neither.");
    expect((await app(samplesRoute.POST, key, "/soil/samples", { method: "POST", body: { paddockId: twelveId, takenOn: "2026-10-19", latitude: -95, longitude: 170 } })).status).toBe(400);
    expect(await as((tx) => listSoilSamples(tx, { farmId }))).toHaveLength(1);
    const audit = await as((tx) => tx.query<{ via: string | null }>("select details->>'via' as via from audit_events where event_type = 'farming.soil_sample_added'"));
    expect(audit.rows.map((row) => row.via)).toEqual(['app "Soil sampler 2"']);
  });

  it("FA2, FA6 scopes are enforced, recording needs the role now, and pasture readings say which app", async () => {
    const readOnly = (await makeKey(owner, "Cover viewer", ["read_pasture"])).body.key as string;
    const refused = await app(readingsRoute.POST, readOnly, "/pasture/readings", { method: "POST", body: { paddockId: twelveId, measuredOn: "2026-10-19", cover: 2400, method: "plate_meter" } });
    expect([refused.status, refused.body.code]).toEqual([403, "forbidden_scope"]);
    expect((await app(farmsRoute.GET, readOnly, "/farms")).status).toBe(403);

    const recorder = (await makeKey(owner, "Plate meter app", ["read_pasture", "record_pasture"])).body.key as string;
    const added = await app(readingsRoute.POST, recorder, "/pasture/readings", { method: "POST", body: { paddockId: twelveId, measuredOn: "2026-10-19", cover: 2400, method: "plate_meter" } });
    expect(added.status).toBe(201);
    expect(((await as((tx) => listReadings(tx, { farmId }))).rows[0]).source).toBe('Recorded via app "Plate meter app"');
    expect(((await app(coverRoute.GET, recorder, "/pasture/cover?onDate=2026-10-20")).body.summary as Json).cover).toMatchObject({ averageKgDmPerHa: 2400 });

    // The owner becomes a viewer: the key can still read, but not record.
    await coreQuery("update organisation_members set role = 'viewer' where organisation_id = $1 and user_id = $2", [ORG, owner.id]);
    try {
      const now = await app(readingsRoute.POST, recorder, "/pasture/readings", { method: "POST", body: { paddockId: twelveId, measuredOn: "2026-10-20", cover: 2450, method: "plate_meter" } });
      expect([now.status, now.body.error]).toEqual([403, "This key can't record pasture cover readings. Its owner's role doesn't allow it now: recording needs the bookkeeper role or higher."]);
      expect((await app(readingsRoute.GET, recorder, "/pasture/readings")).status).toBe(200);
    } finally {
      await coreQuery("update organisation_members set role = 'owner' where organisation_id = $1 and user_id = $2", [ORG, owner.id]);
    }
  });

  it("FA1, FA7 only an app key gets in, with CORS for other sites; a revoked key stops; AI keys and app keys don't mix", async () => {
    const none = await app(farmsRoute.GET, null, "/farms");
    expect([none.status, none.headers.get("access-control-allow-origin")]).toEqual([401, "*"]);
    expect((await app(farmsRoute.GET, "tohyee_app_" + "x".repeat(43), "/farms")).status).toBe(401);
    const preflight = await farmsRoute.OPTIONS();
    expect([preflight.status, preflight.headers.get("access-control-allow-headers")]).toEqual([204, "authorization, content-type"]);

    const made = await makeKey(owner, "Short lived", ["read_farm"]);
    const key = made.body.key as string;
    expect((await app(farmsRoute.GET, key, "/farms")).status).toBe(200);
    // An app key isn't an AI key.
    const mcp = await mcpRoute.POST(new Request("http://tohyee.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), undefined as unknown);
    expect(mcp.status).toBe(401);
    const revoked = await revokeRoute.POST(apiRequest(`/api/farming/app-keys/${(made.body.appKey as Json).id}/revoke`, { method: "POST", cookie: await sessionCookieFor(owner), body: { organisationId: ORG } }), { params: Promise.resolve({ keyId: String((made.body.appKey as Json).id) }) });
    expect(revoked.status).toBe(200);
    expect((await app(farmsRoute.GET, key, "/farms")).status).toBe(401);
  });

  it("FA8 the OpenAPI contract lists every endpoint", async () => {
    const response = await openApiRoute.GET(new Request(`${BASE}/openapi.json`));
    const doc = (await response.json()) as { openapi: string; servers: Array<{ url: string }>; paths: Record<string, Json> };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe("http://tohyee.test/api/farm-apps/v1");
    expect(Object.keys(doc.paths).sort()).toEqual(["/farms", "/me", "/pasture/cover", "/pasture/readings", "/soil/paddocks", "/soil/samples", "/soil/tests"]);
  });
});
