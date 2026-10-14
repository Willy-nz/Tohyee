import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { getJournal } from "@/lib/ledger/journals";
import { headCount, recordMovement, setOpenings, updateLivestockSettings, voidMovement } from "@/lib/livestock/movements";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { cashFlowStatement } from "@/lib/reports/statements";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "livestock-rations";

/** Killed for rations (RAT1-RAT4, #259; not yet reviewed). */
describeWithDatabase("livestock killed for rations", () => {
  let server: TestServer;
  let owner: SessionUser;
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const move = (fields: Record<string, unknown>) =>
    run((tx) => recordMovement(tx, { idempotencyKey: key("lv"), kind: "dairy_cattle", classCode: "ma_cows", ...fields })).then((result) => result.movement);
  const cows = async () => (await run((tx) => headCount(tx, { yearEnd: "2026-05-31" }))).rows.find((row) => row.classCode === "ma_cows")!;
  const journalLines = async (id: string) =>
    (await run((tx) => getJournal(tx, id))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]);

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("rations-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    await run((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 5 }));
    await run((tx) => updateLivestockSettings(tx, { enabled: true, firstYearStart: "2025-06-01" }));
    await run((tx) => setOpenings(tx, { lines: [{ kind: "dairy_cattle", classCode: "ma_cows", head: 300, value: "750000.00" }] }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("RAT1: the owner's rations are income at market value, Dr drawings, Cr rations income", async () => {
    await expect(move({ movementType: "rations", movementDate: "2026-03-10", head: 1 })).rejects.toThrow(/Whose rations/);
    await expect(move({ movementType: "rations", rationsFor: "owner", movementDate: "2026-03-10", head: 1 })).rejects.toThrow(/market value/);
    const rations = await move({ movementType: "rations", rationsFor: "owner", movementDate: "2026-03-10", head: 1, amount: "1100.00" });
    expect(rations).toMatchObject({ movementType: "rations", rationsFor: "owner", amount: "1100.00" });
    expect(rations.journalId).not.toBeNull();
    const journal = await run((tx) => getJournal(tx, rations.journalId!));
    expect(journal).toMatchObject({ origin: "livestock_rations", postingDate: "2026-03-10" });
    expect(await journalLines(rations.journalId!)).toEqual([
      ["3100", "1100.00", "0.00"],
      ["7070", "0.00", "1100.00"],
    ]);
    const accounts = await run((tx) => tx.query<{ code: string; name: string; account_type: string }>("select code, name, account_type from accounts where code = '7070'"));
    expect(accounts.rows[0]).toEqual({ code: "7070", name: "Livestock rations (private use)", account_type: "other_income" });
  });

  it("RAT2: staff rations post nothing and take no value", async () => {
    await expect(move({ movementType: "rations", rationsFor: "staff", movementDate: "2026-03-12", head: 2, amount: "500.00" })).rejects.toThrow(/Staff rations have no value/);
    const staff = await move({ movementType: "rations", rationsFor: "staff", movementDate: "2026-03-12", head: 2 });
    expect(staff).toMatchObject({ rationsFor: "staff", amount: null, journalId: null });
    await expect(move({ movementType: "death", rationsFor: "staff", movementDate: "2026-03-12", head: 1 })).rejects.toThrow(/Only rations/);
  });

  it("RAT4: rations have their own head count column; the owner's rations are non-cash in the cash flow statement", async () => {
    const row = await cows();
    expect(row).toMatchObject({ opening: 300, rations: 3, died: 0, closing: 297 });
    const cf = await run((tx) => cashFlowStatement(tx, { from: "2025-06-01", to: "2026-05-31" }));
    expect(cf.operating.profit).toBe("1100.00");
    expect(cf.operating.adjustments.map((entry) => [entry.label, entry.amount])).toEqual([["Owner's rations (no cash)", "-1100.00"]]);
    expect([cf.operating.total, cf.financing.total, cf.netChange, cf.reconciles]).toEqual(["0.00", "0.00", "0.00", true]);
  });

  it("RAT3: voiding the owner's rations reverses the journal on the same date; can't go below zero", async () => {
    const rations = await move({ movementType: "rations", rationsFor: "owner", movementDate: "2026-04-01", head: 1, amount: "900.00" });
    await run((tx) => voidMovement(tx, rations.id, { reason: "Entered twice" }));
    const reversal = await run((tx) =>
      tx.query<{ id: string; posting_date: string; correction_kind: string }>(
        "select id::text, posting_date::text, correction_kind from ledger_journals where related_journal_id = $1",
        [rations.journalId],
      ),
    );
    expect(reversal.rows).toHaveLength(1);
    expect(reversal.rows[0]).toMatchObject({ posting_date: "2026-04-01", correction_kind: "reversal" });
    expect(await journalLines(reversal.rows[0].id)).toEqual([
      ["3100", "0.00", "900.00"],
      ["7070", "900.00", "0.00"],
    ]);
    expect((await cows()).closing).toBe(297);
    await expect(move({ movementType: "rations", rationsFor: "staff", movementDate: "2026-04-02", head: 298 })).rejects.toThrow(/below zero/);
  });
});
