import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as runsRoute from "@/app/api/depreciation-runs/route";
import * as typesRoute from "@/app/api/fixed-asset-types/route";
import * as registerRoute from "@/app/api/reports/fixed-asset-register/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill, voidBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { fixedAssetRegister } from "@/lib/fixed-assets/register";
import {
  disposeFixedAsset,
  getDepreciationRun,
  previewDepreciationRun,
  previewDisposal,
  rollBackDepreciationRun,
  runDepreciation,
  undoDisposal,
} from "@/lib/fixed-assets/runs";
import {
  archiveFixedAsset,
  archiveFixedAssetType,
  createFixedAsset,
  createFixedAssetType,
  type FixedAsset,
  getFixedAsset,
  listBillLinesForAssets,
  listFixedAssets,
  updateFixedAsset,
  updateFixedAssetSettings,
} from "@/lib/fixed-assets/service";
import { getJournal, getJournalDetails, postJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { accountTransactions } from "@/lib/reports/account-transactions";
import { createTaxCode } from "@/lib/tax/codes";
import { createTrackingValue, getTrackingSetup } from "@/lib/tracking/service";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  sessionCookieFor,
  startTestServer,
  testDatabaseUrl,
  type TestServer,
  withDb,
} from "../helpers/test-server";

const noContext = undefined as unknown;

