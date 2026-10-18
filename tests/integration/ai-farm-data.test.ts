import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { saveProduct } from "@/lib/farming/fertiliser";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addReading } from "@/lib/farming/pasture";
import { addSoilTest } from "@/lib/farming/soil";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "ai-farm-data";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

let rpcId = 0;
async function call(token: string, name: string, args: Json = {}): Promise<Json> {
  rpcId += 1;
  const response = await mcpRoute.POST(
    new Request("http://tohyee.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name, arguments: args } }),
    }),
    noContext,
  );
  const body = (await response.json()) as Json;
  if (body.error) throw new Error(`rpc ${(body.error as Json).code}: ${(body.error as Json).message}`);
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text) as Json;
}

/** The AI reads soil, fertiliser and pasture data (AIW10-AIW14, decision 560; not yet reviewed). */
describeWithDatabase("the AI reads farm data", () => {
  let server: TestServer;
  let owner: SessionUser;
  let token = "";
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  let farmId = "";
  let twelveId = "";
  let ureaId = "";

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    owner = await createTestUser("ai-farm-data-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    const response = await tokensRoute.POST(apiRequest("/api/ai/tokens", { method: "POST", cookie: await sessionCookieFor(owner), body: { organisationId: ORG, name: "look", accessLevel: "read" } }), noContext);
    token = ((await response.json()) as { token: string }).token;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("AIW14 with Farming off, the tools say so", async () => {
    await expect(call(token, "list_fertiliser_products")).rejects.toThrow("Farming is off");
  });

  it("AIW10-AIW13 soil tests, fertiliser and pasture, with the only farm chosen for the AI", async () => {
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    farmId = (await as((tx) => saveFarm(tx, { name: "Home block" })))[0].id;
    twelveId = (await as((tx) => addPaddock(tx, { farmId, name: "12", effectiveHa: "20.0", onDate: "2026-07-01" }))).id;
    const fourteen = await as((tx) => addPaddock(tx, { farmId, name: "14", effectiveHa: "15.0", onDate: "2026-07-01" }));
    ureaId = (await as((tx) => saveProduct(tx, { name: "Urea", nPct: "46" }))).find((product) => product.name === "Urea")!.id;
    await as((tx) => addSoilTest(tx, { paddockId: twelveId, sampledOn: "2026-08-15", lab: "Hill Labs", results: [{ measure: "Olsen P", value: "28", unit: "mg/L" }] }));
    await as((tx) => addReading(tx, { paddockId: twelveId, measuredOn: "2026-09-15", cover: 2500, method: "plate_meter" }));
    await as((tx) => addReading(tx, { paddockId: fourteen.id, measuredOn: "2026-09-15", cover: 1900, method: "satellite" }));

    // AIW10: no farmId needed with one farm; the lab's results as reported, no judgement.
    const soil = await call(token, "list_soil_tests");
    expect(((soil.tests as Json).rows as Json[]).map((test) => [test.paddockName, test.sampledOn, (test.results as Json[])[0].valueText])).toEqual([["12", "2026-08-15", "28"]]);

    // AIW12: FB2's paddock 12 line, worked out and not saved.
    const whatIf = await call(token, "fertiliser_what_if", { productId: ureaId, paddockId: twelveId, kgPerHa: "100", pricePerTonne: "780", spreadingPerHa: "25" });
    expect(whatIf).toMatchObject({ paddock: "12", hectares: "20.00", tonnes: "2.000", kgPerHaOf: { n: "46.0", p: "0.0" }, totalKgOf: { n: "920.0" }, productCost: "1560.00", spreadingCost: "500.00", total: "2060.00", saved: false });
    const byArea = await call(token, "fertiliser_what_if", { productId: ureaId, hectares: "15", kgPerHa: "80" });
    expect(byArea).toMatchObject({ tonnes: "1.200", kgPerHaOf: { n: "36.8" }, totalKgOf: { n: "552.0" }, productCost: null, total: null });
    await expect(call(token, "fertiliser_what_if", { productId: ureaId, kgPerHa: "80" })).rejects.toThrow("Give paddockId or hectares");
    expect(((await call(token, "list_fertiliser_plans")).plans as Json[]).length).toBe(0);

    // AIW13: the farm's cover, with the satellite reading as an estimate.
    const cover = await call(token, "pasture_cover", { onDate: "2026-09-20" });
    expect(cover.cover).toMatchObject({ averageKgDmPerHa: 2243, totalKgDm: 78500, hectares: "35.00", estimates: 1 });
    const readings = await call(token, "list_pasture_readings", { paddockId: fourteen.id });
    expect((readings.rows as Json[]).map((row) => [row.cover, row.estimate])).toEqual([[1900, true]]);

    // AIW10: with two farms, the AI has to say which.
    await as((tx) => saveFarm(tx, { name: "Run-off" }));
    await expect(call(token, "pasture_cover")).rejects.toThrow("There are 2 farms: give farmId");
    expect((await call(token, "pasture_cover", { farmId, onDate: "2026-09-20" })).cover).toMatchObject({ readings: 2 });
  });
});
