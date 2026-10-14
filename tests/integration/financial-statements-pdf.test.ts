import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { postJournal } from "@/lib/ledger/journals";
import { financialStatementsPdf, getStatementNotes, saveStatementNotes } from "@/lib/reports/financial-statements";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "statements-pdf";

/** Year-end financial statements (FS1, FS2; #259, not yet reviewed). */
describeWithDatabase("year-end financial statements", () => {
  let server: TestServer;
  let owner: SessionUser;
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("statements-pdf-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    const pair = (date: string, debit: string, credit: string, amount: string) =>
      run((tx) =>
        postJournal(tx, {
          idempotencyKey: key("j"),
          postingDate: date,
          reference: "Year",
          lines: [
            { accountCode: debit, debitAmount: amount, creditAmount: "0" },
            { accountCode: credit, debitAmount: "0", creditAmount: amount },
          ],
        }),
      );
    // Last year and this year (31 March year end).
    await pair("2025-04-01", "1000", "3000", "5000.00");
    await pair("2025-06-01", "1000", "4000", "1000.00");
    await pair("2026-06-01", "1000", "4000", "3000.00");
    await pair("2026-07-01", "6010", "1000", "1350.00");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("FS2: draft notes until saved; saving replaces them, and an empty list goes back to drafts", async () => {
    const drafts = await run((tx) => getStatementNotes(tx));
    expect(drafts.saved).toBe(false);
    expect(drafts.notes.map((note) => note.title)).toEqual(["Reporting entity", "Basis of preparation", "Changes in accounting policies", "Goods and services tax (GST)", "Property, plant and equipment", "Income tax"]);
    expect(drafts.notes[0].body).toMatch(/\[describe the entity/);
    const saved = await run((tx) => saveStatementNotes(tx, { notes: [{ title: "Reporting entity", body: "A company." }, { title: "Basis of preparation", body: "Special purpose." }] }));
    expect(saved).toEqual({ saved: true, notes: [{ title: "Reporting entity", body: "A company." }, { title: "Basis of preparation", body: "Special purpose." }] });
    await expect(run((tx) => saveStatementNotes(tx, { notes: [{ title: "", body: "x" }] }))).rejects.toThrow(/title/);
    expect((await run((tx) => saveStatementNotes(tx, { notes: [] }))).saved).toBe(false);
  });

  it("FS1: one PDF with a cover, four statements and the notes", async () => {
    const pdf = await run((tx) => financialStatementsPdf(tx, { yearEnd: "2027-03-31" }, new Date("2027-04-20T00:00:00Z")));
    expect(pdf.fileName).toMatch(/financial statements 2027-03-31\.pdf$/);
    const document = await PDFDocument.load(pdf.bytes);
    expect(document.getPageCount()).toBeGreaterThanOrEqual(6);
    expect(document.getTitle()).toMatch(/financial statements for the year ended 31 March 2027/);
    await expect(run((tx) => financialStatementsPdf(tx, { yearEnd: "2027-03-30" }))).rejects.toThrow(/financial year end/);
  });
});
