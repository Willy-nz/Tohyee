import type { AddressInfo } from "node:net";
import { simpleParser, type ParsedMail } from "mailparser";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as rulesRoute from "@/app/api/approval-rules/route";
import * as approveRoute from "@/app/api/approvals/[requestId]/approve/route";
import * as requestRoute from "@/app/api/approvals/[requestId]/route";
import * as mcpRoute from "@/app/api/mcp/route";
import { getApprovalRequest, listApprovalRequests, type Viewer } from "@/lib/approvals/requests";
import { createApprovalRule, listApprovalRules, moveApprovalRule, updateApprovalRule } from "@/lib/approvals/rules";
import { approvalBudget, approveApprovalStep, declineApprovalStep, documentApproval, submitForApproval, withdrawApprovalRequest } from "@/lib/approvals/service";
import type { ApprovalDocumentType, ApprovalRule } from "@/lib/approvals/types";
import type { Role } from "@/lib/auth/roles";
import { COMMAND_LINE_ADMIN } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill, deleteBill, getBill, updateBill } from "@/lib/bills/service";
import { getBudget, listBudgets, setBudgetAmounts } from "@/lib/budgets/service";
import { createContact, type Contact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { processOrganisationOutbox } from "@/lib/email/outbox";
import { updateLocalMailRelay } from "@/lib/email/local-relay";
import { prepareSmtpServer, updateOrganisationEmailSettings } from "@/lib/email/settings";
import { setSmtpPortForTests } from "@/lib/email/smtp";
import { approveExpenseClaim, createExpenseClaim, declineExpenseClaim, getExpenseClaim, submitExpenseClaim } from "@/lib/expense-claims/service";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { getJournal, postJournal } from "@/lib/ledger/journals";
import { getOrganisation } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { approvePurchaseOrder, createPurchaseOrder, getPurchaseOrder } from "@/lib/purchase-orders/service";
import { createRepeatingBill, getRepeatingBill, runRepeatingBills } from "@/lib/repeating/bills";
import { createTrackingValue, getTrackingSetup } from "@/lib/tracking/service";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const noContext = undefined as unknown;
const ORIGIN = "https://books.example";
const SMTP_USER = "accounts@kowhai.test";
const SMTP_PASSWORD = "smtp-password-123";

type Json = Record<string, unknown>;

let rpcId = 0;
async function rpc(token: string, method: string, rpcParams?: unknown): Promise<Json> {
  rpcId += 1;
  const response = await mcpRoute.POST(
    new Request("http://tohyee.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: rpcParams }),
    }),
    noContext,
  );
  return (await response.json()) as Json;
}
async function callTool(token: string, name: string, args: Json = {}): Promise<Json> {
  const body = await rpc(token, "tools/call", { name, arguments: args });
  if (body.error) throw new Error(`rpc ${(body.error as Json).code}: ${(body.error as Json).message}`);
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text) as Json;
}

/**
 * Examples AW1-AW17 in docs/ACCOUNTING-EXAMPLES.md ("Approval workflows").
 * Jess is the owner, Mere and Tama bookkeepers, Ana an admin, Vic a viewer;
 * Kauri Supplies is a supplier. The overall budget for 6010 in October 2026
 * is 1,000.00 and 900.00 has been spent. Rule "Over $1,000" for bills: total
 * at least 1,000.00; step 1 any one of Tama or Ana; step 2 all of Jess. Each
 * test gets its own organisation.
 */
