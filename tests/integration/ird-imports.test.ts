import { afterAll, beforeAll, expect, it } from "vitest";
import * as importsRoute from "@/app/api/income-tax/imports/route";
import * as readRoute from "@/app/api/income-tax/imports/read/route";
import * as acceptRoute from "@/app/api/income-tax/imports/rows/[rowId]/accept/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import type { IrdImportMapping } from "@/lib/tax/income/ird-import-kinds";
import { addIrdDocument, getIrdDocumentContent } from "@/lib/tax/income/ird-documents";
import { acceptImportRow, acceptImportRows, createIrdImport, declineImportRow, deleteIrdMapping, getIrdImport, importedFigures, listIrdMappings, previewIrdImport, readIrdImportFile } from "@/lib/tax/income/ird-imports";
import { addPayment, buildIncomeTax, getIncomeTaxSettings, getIncomeTaxYear, listPayments, saveIncomeTaxYear, updateIncomeTaxSettings } from "@/lib/tax/income/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

/** Made-up IRD account files (ITX-IMP1 to ITX-IMP12). */
const FILE_A = [
  "Kererū Joinery Ltd income tax (made-up file)",
  "Date,Transaction,Period,Debit,Credit,Instalment",
  "01/04/2026,Balance brought forward,31/03/2027,,,",
  '28/08/2026,Payment,31/03/2027,,"6,183.80",Instalment 1',
  '15/01/2027,Payment,31/03/2027,,"6,183.80",',
  "20/01/2027,Interest,31/03/2027,12.40,,",
  "25/01/2027,Interest,31/03/2027,,12.40,",
  "02/02/2027,Late payment penalty,31/03/2027,50.00,,",
].join("\n");
const MAPPING_A: IrdImportMapping = {
  headerRow: 1,
  columns: { date: "Date", type: "Transaction", period: "Period", debit: "Debit", credit: "Credit", appliesTo: "Instalment" },
  dateOrder: "dmy",
  kindValues: { payment: "payment", interest: "interest", "late payment penalty": "penalty", "balance brought forward": "skip" },
  appliesToValues: { "instalment 1": "instalment_1" },
};
const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** Importing IRD account files (ITX-IMP1 to ITX-IMP12; Codex, delegated by owner; as delegated, not yet reviewed). */
describeWithDatabase("income tax: importing IRD account files", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  const org = "ird-imports-co";
  const other = "ird-imports-sheet-co";
  const as = <T>(work: (tx: OrgTx) => Promise<T>, organisation = org) => inOrganisation(organisation, { userId: owner.id, email: owner.email }, work);
  const schedule = async (organisation = org) => {
    const built = await as((tx) => buildIncomeTax(tx, { incomeYear: 2027, today: "2027-02-10" }), organisation);
    if (!built.supported || built.provisional.kind !== "schedule") throw new Error("expected a schedule");
    return { built, schedule: built.provisional };
  };
  let importId = "";
  let rowIds: Record<number, string> = {};

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("irdimports-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("irdimports-bookkeeper@example.com");
    for (const organisation of [org, other]) {
      await createTestOrganisation(owner, organisation);
      const settings = await as((tx) => getIncomeTaxSettings(tx), organisation);
      await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "company", agentExtension: false, version: settings.version }), organisation);
    }
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [org, bookkeeper.id]);
    // The 2026 return filed on time: each 2027 instalment is 6,183.80 (ITX5). The 2026 figures come from an import in ITX-IMP9, in `other`.
    await as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2026, assessedRit: "17668", returnFiledOn: "2026-06-20", version: 0 }));
  }, 300_000);

  afterAll(async () => {
    await server?.teardown();
  });

  it("ITX-IMP1, ITX-IMP2 reads the file through the API, previews it, and refuses a bookkeeper", async () => {
    const cookie = await sessionCookieFor(owner);
    const response = await readRoute.POST(apiRequest("/api/income-tax/imports/read", { method: "POST", cookie, body: { organisationId: org, fileName: "kereru.csv", fileBase64: base64(FILE_A) } }), noContext);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { file: { headerRow: number; headings: string[] }; mappings: unknown[]; suggestedMappingId: string | null };
    expect(body.file.headerRow).toBe(1);
    expect(body.file.headings).toEqual(["Date", "Transaction", "Period", "Debit", "Credit", "Instalment"]);
    expect(body.suggestedMappingId).toBeNull();
    const refused = await readRoute.POST(apiRequest("/api/income-tax/imports/read", { method: "POST", cookie: await sessionCookieFor(bookkeeper), body: { organisationId: org, fileName: "kereru.csv", fileBase64: base64(FILE_A) } }), noContext);
    expect(refused.status).toBe(403);

    const rows = readIrdImportFile({ fileName: "kereru.csv", fileBase64: base64(FILE_A) }).rows;
    const preview = await as((tx) => previewIrdImport(tx, { rows, mapping: MAPPING_A }));
    expect(preview.counts).toEqual({ rows: 6, skipped: 1, withProblems: 0, toReview: 5 });
    const unmapped = await as((tx) => previewIrdImport(tx, { rows, mapping: { ...MAPPING_A, kindValues: { payment: "payment" } } }));
    expect(unmapped.counts.withProblems).toBe(4);
    await expect(
      as((tx) => createIrdImport(tx, { idempotencyKey: key("imp"), fileName: "kereru.csv", fileBase64: base64(FILE_A), source: "myir_export", mapping: { ...MAPPING_A, kindValues: { payment: "payment" } } })),
    ).rejects.toThrow('Row 3: Say what "Balance brought forward" rows are.');
  });

  it("ITX-IMP1, ITX-IMP3, ITX-IMP6 importing keeps the file and the mapping; nothing counts yet", async () => {
    const statement = await as((tx) => addIrdDocument(tx, { idempotencyKey: key("doc"), fileName: "statement-2027.pdf", content: PDF, incomeYear: 2027 }));
    const created = await as((tx) =>
      createIrdImport(tx, { idempotencyKey: key("imp"), fileName: "kereru.csv", fileBase64: base64(FILE_A), source: "myir_export", mapping: MAPPING_A, supportingDocumentId: statement.document.id, saveMappingAs: "myIR income tax account" }),
    );
    expect(created.created).toBe(true);
    importId = created.import.id;
    expect(created.import).toMatchObject({ fileName: "kereru.csv", source: "myir_export", supportingDocument: { fileName: "statement-2027.pdf" }, counts: { waiting: 5, accepted: 0, declined: 0 } });
    rowIds = Object.fromEntries(created.import.rows.map((row) => [row.row, row.id]));
    // The file itself is kept as the source, and can be opened.
    const file = await as((tx) => getIrdDocumentContent(tx, created.import.documentId));
    expect(file).toMatchObject({ fileName: "kereru.csv", contentType: "text/csv" });
    expect(file.content.toString("utf8")).toBe(FILE_A);
    // The mapping is saved, and chosen for a file with the same headings.
    const saved = await as((tx) => listIrdMappings(tx));
    expect(saved.map((entry) => [entry.name, entry.headings])).toEqual([["myIR income tax account", ["Date", "Transaction", "Period", "Debit", "Credit", "Instalment"]]]);
    const response = await readRoute.POST(
      apiRequest("/api/income-tax/imports/read", { method: "POST", cookie: await sessionCookieFor(owner), body: { organisationId: org, fileName: "next.csv", fileBase64: base64(FILE_A.replace("Kererū", "Kererū (next)")) } }),
      noContext,
    );
    expect(((await response.json()) as { suggestedMappingId: string }).suggestedMappingId).toBe(saved[0].id);
    // Nothing counts until accepted.
    const { built, schedule: before } = await schedule();
    expect(built.paidTotal).toBe("0.00");
    expect(before.instalments.map((entry) => entry.amount)).toEqual(["6183.80", "6183.80", "6183.80"]);
    expect((await as((tx) => importedFigures(tx, 2027))).byKind).toEqual([]);
    // The same file can't be imported twice.
    await expect(as((tx) => createIrdImport(tx, { idempotencyKey: key("imp"), fileName: "again.csv", fileBase64: base64(FILE_A), source: "myir_export", mapping: MAPPING_A }))).rejects.toThrow("already imported (as kereru.csv");
  });

  it("ITX-IMP7 a payment that says its instalment is confirmed by IRD, naming the imported file", async () => {
    await expect(inOrganisation(org, { userId: owner.id, email: owner.email, via: 'AI key "Claude"' }, (tx) => acceptImportRow(tx, rowIds[4]))).rejects.toThrow("Only a person");
    const accepted = await as((tx) => acceptImportRow(tx, rowIds[4]));
    expect(accepted.status).toBe("accepted");
    expect(accepted.outcome).toBe("Added as a payment of 6,183.80 on 28 Aug 2026 (the file's date; no effective date). Confirmed by IRD: towards Instalment 1.");
    const payments = await as((tx) => listPayments(tx, 2027));
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ paidOn: "2026-08-28", amount: "6183.80", irdEffectiveOn: null, awaiting: "0.00" });
    expect(payments[0].note).toBe(`From IRD's file kereru.csv, row 4; accepted by ${owner.email}`);
    const imported = await as((tx) => getIrdImport(tx, importId));
    expect(payments[0].allocations[0]).toMatchObject({ appliesTo: "instalment_1", status: "confirmed", amount: "6183.80", irdDocumentId: imported.documentId, basis: 'IRD\'s file kereru.csv, row 4: "Instalment 1"' });
    const { schedule: after } = await schedule();
    expect(after.instalments[0]).toMatchObject({ paid: "6183.80", remaining: "0.00" });
    await expect(as((tx) => acceptImportRow(tx, rowIds[4]))).rejects.toThrow("Row 4 was already accepted.");
  });

  it("ITX-IMP8 a payment that doesn't say is awaiting reconciliation; one already in Tohyee is linked, not added again", async () => {
    // Paid from the bank on 13 Jan 2027, typed in before the import.
    const typed = await as((tx) => addPayment(tx, { idempotencyKey: key("pay"), incomeYear: 2027, paidOn: "2027-01-13", amount: "6183.80", note: "From the bank" }));
    const waiting = (await as((tx) => getIrdImport(tx, importId))).rows.find((row) => row.row === 5)!;
    expect(waiting.wouldLinkTo).toMatchObject({ paymentId: typed.payment.id, paidOn: "2027-01-13" });
    const accepted = await as((tx) => acceptImportRow(tx, rowIds[5]));
    expect(accepted.paymentId).toBe(typed.payment.id);
    expect(accepted.outcome).toBe("Linked to the payment of 6,183.80 on 13 Jan 2027 already in Tohyee, so it isn't counted twice. The file doesn't say which instalment it's for, so 6,183.80 is awaiting reconciliation.");
    const { built, schedule: after } = await schedule();
    expect(built.paidTotal).toBe("12367.60");
    expect(after.instalments[1]).toMatchObject({ paid: "0.00", remaining: "6183.80" });
    expect(after.allocation).toMatchObject({ awaiting: "6183.80", awaitingCount: 1 });
  });

  it("ITX-IMP10, ITX-IMP11 interest and penalties are recorded only; declining needs a reason", async () => {
    const before = await as((tx) => getIncomeTaxYear(tx, 2027));
    const accepted = await as((tx) => acceptImportRows(tx, { rowIds: [rowIds[6], rowIds[7]] }));
    expect(accepted.map((row) => row.outcome)).toEqual(["Recorded as IRD's interest for the 2027 income year. Nothing else changed.", "Recorded as IRD's interest for the 2027 income year. Nothing else changed."]);
    expect(await as((tx) => getIncomeTaxYear(tx, 2027))).toEqual(before);
    await expect(as((tx) => declineImportRow(tx, rowIds[8], { reason: "" }))).rejects.toThrow();
    const declined = await as((tx) => declineImportRow(tx, rowIds[8], { reason: "IRD has since remitted it" }));
    expect(declined).toMatchObject({ status: "declined", declineReason: "IRD has since remitted it" });
    const figures = await as((tx) => importedFigures(tx, 2027));
    expect(figures).toEqual({
      incomeYear: 2027,
      byKind: [
        { kind: "payment", debits: "0.00", credits: "12367.60", net: "-12367.60", rows: 2 },
        { kind: "interest", debits: "12.40", credits: "12.40", net: "0.00", rows: 2 },
      ],
      fromIrd: 4,
      fromOther: 0,
    });
  });

  it("ITX-IMP10 a row already accepted from an overlapping file can't be accepted again", async () => {
    const overlapping = `${FILE_A}\n01/03/2027,Payment,31/03/2027,,100.00,`;
    const created = await as((tx) => createIrdImport(tx, { idempotencyKey: key("imp"), fileName: "kereru-to-march.csv", fileBase64: base64(overlapping), source: "myir_export", mapping: MAPPING_A }));
    const repeat = created.import.rows.find((row) => row.row === 4)!;
    expect(repeat.sameAs).toEqual({ importId, fileName: "kereru.csv", row: 4 });
    expect(repeat.wouldLinkTo).toBeNull();
    await expect(as((tx) => acceptImportRow(tx, repeat.id))).rejects.toThrow("Row 4 looks the same as row 4 of kereru.csv, which was already accepted.");
    // The penalty was declined in the first file, so it isn't a duplicate.
    expect(created.import.rows.find((row) => row.row === 8)!.sameAs).toBeNull();
    // Through the API, as a new payment.
    const newRow = created.import.rows.find((row) => row.row === 9)!;
    const response = await acceptRoute.POST(
      apiRequest(`/api/income-tax/imports/rows/${newRow.id}/accept`, { method: "POST", cookie: await sessionCookieFor(owner), body: { organisationId: org } }),
      { params: Promise.resolve({ rowId: newRow.id }) },
    );
    expect(response.status).toBe(200);
    expect((await as((tx) => listPayments(tx, 2027))).map((payment) => payment.amount)).toEqual(["6183.80", "6183.80", "100.00"]);
    const list = await importsRoute.GET(apiRequest(`/api/income-tax/imports?organisationId=${org}&incomeYear=2027`, { cookie: await sessionCookieFor(owner) }), noContext);
    const listed = (await list.json()) as { imports: Array<{ fileName: string }>; documents: Array<{ fileName: string }> };
    expect(listed.imports.map((entry) => entry.fileName)).toEqual(["kereru-to-march.csv", "kereru.csv"]);
    expect(listed.documents.map((entry) => entry.fileName)).toEqual(["statement-2027.pdf"]);
  });

  it("ITX-IMP7, ITX-IMP9 another spreadsheet: allocated with evidence, never confirmed; an assessment becomes the RIT only when the person says so", async () => {
    const sheet = [
      "Date,What,Year,Amount,Instalment",
      "20/06/2026,Assessment,2026,17668.00,",
      "28/08/2026,Payment,2027,-6183.80,Instalment 1",
    ].join("\n");
    const mapping: IrdImportMapping = {
      headerRow: 0,
      columns: { date: "Date", type: "What", period: "Year", amount: "Amount", appliesTo: "Instalment" },
      dateOrder: "dmy",
      amountSign: "positive_is_debit",
      kindValues: { assessment: "assessment", payment: "payment" },
      appliesToValues: { "instalment 1": "instalment_1" },
    };
    const created = await as((tx) => createIrdImport(tx, { idempotencyKey: key("imp"), fileName: "accountant.csv", fileBase64: base64(sheet), source: "other_spreadsheet", mapping }), other);
    const [assessment, payment] = created.import.rows;
    expect(assessment).toMatchObject({ kind: "assessment", incomeYear: 2026, direction: "debit", amount: "17668.00" });
    await expect(as((tx) => acceptImportRow(tx, payment.id, { useAsAssessedRit: true }), other)).rejects.toThrow("Only an assessment");
    await expect(as((tx) => acceptImportRow(tx, assessment.id, { useAsAssessedRit: true }), other)).rejects.toThrow();
    const rit = await as((tx) => acceptImportRow(tx, assessment.id, { useAsAssessedRit: true, returnFiledOn: "2026-06-20" }), other);
    expect(rit).toMatchObject({ setAssessedRit: true, outcome: "Saved as the 2026 assessed RIT (17,668.00, return filed 20 Jun 2026)." });
    expect(await as((tx) => getIncomeTaxYear(tx, 2026), other)).toMatchObject({ assessedRit: "17668.00", returnFiledOn: "2026-06-20" });
    const paid = await as((tx) => acceptImportRow(tx, payment.id), other);
    expect(paid.outcome).toContain("Allocated with this file as evidence: towards Instalment 1.");
    const payments = await as((tx) => listPayments(tx, 2027), other);
    expect(payments[0].note).toBe(`From accountant.csv (a spreadsheet, not IRD's own file), row 3; accepted by ${owner.email}`);
    expect(payments[0].allocations[0]).toMatchObject({ status: "evidenced", appliesTo: "instalment_1" });
    const { schedule: after } = await schedule(other);
    expect(after.instalments.map((entry) => entry.amount)).toEqual(["6183.80", "6183.80", "6183.80"]);
    expect(after.instalments[0]).toMatchObject({ remaining: "0.00" });
    expect(await as((tx) => importedFigures(tx, 2026), other)).toMatchObject({ fromIrd: 0, fromOther: 1 });
  });

  it("ITX-IMP3 a saved mapping can be deleted", async () => {
    const [saved] = await as((tx) => listIrdMappings(tx));
    await as((tx) => deleteIrdMapping(tx, saved.id));
    expect(await as((tx) => listIrdMappings(tx))).toEqual([]);
  });
});
