import { afterAll, beforeAll, expect, it } from "vitest";
import * as historyRoute from "@/app/api/import/history/route";
import { createAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import { parseDelimited } from "@/lib/bank/formats/table";
import type { OrgTx } from "@/lib/db/org-transaction";
import { applyMapping, autoMap, findHeaderRow, type ImportRecord } from "@/lib/import/fields";
import { importConversion } from "@/lib/import/conversion";
import { importHistory } from "@/lib/import/history";
import { listJournals } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;
const plain = (problems: Array<{ row: number; message: string }>) => problems.map(({ row, message }) => ({ row, message }));

/** Rows mapped the way the import screen maps them (headings matched automatically). */
function mapped(text: string): ImportRecord[] {
  const rows = parseDelimited(text.trim());
  const headerRow = findHeaderRow("general_ledger", rows);
  return applyMapping(rows, headerRow, autoMap("general_ledger", rows[headerRow], "other_system"));
}

const LEDGER = `Date,ID#,Account,Memo,Debit,Credit
05/06/2025,CD000101,6400,Farm Source feed,"1,000.00",
05/06/2025,CD000101,2100,Farm Source feed,150.00,
05/06/2025,CD000101,1000,Farm Source feed,,"1,150.00"
20/06/2025,CR000050,1000,Milk payment,"23,000.00",
20/06/2025,CR000050,4000,Milk payment,,"20,000.00"
20/06/2025,CR000050,2100,Milk payment,,"3,000.00"
30/06/2025,GJ000007,6300,Depreciation June,500.00,
30/06/2025,GJ000007,1650,Depreciation June,,500.00`;

/** The same transactions as MYOB's general ledger (detail) lays them out: account headings, totals. */
const MYOB_LAYOUT = `Account,Date,ID#,Memo,Debit,Credit
1000 Business bank account,,,,,
,,,Beginning Balance,,
,05/06/2025,CD000101,Farm Source feed,,"1,150.00"
,20/06/2025,CR000050,Milk payment,"23,000.00",
,,,Total,"23,000.00","1,150.00"
1650 Accumulated depreciation - motor vehicles,,,,,
,30/06/2025,GJ000007,Depreciation June,,500.00
2100 GST,,,,,
,05/06/2025,CD000101,Farm Source feed,150.00,
,20/06/2025,CR000050,Milk payment,,"3,000.00"
4000 Sales,,,,,
,20/06/2025,CR000050,Milk payment,,"20,000.00"
6300 Depreciation,,,,,
,30/06/2025,GJ000007,Depreciation June,500.00,
6400 Feed,,,,,
,05/06/2025,CD000101,Farm Source feed,"1,000.00",`;

/** Examples IM22-IM28 in docs/ACCOUNTING-EXAMPLES.md ("History: a general ledger as journals"). */
describeWithDatabase("bringing in a general ledger as history", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("history-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function farm(options: { converted?: boolean } = {}) {
    organisations += 1;
    const org = `history-${organisations}-farm`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => createAccount(tx, { code: "6400", name: "Feed", accountType: "expense" }));
    if (options.converted !== false) {
      const tb = parseDelimited("Account code,Debit,Credit\n1000,10000.00,\n3000,,10000.00");
      await as((tx) =>
        importConversion(tx, { idempotencyKey: key("conv"), conversionDate: "2025-05-31", trialBalance: applyMapping(tb, 0, autoMap("trial_balance", tb[0], "tohyee")) }, true),
      );
    }
    const run = (records: ImportRecord[], commit: boolean, idempotencyKey = key("gl"), fileName = "farm-gl.csv") =>
      as((tx) => importHistory(tx, { idempotencyKey, fileName, records }, commit));
    const balance = async (code: string, asAt: string) =>
      (
        await as((tx) =>
          tx.query<{ balance: string }>(
            `select coalesce(sum(l.debit_amount - l.credit_amount), 0)::numeric(18,2)::text as balance
               from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id join accounts a on a.id = l.account_id
              where a.code = $1 and j.posting_date <= $2`,
            [code, asAt],
          ),
        )
      ).rows[0].balance;
    return { org, as, run, balance };
  }

  it("IM22: a general ledger comes in as one journal per date and ID#; the check posts nothing", async () => {
    const f = await farm();
    const check = await f.run(mapped(LEDGER), false);
    expect(check).toMatchObject({ ok: true, committed: false, problems: [] });
    expect(check.summary).toMatchObject({ journals: 3, lines: 8, from: "2025-06-05", to: "2025-06-30", debits: "24650.00", credits: "24650.00", skipped: 0 });
    expect(await f.balance("1000", "2025-06-30")).toBe("10000.00");

    const done = await f.run(mapped(LEDGER), true);
    expect(done).toMatchObject({ ok: true, committed: true });
    expect(await f.balance("1000", "2025-06-30")).toBe("31850.00");
    expect(await f.balance("2100", "2025-06-30")).toBe("-2850.00");
    expect(await f.balance("6400", "2025-06-30")).toBe("1000.00");
    const journals = await f.as((tx) =>
      tx.query<{ posting_date: string; reference: string; description: string; origin: string; lines: string }>(
        `select j.posting_date::text, j.reference, j.description, j.origin, (select count(*) from ledger_journal_lines l where l.journal_id = j.id)::text as lines
           from ledger_journals j where j.origin = 'history' order by j.posting_date`,
      ),
    );
    expect(journals.rows).toEqual([
      { posting_date: "2025-06-05", reference: "CD000101", description: "Farm Source feed", origin: "history", lines: "3" },
      { posting_date: "2025-06-20", reference: "CR000050", description: "Milk payment", origin: "history", lines: "3" },
      { posting_date: "2025-06-30", reference: "GJ000007", description: "Depreciation June", origin: "history", lines: "2" },
    ]);
  });

  it("IM23: the journal list leaves history out unless asked; an Amount column works too", async () => {
    const f = await farm();
    const amounts = mapped(`Date,Reference,Account Code,Description,Amount
05/06/2025,CD000101,6400,Farm Source feed,1000.00
05/06/2025,CD000101,2100,Farm Source feed,150.00
05/06/2025,CD000101,1000,Farm Source feed,-1150.00`);
    expect(await f.run(amounts, true)).toMatchObject({ ok: true, committed: true, summary: { journals: 1, lines: 3 } });
    const all = await f.as((tx) => listJournals(tx, {}));
    expect(all.journals.some((journal) => journal.origin === "history")).toBe(false);
    const history = await f.as((tx) => listJournals(tx, { kind: "history" }));
    expect(history.journals.map((journal) => journal.reference)).toEqual(["CD000101"]);
    expect(await f.balance("1000", "2025-06-30")).toBe("8850.00");
  });

  it("IM24: MYOB's layout, with account headings and totals, gives the same journals", async () => {
    const f = await farm();
    const check = await f.run(mapped(MYOB_LAYOUT), true);
    expect(check.problems).toEqual([]);
    expect(check.summary).toMatchObject({ journals: 3, lines: 8, debits: "24650.00", credits: "24650.00", skipped: 2 });
    expect(await f.balance("1000", "2025-06-30")).toBe("31850.00");
    expect(await f.balance("1650", "2025-06-30")).toBe("-500.00");
  });

  it("IM25: an unbalanced journal, an unknown account or a date in the opening balances refuses the whole file", async () => {
    const f = await farm();
    const unbalanced = await f.run(mapped(LEDGER.replace("2100,Milk payment,,\"3,000.00\"", "2100,Milk payment,,\"2,999.00\"")), true);
    expect(unbalanced.committed).toBe(false);
    expect(plain(unbalanced.problems)).toEqual([{ row: 5, message: "CR000050 on 20 Jun 2025 (rows 5-7) is out by 1.00: debits 23000.00, credits 22999.00." }]);
    expect(await f.balance("1000", "2025-06-30")).toBe("10000.00");

    const unknown = await f.run(mapped(LEDGER.replace("30/06/2025,GJ000007,6300", "30/06/2025,GJ000007,6999")), true);
    expect(plain(unknown.problems)).toEqual([{ row: 8, message: "There's no account 6999. Bring in the chart of accounts first." }]);

    const early = await f.run(mapped(LEDGER.replace(/05\/06\/2025/g, "31/05/2025")), true);
    expect(plain(early.problems)).toEqual([
      { row: 2, message: "CD000101 is dated 31 May 2025, on or before the opening balances (31 May 2025): it's in them already." },
    ]);

    await f.as((tx) => updatePeriodControls(tx, { lockDate: "2025-06-10" }));
    const locked = await f.run(mapped(LEDGER), true);
    expect(locked.committed).toBe(false);
    expect(locked.problems[0]).toMatchObject({ row: 2 });
    expect(locked.problems[0].message).toMatch(/locked/);
  });

  it("IM26: a journal already imported isn't imported again; a retry returns the first result", async () => {
    const f = await farm();
    const idempotencyKey = key("gl");
    const first = await f.run(mapped(LEDGER), true, idempotencyKey);
    expect(first.committed).toBe(true);
    const retry = await f.run(mapped(LEDGER), true, idempotencyKey);
    expect(retry).toMatchObject({ ok: true, committed: true, summary: { journals: 3 } });
    expect(await f.balance("1000", "2025-06-30")).toBe("31850.00");

    const overlap = await f.run(
      mapped(`Date,ID#,Account,Memo,Debit,Credit
05/06/2025,CD000101,6400,Farm Source feed,"1,000.00",
05/06/2025,CD000101,1000,Farm Source feed,,"1,000.00"
01/07/2025,CD000102,6400,More feed,200.00,
01/07/2025,CD000102,1000,More feed,,200.00`),
      true,
    );
    expect(overlap.committed).toBe(false);
    expect(plain(overlap.problems)).toEqual([{ row: 2, message: "CD000101 on 5 Jun 2025 was already imported (farm-gl.csv)." }]);
    expect(await f.balance("1000", "2025-07-31")).toBe("31850.00");
  });

  it("IM22: MYOB's Src and ID# can make the reference together, so a cheque and a receipt with the same number stay apart", async () => {
    const f = await farm();
    const rows = parseDelimited(`Date,Src,ID#,Account,Memo,Debit,Credit
05/06/2025,CD,000101,6400,Feed,100.00,
05/06/2025,CD,000101,1000,Feed,,100.00
05/06/2025,CR,000101,1000,Calf sale,40.00,
05/06/2025,CR,000101,4000,Calf sale,,40.00`);
    const columns = { ...autoMap("general_ledger", rows[0], "other_system"), reference: ["Src", "ID#"] };
    const done = await f.run(applyMapping(rows, 0, columns), true);
    expect(done).toMatchObject({ committed: true, summary: { journals: 2 } });
    const refs = await f.as((tx) => tx.query<{ reference: string }>("select reference from ledger_journals where origin = 'history' order by reference"));
    expect(refs.rows.map((row) => row.reference)).toEqual(["CD 000101", "CR 000101"]);
  });

  it("IM27: no GST codes: the GST account moves, and lines on receivables post as they are", async () => {
    const f = await farm({ converted: false });
    const done = await f.run(
      mapped(`Date,ID#,Account,Memo,Debit,Credit
10/06/2025,IN000001,1100,Calf sales,"1,150.00",
10/06/2025,IN000001,4000,Calf sales,,"1,000.00"
10/06/2025,IN000001,2100,Calf sales,,150.00`),
      true,
    );
    expect(done.committed).toBe(true);
    expect(await f.balance("1100", "2025-06-30")).toBe("1150.00");
    const invoices = await f.as((tx) => tx.query("select 1 from sales_invoices"));
    expect(invoices.rows).toHaveLength(0);
  });

  it("the route checks and posts, for admins", async () => {
    const f = await farm();
    const cookie = await sessionCookieFor(owner);
    const response = await historyRoute.POST(
      apiRequest("/api/import/history", { method: "POST", cookie, body: { organisationId: f.org, idempotencyKey: key("gl"), fileName: "farm-gl.csv", records: mapped(LEDGER), commit: true } }),
      noContext,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { result: { committed: boolean; summary: { journals: number } } };
    expect(body.result).toMatchObject({ committed: true, summary: { journals: 3 } });
  });
});
