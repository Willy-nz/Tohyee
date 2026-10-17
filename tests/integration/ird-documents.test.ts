import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as documentsRoute from "@/app/api/income-tax/documents/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { acceptProposal, addIrdDocument, declineProposal, listProposals, removeIrdDocument } from "@/lib/tax/income/ird-documents";
import { buildIncomeTax, getIncomeTaxSettings, getIncomeTaxYear, listPayments, updateIncomeTaxSettings } from "@/lib/tax/income/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;
type Json = Record<string, unknown>;

// The smallest PDF the file check accepts.
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

/** IRD documents read by the connected AI, checked by a person (ITX30-ITX35; not yet reviewed). */
describeWithDatabase("income tax: IRD documents and proposed figures", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let ownerToken = "";
  let bookkeeperToken = "";
  let documentId = "";
  const org = "ird-docs-co";
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);

  let rpcId = 0;
  async function callTool(token: string, name: string, args: Json = {}) {
    rpcId += 1;
    const request = new Request("http://tohyee.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name, arguments: args } }),
    });
    const response = await mcpRoute.POST(request, noContext);
    const body = (await response.json()) as { result?: { content: Array<{ type: string; text?: string; resource?: { uri: string } }>; isError?: boolean }; error?: { message: string } };
    if (!body.result) return { isError: true, text: body.error?.message ?? "", data: null, content: [] };
    const first = body.result.content[0];
    return { isError: body.result.isError === true, text: first.text ?? "", data: body.result.isError ? null : (JSON.parse(first.text ?? "{}") as Json), content: body.result.content };
  }
  async function makeKey(user: SessionUser, name: string, accessLevel: string) {
    const response = await tokensRoute.POST(apiRequest("/api/ai/tokens", { method: "POST", cookie: await sessionCookieFor(user), body: { organisationId: org, name, accessLevel } }), noContext);
    return ((await response.json()) as { token: string }).token;
  }

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("irddocs-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("irddocs-bookkeeper@example.com");
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [org, bookkeeper.id]);
    const settings = await as((tx) => getIncomeTaxSettings(tx));
    await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "company", agentExtension: false, version: settings.version }));
    ownerToken = await makeKey(owner, "Claude", "draft");
    bookkeeperToken = await makeKey(bookkeeper, "Bookkeeper's AI", "draft");
  }, 300_000);

  afterAll(async () => {
    await server?.teardown();
  });

  it("ITX30 owners and admins upload IRD files; only PDFs and pictures", async () => {
    const added = await as((tx) => addIrdDocument(tx, { idempotencyKey: key("doc"), fileName: "2026-assessment.pdf", content: PDF, incomeYear: 2026, note: "Assessment" }));
    documentId = added.document.id;
    expect(added.document).toMatchObject({ fileName: "2026-assessment.pdf", incomeYear: 2026, createdByEmail: owner.email });
    await expect(as((tx) => addIrdDocument(tx, { idempotencyKey: key("doc"), fileName: "notes.docx", content: new Uint8Array([1, 2, 3]) }))).rejects.toThrow("only PDF, JPG, PNG and HEIC");
    const cookie = await sessionCookieFor(bookkeeper);
    const refused = await documentsRoute.GET(apiRequest(`/api/income-tax/documents?organisationId=${org}`, { cookie }), noContext);
    expect(refused.status).toBe(403);
  });

  it("ITX31 the AI reads documents and figures only for an owner's or admin's key", async () => {
    const list = await callTool(ownerToken, "list_ird_documents");
    expect((list.data!.documents as Array<{ fileName: string }>).map((document) => document.fileName)).toEqual(["2026-assessment.pdf"]);
    const read = await callTool(ownerToken, "read_ird_document", { documentId });
    expect(read.isError).toBe(false);
    expect(read.content[1]).toMatchObject({ type: "resource", resource: { uri: `tohyee://ird-documents/${documentId}/2026-assessment.pdf` } });
    // A bookkeeper's key isn't offered the income tax tools at all.
    const refused = await callTool(bookkeeperToken, "list_ird_documents");
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("only for owners and admins");
  });

  it("ITX32-ITX34 the AI proposes; nothing changes until a person accepts", async () => {
    const proposed = await callTool(ownerToken, "propose_ird_figures", {
      incomeYear: 2026,
      documentId,
      assessedRit: "17668.00",
      returnFiledOn: "2026-06-20",
      note: "Assessment, page 1",
    });
    expect(proposed.isError).toBe(false);
    const payment = await callTool(ownerToken, "propose_ird_figures", { incomeYear: 2027, documentId, payments: [{ paidOn: "2026-08-28", amount: "6183.80", note: "Statement of account, page 2" }] });
    expect(payment.isError).toBe(false);
    const bad = await callTool(ownerToken, "propose_ird_figures", { incomeYear: 2026, assessedRit: "17668.00" });
    expect(bad.text).toContain("or neither");
    const zero = await callTool(ownerToken, "propose_ird_figures", { incomeYear: 2027, payments: [{ paidOn: "2026-08-28", amount: "0" }] });
    expect(zero.isError).toBe(true);

    // Nothing has changed.
    expect((await as((tx) => getIncomeTaxYear(tx, 2026))).assessedRit).toBeNull();
    const waiting = await as((tx) => listProposals(tx));
    expect(waiting.map((proposal) => [proposal.incomeYear, proposal.aiKeyName, proposal.documentName])).toEqual([
      [2026, 'AI key "Claude"', "2026-assessment.pdf"],
      [2027, 'AI key "Claude"', "2026-assessment.pdf"],
    ]);

    // Jess accepts the assessment: the 2027 instalments follow (ITX5).
    const accepted = await as((tx) => acceptProposal(tx, waiting[0].id));
    expect(accepted.status).toBe("accepted");
    expect(await as((tx) => getIncomeTaxYear(tx, 2026))).toMatchObject({ assessedRit: "17668.00", returnFiledOn: "2026-06-20" });
    const report = await as((tx) => buildIncomeTax(tx, { incomeYear: 2027, today: "2026-10-16" }));
    expect(report.supported && report.provisional.kind === "schedule" && report.provisional.instalments.map((entry) => entry.amount)).toEqual(["6183.80", "6183.80", "6183.80"]);
    await expect(as((tx) => acceptProposal(tx, waiting[0].id))).rejects.toThrow("already accepted");

    // The payment, then the same payment again: shown as already typed, and not added twice.
    await as((tx) => acceptProposal(tx, waiting[1].id));
    const payments = await as((tx) => listPayments(tx, 2027));
    expect(payments.map((entry) => [entry.paidOn, entry.amount])).toEqual([["2026-08-28", "6183.80"]]);
    expect(payments[0].note).toContain('proposed by AI key "Claude", accepted by irddocs-owner@example.com');
    await callTool(ownerToken, "propose_ird_figures", { incomeYear: 2027, payments: [{ paidOn: "2026-08-28", amount: "6183.80" }] });
    const again = (await as((tx) => listProposals(tx)))[0];
    expect(again.payments[0].alreadyTyped).toBe(true);
    await as((tx) => acceptProposal(tx, again.id));
    expect(await as((tx) => listPayments(tx, 2027))).toHaveLength(1);
    // ITX58: imputation credits and overseas tax can be proposed too, and accepting keeps the other typed figures.
    await callTool(ownerToken, "propose_ird_figures", { incomeYear: 2025, imputationCredits: "350.00", overseasTaxPaid: "20.00" });
    const credits = (await as((tx) => listProposals(tx)))[0];
    await as((tx) => acceptProposal(tx, credits.id));
    expect(await as((tx) => getIncomeTaxYear(tx, 2025))).toMatchObject({ imputationCredits: "350.00", overseasTaxPaid: "20.00", taxCredits: "0.00" });
  });

  it("ITX33 declining needs a reason; the AI can't accept; removing a document needs a reason", async () => {
    await callTool(ownerToken, "propose_ird_figures", { incomeYear: 2026, taxCredits: "140.00" });
    const proposal = (await as((tx) => listProposals(tx)))[0];
    await expect(as((tx) => declineProposal(tx, proposal.id, { reason: "" }))).rejects.toThrow("reason");
    await expect(inOrganisation(org, { userId: owner.id, email: owner.email, via: 'AI key "Claude"' }, (tx) => acceptProposal(tx, proposal.id))).rejects.toThrow("Only a person");
    const declined = await as((tx) => declineProposal(tx, proposal.id, { reason: "That's the 2025 figure" }));
    expect(declined).toMatchObject({ status: "declined", declineReason: "That's the 2025 figure" });
    expect((await as((tx) => getIncomeTaxYear(tx, 2026))).taxCredits).toBe("0.00");

    const removed = await as((tx) => removeIrdDocument(tx, documentId, { reason: "Wrong company" }));
    expect(removed.removed).toMatchObject({ reason: "Wrong company" });
    const read = await callTool(ownerToken, "read_ird_document", { documentId });
    expect(read.text).toContain("removed");
    const audit = await as((tx) => tx.query<{ event_type: string }>("select event_type from audit_events where event_type like 'income_tax.figures_%' or event_type like 'income_tax.ird_document_%' order by id"));
    expect(audit.rows.map((row) => row.event_type)).toContain("income_tax.figures_declined");
    expect(audit.rows.map((row) => row.event_type)).toContain("income_tax.ird_document_removed");
  });
});
