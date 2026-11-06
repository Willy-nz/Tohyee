import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { correctJournal, listJournals, postJournal } from "@/lib/ledger/journals";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "journal-pages";

/** The Journals list (decision 1564): manual journals by default, 100 a page with a count. Made-up figures. */
describeWithDatabase("journal list pages", () => {
  let server: TestServer;
  let owner: SessionUser;
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  let corrected = "";

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("journal-pages-owner@example.com");
    await createTestOrganisation(owner, ORG);
    // 105 manual journals.
    await run(async (tx) => {
      for (let n = 1; n <= 105; n += 1) {
        await postJournal(tx, {
          idempotencyKey: key("j"),
          postingDate: "2026-06-01",
          reference: `J${n}`,
          lines: [
            { accountCode: "6010", debitAmount: "10.00", creditAmount: "0" },
            { accountCode: "1000", debitAmount: "0", creditAmount: "10.00" },
          ],
        });
      }
    });
    // One corrected: a reversal and a replacement.
    const first = (await run((tx) => listJournals(tx, { referenceQuery: "J1", kind: "manual", limit: 200 }))).journals.find((journal) => journal.reference === "J1")!;
    corrected = first.id;
    await run((tx) =>
      correctJournal(tx, {
        idempotencyKey: key("fix"),
        originalJournalId: first.id,
        postingDate: "2026-06-02",
        reference: "J1 fixed",
        lines: [
          { accountCode: "6010", debitAmount: "12.00" },
          { accountCode: "1000", creditAmount: "12.00" },
        ],
      }),
    );
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("pages of 100 with the total, newest first", async () => {
    const first = await run((tx) => listJournals(tx, { kind: "journals", page: 1, pageSize: 100 }));
    // 105 posted plus the replacement; the reversal is left out.
    expect(first.total).toBe(106);
    expect(first.pages).toBe(2);
    expect(first.page).toBe(1);
    expect(first.journals).toHaveLength(100);
    expect(first.journals[0].reference).toBe("J1 fixed");
    const second = await run((tx) => listJournals(tx, { kind: "journals", page: 2, pageSize: 100 }));
    expect(second.journals).toHaveLength(6);
    expect(new Set([...first.journals, ...second.journals].map((journal) => journal.id)).size).toBe(106);
    // A page past the end is empty, not an error.
    expect((await run((tx) => listJournals(tx, { kind: "journals", page: 9, pageSize: 100 }))).journals).toEqual([]);
  });

  it("'journals' is manual journals and their replacements, without the reversals; the corrected one is still there", async () => {
    const all = await run((tx) => listJournals(tx, { kind: "journals", page: 1, pageSize: 200 }));
    expect(all.journals.some((journal) => journal.correctionKind === "reversal")).toBe(false);
    expect(all.journals.some((journal) => journal.id === corrected)).toBe(true);
    // "manual" is still only journals entered by hand.
    const manual = await run((tx) => listJournals(tx, { kind: "manual", page: 1, pageSize: 200 }));
    expect(manual.total).toBe(105);
  });

  it("refuses a page size over 200", async () => {
    await expect(run((tx) => listJournals(tx, { page: 1, pageSize: 500 }))).rejects.toThrow("pageSize");
  });
});