/** Examples FA1-FA14 in docs/ACCOUNTING-EXAMPLES.md ("Fixed assets"). Each test gets its own organisation. */
describeWithDatabase("fixed assets", () => {
  let server: TestServer;
  let owner: SessionUser;
  let aroha: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("fa-jess@example.com", { serverAdmin: true });
    aroha = await createTestUser("fa-aroha@example.com");
    viewer = await createTestUser("fa-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `fa-${organisations}-co`;
    await createTestOrganisation(owner, org);
    for (const [user, role] of [
      [aroha, "bookkeeper"],
      [viewer, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
    }
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const asAroha = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: aroha.id, email: aroha.email }, work);
    await as((tx) =>
      createTaxCode(tx, { idempotencyKey: key("tax"), code: "GST", label: "GST (15%)", category: "standard", rate: "0.15", effectiveFrom: "2026-01-01" }),
    );
    const type = async (name: string, asset: string, accumulated: string, method: string, rate: string | null) =>
      (
        await as((tx) =>
          createFixedAssetType(tx, {
            idempotencyKey: key("type"),
            name,
            assetAccountCode: asset,
            accumulatedDepreciationAccountCode: accumulated,
            depreciationExpenseAccountCode: "6300",
            method,
            rate,
          }),
        )
      ).type;
    const computers = await type("Computer equipment", "1620", "1630", "dv", "50");
    const vehicles = await type("Motor vehicles", "1640", "1650", "dv", "30");
    const office = await type("Office equipment", "1600", "1610", "sl", "20");
    const journal = (postingDate: string, reference: string, lines: Array<[string, string, string]>) =>
      as((tx) =>
        postJournal(tx, {
          idempotencyKey: key("journal"),
          postingDate,
          reference,
          lines: lines.map(([accountCode, debitAmount, creditAmount]) => ({ accountCode, debitAmount, creditAmount })),
        }),
      );
    const register = async (fields: Record<string, unknown>, idempotencyKey = key("asset")) =>
      (await asAroha((tx) => createFixedAsset(tx, { idempotencyKey, ...fields }))).asset;
    const run = async (periodEnd: string, idempotencyKey = key("run")) => (await asAroha((tx) => runDepreciation(tx, { idempotencyKey, periodEnd }))).run;
    const rollBack = async (runId: string, idempotencyKey = key("rollback")) =>
      (await asAroha((tx) => rollBackDepreciationRun(tx, runId, { idempotencyKey }))).run;
    const dispose = async (assetId: string, fields: Record<string, unknown>, idempotencyKey = key("dispose")) =>
      (await asAroha((tx) => disposeFixedAsset(tx, assetId, { idempotencyKey, ...fields }))).asset;
    const undo = async (assetId: string, idempotencyKey = key("undo")) => (await asAroha((tx) => undoDisposal(tx, assetId, { idempotencyKey }))).asset;
    const lines = async (journalId: string) => (await as((tx) => getJournal(tx, journalId))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]);
    const asset = (id: string) => as((tx) => getFixedAsset(tx, id));
    const balance = async (code: string) =>
      (
        await as((tx) =>
          tx.query<{ balance: string }>(
            "select coalesce(sum(l.debit_amount - l.credit_amount), 0)::text as balance from ledger_journal_lines l join accounts a on a.id = l.account_id where a.code = $1",
            [code],
          ),
        )
      ).rows[0].balance;
    const journals = async () => Number((await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);

    /** The laptop's bill: PB Tech, 10 May 2026, 2,300.00 including GST to 1620 (2,000.00 + 300.00 GST). */
    const laptopBill = async () => {
      const supplier = (await as((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "PB Tech", isSupplier: true }))).contact;
      const bill = (
        await as((tx) =>
          createBill(tx, {
            idempotencyKey: key("bill"),
            contactId: supplier.id,
            billDate: "2026-05-10",
            dueDate: "2026-06-20",
            supplierInvoiceNumber: "PB-7781",
            amountsMode: "inclusive",
            lines: [{ description: "Laptop", quantity: "1", unitPrice: "2300.00", accountCode: "1620", taxCode: "GST" }],
          }),
        )
      ).bill;
      await as((tx) => approveBill(tx, bill.id, { idempotencyKey: key("approve") }));
      const line = (await as((tx) => listBillLinesForAssets(tx))).find((entry) => entry.billId === bill.id)!;
      return { bill, line };
    };

    /** The register at the start of May: the laptop (from its bill), the desk and the printer (brought in with its opening balance). */
    const standard = async () => {
      const { bill, line } = await laptopBill();
      const laptop = await register({ name: "Laptop", typeId: computers.id, billLineId: line.billLineId });
      await journal("2026-04-01", "DESK", [
        ["1600", "1200.00", ""],
        ["1000", "", "1200.00"],
      ]);
      const desk = await register({ name: "Desk", typeId: office.id, purchaseDate: "2026-04-01", cost: "1200.00" });
      await journal("2026-03-31", "OPENING", [
        ["1600", "1500.00", ""],
        ["1610", "", "900.00"],
        ["3000", "", "600.00"],
      ]);
      const printer = await register({
        name: "Printer",
        typeId: office.id,
        purchaseDate: "2023-07-01",
        cost: "1500.00",
        method: "dv",
        rate: "40",
        openingDate: "2026-03-31",
        openingAccumulatedDepreciation: "900.00",
      });
      return { bill, line, laptop, desk, printer };
    };

    /** The ute: bought 20 Jun 2026 for 30,000.00 on the term loan. */
    const registerUte = async (fields: Record<string, unknown> = {}) => {
      await journal("2026-06-20", "UTE", [
        ["1640", "30000.00", ""],
        ["2800", "", "30000.00"],
      ]);
      return register({ name: "Ute", typeId: vehicles.id, purchaseDate: "2026-06-20", cost: "30000.00", ...fields });
    };

    /** Runs to 31 May, the ute, runs to 30 Jun and 31 Aug (FA3, FA4, FA6). */
    const throughAugust = async () => {
      const assets = await standard();
      const may = await run("2026-05-31");
      const ute = await registerUte();
      const june = await run("2026-06-30");
      const august = await run("2026-08-31");
      return { ...assets, ute, may, june, august };
    };

    return {
      org,
      as,
      asAroha,
      types: { computers, vehicles, office },
      journal,
      register,
      run,
      rollBack,
      dispose,
      undo,
      lines,
      asset,
      balance,
      journals,
      laptopBill,
      standard,
      registerUte,
      throughAugust,
    };
  }

  it("FA1: asset types say which accounts to use and a default method and rate; disposals get system accounts", async () => {
    const w = await setup();
    const system = await w.as((tx) =>
      tx.query<{ code: string; name: string; account_type: string; system_key: string }>(
        "select code, name, account_type, system_key from accounts where system_key like 'fixed_asset%' order by code",
      ),
    );
    expect(system.rows).toEqual([
      { code: "7030", name: "Gain or loss on disposal of fixed assets", account_type: "other_income", system_key: "fixed_asset_disposal" },
      { code: "7040", name: "Capital gains on disposal of fixed assets", account_type: "other_income", system_key: "fixed_asset_capital_gain" },
    ]);
    expect(w.types.computers).toMatchObject({
      name: "Computer equipment",
      assetAccountCode: "1620",
      accumulatedDepreciationAccountCode: "1630",
      depreciationExpenseAccountCode: "6300",
      method: "dv",
      rate: "50",
    });
    const make = (fields: Record<string, unknown>) =>
      w.as((tx) =>
        createFixedAssetType(tx, {
          idempotencyKey: key("type"),
          name: "Tools",
          assetAccountCode: "1600",
          accumulatedDepreciationAccountCode: "1610",
          depreciationExpenseAccountCode: "6300",
          method: "dv",
          rate: "25",
          ...fields,
        }),
      );
    await expect(make({ assetAccountCode: "6070" })).rejects.toThrow("isn't a fixed asset account");
    await expect(make({ accumulatedDepreciationAccountCode: "1600" })).rejects.toThrow("different account");
    await expect(make({ depreciationExpenseAccountCode: "1000" })).rejects.toThrow("isn't an expense account");
    await expect(make({ rate: "0" })).rejects.toThrow("must not be zero");
    await expect(make({ rate: "101" })).rejects.toThrow("at most 100");
    await expect(make({ rate: null })).rejects.toThrow("rate is required");
    await expect(make({ method: "none", rate: "10" })).rejects.toThrow("has no rate");
    await expect(make({ name: "Motor vehicles" })).rejects.toThrow("already an asset type called");
    const land = (await make({ name: "Land", method: "none", rate: null })).type;
    expect([land.method, land.rate]).toEqual(["none", null]);
    // Admins set types up; a bookkeeper is refused, a viewer can list them.
    const arohaCookie = await sessionCookieFor(aroha);
    const refused = await typesRoute.POST(
      apiRequest("/api/fixed-asset-types", {
        method: "POST",
        cookie: arohaCookie,
        body: { organisationId: w.org, idempotencyKey: key("t"), name: "X", assetAccountCode: "1600", accumulatedDepreciationAccountCode: "1610", depreciationExpenseAccountCode: "6300", method: "sl", rate: "10" },
      }),
      noContext,
    );
    expect(refused.status).toBe(403);
    const listed = await typesRoute.GET(apiRequest(`/api/fixed-asset-types?organisationId=${w.org}`, { cookie: await sessionCookieFor(viewer) }), noContext);
    expect(((await listed.json()) as { types: unknown[] }).types).toHaveLength(4);
    // Archived, never deleted.
    const archived = await w.as((tx) => archiveFixedAssetType(tx, land.id, { archived: true }));
    expect(archived.isArchived).toBe(true);
    await expect(w.as((tx) => tx.query("delete from fixed_asset_types where id = $1", [land.id]))).rejects.toThrow("can't be deleted");
  });

  it("FA1: migration 0029 gives an existing organisation the disposal accounts, at the next free code", async () => {
    const databaseName = `${server.coreDatabase}_org_upgrade_assets`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl! });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    await admin.end();
    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, databaseName) });
    await client.connect();
    try {
      await applyMigrations(client, tenantMigrations.filter((migration) => migration.version < "0029"), "test:upgrade");
      await client.query("insert into organisation_settings (organisation_id, display_name, base_currency) values ('assets-co', 'Assets Co', 'NZD')");
      await client.query("insert into accounts (code, name, account_class, account_type) values ('7030', 'Donations', 'revenue', 'other_income')");
      expect((await applyMigrations(client, tenantMigrations, "test:upgrade")).applied).toContain("0029");
      expect((await client.query("select code, name, system_key from accounts where code like '70%' order by code")).rows).toEqual([
        { code: "7030", name: "Donations", system_key: null },
        { code: "7031", name: "Gain or loss on disposal of fixed assets", system_key: "fixed_asset_disposal" },
        { code: "7040", name: "Capital gains on disposal of fixed assets", system_key: "fixed_asset_capital_gain" },
      ]);
      expect((await client.query("select fixed_asset_first_month, fixed_asset_disposal_month from organisation_settings")).rows).toEqual([
        { fixed_asset_first_month: "full_month", fixed_asset_disposal_month: "exclude" },
      ]);
    } finally {
      await client.end();
    }
  });

  it("FA2: registering an asset, from a bill line or typed in, posts nothing", async () => {
    const w = await setup();
    const { bill, line } = await w.laptopBill();
    expect([line.accountCode, line.netAmount, line.unregistered]).toEqual(["1620", "2000.00", "2000.00"]);
    const before = await w.journals();
    const register = (fields: Record<string, unknown>) => w.register({ name: "Laptop", typeId: w.types.computers.id, billLineId: line.billLineId, ...fields });
    await expect(register({ cost: "2000.01" })).rejects.toThrow("left of the bill line excluding GST (2000.00)");
    await expect(register({ typeId: w.types.vehicles.id })).rejects.toThrow("on account 1620");
    const k = key("asset");
    const laptop = await w.register({ name: "Laptop", typeId: w.types.computers.id, billLineId: line.billLineId }, k);
    expect([laptop.assetNumber, laptop.cost, laptop.purchaseDate, laptop.method, laptop.rate, laptop.bookValue, laptop.billId, laptop.status]).toEqual([
      "FA-0001",
      "2000.00",
      "2026-05-10",
      "dv",
      "50",
      "2000.00",
      bill.id,
      "registered",
    ]);
    expect((await w.register({ name: "Laptop", typeId: w.types.computers.id, billLineId: line.billLineId }, k)).id).toBe(laptop.id);
    await expect(w.register({ name: "Other", typeId: w.types.computers.id, billLineId: line.billLineId }, k)).rejects.toThrow("idempotency key");
    expect(await w.journals()).toBe(before);
    expect(await w.balance("1620")).toBe("2000.00");
    await expect(register({ cost: "0.01" })).rejects.toThrow("already been registered");
    expect((await w.as((tx) => listBillLinesForAssets(tx))).map((entry) => entry.billLineId)).not.toContain(line.billLineId);
    // The database refuses more than the line too.
    await expect(
      w.as((tx) =>
        tx.query(
          `insert into fixed_assets (command_source, idempotency_key, request_hash, asset_number, name, type_id, purchase_date, cost, bill_line_id, method, rate)
           values ('x', 'y', 'z', 'FA-9999', 'Copy', $1, '2026-05-10', 1, $2, 'dv', 50)`,
          [w.types.computers.id, line.billLineId],
        ),
      ),
    ).rejects.toThrow("can't cost more than the line");
    // Voiding the bill is refused while the asset is registered from it; archived, it can be voided.
    await expect(w.as((tx) => voidBill(tx, bill.id, { idempotencyKey: key("void"), voidDate: "2026-05-20" }))).rejects.toThrow(
      "registered as fixed asset FA-0001",
    );
    await w.asAroha((tx) => archiveFixedAsset(tx, laptop.id));
    await w.as((tx) => voidBill(tx, bill.id, { idempotencyKey: key("void"), voidDate: "2026-05-20" }));
    // Typed in, the number goes on with no gap; refusals.
    const typed = (fields: Record<string, unknown>) => w.register({ name: "Desk", typeId: w.types.office.id, purchaseDate: "2026-04-01", cost: "1200.00", ...fields });
    await expect(typed({ cost: "" })).rejects.toThrow("cost is required");
    await expect(typed({ purchaseDate: "" })).rejects.toThrow("purchaseDate is required");
    await expect(typed({ residualValue: "1200.01" })).rejects.toThrow("residual value can't be more than the cost");
    await expect(typed({ openingAccumulatedDepreciation: "100.00" })).rejects.toThrow("needs the date");
    await expect(typed({ openingDate: "2026-04-15" })).rejects.toThrow("must be a month end");
    await expect(typed({ openingDate: "2026-03-31" })).rejects.toThrow("before the purchase date");
    await expect(typed({ openingDate: "2026-04-30", openingAccumulatedDepreciation: "1200.01" })).rejects.toThrow("more than the cost");
    await expect(typed({ method: "sl", rate: "" })).rejects.toThrow("rate is required");
    const desk = await typed({});
    expect([desk.assetNumber, desk.method, desk.rate]).toEqual(["FA-0002", "sl", "20"]);
    const land = await w.register({ name: "Section", typeId: w.types.office.id, purchaseDate: "2026-04-01", cost: "500.00", method: "none" });
    expect([land.assetNumber, land.method, land.rate]).toEqual(["FA-0003", "none", null]);
    expect((await w.as((tx) => listFixedAssets(tx))).map((entry) => entry.assetNumber)).toEqual(["FA-0002", "FA-0003"]);
    expect((await w.as((tx) => listFixedAssets(tx, { status: "archived" }))).map((entry) => entry.assetNumber)).toEqual(["FA-0001"]);
  });

  it("FA3: the first run to 31 May charges each asset from its first month, in one journal by asset type", async () => {
    const w = await setup();
    const { laptop, desk, printer } = await w.standard();
    expect(printer.bookValue).toBe("600.00");
    const preview = await w.as((tx) => previewDepreciationRun(tx, "2026-05-31"));
    expect(preview.lines.map((line) => [line.assetNumber, line.fromMonth, line.toMonth, line.amount])).toEqual([
      ["FA-0001", "2026-05", "2026-05", "83.33"],
      ["FA-0002", "2026-04", "2026-05", "40.00"],
      ["FA-0003", "2026-04", "2026-05", "40.00"],
    ]);
    const before = await w.journals();
    const may = await w.run("2026-05-31");
    expect(await w.journals()).toBe(before + 1);
    expect([may.reference, may.total, may.status]).toEqual(["DEP-2026-05", "163.33", "active"]);
    const posted = await w.as((tx) => getJournal(tx, may.journalId!));
    expect([posted.postingDate, posted.reference, posted.origin, posted.description]).toEqual(["2026-05-31", "DEP-2026-05", "fixed_asset_depreciation", "Depreciation to 31 May 2026"]);
    expect(await w.lines(may.journalId!)).toEqual([
      ["6300", "83.33", "0.00"],
      ["1630", "0.00", "83.33"],
      ["6300", "80.00", "0.00"],
      ["1610", "0.00", "80.00"],
    ]);
    expect((await w.asset(laptop.id)).bookValue).toBe("1916.67");
    expect((await w.asset(desk.id)).depreciatedTo).toBe("2026-05-31");
    expect((await w.asset(printer.id)).accumulatedDepreciation).toBe("940.00");
    await expect(w.run("2026-06-15")).rejects.toThrow("month end");
  });

  it("FA4: the June run, rounded so May and June add up; runs only go forward and are idempotent", async () => {
    const w = await setup();
    await w.standard();
    const may = await w.run("2026-05-31");
    const ute = await w.registerUte();
    expect(ute.assetNumber).toBe("FA-0004");
    const k = key("run");
    const june = await w.run("2026-06-30", k);
    expect(june.total).toBe("873.34");
    expect(june.lines.map((line) => [line.assetNumber, line.amount])).toEqual([
      ["FA-0001", "83.34"],
      ["FA-0002", "20.00"],
      ["FA-0003", "20.00"],
      ["FA-0004", "750.00"],
    ]);
    expect(await w.lines(june.journalId!)).toEqual([
      ["6300", "83.34", "0.00"],
      ["1630", "0.00", "83.34"],
      ["6300", "750.00", "0.00"],
      ["1650", "0.00", "750.00"],
      ["6300", "40.00", "0.00"],
      ["1610", "0.00", "40.00"],
    ]);
    expect((await w.run("2026-06-30", k)).id).toBe(june.id);
    await expect(w.run("2026-07-31", k)).rejects.toThrow("idempotency key");
    await expect(w.run("2026-06-30")).rejects.toThrow("already been run to 2026-06-30");
    await expect(w.run("2026-05-31")).rejects.toThrow("already been run to 2026-06-30");
    await expect(
      w.as((tx) =>
        tx.query("insert into fixed_asset_depreciation_runs (command_source, idempotency_key, request_hash, period_end, total) values ('x', 'y', 'z', '2026-04-30', 0)"),
      ),
    ).rejects.toThrow("already been run to 2026-06-30");
    await expect(w.as((tx) => tx.query("delete from fixed_asset_depreciation_runs where id = $1", [may.id]))).rejects.toThrow("can't be deleted");
    await expect(w.as((tx) => tx.query("update fixed_asset_depreciation_lines set amount = 0 where run_id = $1", [may.id]))).rejects.toThrow("can't be changed");
    // Locked periods.
    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-07-31" }));
    await expect(w.run("2026-07-31")).rejects.toThrow(/locked period/);
  });

  it("FA5: the latest run can be rolled back with the exact reversal on its date, and run again", async () => {
    const w = await setup();
    await w.standard();
    const may = await w.run("2026-05-31");
    await w.registerUte();
    const june = await w.run("2026-06-30");
    await expect(w.rollBack(may.id)).rejects.toThrow("Only the latest run");
    const k = key("rollback");
    const rolled = await w.rollBack(june.id, k);
    expect(rolled.status).toBe("rolled_back");
    const reversal = await w.as((tx) => getJournal(tx, rolled.rollbackJournalId!));
    expect([reversal.postingDate, reversal.reference, reversal.correctionKind]).toEqual(["2026-06-30", "VOID-DEP-2026-06", "reversal"]);
    expect(await w.lines(rolled.rollbackJournalId!)).toEqual([
      ["6300", "0.00", "83.34"],
      ["1630", "83.34", "0.00"],
      ["6300", "0.00", "750.00"],
      ["1650", "750.00", "0.00"],
      ["6300", "0.00", "40.00"],
      ["1610", "40.00", "0.00"],
    ]);
    expect((await w.rollBack(june.id, k)).id).toBe(june.id);
    await expect(w.rollBack(june.id)).rejects.toThrow("already been rolled back");
    expect(await w.balance("1650")).toBe("0.00");
    const again = await w.run("2026-06-30");
    expect([again.total, again.id === june.id]).toEqual(["873.34", false]);
    // Rolling back in a locked period is refused.
    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-06-30" }));
    await expect(w.rollBack(again.id)).rejects.toThrow(/locked period/);
    expect((await w.as((tx) => getDepreciationRun(tx, again.id))).status).toBe("active");
  });

  it("FA6: a run covering two months charges the same as two monthly runs; an asset registered late catches up", async () => {
    const w = await setup();
    await w.standard();
    await w.run("2026-05-31");
    await w.registerUte();
    await w.run("2026-06-30");
    const monitor = await w.register({ name: "Monitor", typeId: w.types.computers.id, purchaseDate: "2026-05-20", cost: "600.00" });
    expect(monitor.assetNumber).toBe("FA-0005");
    const august = await w.run("2026-08-31");
    expect(august.lines.map((line) => [line.assetNumber, line.fromMonth, line.toMonth, line.months, line.amount])).toEqual([
      ["FA-0001", "2026-07", "2026-08", 2, "166.66"],
      ["FA-0002", "2026-07", "2026-08", 2, "40.00"],
      ["FA-0003", "2026-07", "2026-08", 2, "40.00"],
      ["FA-0004", "2026-07", "2026-08", 2, "1500.00"],
      ["FA-0005", "2026-05", "2026-08", 4, "100.00"],
    ]);
    expect(august.total).toBe("1846.66");
    expect(await w.lines(august.journalId!)).toEqual([
      ["6300", "266.66", "0.00"],
      ["1630", "0.00", "266.66"],
      ["6300", "1500.00", "0.00"],
      ["1650", "0.00", "1500.00"],
      ["6300", "80.00", "0.00"],
      ["1610", "0.00", "80.00"],
    ]);
  });

  it("FA7: with depreciation starting the month after purchase, the ute starts in July", async () => {
    const w = await setup();
    await w.as((tx) => updateFixedAssetSettings(tx, { firstMonth: "next_month" }));
    await w.registerUte();
    const june = await w.run("2026-06-30");
    expect([june.total, june.journalId, june.lines]).toEqual(["0.00", null, []]);
    const july = await w.run("2026-07-31");
    expect(july.lines.map((line) => [line.assetNumber, line.fromMonth, line.amount])).toEqual([["FA-0001", "2026-07", "750.00"]]);
    // A run with nothing to post can be rolled back too (it posts nothing).
    await w.rollBack(july.id);
    expect((await w.rollBack(june.id)).status).toBe("rolled_back");
    await expect(w.as((tx) => updateFixedAssetSettings(tx, { firstMonth: "half" }))).rejects.toThrow("firstMonth must be");
  });

  it("FA8: selling the ute below book value posts the loss; refusals; the disposal month setting", async () => {
    const w = await setup();
    const { ute } = await w.throughAugust();
    await w.journal("2026-09-15", "SALE-UTE", [
      ["1000", "25000.00", ""],
      ["4100", "", "25000.00"],
    ]);
    const sale = { disposalDate: "2026-09-15", proceeds: "25000.00", proceedsAccountCode: "4100" };
    await expect(w.dispose(ute.id, { ...sale, disposalDate: "2026-08-31" })).rejects.toThrow("Roll that run back first");
    await expect(w.dispose(ute.id, { ...sale, proceedsAccountCode: "" })).rejects.toThrow("Choose the account the sale was coded to");
    await expect(w.dispose(ute.id, { ...sale, proceedsAccountCode: "1000" })).rejects.toThrow("can't be used");
    await expect(w.dispose(ute.id, { ...sale, proceedsAccountCode: "1100" })).rejects.toThrow("can't be used");
    await expect(w.dispose(ute.id, { ...sale, gainLossAccountCode: "1600" })).rejects.toThrow("isn't an income or expense account");
    await expect(w.dispose(ute.id, { disposalDate: "2026-09-15", proceedsAccountCode: "4100" })).rejects.toThrow("has no proceeds account");
    const preview = await w.as((tx) => previewDisposal(tx, ute.id, sale));
    expect([preview.depreciation, preview.accumulatedDepreciation, preview.bookValue, preview.loss]).toEqual(["0.00", "2250.00", "27750.00", "2750.00"]);
    const k = key("dispose");
    const sold = await w.dispose(ute.id, sale, k);
    expect([sold.status, sold.bookValue]).toEqual(["disposed", "0.00"]);
    const disposal = sold.disposals[0];
    expect([disposal.cost, disposal.accumulatedDepreciation, disposal.bookValue, disposal.proceeds, disposal.loss, disposal.depreciationRecovered]).toEqual([
      "30000.00",
      "2250.00",
      "27750.00",
      "25000.00",
      "2750.00",
      "0.00",
    ]);
    const posted = await w.as((tx) => getJournal(tx, disposal.journalId));
    expect([posted.postingDate, posted.reference, posted.origin]).toEqual(["2026-09-15", "FA-0004", "fixed_asset_disposal"]);
    expect(await w.lines(disposal.journalId)).toEqual([
      ["1650", "2250.00", "0.00"],
      ["1640", "0.00", "30000.00"],
      ["4100", "25000.00", "0.00"],
      ["7030", "2750.00", "0.00"],
    ]);
    expect([await w.balance("1640"), await w.balance("1650"), await w.balance("4100")]).toEqual(["0.00", "0.00", "0.00"]);
    expect((await w.dispose(ute.id, sale, k)).id).toBe(ute.id);
    await expect(w.dispose(ute.id, sale)).rejects.toThrow("disposed, so it can't be disposed of");
    // Later runs leave it out; the register lists it as disposed this year.
    const september = await w.run("2026-09-30");
    expect(september.lines.map((line) => line.assetNumber)).not.toContain("FA-0004");
    const register = await w.as((tx) => fixedAssetRegister(tx, { asOf: "2026-09-30" }));
    expect(register.disposals.map((entry) => [entry.assetNumber, entry.disposalDate, entry.proceeds, entry.gainOrLoss, entry.depreciationThisYear])).toEqual([
      ["FA-0004", "2026-09-15", "25000.00", "-2750.00", "2250.00"],
    ]);
    expect(register.groups.map((group) => group.typeName)).not.toContain("Motor vehicles");
    expect(register.ledger.filter((entry) => entry.accountCode === "1640" || entry.accountCode === "1650").map((entry) => [entry.register, entry.ledger])).toEqual([
      ["0.00", "0.00"],
      ["0.00", "0.00"],
    ]);
    expect(register.ties).toBe(true);
  });

  it("FA8: with the disposal month depreciated, the ute's September is charged before it's taken off", async () => {
    const w = await setup();
    const { ute } = await w.throughAugust();
    await w.as((tx) => updateFixedAssetSettings(tx, { disposalMonth: "include" }));
    const sold = await w.dispose(ute.id, { disposalDate: "2026-09-15", proceeds: "25000.00", proceedsAccountCode: "4100" });
    expect(await w.lines(sold.disposals[0].journalId)).toEqual([
      ["6300", "750.00", "0.00"],
      ["1650", "0.00", "750.00"],
      ["1650", "3000.00", "0.00"],
      ["1640", "0.00", "30000.00"],
      ["4100", "25000.00", "0.00"],
      ["7030", "2000.00", "0.00"],
    ]);
    expect(sold.history.filter((line) => line.kind === "disposal").map((line) => [line.fromMonth, line.toMonth, line.amount])).toEqual([["2026-09", "2026-09", "750.00"]]);
  });

  it("FA9: selling above book value: depreciation recovered, and a capital gain above cost", async () => {
    const w = await setup();
    const { desk, printer } = await w.throughAugust();
    const deskSold = await w.dispose(desk.id, { disposalDate: "2026-09-20", proceeds: "1300.00", proceedsAccountCode: "4100" });
    expect(await w.lines(deskSold.disposals[0].journalId)).toEqual([
      ["1610", "100.00", "0.00"],
      ["1600", "0.00", "1200.00"],
      ["4100", "1300.00", "0.00"],
      ["7030", "0.00", "100.00"],
      ["7040", "0.00", "100.00"],
    ]);
    const printerSold = await w.dispose(printer.id, { disposalDate: "2026-09-20", proceeds: "700.00", proceedsAccountCode: "4100" });
    expect(await w.lines(printerSold.disposals[0].journalId)).toEqual([
      ["1610", "1000.00", "0.00"],
      ["1600", "0.00", "1500.00"],
      ["4100", "700.00", "0.00"],
      ["7030", "0.00", "200.00"],
    ]);
    expect([printerSold.disposals[0].depreciationRecovered, printerSold.disposals[0].capitalGain]).toEqual(["200.00", "0.00"]);
  });

  it("FA10: writing off the laptop charges September's depreciation and posts the book value as a loss", async () => {
    const w = await setup();
    const { laptop } = await w.throughAugust();
    const written = await w.dispose(laptop.id, { disposalDate: "2026-10-10" });
    const disposal = written.disposals[0];
    expect([disposal.depreciation, disposal.accumulatedDepreciation, disposal.bookValue, disposal.proceeds, disposal.loss, disposal.proceedsAccountCode]).toEqual([
      "83.34",
      "416.67",
      "1583.33",
      "0.00",
      "1583.33",
      null,
    ]);
    expect(await w.lines(disposal.journalId)).toEqual([
      ["6300", "83.34", "0.00"],
      ["1630", "0.00", "83.34"],
      ["1630", "416.67", "0.00"],
      ["1620", "0.00", "2000.00"],
      ["7030", "1583.33", "0.00"],
    ]);
    expect((await w.as((tx) => getJournal(tx, disposal.journalId))).description).toBe("Write-off of FA-0001 Laptop");
  });

  it("FA11: undoing a disposal reverses it exactly; a run it was worked out from can't be rolled back first", async () => {
    const w = await setup();
    const { ute, desk, august } = await w.throughAugust();
    const sold = await w.dispose(ute.id, { disposalDate: "2026-09-15", proceeds: "25000.00", proceedsAccountCode: "4100" });
    await expect(w.rollBack(august.id)).rejects.toThrow("Undo the disposal of FA-0004 first");
    await expect(w.as((tx) => tx.query("delete from fixed_asset_disposals where asset_id = $1", [ute.id]))).rejects.toThrow("can't be deleted");
    await expect(w.as((tx) => tx.query("update fixed_assets set cost = 1 where id = $1", [ute.id]))).rejects.toThrow("only its name");
    const k = key("undo");
    const undone = await w.undo(ute.id, k);
    expect([undone.status, undone.accumulatedDepreciation, undone.bookValue, undone.depreciatedTo]).toEqual(["registered", "2250.00", "27750.00", "2026-08-31"]);
    const reversal = await w.as((tx) => getJournal(tx, undone.disposals[0].undoJournalId!));
    expect([reversal.postingDate, reversal.reference]).toEqual(["2026-09-15", "VOID-FA-0004"]);
    expect(await w.lines(reversal.id)).toEqual([
      ["1650", "0.00", "2250.00"],
      ["1640", "30000.00", "0.00"],
      ["4100", "0.00", "25000.00"],
      ["7030", "0.00", "2750.00"],
    ]);
    expect((await w.undo(ute.id, k)).id).toBe(ute.id);
    await expect(w.undo(ute.id)).rejects.toThrow("hasn't been disposed of");
    expect(sold.disposals[0].status).toBe("active");
    const september = await w.run("2026-09-30");
    expect(september.lines.find((line) => line.assetNumber === "FA-0004")?.amount).toBe("750.00");
    // Disposing of the desk after September's run; then rolling back September is refused until it's undone.
    await w.dispose(desk.id, { disposalDate: "2026-10-05" });
    await expect(w.rollBack(september.id)).rejects.toThrow("Undo the disposal of FA-0002 first");
    await w.undo(desk.id);
    expect((await w.rollBack(september.id)).status).toBe("rolled_back");
  });

  it("FA12: an asset's tracking goes onto its depreciation and disposal lines", async () => {
    const w = await setup();
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const department = (await w.as((tx) => getTrackingSetup(tx))).categories.find((c) => c.kind === "department")!.id;
    const farm = (await w.as((tx) => createTrackingValue(tx, { categoryId: department, name: "Farm" }))).categories
      .find((c) => c.id === department)!
      .values.find((v) => v.name === "Farm")!.id;
    await w.standard();
    const ute = await w.registerUte({ tracking: { [department]: farm } });
    expect(ute.tracking).toEqual({ [department]: farm });
    const june = await w.run("2026-06-30");
    const lines = (await w.as((tx) => getJournal(tx, june.journalId!))).lines;
    expect(lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount, line.tracking])).toEqual([
      ["6300", "166.67", "0.00", {}],
      ["1630", "0.00", "166.67", {}],
      ["6300", "750.00", "0.00", { [department]: farm }],
      ["1650", "0.00", "750.00", { [department]: farm }],
      ["6300", "120.00", "0.00", {}],
      ["1610", "0.00", "120.00", {}],
    ]);
    const sold = await w.dispose(ute.id, { disposalDate: "2026-07-10", proceeds: "29000.00", proceedsAccountCode: "4100" });
    const disposalLines = (await w.as((tx) => getJournal(tx, sold.disposals[0].journalId))).lines;
    expect(disposalLines.every((line) => line.tracking[department] === farm)).toBe(true);
  });

  it("FA13: the register as at 30 Jun 2026 ties to the ledger, and shows a manual journal as a difference", async () => {
    const w = await setup();
    await w.standard();
    await w.run("2026-05-31");
    await w.registerUte();
    await w.run("2026-06-30");
    const register = await w.as((tx) => fixedAssetRegister(tx, { asOf: "2026-06-30" }));
    expect(register.financialYearStart).toBe("2026-04-01");
    expect(
      register.groups.map((group) => [
        group.typeName,
        group.assets.map((a) => [a.assetNumber, a.cost, a.accumulatedDepreciation, a.bookValue, a.depreciationThisYear]),
        [group.totals.cost, group.totals.accumulatedDepreciation, group.totals.bookValue, group.totals.depreciationThisYear],
      ]),
    ).toEqual([
      ["Computer equipment", [["FA-0001", "2000.00", "166.67", "1833.33", "166.67"]], ["2000.00", "166.67", "1833.33", "166.67"]],
      ["Motor vehicles", [["FA-0004", "30000.00", "750.00", "29250.00", "750.00"]], ["30000.00", "750.00", "29250.00", "750.00"]],
      [
        "Office equipment",
        [
          ["FA-0002", "1200.00", "60.00", "1140.00", "60.00"],
          ["FA-0003", "1500.00", "960.00", "540.00", "60.00"],
        ],
        ["2700.00", "1020.00", "1680.00", "120.00"],
      ],
    ]);
    expect(register.totals).toEqual({ cost: "34700.00", accumulatedDepreciation: "1936.67", bookValue: "32763.33", depreciationThisYear: "1036.67" });
    expect(register.ledger.map((entry) => [entry.accountCode, entry.role, entry.register, entry.ledger, entry.difference])).toEqual([
      ["1600", "cost", "2700.00", "2700.00", "0.00"],
      ["1610", "accumulated_depreciation", "1020.00", "1020.00", "0.00"],
      ["1620", "cost", "2000.00", "2000.00", "0.00"],
      ["1630", "accumulated_depreciation", "166.67", "166.67", "0.00"],
      ["1640", "cost", "30000.00", "30000.00", "0.00"],
      ["1650", "accumulated_depreciation", "750.00", "750.00", "0.00"],
    ]);
    expect(register.ties).toBe(true);
    // As at 31 May: before the June run and before the ute.
    const may = await w.as((tx) => fixedAssetRegister(tx, { asOf: "2026-05-31" }));
    expect([may.totals.cost, may.totals.accumulatedDepreciation]).toEqual(["4700.00", "1063.33"]);
    await w.journal("2026-06-30", "WRITE-DOWN", [
      ["6130", "50.00", ""],
      ["1600", "", "50.00"],
    ]);
    const after = await w.as((tx) => fixedAssetRegister(tx, { asOf: "2026-06-30" }));
    expect(after.ledger.find((entry) => entry.accountCode === "1600")).toMatchObject({ register: "2700.00", ledger: "2650.00", difference: "-50.00" });
    expect(after.ties).toBe(false);
    const viewerCookie = await sessionCookieFor(viewer);
    const response = await registerRoute.GET(apiRequest(`/api/reports/fixed-asset-register?organisationId=${w.org}&asOf=2026-06-30`, { cookie: viewerCookie }), noContext);
    expect(response.status).toBe(200);
  });

  it("FA14: what can change, archiving, who can run depreciation, and where the journals came from", async () => {
    const w = await setup();
    const { laptop, desk } = await w.standard();
    // Before depreciation anything can change; after, only the name, description and tracking.
    const renamed = await w.asAroha((tx) => updateFixedAsset(tx, desk.id, { cost: "1250.00", name: "Standing desk" }));
    expect([renamed.cost, renamed.name]).toEqual(["1250.00", "Standing desk"]);
    await w.asAroha((tx) => updateFixedAsset(tx, desk.id, { cost: "1200.00" }));
    const may = await w.run("2026-05-31");
    await expect(w.asAroha((tx) => updateFixedAsset(tx, desk.id, { cost: "1300.00" }))).rejects.toThrow("only its name, description and tracking");
    await expect(w.asAroha((tx) => updateFixedAsset(tx, desk.id, { rate: "25" }))).rejects.toThrow("only its name");
    expect((await w.asAroha((tx) => updateFixedAsset(tx, desk.id, { description: "Rimu" }))).description).toBe("Rimu");
    await expect(w.asAroha((tx) => archiveFixedAsset(tx, laptop.id))).rejects.toThrow("can't be archived");
    await expect(w.as((tx) => tx.query("delete from fixed_assets where id = $1", [laptop.id]))).rejects.toThrow("can't be deleted");
    await expect(w.as((tx) => tx.query("update fixed_assets set status = 'archived', archived_at = now() where id = $1", [laptop.id]))).rejects.toThrow("can't be archived");
    // The type's accounts can't change once it has assets.
    await expect(w.as((tx) => tx.query("update fixed_asset_types set asset_account_id = (select id from accounts where code = '1640') where id = $1", [w.types.computers.id]))).rejects.toThrow(
      "its accounts can't change",
    );
    // Viewers read runs and the register but can't run depreciation.
    const viewerCookie = await sessionCookieFor(viewer);
    const refused = await runsRoute.POST(apiRequest("/api/depreciation-runs", { method: "POST", cookie: viewerCookie, body: { organisationId: w.org, idempotencyKey: key("r"), periodEnd: "2026-06-30" } }), noContext);
    expect(refused.status).toBe(403);
    const listed = await runsRoute.GET(apiRequest(`/api/depreciation-runs?organisationId=${w.org}`, { cookie: viewerCookie }), noContext);
    expect(((await listed.json()) as { runs: Array<{ id: string }> }).runs.map((run) => run.id)).toEqual([may.id]);
    // Their journals are corrected by rolling back or undoing, not in the ledger, and say where they came from.
    expect((await w.as((tx) => getJournalDetails(tx, may.journalId!))).canCorrect).toBe(false);
    const sold = await w.dispose(desk.id, { disposalDate: "2026-06-10" });
    expect((await w.as((tx) => getJournalDetails(tx, sold.disposals[0].journalId))).canCorrect).toBe(false);
    const accumulatedId = (await w.as((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '1610'"))).rows[0].id;
    const report = await w.as((tx) => accountTransactions(tx, { accountId: accumulatedId, from: "2026-05-01", to: "2026-06-30" }));
    expect(report.accounts[0].lines.map((line) => [line.source.label, line.source.href])).toEqual([
      ["Depreciation run DEP-2026-05", `/operations/fixed-assets/depreciation?run=${may.id}`],
      ["Disposal of FA-0002", `/operations/fixed-assets/${desk.id}`],
    ]);
    const deskNow: FixedAsset = await w.asset(desk.id);
    expect(deskNow.status).toBe("disposed");
  });
});
