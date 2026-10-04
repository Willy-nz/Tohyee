import { afterAll, beforeAll, expect, it } from "vitest";
import * as searchRoute from "@/app/api/search/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { createContact } from "@/lib/contacts/service";
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

const ORG = "search-co";
const noContext = undefined as unknown;

describeWithDatabase("search API", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let reportViewer: SessionUser;
  let viewerCookie: string;
  let reportViewerCookie: string;

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);

  const body = async (response: Response) => {
    return (await response.json()) as {
      groups: Array<{ key: string; records: Array<{ title: string; subtitle: string; href: string }> }>;
    };
  };

  async function insertJournal(tx: OrgTx, postingDate: string, reference: string, amount = "100.00"): Promise<string> {
    const accounts = await tx.query<{ id: string }>("select id::text from accounts where is_active order by id limit 2");
    const debitAccount = accounts.rows[0]?.id;
    const creditAccount = accounts.rows[1]?.id;
    if (!debitAccount || !creditAccount) throw new Error("Expected default chart accounts.");
    const journal = await tx.query<{ id: string }>(
      `insert into ledger_journals (
          command_source, idempotency_key, request_hash, origin, posting_date, reference, description, currency_code,
          total_debit, total_credit, created_by_user_id, created_by_email
       ) values ('tests', $1, $2, 'manual', $3, $4, 'Search test', 'NZD', $5::numeric, $5::numeric, $6, $7)
       returning id::text`,
      [key("journal"), key("hash"), postingDate, reference, amount, tx.actor.userId, tx.actor.email],
    );
    const journalId = journal.rows[0]!.id;
    await tx.query(
      `insert into ledger_journal_lines (journal_id, line_order, account_id, debit_amount, credit_amount)
       values ($1, 1, $2, $4::numeric, 0), ($1, 2, $3, 0, $4::numeric)`,
      [journalId, debitAccount, creditAccount, amount],
    );
    return journalId;
  }

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("viewer@example.com");
    reportViewer = await createTestUser("client@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer'), ($1, $3, 'report_viewer')", [
      ORG,
      viewer.id,
      reportViewer.id,
    ]);
    viewerCookie = await sessionCookieFor(viewer);
    reportViewerCookie = await sessionCookieFor(reportViewer);

    await asUser(owner, async (tx) => {
      const { contact } = await createContact(tx, {
        source: "tests",
        idempotencyKey: key("contact"),
        name: "Kobe Ltd",
        isCustomer: true,
        isSupplier: true,
        email: "accounts@kobe.example.nz",
        phone: "+64 9 555 0100",
      });

      for (let index = 1; index <= 6; index += 1) {
        const approvalJournal = await insertJournal(tx, "2026-10-04", `INV-${100 + index}`);
        await tx.query(
          `insert into sales_invoices (
              command_source, idempotency_key, request_hash, status, contact_id, invoice_date, due_date, reference,
              amounts_mode, currency_code, subtotal, tax_total, total, invoice_sequence, invoice_number,
              approval_journal_id, approve_command_source, approve_idempotency_key, approve_request_hash, approved_at,
              created_by_user_id, created_by_email
           ) values ('tests', $1, $2, 'approved', $3, '2026-10-04', '2026-10-20', $4, 'exclusive', 'NZD',
                     $5::numeric, 0, $5::numeric, $6, $7, $8, 'tests', $9, $10, now(), $11, $12)`,
          [
            key("invoice"),
            key("hash"),
            contact.id,
            `KOBE-${index}`,
            index === 6 ? "1748.00" : "100.00",
            100 + index,
            `INV-0${100 + index}`,
            approvalJournal,
            key("approve"),
            key("approve-hash"),
            owner.id,
            owner.email,
          ],
        );
      }

      const billApprovalJournal = await insertJournal(tx, "2026-10-04", "BILL-1");
      await tx.query(
        `insert into bills (
            command_source, idempotency_key, request_hash, status, contact_id, bill_date, due_date, supplier_invoice_number,
            amounts_mode, currency_code, subtotal, tax_total, total, approval_journal_id, approve_command_source,
            approve_idempotency_key, approve_request_hash, approved_at, created_by_user_id, created_by_email
         ) values ('tests', $1, $2, 'approved', $3, '2026-10-04', '2026-10-18', 'KAURI-88',
                   'exclusive', 'NZD', 200.00, 0, 200.00, $4, 'tests', $5, $6, now(), $7, $8)`,
        [key("bill"), key("hash"), contact.id, billApprovalJournal, key("approve"), key("approve-hash"), owner.id, owner.email],
      );

      await tx.query(
        `insert into bank_statement_imports (
            command_source, idempotency_key, request_hash, account_id, source, file_name, file_format, line_count,
            duplicate_count, possible_duplicate_count, created_by_user_id, created_by_email
         ) values ('tests', $1, $2, (select id from accounts order by id limit 1), 'file', 'bank.csv', 'csv', 1, 0, 0, $3, $4)`,
        [key("import"), key("hash"), owner.id, owner.email],
      );
      await tx.query(
        `insert into bank_statement_lines (account_id, import_id, line_date, amount, description, payee, reference, match_key, currency_code)
         values ((select id from accounts order by id limit 1),
                 (select id from bank_statement_imports order by id desc limit 1),
                 '2026-10-04', 1748.00, 'Kobe payment', 'Kobe Ltd', 'INV-0106', 'kobe-payment', 'NZD')`,
      );

      await tx.query(
        `insert into items (command_source, idempotency_key, request_hash, code, name, item_type)
         values ('tests', $1, $2, 'KOBE-ITEM', 'Kobe item', 'service')`,
        [key("item"), key("hash")],
      );
      const typeInsert = await tx.query<{ id: string }>(
        `insert into fixed_asset_types (
            command_source, idempotency_key, request_hash, name, asset_account_id, accumulated_depreciation_account_id,
            depreciation_expense_account_id, method, rate, created_by_user_id, created_by_email
         ) values ('tests', $1, $2, 'Plant', (select id from accounts where account_class = 'asset' order by id limit 1),
                   (select id from accounts where account_class = 'asset' order by id offset 1 limit 1),
                   (select id from accounts where account_class = 'expense' order by id limit 1),
                   'sl', 20, $3, $4)
         returning id::text`,
        [key("fat"), key("hash"), owner.id, owner.email],
      );
      await tx.query(
        `insert into fixed_assets (
            command_source, idempotency_key, request_hash, asset_number, name, type_id, status, purchase_date, cost, method, rate,
            created_by_user_id, created_by_email
         ) values ('tests', $1, $2, 'FA-0100', 'Kobe forklift', $3, 'registered', '2026-10-04', 1748.00, 'sl', 20, $4, $5)`,
        [key("fa"), key("hash"), typeInsert.rows[0]!.id, owner.id, owner.email],
      );

      await tx.query("update organisation_settings set crm_enabled = true where id = true");
      const person = await tx.query<{ id: string }>(
        "insert into crm_people (contact_id, first_name, last_name, email, phone) values ($1, 'Kobe', 'Buyer', 'kobe.person@example.nz', '+64 21 111 1111') returning id::text",
        [contact.id],
      );
      await tx.query(
        "insert into crm_opportunities (name, contact_id, point_of_contact_id, amount, close_date, stage, currency_code) values ('Kobe expansion', $1, $2, 1748.00, '2026-10-04', 'proposal', 'NZD')",
        [contact.id, person.rows[0]!.id],
      );
    });

    await asUser(owner, (tx) =>
      tx.query(
        `insert into analytics_dashboards (name, settings, tiles, created_by_email, updated_by_email)
         values ('Client dashboard', '{}'::jsonb, '[]'::jsonb, $1, $1)`,
        [owner.email],
      ),
    );
    await asUser(owner, (tx) =>
      tx.query(
        `insert into analytics_dashboard_shares (dashboard_id, user_id, shared_by_email)
         values ((select id from analytics_dashboards order by id desc limit 1), $1, $2)`,
        [reportViewer.id, owner.email],
      ),
    );
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("returns records for matching kinds and keeps five per kind", async () => {
    const response = await searchRoute.GET(
      apiRequest(`/api/search?organisationId=${ORG}&q=kobe&kind=all`, { cookie: viewerCookie }),
      noContext,
    );
    expect(response.status).toBe(200);
    const data = await body(response);
    const invoices = data.groups.find((group) => group.key === "invoice");
    expect(invoices?.records.length).toBe(5);
    expect(data.groups.some((group) => group.key === "contact")).toBe(true);
    expect(data.groups.some((group) => group.key === "bank_statement_line")).toBe(true);
    // With "All", companies are in Contacts (the same records), not listed twice.
    expect(data.groups.some((group) => group.key === "crm_company")).toBe(false);
    expect(data.groups.some((group) => group.key === "crm_person")).toBe(true);
    const crm = await body(await searchRoute.GET(apiRequest(`/api/search?organisationId=${ORG}&q=kobe&kind=crm`, { cookie: viewerCookie }), noContext));
    expect(crm.groups.some((group) => group.key === "crm_company")).toBe(true);
    expect(data.groups.some((group) => group.key === "crm_opportunity")).toBe(true);
  });

  it("matches amount, date and kind prefix terms", async () => {
    const byAmount = await body(
      await searchRoute.GET(apiRequest(`/api/search?organisationId=${ORG}&q=1,748.00&kind=all`, { cookie: viewerCookie }), noContext),
    );
    expect(byAmount.groups.some((group) => group.records.some((record) => record.title.includes("INV-0106")))).toBe(true);

    const byDate = await body(
      await searchRoute.GET(apiRequest(`/api/search?organisationId=${ORG}&q=4 Oct&kind=all`, { cookie: viewerCookie }), noContext),
    );
    expect(byDate.groups.some((group) => group.records.some((record) => record.subtitle.includes("4 Oct 2026")))).toBe(true);

    const byPrefix = await body(
      await searchRoute.GET(apiRequest(`/api/search?organisationId=${ORG}&q=inv 106&kind=all`, { cookie: viewerCookie }), noContext),
    );
    expect(byPrefix.groups.every((group) => group.key === "invoice")).toBe(true);
  });

  it("limits report viewers to shared dashboard names only", async () => {
    const response = await searchRoute.GET(
      apiRequest(`/api/search?organisationId=${ORG}&q=client&kind=all`, { cookie: reportViewerCookie }),
      noContext,
    );
    expect(response.status).toBe(200);
    const data = await body(response);
    expect(data.groups.map((group) => group.key)).toEqual(["dashboard"]);
    expect(data.groups[0]?.records[0]?.title).toBe("Client dashboard");
  });

  it("refuses people outside the organisation, needs two characters, and leaves out the CRM when it's off", async () => {
    const outsider = await createTestUser("outsider@example.com");
    const outsiderResponse = await searchRoute.GET(
      apiRequest(`/api/search?organisationId=${ORG}&q=kobe&kind=all`, { cookie: await sessionCookieFor(outsider) }),
      noContext,
    );
    expect(outsiderResponse.status).toBe(404);

    const short = await body(await searchRoute.GET(apiRequest(`/api/search?organisationId=${ORG}&q=k&kind=all`, { cookie: viewerCookie }), noContext));
    expect(short.groups).toEqual([]);

    await asUser(owner, (tx) => tx.query("update organisation_settings set crm_enabled = false"));
    try {
      const data = await body(await searchRoute.GET(apiRequest(`/api/search?organisationId=${ORG}&q=kobe&kind=all`, { cookie: viewerCookie }), noContext));
      expect(data.groups.some((group) => group.key.startsWith("crm_"))).toBe(false);
      expect(data.groups.some((group) => group.key === "invoice")).toBe(true);
    } finally {
      await asUser(owner, (tx) => tx.query("update organisation_settings set crm_enabled = true"));
    }
  });

  it("runs every kind's search without error", async () => {
    for (const kind of ["all", "contacts", "sales", "purchases", "banking", "accounts", "crm"]) {
      for (const q of ["kobe", "1748", "4 Oct"]) {
        const response = await searchRoute.GET(apiRequest(`/api/search?organisationId=${ORG}&q=${encodeURIComponent(q)}&kind=${kind}`, { cookie: viewerCookie }), noContext);
        expect(response.status, `${kind} ${q}`).toBe(200);
      }
    }
  });
});
