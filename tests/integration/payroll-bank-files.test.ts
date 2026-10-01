import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as settingsRoute from "@/app/api/payroll/bank-file-settings/route";
import * as bankFileRoute from "@/app/api/payroll/pay-runs/[payRunId]/bank-file/route";
import * as paymentVoidRoute from "@/app/api/payroll/pay-runs/[payRunId]/payments/[paymentId]/void/route";
import * as paymentsRoute from "@/app/api/payroll/pay-runs/[payRunId]/payments/route";
import { createBankAccount } from "@/lib/bank/accounts";
import { todayIsoDate } from "@/lib/dates";
import type { BankFileSettings, PayRunBankFile } from "@/lib/payroll/bank-file-service";
import { updateEmployee } from "@/lib/payroll/employees";
import type { PayRunPayments, WagePayment } from "@/lib/payroll/wage-payments";
import { type P5World, setUpP5World } from "../helpers/payroll-p5";
import { describeWithDatabase, key, params, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * Examples PBF1-PBF7 in docs/ACCOUNTING-EXAMPLES.md ("NZ payroll — bank
 * files for paying wages", not yet approved by Jess), through the API
 * routes against PostgreSQL. The files' bytes are checked against the
 * examples; the creation date is today's (the file is made now).
 */

const CRLF = "\r\n";
const sp = (count: number) => " ".repeat(count);

describeWithDatabase("payroll: bank files (PBF1-PBF7)", () => {
  let server: TestServer;
  let w: P5World;
  let run1 = ""; // PAYRUN-1 (PRUN1): Kiri Tane 1,657.00, Hemi Walker 2,042.50
  let run2 = ""; // PAYRUN-2 (PRUN3): Aroha Ngata 2,590.50
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const today = todayIsoDate();
  const yyyymmdd = (date: string) => date.replace(/-/g, "");
  const yymmdd = (date: string) => date.replace(/-/g, "").slice(2);
  // BNZ won't take a due date before today; the pay date is 14 Oct 2026.
  const bnzDue = today > "2026-10-14" ? today : "2026-10-14";

  const makeFile = (user: P5World["ben"], payRunId: string, body: Record<string, unknown>) =>
    w.call(bankFileRoute.POST, user, `/api/payroll/pay-runs/${payRunId}/bank-file`, { method: "POST", body, context: params({ payRunId }) });

  const fileOf = async (payRunId: string, body: Record<string, unknown>) => {
    const response = await makeFile(w.ben, payRunId, body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.file as PayRunBankFile;
  };

  const payments = async (payRunId: string) =>
    (await w.call(paymentsRoute.GET, w.ben, `/api/payroll/pay-runs/${payRunId}/payments`, { context: params({ payRunId }) })).body.payments as PayRunPayments;

  const pay = async (payRunId: string, body: Record<string, unknown>) => {
    const response = await w.call(paymentsRoute.POST, w.ben, `/api/payroll/pay-runs/${payRunId}/payments`, {
      method: "POST",
      body: { idempotencyKey: key("wages"), bankAccountCode: "1000", paymentDate: "2026-10-14", ...body },
      context: params({ payRunId }),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.payment as WagePayment;
  };

  const setUp = (user: P5World["mere"], body: Record<string, unknown>) => w.call(settingsRoute.PUT, user, "/api/payroll/bank-file-settings", { method: "PUT", body });

  const accountId = async (code: string) =>
    ((await w.call(settingsRoute.GET, w.ben, "/api/payroll/bank-file-settings")).body as BankFileSettings).accounts.find((account) => account.code === code)!.accountId;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    w = await setUpP5World("payroll-bank-files-co", "paybankfiles.test");
    await w.asUser(w.jess, (tx) => createBankAccount(tx, { code: "1010", name: "ASB cheque", accountType: "bank" }));
    await w.asUser(w.jess, (tx) => createBankAccount(tx, { code: "1020", name: "BNZ wages", accountType: "bank" }));
    await w.asUser(w.jess, (tx) => createBankAccount(tx, { code: "1030", name: "Not set up", accountType: "bank" }));
    const first = await w.approvedRun(w.groups.fortnightly, "2026-09-28");
    expect(first.reference).toBe("PAYRUN-1");
    run1 = first.id;
    const second = await w.approvedRun(w.groups.fourWeekly, "2026-09-14");
    expect(second.reference).toBe("PAYRUN-2");
    run2 = second.id;
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  describe("settings", () => {
    it("PBF7: admins set each bank account's number and format; bookkeepers can only see them; Westpac and Kiwibank are refused", async () => {
      const listed = (await w.call(settingsRoute.GET, w.ben, "/api/payroll/bank-file-settings")).body as BankFileSettings;
      expect(listed.formats.map((format) => format.format)).toEqual(["anz_domestic_extended", "asb_mt9", "bnz_ib4b"]);
      expect(listed.refused.map((bank) => bank.bank)).toEqual(["Westpac", "Kiwibank"]);
      expect(listed.accounts.find((account) => account.code === "1000")).toMatchObject({ format: null, accountNumber: null });

      const byBen = await setUp(w.ben, { accountId: await accountId("1000"), format: "anz_domestic_extended", accountNumber: "01-0505-0111222-00" });
      expect(byBen.status).toBe(403);
      const badNumber = await setUp(w.mere, { accountId: await accountId("1000"), format: "anz_domestic_extended", accountNumber: "01-0505-011122-00" });
      expect(badNumber.status).toBe(400);
      expect(badNumber.body.error).toBe("Enter 1000's New Zealand bank account number (bank 2 digits, branch 4, account 7, suffix 2 or 3).");
      const westpac = await setUp(w.mere, { accountId: await accountId("1000"), format: "westpac", accountNumber: "03-0123-0123456-00" });
      expect(westpac.status).toBe(400);
      expect(westpac.body.error).toBe(
        "Not supported yet (refused rather than guessed): Westpac doesn't publish a field-level specification of its payment files. Ask Westpac for it.",
      );
      const kiwibank = await setUp(w.mere, { accountId: await accountId("1000"), format: "Kiwibank", accountNumber: "38-9000-0123456-00" });
      expect(kiwibank.body.error).toContain("Kiwibank doesn't publish");

      const anz = await setUp(w.mere, { accountId: await accountId("1000"), format: "anz_domestic_extended", accountNumber: "01 0505 0111222 00" });
      expect(anz.status).toBe(200);
      expect(anz.body.setting).toMatchObject({ code: "1000", format: "anz_domestic_extended", formatLabel: "ANZ domestic extended", accountNumber: "01-0505-0111222-00" });
      expect((await setUp(w.mere, { accountId: await accountId("1010"), format: "asb_mt9", accountNumber: "12-3011-0333444-00" })).status).toBe(200);
      expect((await setUp(w.mere, { accountId: await accountId("1020"), format: "bnz_ib4b", accountNumber: "0201000555666000" })).status).toBe(200);
    });
  });

  describe("making files", () => {
    it("PBF1: ANZ file for PAYRUN-1, byte for byte; nothing is posted or paid", async () => {
      const file = await fileOf(run1, { bankAccountCode: "1000", dueDate: "2026-10-14" });
      expect(file.content).toBe(
        [
          `1,,,,,,20261014,${yyyymmdd(today)},`,
          "2,1231910654321001,50,165700,Kiri Tane,2026-10-14,PAYRUN-1,,Wages,Harbour Cafe Ltd,PAYRUN-1,2026-10-14,Wages",
          "2,0102420123456000,50,204250,Hemi Walker,2026-10-14,PAYRUN-1,,Wages,Harbour Cafe Ltd,PAYRUN-1,2026-10-14,Wages",
          "3,369950,2,34330777777",
        ].join(CRLF) + CRLF,
      );
      expect(file).toMatchObject({ fileName: "PAYRUN-1 ANZ 2026-10-14.csv", count: 2, total: "3699.50", hashTotal: "34330777777", payRunReference: "PAYRUN-1" });
      expect(await payments(run1)).toMatchObject({ unpaid: "3699.50", paid: "0.00", payments: [] });
      // The due date defaults to the pay date.
      expect((await fileOf(run1, { bankAccountCode: "1000" })).content.split(CRLF)[0]).toBe(`1,,,,,,20261014,${yyyymmdd(today)},`);
    });

    it("PBF2: ASB MT9 file for PAYRUN-1, byte for byte", async () => {
      const file = await fileOf(run1, { bankAccountCode: "1010", dueDate: "2026-10-14" });
      const detail = (bank: string, branch: string, base: string, suffix: string, cents: string, name: string) =>
        "13" + bank + branch + base + suffix + "052" + cents + name + "PAYRUN-1" + sp(4) + "PAYRUN-1" + sp(4) + "2026-10-14" + sp(2) + "Wages" + sp(7) + sp(1) +
        "Harbour Cafe Ltd" + sp(4) + "PAYRUN-1" + sp(4) + "2026-10-14" + sp(2) + "Wages" + sp(7) + sp(4);
      expect(file.content).toBe(
        "12" + "12" + "3011" + "0333444" + "00 " + "14102026" + sp(5) + "Harbour Cafe Ltd" + sp(4) + sp(109) + "\r" +
          detail("12", "3191", "0654321", "001", "0000165700", "Kiri Tane" + sp(11)) + "\r" +
          detail("01", "0242", "0123456", "000", "0000204250", "Hemi Walker" + sp(9)) + "\r" +
          "13" + "99" + "34330777777" + sp(6) + "0000369950" + sp(129) + "\r",
      );
      expect(file.fileName).toBe("PAYRUN-1 ASB 2026-10-14.txt");
    });

    it("PBF3: BNZ file for PAYRUN-1, one statement line or one each; a due date before today is refused", async () => {
      const file = await fileOf(run1, { bankAccountCode: "1020", dueDate: bnzDue });
      expect(file.content).toBe(
        [
          `1,,,,0201000555666000,7,${yymmdd(bnzDue)},${yymmdd(today)},`,
          "2,1231910654321001,52,165700,Kiri Tane,2026-10-14,PAYRUN-1,,Wages,Harbour Cafe Ltd,PAYRUN-1,2026-10-14,Wages",
          "2,0102420123456000,52,204250,Hemi Walker,2026-10-14,PAYRUN-1,,Wages,Harbour Cafe Ltd,PAYRUN-1,2026-10-14,Wages",
          "3,369950,2,34330777777",
        ].join(CRLF) + CRLF,
      );
      const each = await fileOf(run1, { bankAccountCode: "1020", dueDate: bnzDue, statementLines: "each" });
      expect(each.content.split(CRLF)[0]).toBe(`1,,,,0201000555666000,7,${yymmdd(bnzDue)},${yymmdd(today)},I`);
      const yesterday = new Date(`${today}T00:00:00Z`);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const early = await makeFile(w.ben, run1, { bankAccountCode: "1020", dueDate: yesterday.toISOString().slice(0, 10) });
      expect(early.status).toBe(400);
      expect(early.body.error).toBe(`BNZ won't take a due date before the day the file is made (${today}).`);
    });

    it("PBF4: one employee; BNZ zero-fills the hash total, ANZ doesn't, ASB's is a fixed 11 digits", async () => {
      const bnz = await fileOf(run2, { bankAccountCode: "1020", dueDate: bnzDue, statementLines: "each" });
      expect(bnz.content).toBe(
        [
          `1,,,,0201000555666000,7,${yymmdd(bnzDue)},${yymmdd(today)},I`,
          "2,0201080987654000,52,259050,Aroha Ngata,2026-10-14,PAYRUN-2,,Wages,Harbour Cafe Ltd,PAYRUN-2,2026-10-14,Wages",
          "3,259050,1,01080987654",
        ].join(CRLF) + CRLF,
      );
      expect((await fileOf(run2, { bankAccountCode: "1000" })).content.split(CRLF)[2]).toBe("3,259050,1,1080987654");
      expect((await fileOf(run2, { bankAccountCode: "1010" })).content.split("\r")[2]).toBe("13" + "99" + "01080987654" + sp(6) + "0000259050" + sp(129));
    });

    it("PBF5: only what's unpaid; then nothing left; a run paid in part as a whole is refused", async () => {
      await pay(run1, { amount: "2042.50", employeeId: w.people.hemi });
      const kiriOnly = await fileOf(run1, { bankAccountCode: "1000" });
      expect(kiriOnly.content.split(CRLF).slice(1, 3)).toEqual([
        "2,1231910654321001,50,165700,Kiri Tane,2026-10-14,PAYRUN-1,,Wages,Harbour Cafe Ltd,PAYRUN-1,2026-10-14,Wages",
        "3,165700,1,31910654321",
      ]);
      await pay(run1, { amount: "1657.00", employeeId: w.people.kiri });
      const nothing = await makeFile(w.ben, run1, { bankAccountCode: "1000" });
      expect(nothing.status).toBe(409);
      expect(nothing.body.error).toBe("Nothing is left to pay on PAYRUN-1.");

      const part = await pay(run2, { amount: "100.00" });
      const whole = await makeFile(w.ben, run2, { bankAccountCode: "1000" });
      expect(whole.status).toBe(409);
      expect(whole.body.error).toBe(
        "PAYRUN-2 has been paid in part as a whole, so Tohyee can't tell whose pay is left. Void that payment, or pay the rest in your bank's own screens.",
      );
      const voided = await w.call(paymentVoidRoute.POST, w.ben, `/api/payroll/pay-runs/${run2}/payments/${part.id}/void`, {
        method: "POST",
        body: { idempotencyKey: key("void"), voidDate: "2026-10-14" },
        context: params({ payRunId: run2, paymentId: part.id }),
      });
      expect(voided.status).toBe(201);
      expect((await fileOf(run2, { bankAccountCode: "1000" })).total).toBe("2590.50");
    });
  });

  describe("refused and access", () => {
    it("PBF6: employees' bank accounts, unset bank accounts and drafts", async () => {
      await w.asUser(w.jess, (tx) => updateEmployee(tx, w.people.aroha, { bankAccount: "02-0108-098765-000" }));
      const bad = await makeFile(w.ben, run2, { bankAccountCode: "1000" });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe(
        "Aroha Ngata's bank account isn't a New Zealand bank account number (bank 2 digits, branch 4, account 7, suffix 2 or 3). Fix it under Payroll › Employees.",
      );
      expect(JSON.stringify(bad.body)).not.toContain("098765");
      await w.asUser(w.jess, (tx) => updateEmployee(tx, w.people.aroha, { bankAccount: null }));
      const none = await makeFile(w.ben, run2, { bankAccountCode: "1000" });
      expect(none.body.error).toBe("Aroha Ngata has no bank account. Add it under Payroll › Employees.");
      await w.asUser(w.jess, (tx) => updateEmployee(tx, w.people.aroha, { bankAccount: "02-0108-0987654-000" }));

      const unset = await makeFile(w.ben, run2, { bankAccountCode: "1030" });
      expect(unset.status).toBe(400);
      expect(unset.body.error).toBe("Set up 1030 (Not set up) for bank files first: an admin enters its account number and bank under Settings › Bank files.");
      const notBank = await makeFile(w.ben, run2, { bankAccountCode: "6200" });
      expect(notBank.body.error).toBe("There's no bank account with the code 6200.");

      const draft = await w.draftRun(w.groups.fortnightly, "2026-10-12", "2026-10-28");
      expect(draft.reference).toBe("PAYRUN-3");
      const fromDraft = await makeFile(w.ben, draft.id, { bankAccountCode: "1000" });
      expect(fromDraft.status).toBe(409);
      expect(fromDraft.body.error).toBe("PAYRUN-3 is a draft, so it has no bank file. Approve it first.");
    });

    it("PBF7: payroll access and the bookkeeper role; the audit log has no amounts or account numbers", async () => {
      const noah = await makeFile(w.noah, run2, { bankAccountCode: "1000" });
      expect(noah.status).toBe(403);
      expect(noah.body.error).toContain("You need payroll access to see payroll");
      expect((await makeFile(w.vic, run2, { bankAccountCode: "1000" })).status).toBe(403);
      expect((await w.call(settingsRoute.GET, w.vic, "/api/payroll/bank-file-settings")).status).toBe(403);

      const events = await w.asUser(w.jess, (tx) =>
        tx.query<{ entity_id: string; details: Record<string, unknown> }>(
          "select entity_id, details from audit_events where event_type = 'payroll_bank_file.made' order by id",
        ),
      );
      expect(events.rows.length).toBeGreaterThan(5);
      expect(events.rows[0]).toMatchObject({
        entity_id: run1,
        details: { payRunReference: "PAYRUN-1", bankAccountCode: "1000", format: "anz_domestic_extended", dueDate: "2026-10-14", payments: 2 },
      });
      const everything = JSON.stringify(
        (await w.asUser(w.jess, (tx) => tx.query("select event_type, details from audit_events where event_type in ('payroll_bank_file.made', 'bank_file_settings.changed')"))).rows,
      );
      for (const secret of ["0654321", "0123456", "0987654", "1657", "2042", "2590", "3699"]) expect(everything).not.toContain(secret);
    });
  });
});