describeWithDatabase("approval workflows (AW1-AW17)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let mere: SessionUser;
  let tama: SessionUser;
  let ana: SessionUser;
  let vic: SessionUser;
  let smtp: SMTPServer;
  let smtpPort = 0;
  const received: { to: string[]; mail: ParsedMail }[] = [];
  let organisations = 0;

  const ROLES = new Map<string, Role>();

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    server = await startTestServer();
    jess = await createTestUser("aw-jess@example.com", { serverAdmin: true, displayName: "Jess" });
    mere = await createTestUser("aw-mere@example.com", { displayName: "Mere" });
    tama = await createTestUser("aw-tama@example.com", { displayName: "Tama" });
    ana = await createTestUser("aw-ana@example.com", { displayName: "Ana" });
    vic = await createTestUser("aw-vic@example.com", { displayName: "Vic" });
    ROLES.set(jess.id, "owner").set(mere.id, "bookkeeper").set(tama.id, "bookkeeper").set(ana.id, "admin").set(vic.id, "viewer");
    smtp = new SMTPServer({
      secure: false,
      authOptional: false,
      allowInsecureAuth: true,
      disabledCommands: ["STARTTLS"],
      logger: false,
      onAuth(auth, _session, callback) {
        if (auth.username === SMTP_USER && auth.password === SMTP_PASSWORD) return callback(null, { user: SMTP_USER });
        return callback(Object.assign(new Error("Invalid username or password"), { responseCode: 535 }));
      },
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          simpleParser(Buffer.concat(chunks)).then(
            (mail) => {
              received.push({ to: session.envelope.rcptTo.map((rcpt) => rcpt.address), mail });
              callback(null, "Queued as AW12");
            },
            (error: Error) => callback(error),
          );
        });
      },
    });
    await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
    smtpPort = (smtp.server.address() as AddressInfo).port;
    // Saved as an allowed mail port, sent to the test server's own; it runs on this computer, which a server admin allows (#145).
    setSmtpPortForTests(smtpPort);
    await updateLocalMailRelay(COMMAND_LINE_ADMIN, { allowed: true });
  });

  afterAll(async () => {
    setSmtpPortForTests(null);
    await new Promise<void>((resolve) => smtp?.close(() => resolve()));
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `aw-${organisations}-co`;
    await createTestOrganisation(jess, org);
    await coreQuery(
      `insert into organisation_members (organisation_id, user_id, role)
       values ($1, $2, 'bookkeeper'), ($1, $3, 'bookkeeper'), ($1, $4, 'admin'), ($1, $5, 'viewer')`,
      [org, mere.id, tama.id, ana.id, vic.id],
    );
    const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
    const viewer = (user: SessionUser): Viewer => ({ userId: user.id, email: user.email, role: ROLES.get(user.id)! });
    await as(jess, (tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const department = (await as(jess, (tx) => getTrackingSetup(tx))).categories.find((category) => category.kind === "department")!.id;
    const value = async (name: string) =>
      (await as(jess, (tx) => createTrackingValue(tx, { categoryId: department, name }))).categories.find((category) => category.id === department)!.values.find((item) => item.name === name)!.id;
    const retail = await value("Retail");
    await value("Wholesale");
    const kauri: Contact = (await as(jess, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kauri Supplies", isSupplier: true }))).contact;
    // October's budget for 6010, and 900.00 already spent.
    await as(jess, async (tx) => {
      const overall = (await listBudgets(tx))[0];
      await setBudgetAmounts(tx, overall.id, { version: (await getBudget(tx, overall.id)).budget.version, amounts: [{ accountCode: "6010", month: "2026-10", amount: "1000.00" }] });
      await postJournal(tx, {
        idempotencyKey: key("j"),
        postingDate: "2026-10-02",
        reference: "Spent",
        lines: [
          { accountCode: "6010", debitAmount: "900.00" },
          { accountCode: "1000", creditAmount: "900.00" },
        ],
      });
    });
    const steps = (...list: [string, SessionUser[]][]) => list.map(([mode, users]) => ({ mode, approverUserIds: users.map((user) => user.id) }));
    const addRule = async (input: Json, by: SessionUser = ana) => (await as(by, (tx) => createApprovalRule(tx, ROLES.get(by.id)!, input))).rule;
    const overThousand = () => addRule({ documentType: "bill", name: "Over $1,000", minTotal: "1000.00", steps: steps(["any", [tama, ana]], ["all", [jess]]) });
    let numbers = 300;
    const bill = async (by: SessionUser = mere, fields: Json = {}) => {
      numbers += 1;
      return (
        await as(by, (tx) =>
          createBill(tx, {
            idempotencyKey: key("bill"),
            contactId: kauri.id,
            billDate: "2026-10-03",
            dueDate: "2026-10-20",
            supplierInvoiceNumber: `K-${numbers}`,
            amountsMode: "exclusive",
            lines: [{ description: "Year-end accounts", quantity: "1", unitPrice: "1000.00", accountCode: "6010", taxCode: "GST" }],
            ...fields,
          }),
        )
      ).bill;
    };
    const submit = (by: SessionUser, documentType: ApprovalDocumentType, documentId: string) =>
      as(by, (tx) => submitForApproval(tx, viewer(by), documentType, documentId, { origin: ORIGIN }));
    const approve = (by: SessionUser, requestId: string, command: Json = {}) => as(by, (tx) => approveApprovalStep(tx, viewer(by), requestId, { origin: ORIGIN, ...command }));
    const view = (by: SessionUser, requestId: string) => as(by, (tx) => getApprovalRequest(tx, requestId, viewer(by)));
    const journals = async () => Number((await as(jess, (tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);
    const emails = async (requestId: string) =>
      (await as(jess, (tx) => tx.query<{ step_number: number; to_email: string; subject: string; body: string }>("select step_number, to_email, subject, body from approval_emails where request_id = $1 order by id", [requestId]))).rows;
    const history = async (type: string, id: string) =>
      (await as(jess, (tx) => tx.query<{ event_type: string; actor_email: string }>("select event_type, actor_email from audit_events where entity_type = $1 and entity_id = $2 order by id", [type, id]))).rows
        .filter((row) => row.event_type.startsWith("approval.") || row.event_type === `${type}.approved`)
        .map((row) => [row.event_type, row.actor_email]);
    return { org, as, viewer, retail, department, kauri, steps, addRule, overThousand, bill, submit, approve, view, journals, emails, history };
  }

  it("AW1: an admin adds the rule; bad rules are refused; bookkeepers see but can't change rules; the history says who", async () => {
    const w = await setup();
    const base = { documentType: "bill", name: "Over $1,000", minTotal: "1000.00" };
    await expect(w.addRule({ ...base, steps: [] })).rejects.toThrow("Add at least one approval step.");
    await expect(w.addRule({ ...base, steps: w.steps(["any", []]) })).rejects.toThrow("Step 1 has no approvers.");
    await expect(w.addRule({ ...base, steps: w.steps(["any", [vic]]) })).rejects.toThrow("Step 1: Vic is a viewer. Approvers must be bookkeepers, admins or owners.");
    await expect(w.addRule({ ...base, minTotal: "-1", steps: w.steps(["any", [tama]]) })).rejects.toThrow("The minimum total can't be negative.");
    await expect(w.addRule({ ...base, steps: w.steps(["any", [tama]]) }, mere)).rejects.toThrow("Only admins can change approval rules.");

    const saved = await w.as(ana, (tx) => createApprovalRule(tx, "admin", { ...base, steps: w.steps(["any", [tama, ana]], ["all", [jess]]) }));
    expect(saved.rule).toMatchObject({ name: "Over $1,000", minTotal: "1000.00", position: 1, documentType: "bill" });
    expect(saved.rule.steps.map((step) => [step.stepNumber, step.mode, step.approvers.map((approver) => approver.email).sort()])).toEqual([
      [1, "any", [ana.email, tama.email].sort()],
      [2, "all", [jess.email]],
    ]);
    // A step with one approver can get stuck (AW6), so saving warns.
    expect(saved.warnings).toEqual([expect.stringContaining("Step 2 has one approver, Jess.")]);
    await expect(w.addRule({ ...base, steps: w.steps(["any", [tama]]) })).rejects.toThrow('already an approval rule called "Over $1,000"');

    // A bookkeeper sees the rules, but the route refuses changes (403); a viewer can read them.
    expect((await w.as(mere, (tx) => listApprovalRules(tx))).map((rule) => rule.name)).toEqual(["Over $1,000"]);
    const refused = await rulesRoute.POST(
      apiRequest("/api/approval-rules", { method: "POST", cookie: await sessionCookieFor(mere), body: { organisationId: w.org, ...base, name: "Other", steps: w.steps(["any", [tama]]) } }),
      noContext,
    );
    expect(refused.status).toBe(403);
    const listed = await rulesRoute.GET(apiRequest(`/api/approval-rules?organisationId=${w.org}`, { cookie: await sessionCookieFor(vic) }), noContext);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { rules: ApprovalRule[]; approvers: { displayName: string }[] };
    expect(body.rules).toHaveLength(1);
    expect(body.approvers.map((member) => member.displayName)).toEqual(["Ana", "Jess", "Mere", "Tama"]);
    const audit = await w.as(jess, (tx) => tx.query<{ event_type: string; actor_email: string }>("select event_type, actor_email from audit_events where entity_type = 'approval_rule'"));
    expect(audit.rows).toEqual([{ event_type: "approval_rule.created", actor_email: ana.email }]);
  });

  it("AW2: a 460.00 bill doesn't match the rule and Mere approves it directly", async () => {
    const w = await setup();
    await w.overThousand();
    const small = await w.bill(mere, { lines: [{ description: "Advice", quantity: "1", unitPrice: "400.00", accountCode: "6010", taxCode: "GST" }] });
    expect(small.total).toBe("460.00");
    expect((await w.as(mere, (tx) => documentApproval(tx, w.viewer(mere), "bill", small.id))).rule).toBeNull();
    const approved = await w.as(mere, (tx) => approveBill(tx, small.id, { idempotencyKey: key("a") }));
    expect(approved.bill.status).toBe("approved");
  });

  it("AW3-AW5: K-300 is submitted, frozen, shows the budget, and is approved by Tama then Jess", async () => {
    const w = await setup();
    await w.overThousand();
    const k300 = await w.bill(mere, { supplierInvoiceNumber: "K-300" });
    expect(k300.total).toBe("1150.00");
    // AW3: approving directly is refused; submitting freezes it as a draft and posts nothing.
    await expect(w.as(mere, (tx) => approveBill(tx, k300.id, { idempotencyKey: key("a") }))).rejects.toThrow(
      "This bill needs approval (rule: Over $1,000). Submit it for approval.",
    );
    expect(await w.as(mere, (tx) => documentApproval(tx, w.viewer(mere), "bill", k300.id))).toMatchObject({ rule: { name: "Over $1,000" }, request: null, needsApproval: true });
    const before = await w.journals();
    const request = await w.submit(mere, "bill", k300.id);
    expect(request).toMatchObject({ status: "waiting", ruleName: "Over $1,000", currentStep: 1, stepCount: 2, waitingFor: "Waiting for Ana or Tama", canAct: false, canWithdraw: true });
    expect((await w.as(mere, (tx) => getBill(tx, k300.id))).status).toBe("draft");
    expect(await w.journals()).toBe(before);
    await expect(w.as(mere, (tx) => updateBill(tx, k300.id, { dueDate: "2026-10-25" }))).rejects.toThrow("Withdraw it from approval first.");
    await expect(w.as(mere, (tx) => deleteBill(tx, k300.id))).rejects.toThrow("Withdraw it from approval first.");
    await expect(w.as(ana, (tx) => approveBill(tx, k300.id, { idempotencyKey: key("a") }))).rejects.toThrow("This bill is waiting for approval (rule: Over $1,000).");
    // Submitting again returns the same request.
    expect((await w.submit(mere, "bill", k300.id)).id).toBe(request.id);
    // Tama and Ana are asked (the approvals page and an email each); Jess isn't yet.
    expect((await w.emails(request.id)).map((email) => [email.step_number, email.to_email]).sort()).toEqual([
      [1, ana.email],
      [1, tama.email],
    ]);
    const mine = async (user: SessionUser) => (await w.as(user, (tx) => listApprovalRequests(tx, w.viewer(user), { mine: true }))).map((item) => item.id);
    expect([await mine(tama), await mine(ana), await mine(jess), await mine(mere)]).toEqual([[request.id], [request.id], [], []]);

    // AW4: the budget at approval.
    const budget = await w.as(tama, (tx) => approvalBudget(tx, request.id));
    expect(budget).toEqual([
      expect.objectContaining({
        accountCode: "6010",
        budgetName: "Overall budget",
        month: "2026-10-01",
        budget: "1000.00",
        spent: "900.00",
        thisDocument: "1000.00",
        left: "-900.00",
        overBy: "Over budget by 900.00",
      }),
    ]);

    // AW5: Tama approves step 1; Ana is no longer asked; Jess is.
    const afterTama = (await w.approve(tama, request.id)).request;
    expect(afterTama).toMatchObject({ status: "waiting", currentStep: 2, waitingFor: "Waiting for Jess" });
    expect((await w.view(ana, request.id)).canAct).toBe(false);
    expect((await w.view(jess, request.id))).toMatchObject({ canAct: true, isFinalStep: true });
    expect((await w.emails(request.id)).filter((email) => email.step_number === 2).map((email) => email.to_email)).toEqual([jess.email]);
    expect((await w.as(mere, (tx) => getBill(tx, k300.id))).status).toBe("draft");
    const done = await w.approve(jess, request.id);
    expect(done.refused).toBeNull();
    expect(done.request).toMatchObject({ status: "approved", finishedByEmail: jess.email, currentStep: null });
    const approved = await w.as(jess, (tx) => getBill(tx, k300.id));
    expect([approved.status, approved.approvedByEmail]).toEqual(["approved", jess.email]);
    const journal = await w.as(jess, (tx) => getJournal(tx, approved.approvalJournalId!));
    expect([journal.postingDate, journal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])]).toEqual([
      "2026-10-03",
      [
        ["6010", "1000.00", "0.00"],
        ["2100", "150.00", "0.00"],
        ["2000", "0.00", "1150.00"],
      ],
    ]);
    expect(await w.history("bill", k300.id)).toEqual([
      ["approval.submitted", mere.email],
      ["approval.step_approved", tama.email],
      ["approval.step_approved", jess.email],
      ["bill.approved", jess.email],
      ["approval.approved", jess.email],
    ]);
    // A finished request can't be acted on again.
    await expect(w.approve(jess, request.id)).rejects.toThrow("already approved");
  });

  it("AW6: nobody approves their own; a step only the submitter could approve says so until an admin changes it", async () => {
    const w = await setup();
    const rule = await w.overThousand();
    // Mere is made an approver of step 1, but can't approve the bill she submitted.
    await w.as(ana, async (tx) => updateApprovalRule(tx, "admin", rule.id, { name: rule.name, minTotal: rule.minTotal, version: rule.version, steps: w.steps(["any", [mere, tama]], ["all", [jess]]) }));
    const meres = await w.submit(mere, "bill", (await w.bill(mere)).id);
    await expect(w.approve(mere, meres.id)).rejects.toThrow("nobody approves their own, and you submitted or made it");
    expect((await w.emails(meres.id)).map((email) => email.to_email)).toEqual([tama.email]);

    // Jess makes and submits her own bill: step 2 can never be done by her.
    const jesss = await w.submit(jess, "bill", (await w.bill(jess)).id);
    await w.approve(tama, jesss.id);
    const stuck = await w.view(ana, jesss.id);
    expect(stuck.waitingFor).toBe(
      "Only Jess can approve this step, and Jess submitted it. An admin can change the rule's approvers (Settings › Approval rules), and the request carries on with them.",
    );
    await expect(w.approve(jess, jesss.id)).rejects.toThrow("nobody approves their own");
    // A bill Jess made but Mere submitted: Jess still can't approve it.
    const made = await w.bill(jess);
    const madeRequest = await w.submit(mere, "bill", made.id);
    await w.approve(tama, madeRequest.id);
    expect((await w.view(jess, madeRequest.id)).waitingFor).toMatch(/^Only Jess can approve this step, and Jess made it\./);

    // Ana changes step 2's approver; the request carries on with her.
    const current = (await w.as(ana, (tx) => listApprovalRules(tx)))[0];
    await w.as(ana, (tx) => updateApprovalRule(tx, "admin", current.id, { name: current.name, minTotal: current.minTotal, version: current.version, steps: w.steps(["any", [tama, ana]], ["all", [ana]]) }));
    expect((await w.view(ana, jesss.id))).toMatchObject({ waitingFor: "Waiting for Ana", canAct: true });
    // Three 1,150.00 Kauri bills this week: the last approver sees the duplicate warning and approves anyway (DU2).
    const warned = await w.approve(ana, jesss.id);
    expect([warned.request.status, warned.refused]).toEqual(["waiting", expect.stringContaining("A person can approve it anyway")]);
    expect((await w.approve(ana, jesss.id, { approveDespiteWarnings: true })).request.status).toBe("approved");
    // A stale version is refused.
    await expect(w.as(ana, (tx) => updateApprovalRule(tx, "admin", current.id, { name: current.name, version: current.version, steps: w.steps(["any", [tama]]) }))).rejects.toThrow("Someone else changed this rule");
  });

  it("AW7: Ana declines step 1 with a reason; the bill is Mere's draft again; submitting again starts at step 1", async () => {
    const w = await setup();
    await w.overThousand();
    const draft = await w.bill();
    const first = await w.submit(mere, "bill", draft.id);
    await expect(w.as(ana, (tx) => declineApprovalStep(tx, w.viewer(ana), first.id, { reason: "" }))).rejects.toThrow("The reason is required.");
    const declined = await w.as(ana, (tx) => declineApprovalStep(tx, w.viewer(ana), first.id, { reason: "Wrong supplier" }));
    expect(declined).toMatchObject({ status: "declined", declineReason: "Wrong supplier", finishedByEmail: ana.email });
    expect(await w.as(mere, (tx) => documentApproval(tx, w.viewer(mere), "bill", draft.id))).toMatchObject({ needsApproval: true, request: { status: "declined", declineReason: "Wrong supplier" } });
    const edited = await w.as(mere, (tx) => updateBill(tx, draft.id, { dueDate: "2026-10-25" }));
    expect(edited.dueDate).toBe("2026-10-25");
    const again = await w.submit(mere, "bill", draft.id);
    expect(again.id).not.toBe(first.id);
    expect(again).toMatchObject({ currentStep: 1, actions: [] });
    expect(await w.history("bill", draft.id)).toEqual([
      ["approval.submitted", mere.email],
      ["approval.declined", ana.email],
      ["approval.submitted", mere.email],
    ]);
  });

  it("AW8: Mere withdraws a submitted bill: a draft again, approvals dropped; Tama can't withdraw it", async () => {
    const w = await setup();
    await w.overThousand();
    const draft = await w.bill();
    const request = await w.submit(mere, "bill", draft.id);
    await w.approve(tama, request.id);
    await expect(w.as(tama, (tx) => withdrawApprovalRequest(tx, w.viewer(tama), request.id))).rejects.toThrow("Only Mere, who submitted it, or an admin can withdraw it.");
    const withdrawn = await w.as(mere, (tx) => withdrawApprovalRequest(tx, w.viewer(mere), request.id));
    expect(withdrawn).toMatchObject({ status: "withdrawn", actions: [expect.objectContaining({ stepNumber: 1, action: "approved", email: tama.email })] });
    await w.as(mere, (tx) => updateBill(tx, draft.id, { lines: [{ description: "Year-end accounts", quantity: "1", unitPrice: "1100.00", accountCode: "6010", taxCode: "GST" }] }));
    const again = await w.submit(mere, "bill", draft.id);
    expect(again).toMatchObject({ currentStep: 1, waitingFor: "Waiting for Ana or Tama" });
  });

  it("AW9: a step of all of Tama and Ana needs both before step 2, showing who has and who hasn't", async () => {
    const w = await setup();
    await w.addRule({ documentType: "bill", name: "Both of them", steps: w.steps(["all", [tama, ana]], ["any", [jess]]) });
    const request = await w.submit(mere, "bill", (await w.bill()).id);
    const afterTama = (await w.approve(tama, request.id)).request;
    expect(afterTama.currentStep).toBe(1);
    expect(afterTama.waitingFor).toBe("Waiting for Ana");
    expect(afterTama.steps[0].approvers.map((approver) => [approver.name, approver.approvedAt !== null])).toEqual([
      ["Ana", false],
      ["Tama", true],
    ]);
    await expect(w.approve(tama, request.id)).rejects.toThrow("it's waiting for Ana");
    expect((await w.approve(ana, request.id)).request).toMatchObject({ currentStep: 2, waitingFor: "Waiting for Jess" });
  });

  it("AW10: a locked period refuses the last approval; the request waits at step 2 and says why; after unlocking Jess approves", async () => {
    const w = await setup();
    await w.overThousand();
    const september = await w.bill(mere, { billDate: "2026-09-28", dueDate: "2026-10-20" });
    const request = await w.submit(mere, "bill", september.id);
    await w.approve(tama, request.id);
    await w.as(jess, (tx) => updatePeriodControls(tx, { lockDate: "2026-09-30" }));
    const response = await approveRoute.POST(
      apiRequest(`/api/approvals/${request.id}/approve`, { method: "POST", cookie: await sessionCookieFor(jess), body: { organisationId: w.org } }),
      params({ requestId: request.id }),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/locked|lock date/i);
    const waiting = await w.view(jess, request.id);
    expect(waiting).toMatchObject({ status: "waiting", currentStep: 2, canAct: true });
    expect(waiting.lastError).toMatch(/locked|lock date/i);
    expect(waiting.actions.map((action) => [action.stepNumber, action.email])).toEqual([[1, tama.email]]);
    expect((await w.as(jess, (tx) => getBill(tx, september.id))).status).toBe("draft");
    await w.as(jess, (tx) => updatePeriodControls(tx, { lockDate: null, reason: "Open for the accounts" }));
    const done = await w.approve(jess, request.id);
    expect([done.refused, done.request.status, done.request.lastError]).toEqual([null, "approved", null]);
    expect((await w.as(jess, (tx) => getBill(tx, september.id))).status).toBe("approved");
  });

  it("AW11: a purchase order rule for Retail lines goes to Tama; rules are tried in order", async () => {
    const w = await setup();
    await w.addRule({ documentType: "purchase_order", name: "Tama for Retail", trackingValueId: w.retail, steps: w.steps(["any", [tama]]) });
    const order = (
      await w.as(mere, (tx) =>
        createPurchaseOrder(tx, {
          idempotencyKey: key("po"),
          contactId: w.kauri.id,
          orderDate: "2026-10-03",
          amountsMode: "exclusive",
          lines: [{ description: "Shelving", quantity: "2", unitPrice: "150.00", accountCode: "6010", taxCode: "GST", tracking: { [w.department]: w.retail } }],
        }),
      )
    ).purchaseOrder;
    await expect(w.as(mere, (tx) => approvePurchaseOrder(tx, order.id, { idempotencyKey: key("a") }))).rejects.toThrow(
      "This purchase order needs approval (rule: Tama for Retail). Submit it for approval.",
    );
    const request = await w.submit(mere, "purchase_order", order.id);
    expect(request.waitingFor).toBe("Waiting for Tama");
    expect((await w.approve(tama, request.id)).request.status).toBe("approved");
    const approved = await w.as(mere, (tx) => getPurchaseOrder(tx, order.id));
    expect([approved.status, approved.poNumber, approved.approvedByEmail]).toEqual(["approved", "PO-0001", tama.email]);

    // Two bill rules match a 1,150.00 Kauri bill: the first is used, until the second is moved up.
    await w.overThousand();
    const kauriRule = await w.addRule({ documentType: "bill", name: "Kauri bills", contactId: w.kauri.id, steps: w.steps(["any", [ana]]) });
    expect((await w.submit(mere, "bill", (await w.bill()).id)).ruleName).toBe("Over $1,000");
    await w.as(ana, (tx) => moveApprovalRule(tx, "admin", kauriRule.id, "up"));
    expect((await w.as(ana, (tx) => listApprovalRules(tx, { documentType: "bill" }))).map((rule) => [rule.name, rule.position])).toEqual([
      ["Kauri bills", 1],
      ["Over $1,000", 2],
    ]);
    expect((await w.submit(mere, "bill", (await w.bill()).id)).ruleName).toBe("Kauri bills");
  });

  it("AW12: Tama's email has the bill and a link that needs signing in; another member sees who it's waiting for, with no buttons", async () => {
    const w = await setup();
    await w.overThousand();
    const smtpServer = await prepareSmtpServer({ host: "127.0.0.1", port: 2525, security: "none" });
    await w.as(jess, (tx) => updateOrganisationEmailSettings(tx, { fromName: "Kowhai", fromAddress: SMTP_USER, username: SMTP_USER, password: SMTP_PASSWORD }, smtpServer));
    const request = await w.submit(mere, "bill", (await w.bill(mere, { supplierInvoiceNumber: "K-300" })).id);
    const link = `${ORIGIN}/login?next=${encodeURIComponent(`/operations/purchases/approvals/${request.id}/in/${w.org}`)}`;
    const toTama = (await w.emails(request.id)).find((email) => email.to_email === tama.email)!;
    expect(toTama.subject).toBe("Approval needed: Bill K-300 from Kauri Supplies (1,150.00 NZD)");
    expect(toTama.body).toContain("Hi Tama,");
    expect(toTama.body).toContain("Mere submitted bill K-300 from Kauri Supplies for approval (rule: Over $1,000, step 1 of 2).");
    expect(toTama.body).toContain("Supplier: Kauri Supplies\nNumber: K-300\nTotal: 1,150.00 NZD");
    expect(toTama.body).toContain(link);
    expect(toTama.body).toContain("Nothing is approved from this email");

    received.length = 0;
    const result = await processOrganisationOutbox((await getOrganisation(w.org))!);
    expect(result.waiting).toBe(0);
    expect(received.map((mail) => mail.to[0]).sort()).toEqual([ana.email, tama.email].sort());
    const mail = received.find((item) => item.to[0] === tama.email)!.mail;
    expect(mail.subject).toBe(toTama.subject);
    expect(mail.text).toContain(link);
    expect(mail.attachments).toHaveLength(0);
    expect((await w.view(mere, request.id)).emails.map((email) => email.status)).toEqual(["sent", "sent"]);

    // Signed out, the request can't be read; signed in as another member it says who it's waiting for, with no buttons.
    const signedOut = await requestRoute.GET(apiRequest(`/api/approvals/${request.id}?organisationId=${w.org}`), params({ requestId: request.id }));
    expect(signedOut.status).toBe(401);
    const asMere = await requestRoute.GET(apiRequest(`/api/approvals/${request.id}?organisationId=${w.org}`, { cookie: await sessionCookieFor(mere) }), params({ requestId: request.id }));
    const seen = (await asMere.json()) as { request: { waitingFor: string; canAct: boolean; submittedByName: string }; budget: unknown[] };
    expect(seen.request).toMatchObject({ waitingFor: "Waiting for Ana or Tama", canAct: false, submittedByName: "Mere" });
    expect(seen.budget).toHaveLength(1);
  });

  it("AW13: Jess's AI key drafts and submits a 1,150.00 bill, but can't approve it; it can list what's waiting", async () => {
    const w = await setup();
    await w.overThousand();
    const made = await tokensRoute.POST(
      apiRequest("/api/ai/tokens", { method: "POST", cookie: await sessionCookieFor(jess), body: { organisationId: w.org, name: "Claude", accessLevel: "post" } }),
      noContext,
    );
    const token = ((await made.json()) as { token: string }).token;
    const drafted = await callTool(token, "create_draft_bill", {
      contactId: w.kauri.id,
      billDate: "2026-10-03",
      dueDate: "2026-10-20",
      supplierInvoiceNumber: "K-400",
      amountsMode: "exclusive",
      lines: [{ description: "Year-end accounts", quantity: "1", unitPrice: "1000.00", accountCode: "6010", taxCode: "GST" }],
    });
    const billId = (drafted.bill as Json).id as string;
    await expect(callTool(token, "approve_bill", { billId })).rejects.toThrow("This bill needs a person's approval (rule: Over $1,000).");
    const submitted = await callTool(token, "submit_for_approval", { documentType: "bill", documentId: billId });
    expect(submitted).toMatchObject({ rule: "Over $1,000", step: 1, steps: 2, waitingFor: "Waiting for Ana or Tama" });
    await expect(callTool(token, "approve_bill", { billId })).rejects.toThrow("This bill needs a person's approval (rule: Over $1,000).");
    const listed = await callTool(token, "list_approvals");
    expect(listed.requests).toEqual([expect.objectContaining({ document: "Bill K-400 from Kauri Supplies", total: "1150.00", rule: "Over $1,000", step: 1 })]);
    // The history says it was submitted through the AI key.
    const audit = await w.as(jess, (tx) => tx.query<{ details: Json }>("select details from audit_events where event_type = 'approval.submitted' and entity_id = $1", [billId]));
    expect(audit.rows[0].details.via).toMatch(/Claude/);
  });

  it("AW14: a repeating bill set to approve, whose bill matches the rule, is submitted instead", async () => {
    const w = await setup();
    await w.overThousand();
    const template = (
      await w.as(jess, (tx) =>
        createRepeatingBill(tx, {
          idempotencyKey: key("rb"),
          contactId: w.kauri.id,
          supplierInvoiceNumber: "RENT-{date}",
          amountsMode: "exclusive",
          lines: [{ description: "Rent", quantity: "1", unitPrice: "1000.00", accountCode: "6010", taxCode: "GST" }],
          period: "month",
          every: 1,
          startDate: "2026-10-01",
          dueRule: "days_after",
          dueDays: 7,
          saveAs: "approve",
        }),
      )
    ).repeatingBill;
    const run = await inOrganisation(w.org, { userId: null, email: "repeating-bills@tohyee" }, (tx) => runRepeatingBills(tx, { today: "2026-10-01", repeatingBillId: template.id }));
    expect([run.made, run.approved, run.refused]).toEqual([1, 0, 0]);
    const runs = (await w.as(jess, (tx) => getRepeatingBill(tx, template.id))).runs;
    expect(runs.map((item) => [item.outcome, item.message])).toEqual([["submitted", "Submitted for approval (rule: Over $1,000)"]]);
    const billId = runs[0].billId!;
    expect((await w.as(jess, (tx) => getBill(tx, billId))).status).toBe("draft");
    expect(await w.as(tama, (tx) => documentApproval(tx, w.viewer(tama), "bill", billId))).toMatchObject({ request: { status: "waiting", currentStep: 1 } });
  });

  it("AW15-AW17: expense claims under 'Claims over $300'", async () => {
    const w = await setup();
    await w.addRule({ documentType: "expense_claim", name: "Claims over $300", minTotal: "300.00", steps: w.steps(["any", [ana, jess]]) });
    const receipt = (amount: string) => ({
      receiptDate: "2026-10-02",
      supplierName: "Noel Leeming",
      description: "Monitor",
      accountCode: "6140",
      taxCode: "GST",
      amount,
      supplierGstNumber: "123-456-789",
    });
    const claim = async (by: SessionUser, amount: string) =>
      w.as(by, async (tx) => submitExpenseClaim(tx, (await createExpenseClaim(tx, { idempotencyKey: key("claim"), receipts: [receipt(amount)] })).claim.id, { origin: ORIGIN }));
    const waitingFor = async (claimId: string) => (await w.as(jess, (tx) => documentApproval(tx, w.viewer(jess), "expense_claim", claimId))).request!;

    // AW15: Tama's 345.00 claim waits for Ana or Jess; Mere can't approve it (without a rule she could).
    const tamas = await claim(tama, "345.00");
    expect(tamas.status).toBe("submitted");
    const request = await waitingFor(tamas.id);
    expect(request).toMatchObject({ status: "waiting", ruleName: "Claims over $300", waitingFor: "Waiting for Ana or Jess" });
    await expect(w.approve(mere, request.id, { claimDate: "2026-10-05" })).rejects.toThrow("Only this step's approvers can approve or decline it: it's waiting for Ana or Jess.");
    await expect(w.as(mere, (tx) => approveExpenseClaim(tx, "bookkeeper", tamas.id, { idempotencyKey: key("a"), claimDate: "2026-10-05" }))).rejects.toThrow(
      "This expense claim is waiting for approval (rule: Claims over $300).",
    );
    await expect(w.as(mere, (tx) => declineExpenseClaim(tx, "bookkeeper", tamas.id, { reason: "No" }))).rejects.toThrow("waiting for approval");

    // AW16: Ana approves, choosing the claim date: posted as EC3, approved by Ana.
    await expect(w.approve(ana, request.id)).rejects.toThrow("Choose the claim date");
    const done = await w.approve(ana, request.id, { claimDate: "2026-10-05" });
    expect(done.request.status).toBe("approved");
    const approved = await w.as(ana, (tx) => getExpenseClaim(tx, tamas.id));
    expect([approved.status, approved.claimDate, approved.approvedByEmail]).toEqual(["approved", "2026-10-05", ana.email]);
    const journal = await w.as(jess, (tx) => getJournal(tx, approved.approvalJournalId!));
    expect(journal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["6140", "300.00", "0.00"],
      ["2100", "45.00", "0.00"],
      ["2010", "0.00", "345.00"],
    ]);
    // Declined instead: back to Tama as a draft with the reason, as EC6.
    const second = await claim(tama, "345.00");
    const secondRequest = await waitingFor(second.id);
    await w.as(ana, (tx) => declineApprovalStep(tx, w.viewer(ana), secondRequest.id, { reason: "Use the company card" }));
    const declined = await w.as(tama, (tx) => getExpenseClaim(tx, second.id));
    expect([declined.status, declined.declineReason, declined.declinedByEmail]).toEqual(["draft", "Use the company card", ana.email]);

    // AW17: Jess's own 400.00 claim: Jess can't approve it, even as owner; Ana does.
    const jesss = await claim(jess, "400.00");
    const jessRequest = await waitingFor(jesss.id);
    expect(jessRequest.waitingFor).toBe("Waiting for Ana");
    await expect(w.approve(jess, jessRequest.id, { claimDate: "2026-10-05" })).rejects.toThrow("nobody approves their own");
    expect((await w.approve(ana, jessRequest.id, { claimDate: "2026-10-05" })).request.status).toBe("approved");
    // A 120.00 claim matches no rule: approved as EC3 today.
    const small = await claim(tama, "120.00");
    expect((await w.as(jess, (tx) => documentApproval(tx, w.viewer(jess), "expense_claim", small.id))).request).toBeNull();
    expect((await w.as(mere, (tx) => approveExpenseClaim(tx, "bookkeeper", small.id, { idempotencyKey: key("a"), claimDate: "2026-10-05" }))).claim.status).toBe("approved");
    // Tama withdraws a submitted claim back to draft; Ana (not the claimant) can't.
    const third = await claim(tama, "350.00");
    const thirdRequest = await waitingFor(third.id);
    await expect(w.as(ana, (tx) => withdrawApprovalRequest(tx, w.viewer(ana), thirdRequest.id))).rejects.toThrow("Only Tama, whose claim it is, can withdraw it.");
    await w.as(tama, (tx) => withdrawApprovalRequest(tx, w.viewer(tama), thirdRequest.id));
    expect((await w.as(tama, (tx) => getExpenseClaim(tx, third.id))).status).toBe("draft");
    expect(await w.history("expense_claim", third.id)).toEqual([
      ["approval.submitted", tama.email],
      ["approval.withdrawn", tama.email],
    ]);
  });
});
