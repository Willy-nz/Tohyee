import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as booksRoute from "@/app/api/analytics/books/route";
import * as analyticsRoute from "@/app/api/analytics/route";
import * as sourcesRoute from "@/app/api/analytics/sources/route";
import { runTile } from "@/lib/analytics/dashboards";
import { readBooks } from "@/lib/analytics/books";
import { closeAnalytics, queryAnalytics, replaceTohyeeTables, type TableCopy, type TableCopyRow } from "@/lib/analytics/engine";
import { runDueLoads } from "@/lib/analytics/scheduler";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { createOpportunity } from "@/lib/crm/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { approveInvoice, createInvoice, voidInvoice } from "@/lib/invoices/service";
import { postJournal, postJournalBody } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { coreQuery } from "@/lib/db/transactions";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const ORG = "books-co";
const noContext = undefined as unknown;

/** Examples AB1-AB10 in docs/ACCOUNTING-EXAMPLES.md ("Analytics: Tohyee's own books and CRM"). */
describeWithDatabase("analytics: the books and CRM", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let cookie: string;
  let root: string;
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const refresh = async (user = cookie) =>
    (await (await booksRoute.POST(apiRequest("/api/analytics/books", { method: "POST", cookie: user, body: { organisationId: ORG } }), noContext)).json()) as {
      run?: { status: string; rowsLoaded: string; error: string | null };
      error?: string;
    };
  const sum = async (sql: string) => (await queryAnalytics(ORG, `select coalesce(sum(amount), 0)::varchar as total from tohyee_ledger_lines where ${sql}`))[0].total;
  const journal = (postingDate: string, debit: string, credit: string, amount: string) =>
    as((tx) =>
      postJournal(tx, {
        idempotencyKey: key("journal"),
        postingDate,
        reference: "Setup",
        lines: [
          { accountCode: debit, debitAmount: amount, creditAmount: "0" },
          { accountCode: credit, debitAmount: "0", creditAmount: amount },
        ],
      }),
    );

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-books-"));
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("viewer@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    cookie = await sessionCookieFor(owner);
    await as((tx) => updateOrganisationSettings(tx, { analyticsEnabled: true }));
    // The CR1 journals.
    await journal("2026-03-01", "1000", "3000", "5000.00");
    await journal("2026-03-20", "1000", "4000", "500.00");
    await journal("2026-04-10", "1000", "4000", "1000.00");
    await journal("2026-04-15", "6010", "1000", "100.00");
    await journal("2026-05-12", "1000", "4000", "1500.00");
    await journal("2026-05-13", "5000", "1000", "400.00");
    await journal("2026-06-08", "1000", "4000", "1200.00");
    await journal("2026-06-09", "5000", "1000", "300.00");
    await journal("2026-06-20", "6010", "1000", "250.00");
    await journal("2026-06-30", "1000", "4200", "20.00");
  });

  afterAll(async () => {
    await closeAnalytics(ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("AB1-AB5: the ledger lines are copied as they are, and tiles decide which way round to show them", async () => {
    const result = await refresh();
    expect(result.run).toMatchObject({ status: "ok", error: null });
    const count = await queryAnalytics(ORG, "select count(*)::int as n, sum(amount)::varchar as total from tohyee_ledger_lines");
    expect(count).toEqual([{ n: 20, total: "0.00" }]);
    const first = await queryAnalytics(
      ORG,
      "select posting_date::varchar as d, account_code, debit::varchar as debit, credit::varchar as credit from tohyee_ledger_lines order by journal_id, line limit 2",
    );
    expect(first).toEqual([
      { d: "2026-03-01", account_code: "1000", debit: "5000.00", credit: "0.00" },
      { d: "2026-03-01", account_code: "3000", debit: "0.00", credit: "5000.00" },
    ]);
    // AB2: June sales are a credit; a tile can show them the other way round.
    expect(await sum("account_code = '4000' and posting_date between '2026-06-01' and '2026-06-30'")).toBe("-1200.00");
    const sales = { label: "Sales", aggregate: "sum", field: "amount", negate: true };
    const june = await runTile(ORG, {
      table: "tohyee_ledger_lines",
      groupBy: null,
      measures: [sales],
      filters: [{ field: "account_code", op: "eq", value: "4000" }],
      dateField: "posting_date",
    }, { from: "2026-06-01", to: "2026-06-30" });
    expect(june.rows).toEqual([{ m0: "1200.00" }]);
    // AB3, AB5.
    expect(await sum("account_code = '5000' and posting_date between '2026-06-01' and '2026-06-30'")).toBe("300.00");
    expect(await sum("account_code = '1000' and posting_date <= '2026-06-30'")).toBe("8170.00");
    // AB4.
    const monthly = await runTile(ORG, {
      table: "tohyee_ledger_lines",
      groupBy: { field: "posting_date", grain: "month" },
      measures: [sales],
      filters: [{ field: "account_code", op: "eq", value: "4000" }],
    });
    expect(monthly.rows).toEqual([
      { category: "2026-03-01", m0: "500.00" },
      { category: "2026-04-01", m0: "1000.00" },
      { category: "2026-05-01", m0: "1500.00" },
      { category: "2026-06-01", m0: "1200.00" },
    ]);
  });

  it("AB6, AB7: approved and voided invoices are copied (never drafts), foreign ones at their base amounts", async () => {
    const kobe = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Ltd", isCustomer: true, email: "accounts@kobe.example" }))).contact;
    const acme = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Acme Inc", isCustomer: true, currencyCode: "USD" }))).contact;
    const draft = async (contactId: string, unitPrice: string, foreign?: { exchangeRate: string }) =>
      (
        await as((tx) =>
          createInvoice(
            tx,
            {
              idempotencyKey: key("i"),
              contactId,
              invoiceDate: "2026-07-03",
              dueDate: "2026-07-31",
              amountsMode: "exclusive",
              lines: [{ description: "Work", quantity: "2", unitPrice, accountCode: "4000", taxCode: foreign ? "ZERO" : "GST" }],
              ...(foreign ?? {}),
            },
            foreign ? { foreignCurrency: true } : {},
          ),
        )
      ).invoice;
    const i1 = await draft(kobe.id, "50.00");
    await as((tx) => approveInvoice(tx, i1.id, { idempotencyKey: key("a") }));
    await draft(kobe.id, "70.00"); // stays a draft
    const voided = await draft(kobe.id, "10.00");
    await as((tx) => approveInvoice(tx, voided.id, { idempotencyKey: key("a") }));
    await as((tx) => voidInvoice(tx, voided.id, { idempotencyKey: key("v"), voidDate: "2026-07-05" }));
    const usd = await draft(acme.id, "50.00", { exchangeRate: "1.60" });
    await as((tx) => approveInvoice(tx, usd.id, { idempotencyKey: key("a") }));

    expect((await refresh()).run?.status).toBe("ok");
    const invoices = await queryAnalytics(
      ORG,
      `select contact, status, void_date::varchar as void_date, net::varchar as net, gst::varchar as gst, total::varchar as total,
              currency, foreign_total::varchar as foreign_total from tohyee_invoices order by invoice_id`,
    );
    expect(invoices).toEqual([
      { contact: "Kobe Ltd", status: "approved", void_date: null, net: "100.00", gst: "15.00", total: "115.00", currency: "NZD", foreign_total: null },
      { contact: "Kobe Ltd", status: "voided", void_date: "2026-07-05", net: "20.00", gst: "3.00", total: "23.00", currency: "NZD", foreign_total: null },
      { contact: "Acme Inc", status: "approved", void_date: null, net: "160.00", gst: "0.00", total: "160.00", currency: "USD", foreign_total: "100.00" },
    ]);
    const lines = await queryAnalytics(ORG, "select count(*)::int as n from tohyee_invoice_lines");
    expect(lines).toEqual([{ n: 3 }]);
    // The voided invoice's posting and reversal are both in the ledger lines, netting to 0.00.
    expect(await sum("contact = 'Kobe Ltd' and account_code = '4000' and abs(amount) = 20.00")).toBe("0.00");
    expect((await queryAnalytics(ORG, "select count(*)::int as n from tohyee_ledger_lines where contact = 'Kobe Ltd' and abs(amount) = 20.00"))[0]).toEqual({ n: 2 });
    const contacts = await queryAnalytics(ORG, "select name, email, is_customer from tohyee_contacts order by name");
    expect(contacts).toEqual([
      { name: "Acme Inc", email: null, is_customer: true },
      { name: "Kobe Ltd", email: "accounts@kobe.example", is_customer: true },
    ]);
  });

  it("AB8: the copy doesn't change until it's refreshed (nightly or Refresh now)", async () => {
    await journal("2026-07-01", "1000", "4000", "300.00");
    expect(await sum("account_code = '4000' and posting_date between '2026-07-01' and '2026-07-01'")).toBe("0.00");
    await refresh();
    expect(await sum("account_code = '4000' and posting_date between '2026-07-01' and '2026-07-01'")).toBe("-300.00");

    // The nightly copy runs for every organisation with Analytics on, folder or not.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    tomorrow.setUTCHours(18, 0, 0, 0);
    const made = await runDueLoads(tomorrow);
    expect(made.map((run) => [run.sourceName, run.status, run.trigger])).toEqual([["Books and CRM", "ok", "schedule"]]);
  });

  it("AB9: CRM tables are copied only while the CRM is on", async () => {
    expect((await queryAnalytics(ORG, "select count(*)::int as n from information_schema.tables where table_name like 'tohyee_crm%'"))[0]).toEqual({ n: 0 });
    await as((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    const company = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Vets", isProspect: true }))).contact;
    await as((tx) =>
      createOpportunity(tx, { name: "Paw prints 2027", contactId: company.id, ownerUserId: owner.id, amount: "5000", closeDate: "2026-12-15", stage: "proposal" }),
    );
    await refresh();
    expect(await queryAnalytics(ORG, "select name, company, amount::varchar as amount, stage, outcome, expected_close::varchar as close from tohyee_crm_opportunities")).toEqual([
      { name: "Paw prints 2027", company: "Harbour Vets", amount: "5000.00", stage: "Proposal", outcome: "open", close: "2026-12-15" },
    ]);
    await as((tx) => updateOrganisationSettings(tx, { crmEnabled: false }));
    await refresh();
    expect((await queryAnalytics(ORG, "select count(*)::int as n from information_schema.tables where table_name like 'tohyee_crm%'"))[0]).toEqual({ n: 0 });
  });

  it("AB10: pay run lines are copied without names", async () => {
    await as((tx) =>
      postJournalBody(
        tx,
        "test",
        key("payroll"),
        {
          postingDate: "2026-07-10",
          reference: "Pay run 3 - Aroha Smith",
          description: "Wages for Aroha Smith",
          currencyCode: "NZD",
          total: "900.00",
          customInput: undefined,
          lines: [
            { accountCode: "6010", debit: "900.00", credit: "0", description: "Aroha Smith wages", tracking: {}, customInput: undefined, foreign: null },
            { accountCode: "1000", debit: "0", credit: "900.00", description: "Aroha Smith net pay", tracking: {}, customInput: undefined, foreign: null },
          ],
        },
        { origin: "payroll" },
      ),
    );
    await refresh();
    const rows = await queryAnalytics(ORG, "select reference, journal_description, description, contact from tohyee_ledger_lines where source = 'payroll'");
    expect(rows).toEqual([
      { reference: null, journal_description: "Pay run", description: "Pay run", contact: null },
      { reference: null, journal_description: "Pay run", description: "Pay run", contact: null },
    ]);
    expect(JSON.stringify(await queryAnalytics(ORG, "select * from tohyee_ledger_lines"))).not.toContain("Aroha");
  });

  it("reads the big tables in batches (issue 150) and copies the same rows as one batch", async () => {
    // Every table's rows, read in the transaction; batched tables are collected batch by batch.
    const read = (batchSize?: number) =>
      as(async (tx) => {
        const tables = await readBooks(tx, new Map(), batchSize === undefined ? {} : { batchSize });
        const copies: Array<{ name: string; columns: TableCopy["columns"]; rows: TableCopyRow[]; batches: number[] }> = [];
        for (const table of tables) {
          const rows: TableCopyRow[] = [];
          const batches: number[] = [];
          if (Array.isArray(table.rows)) rows.push(...table.rows);
          else {
            for await (const batch of table.rows) {
              batches.push(batch.length);
              rows.push(...batch);
            }
          }
          copies.push({ name: table.name, columns: table.columns, rows, batches });
        }
        return copies;
      });
    const whole = await read();
    const small = await read(3);
    const strip = (copies: typeof whole) => copies.map(({ name, columns, rows }) => ({ name, columns, rows }));
    expect(strip(small)).toEqual(strip(whole));
    const ledger = small.find((table) => table.name === "tohyee_ledger_lines")!;
    // 10 setup journals, AB6's invoice journals, AB8's and AB10's: more lines than one batch of 3.
    expect(ledger.rows.length).toBeGreaterThan(20);
    expect(ledger.batches.every((size) => size <= 3)).toBe(true);
    expect(ledger.batches.length).toBe(Math.ceil(ledger.rows.length / 3));
    expect(whole.find((table) => table.name === "tohyee_ledger_lines")!.batches).toEqual([ledger.rows.length]);

    // Appended batch by batch into DuckDB, the copy is the same as the nightly one.
    const before = await queryAnalytics(ORG, "select count(*)::int as n, sum(amount)::varchar as total, string_agg(account_code, ',' order by journal_id, line) as codes from tohyee_ledger_lines");
    const copied = await as(async (tx) => replaceTohyeeTables(ORG, await readBooks(tx, new Map(), { batchSize: 3 })));
    expect(copied).toBe(small.reduce((total, table) => total + table.rows.length, 0));
    expect(await queryAnalytics(ORG, "select count(*)::int as n, sum(amount)::varchar as total, string_agg(account_code, ',' order by journal_id, line) as codes from tohyee_ledger_lines")).toEqual(before);
    expect(before[0].n).toBe(ledger.rows.length);
  });

  it("only admins and owners refresh; CSV sources can't take tohyee_ names; anyone can see when it was copied", async () => {
    const viewerCookie = await sessionCookieFor(viewer);
    const refused = await booksRoute.POST(apiRequest("/api/analytics/books", { method: "POST", cookie: viewerCookie, body: { organisationId: ORG } }), noContext);
    expect(refused.status).toBe(403);
    const named = await sourcesRoute.POST(
      apiRequest("/api/analytics/sources", {
        method: "POST",
        cookie,
        body: { organisationId: ORG, name: "x", tableName: "tohyee_ledger_lines", fileName: "x.csv", columns: [{ source: "a", name: "a", kind: "text" }] },
      }),
      noContext,
    );
    expect(named.status).toBe(400);
    const overview = (await (await analyticsRoute.GET(apiRequest(`/api/analytics?organisationId=${ORG}`, { cookie: viewerCookie }), noContext)).json()) as {
      books: { status: string } | null;
    };
    expect(overview.books?.status).toBe("ok");
  });
});
