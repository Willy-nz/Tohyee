import { afterAll, beforeAll, expect, it } from "vitest";
import * as icaRoute from "@/app/api/income-tax/ica/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { addIcaEntry, removeIcaEntry } from "@/lib/tax/income/ica";
import { addPayment, buildIncomeTax, getIncomeTaxSettings, updateIncomeTaxSettings } from "@/lib/tax/income/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;

/** The imputation credit account (ITX25-ITX29; from IR274, not yet reviewed). */
describeWithDatabase("income tax: the imputation credit account", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  const org = "ica-co";
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
  const entry = (entryDate: string, kind: string, fields: { amount?: string; dividendAmount?: string } = {}) => as((tx) => addIcaEntry(tx, { idempotencyKey: key("ica"), entryDate, kind, ...fields }));

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("ica-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("ica-bookkeeper@example.com");
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [org, bookkeeper.id]);
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("ITX25 only companies keep one", async () => {
    await expect(entry("2025-04-01", "opening", { amount: "5000" })).rejects.toThrow("Only companies");
    const settings = await as((tx) => getIncomeTaxSettings(tx));
    await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "individual", agentExtension: false, version: settings.version }));
    const report = await as((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-10-16" }));
    expect(report.supported && report.ica).toBeNull();
    await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "company", agentExtension: false, version: settings.version + 1 }));
  });

  it("ITX26, ITX27, ITX29 typed entries and income tax payments make the 2026 ICA", async () => {
    await entry("2025-04-01", "opening", { amount: "5000" });
    await expect(entry("2025-04-01", "opening", { amount: "1" })).rejects.toThrow("already an opening balance");
    await as((tx) => addPayment(tx, { idempotencyKey: key("pay"), incomeYear: 2026, paidOn: "2025-08-28", amount: "6183.80" }));
    await entry("2025-10-31", "dividend_received", { amount: "280" });
    await expect(entry("2025-12-15", "dividend_paid", { dividendAmount: "7200", amount: "2800.01" })).rejects.toThrow("at most 2800.00");
    const dividend = await entry("2025-12-15", "dividend_paid", { dividendAmount: "7200" });
    await entry("2026-01-10", "refund", { amount: "500" });
    await as((tx) => addPayment(tx, { idempotencyKey: key("pay"), incomeYear: 2025, paidOn: "2026-02-07", amount: "2000" }));
    await entry("2026-03-31", "rwt_deducted", { amount: "140" });

    const report = await as((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-10-16" }));
    expect(report.supported).toBe(true);
    if (!report.supported) return;
    const ica = report.ica!;
    expect(ica.rows.map((row) => [row.kind, row.amount])).toEqual([
      ["opening", "5000.00"],
      ["tax_paid", "6183.80"],
      ["dividend_received", "280.00"],
      ["dividend_paid", "-2800.00"],
      ["refund", "-500.00"],
      ["tax_paid", "2000.00"],
      ["rwt_deducted", "140.00"],
    ]);
    expect(ica.rows[5].description).toBe("Towards the 2025 income year");
    expect(ica.closing).toBe("10303.80");

    // Removing an entry is in the history.
    await as((tx) => removeIcaEntry(tx, dividend.entryId));
    const after = await as((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-10-16" }));
    expect(after.supported && after.ica!.closing).toBe("13103.80");
    const audit = await as((tx) => tx.query<{ event_type: string }>("select event_type from audit_events where entity_type = 'ica_entry' order by id"));
    expect(audit.rows.filter((row) => row.event_type === "income_tax.ica_entry_removed")).toHaveLength(1);
  });

  it("ITX28 a debit balance shows further income tax and the penalty", async () => {
    await entry("2026-03-01", "dividend_paid", { dividendAmount: "45000" });
    const report = await as((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-10-16" }));
    expect(report.supported && report.ica!.debitBalance).toMatchObject({ furtherIncomeTax: "4396.20", penalty: "439.62", dueDate: "2026-06-20" });
  });

  it("only owners and admins can type entries", async () => {
    const cookie = await sessionCookieFor(bookkeeper);
    const refused = await icaRoute.POST(apiRequest("/api/income-tax/ica", { method: "POST", cookie, body: { organisationId: org, idempotencyKey: key("ica"), entryDate: "2025-05-01", kind: "other_credit", amount: "1" } }), noContext);
    expect(refused.status).toBe(403);
  });
});
