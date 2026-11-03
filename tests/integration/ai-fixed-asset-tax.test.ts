import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { buildIncomeTax, getIncomeTaxSettings, updateIncomeTaxSettings } from "@/lib/tax/income/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "ai-fixed-asset-tax";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

let rpcId = 0;
async function rpc(token: string, method: string, rpcParams?: unknown) {
  rpcId += 1;
  const response = await mcpRoute.POST(
    new Request("http://tohyee.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: rpcParams }),
    }),
    noContext,
  );
  return (await response.json()) as Json;
}

async function call(token: string, name: string, args: Json = {}): Promise<Json> {
  const body = await rpc(token, "tools/call", { name, arguments: args });
  if (body.error) throw new Error(`rpc ${(body.error as Json).code}: ${(body.error as Json).message}`);
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text) as Json;
}

async function makeToken(user: SessionUser, name: string, accessLevel: string): Promise<string> {
  const response = await tokensRoute.POST(
    apiRequest("/api/ai/tokens", {
      method: "POST",
      cookie: await sessionCookieFor(user),
      body: { organisationId: ORG, name, accessLevel, ...(accessLevel === "full" ? { confirmFullAccess: true } : {}) },
    }),
    noContext,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

/** Decisions 1345-1348, examples AIF7-AIF9: fixed asset types and Investment Boost through a Full access key (made-up data). */
describeWithDatabase("Full access AI: fixed asset types and Investment Boost (AIF7-AIF9)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let secondOwner: SessionUser;
  let bookkeeper: SessionUser;
  const tokens: Record<string, string> = {};
  const asOwner = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const count = async (sql: string) => Number((await asOwner((tx) => tx.query<{ n: string }>(sql))).rows[0].n);
  let typeId = "";

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("fa-ai-owner@example.com", { serverAdmin: true, displayName: "Aroha" });
    secondOwner = await createTestUser("fa-ai-owner2@example.com", { displayName: "Tama" });
    bookkeeper = await createTestUser("fa-ai-bookkeeper@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'bookkeeper')", [ORG, secondOwner.id, bookkeeper.id]);
    const settings = await asOwner((tx) => getIncomeTaxSettings(tx));
    await asOwner((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "company", agentExtension: false, version: settings.version }));
    tokens.full = await makeToken(owner, "full", "full");
    tokens.post = await makeToken(owner, "post", "post");
    tokens.demoted = await makeToken(secondOwner, "demoted", "full");
    tokens.bookkeeperRead = await makeToken(bookkeeper, "read", "read");
  }, 300_000);

  afterAll(async () => {
    await server?.teardown();
  });

  it("AIF7: lower levels can't see or use the type tools, and a Full key whose owner is now an admin works as Make and post", async () => {
    const listed = ((await rpc(tokens.post, "tools/list")).result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    expect(listed).not.toContain("create_fixed_asset_type");
    expect(listed).not.toContain("update_fixed_asset_type");
    expect(listed).toContain("list_fixed_asset_types");
    const full = ((await rpc(tokens.full, "tools/list")).result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    expect(full).toEqual(expect.arrayContaining(["create_fixed_asset_type", "update_fixed_asset_type"]));
    const plant = { name: "Plant", assetAccountCode: "1640", accumulatedDepreciationAccountCode: "1650", depreciationExpenseAccountCode: "6300", method: "sl", rate: "20" };
    await expect(call(tokens.post, "create_fixed_asset_type", plant)).rejects.toThrow(/Full access/);
    await coreQuery("update organisation_members set role = 'admin' where organisation_id = $1 and user_id = $2", [ORG, secondOwner.id]);
    await expect(call(tokens.demoted, "create_fixed_asset_type", plant)).rejects.toThrow(/Full access/);
    expect(await count("select count(*)::text as n from fixed_asset_types")).toBe(0);
  });

  it("AIF7: makes and edits a type with the screen's checks and audit", async () => {
    const base = { name: "Plant", assetAccountCode: "1640", accumulatedDepreciationAccountCode: "1650", depreciationExpenseAccountCode: "6300", method: "sl", rate: "20" };
    await expect(call(tokens.full, "create_fixed_asset_type", { ...base, accumulatedDepreciationAccountCode: "1640" })).rejects.toThrow("different account from the asset account");
    await expect(call(tokens.full, "create_fixed_asset_type", { ...base, depreciationExpenseAccountCode: "1650" })).rejects.toThrow("isn't an expense account");
    await expect(call(tokens.full, "create_fixed_asset_type", { ...base, assetAccountCode: "4000" })).rejects.toThrow("isn't a fixed asset account");
    await expect(call(tokens.full, "create_fixed_asset_type", { ...base, rate: undefined })).rejects.toThrow("rate is required");
    await expect(call(tokens.full, "create_fixed_asset_type", { ...base, method: "none" })).rejects.toThrow("no rate");
    const made = (await call(tokens.full, "create_fixed_asset_type", { ...base, idempotencyKey: "aif7-plant" })) as { created: boolean; type: { id: string; method: string; rate: string } };
    expect(made).toMatchObject({ created: true, type: { name: "Plant", assetAccountCode: "1640", method: "sl", rate: "20" } });
    expect(await call(tokens.full, "create_fixed_asset_type", { ...base, idempotencyKey: "aif7-plant" })).toMatchObject({ created: false, type: { id: made.type.id } });
    await expect(call(tokens.full, "create_fixed_asset_type", { ...base, name: "plant" })).rejects.toThrow("already an asset type called plant");
    typeId = made.type.id;
    expect(await call(tokens.full, "update_fixed_asset_type", { typeId, name: "Plant and machinery", rate: "25" })).toMatchObject({ name: "Plant and machinery", method: "sl", rate: "25" });
    // Archiving isn't offered: anything else sent changes nothing (as AIF3).
    expect(await call(tokens.full, "update_fixed_asset_type", { typeId, isArchived: true, archived: true })).toMatchObject({ isArchived: false });
    expect(await count("select count(*)::text as n from audit_events where event_type in ('fixed_asset_type.created', 'fixed_asset_type.updated')")).toBe(3);
    expect(((await call(tokens.post, "list_fixed_asset_types")).types as Json[]).map((type) => type.name)).toEqual(["Plant and machinery"]);
  });

  it("AIF8: Investment Boost is refused where the Income tax page refuses it, and nothing is registered", async () => {
    const machine = { name: "Bad machine", typeId, purchaseDate: "2025-06-01", cost: "100000.00" };
    await expect(call(tokens.full, "register_fixed_asset", { ...machine, taxDetails: { method: "sl", rate: "20", investmentBoost: true } })).rejects.toThrow("tick that it's new");
    await expect(call(tokens.full, "register_fixed_asset", { ...machine, purchaseDate: "2025-05-01", taxDetails: { method: "sl", rate: "20", newAsset: true, investmentBoost: true } })).rejects.toThrow(
      "on or after 22 May 2025",
    );
    await expect(
      call(tokens.full, "register_fixed_asset", { ...machine, purchaseDate: "2025-05-01", taxDetails: { method: "sl", rate: "20", newAsset: true, investmentBoost: true, availableOn: "2025-06-01" } }),
    ).rejects.toThrow("on or after 22 May 2025");
    await expect(call(tokens.full, "register_fixed_asset", { ...machine, taxDetails: { method: "not_depreciable", newAsset: true, investmentBoost: true } })).rejects.toThrow(
      "only for assets depreciated by diminishing value or straight line",
    );
    await expect(call(tokens.full, "register_fixed_asset", { ...machine, taxDetails: { method: "sl", rate: "20", businessUsePercent: "120" } })).rejects.toThrow("at most 100");
    await expect(call(tokens.full, "register_fixed_asset", { ...machine, taxDetails: { method: "sl", rate: "20", boost: true } })).rejects.toThrow("taxDetails can't have boost");
    await expect(call(tokens.post, "register_fixed_asset", { ...machine, taxDetails: { method: "sl", rate: "20" } })).rejects.toThrow(/Full access/);
    expect(await count("select count(*)::text as n from fixed_assets")).toBe(0);
  });

  it("AIF8, AIF9: register with Investment Boost, edit it, and the income tax workpaper takes it in (as ITX14, ITX18)", async () => {
    const registered = (await call(tokens.full, "register_fixed_asset", {
      name: "Machine",
      typeId,
      purchaseDate: "2025-06-01",
      cost: "100000.00",
      taxDetails: { method: "sl", rate: "20", newAsset: true, investmentBoost: true },
      idempotencyKey: "aif8-machine",
    })) as { created: boolean; asset: { id: string; taxDetails: Json }; taxYear: Json };
    expect(registered.created).toBe(true);
    expect(registered.asset.taxDetails).toMatchObject({ method: "sl", rate: "20", taxCost: "100000.00", businessUsePercent: "100", availableOn: "2025-06-01", newAsset: true, investmentBoost: true, version: 1 });
    expect(registered.taxYear).toMatchObject({ incomeYear: 2026, months: 10, investmentBoost: "20000.00", depreciation: "13333.33", closingAtv: "66666.67" });
    // Sent again: nothing more is registered or changed.
    expect(await call(tokens.full, "register_fixed_asset", { name: "Machine", typeId, purchaseDate: "2025-06-01", cost: "100000.00", taxDetails: { method: "sl", rate: "20", newAsset: true, investmentBoost: true }, idempotencyKey: "aif8-machine" })).toMatchObject({
      created: false,
      asset: { id: registered.asset.id, taxDetails: { version: 1 } },
    });
    const machineId = registered.asset.id;

    // A desk registered without tax details, then given them, then edited with only the boost sent.
    const desk = ((await call(tokens.full, "register_fixed_asset", { name: "Desk", typeId, purchaseDate: "2025-07-01", cost: "2500.00" })) as { asset: { id: string; taxDetails: unknown } }).asset;
    expect(desk.taxDetails).toBeNull();
    await expect(call(tokens.full, "update_fixed_asset", { assetId: desk.id, taxDetails: { method: "dv", rate: "25", newAsset: true, investmentBoost: true } })).rejects.toThrow("version must be");
    const boosted = (await call(tokens.full, "update_fixed_asset", { assetId: desk.id, taxDetails: { method: "dv", rate: "25", newAsset: true, investmentBoost: true, version: 0 } })) as Json;
    expect(boosted).toMatchObject({ id: desk.id, name: "Desk", taxDetails: { method: "dv", investmentBoost: true, version: 1 }, taxYear: { investmentBoost: "500.00" } });
    await expect(call(tokens.full, "update_fixed_asset", { assetId: desk.id, taxDetails: { investmentBoost: false, version: 0 } })).rejects.toThrow("Someone else changed");
    const unboosted = (await call(tokens.full, "update_fixed_asset", { assetId: desk.id, name: "Standing desk", taxDetails: { investmentBoost: false, version: 1 } })) as Json;
    expect(unboosted).toMatchObject({ name: "Standing desk", taxDetails: { method: "dv", rate: "25", newAsset: true, investmentBoost: false, version: 2 }, taxYear: { investmentBoost: "0.00" } });

    // Reads show the setting to owners and admins only.
    expect(await call(tokens.post, "get_fixed_asset", { assetId: machineId })).toMatchObject({ taxDetails: { investmentBoost: true, version: 1 } });
    const listed = (await call(tokens.full, "list_fixed_assets")).assets as Json[];
    expect(listed.map((asset) => [asset.name, (asset.taxDetails as Json).investmentBoost])).toEqual([
      ["Machine", true],
      ["Standing desk", false],
    ]);
    const forBookkeeper = await call(tokens.bookkeeperRead, "get_fixed_asset", { assetId: machineId });
    expect(forBookkeeper).not.toHaveProperty("taxDetails");
    expect(((await call(tokens.bookkeeperRead, "list_fixed_assets")).assets as Json[]).every((asset) => !("taxDetails" in asset))).toBe(true);

    // The income tax workpaper (ITX18): the boost and tax depreciation come in for both assets.
    const report = await asOwner((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-10-16" }));
    expect(report.supported).toBe(true);
    if (!report.supported) return;
    // Desk: 2,500.00 at 25% DV from July 2025 (9 months) = 468.75; machine as ITX14 for 10 months.
    expect(report.workpaper.adjustments.map((entry) => [entry.description, entry.amount])).toEqual([
      ["Investment Boost", "-20000.00"],
      ["Tax depreciation", "-13802.08"],
    ]);
    expect(await count("select count(*)::text as n from audit_events where event_type = 'income_tax.asset_details_set'")).toBe(3);
  });
});
