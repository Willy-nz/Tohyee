import { afterAll, beforeAll, expect, it } from "vitest";
import * as projectRoute from "@/app/api/projects/[projectId]/route";
import * as projectsRoute from "@/app/api/projects/route";
import * as profitabilityRoute from "@/app/api/reports/project-profitability/route";
import * as timeReportRoute from "@/app/api/reports/project-time/route";
import * as staffRatesRoute from "@/app/api/project-staff-rates/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankTransaction, voidBankTransaction } from "@/lib/bank/transactions";
import { approveBill, createBill, voidBill } from "@/lib/bills/service";
import { archiveContact, createContact } from "@/lib/contacts/service";
import { createItem } from "@/lib/items/service";
import { getCustomerSetup } from "@/lib/customers/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveExpenseClaim, createExpenseClaim, submitExpenseClaim, voidExpenseClaim } from "@/lib/expense-claims/service";
import { approveInvoice, deleteInvoice, getInvoice, voidInvoice } from "@/lib/invoices/service";
import { getJournal } from "@/lib/ledger/journals";
import {
  archiveTask,
  closeProject,
  createProject,
  createTask,
  createTimeEntry,
  getProject,
  invoiceProject,
  linkProjectExpense,
  listExpenseSources,
  listProjects,
  type Project,
  projectProfitability,
  removeProjectExpense,
  removeTimeEntry,
  reopenProject,
  setStaffRate,
  timeReport,
  updateProjectExpense,
  updateTask,
  updateTimeEntry,
} from "@/lib/projects/service";
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

const noContext = undefined as unknown;

/** Examples PJ1-PJ12 in docs/ACCOUNTING-EXAMPLES.md ("Projects and time tracking"). Each test gets its own organisation. */
describeWithDatabase("projects and time tracking", () => {
  let server: TestServer;
  let jess: SessionUser;
  let aroha: SessionUser;
  let sam: SessionUser;
  let viewer: SessionUser;
  let stranger: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    jess = await createTestUser("pj-jess@example.com", { serverAdmin: true, displayName: "Jess Kelly" });
    aroha = await createTestUser("pj-aroha@example.com", { displayName: "Aroha Ngata" });
    sam = await createTestUser("pj-sam@example.com");
    viewer = await createTestUser("pj-viewer@example.com");
    stranger = await createTestUser("pj-stranger@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `pj-${organisations}-co`;
    await createTestOrganisation(jess, org);
    for (const [user, role] of [
      [aroha, "bookkeeper"],
      [sam, "bookkeeper"],
      [viewer, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
    }
    const asUser = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
    const as = asUser(jess);
    const asAroha = asUser(aroha);
    const asSam = asUser(sam);
    const terms = (await as((tx) => getCustomerSetup(tx))).paymentTerms;
    const twentieth = terms.find((term) => term.name === "20th of the following month")!.id;
    const harbour = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Cafe", isCustomer: true, paymentTermId: twentieth }))).contact;
    const paw = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Paw Supplies", isSupplier: true }))).contact;
    await as((tx) => setStaffRate(tx, "owner", { userId: jess.id, costRate: "40.00" }));
    await as((tx) => setStaffRate(tx, "owner", { userId: aroha.id, costRate: "30.00" }));
    const { project } = await asAroha((tx) =>
      createProject(tx, { idempotencyKey: key("project"), name: "Cafe rebrand", contactId: harbour.id, estimate: "2000.00", deadline: "2026-08-31" }),
    );
    const task = async (fields: Record<string, unknown>) => (await asAroha((tx) => createTask(tx, project.id, { idempotencyKey: key("task"), ...fields }))).taskId;
    const design = await task({ name: "Design", chargeType: "hourly", rate: "90.00", estimateHours: "10" });
    const photo = await task({ name: "Photography", chargeType: "fixed", rate: "600.00" });
    const admin = await task({ name: "Admin", chargeType: "non_chargeable" });
    const time = async (who: "jess" | "aroha" | "sam", taskId: string, entryDate: string, hours: string, minutes: string, description = "Work") => {
      const run = who === "jess" ? as : who === "aroha" ? asAroha : asSam;
      return (await run((tx) => createTimeEntry(tx, who === "jess" ? "owner" : "bookkeeper", project.id, { idempotencyKey: key("time"), taskId, entryDate, hours, minutes, description }))).entry;
    };
    const get = () => as((tx) => getProject(tx, project.id));
    const journals = async () => Number((await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);
    const sources = () => as((tx) => listExpenseSources(tx));
    const link = async (lineId: string, sourceType: string, chargeable: boolean, markupPercent?: string, projectId = project.id) =>
      (await asAroha((tx) => linkProjectExpense(tx, projectId, { idempotencyKey: key("link"), sourceType, lineId, chargeable, markupPercent }))).expenseId;
    const invoice = async (fields: Record<string, unknown> = {}, idempotencyKey = key("invoice")) =>
      asAroha((tx) => invoiceProject(tx, project.id, { idempotencyKey, invoiceDate: "2026-07-10", accountCode: "4000", taxCode: "GST", ...fields }));
    const bank = (await as((tx) => tx.query<{ id: string }>("select id::text from accounts where code = '1000'"))).rows[0].id;
    return { org, as, asAroha, asSam, harbour, paw, project, design, photo, admin, time, get, journals, sources, link, invoice, bank };
  }
  type World = Awaited<ReturnType<typeof setup>>;

  /** The PJ3 time and the PJ4 expenses. */
  async function scenario(w: World) {
    const t1 = await w.time("jess", w.design, "2026-07-01", "2", "30", "Logo concepts");
    const t2 = await w.time("aroha", w.design, "2026-07-02", "1", "15", "Colour options");
    const t3 = await w.time("jess", w.admin, "2026-07-03", "", "45", "Meeting prep");
    const t4 = await w.time("aroha", w.photo, "2026-07-03", "4", "0", "Shoot");
    const { bill } = await w.as((tx) =>
      createBill(tx, {
        idempotencyKey: key("bill"),
        contactId: w.paw.id,
        billDate: "2026-07-04",
        dueDate: "2026-07-20",
        supplierInvoiceNumber: "PS-300",
        amountsMode: "exclusive",
        lines: [{ description: "Printing of menus", quantity: "1", unitPrice: "200.00", accountCode: "6140", taxCode: "GST" }],
      }),
    );
    await w.as((tx) => approveBill(tx, bill.id, { idempotencyKey: key("approve") }));
    const { claim } = await w.asAroha((tx) =>
      createExpenseClaim(tx, {
        idempotencyKey: key("claim"),
        receipts: [{ receiptDate: "2026-07-05", supplierName: "Z Energy", description: "Fuel to shoot", accountCode: "6120", taxCode: "GST", amount: "69.00" }],
      }),
    );
    await w.asAroha((tx) => submitExpenseClaim(tx, claim.id));
    await w.as((tx) => approveExpenseClaim(tx, "owner", claim.id, { idempotencyKey: key("approve"), claimDate: "2026-07-06" }));
    const { bankTransaction } = await w.as((tx) =>
      createBankTransaction(tx, {
        idempotencyKey: key("spend"),
        kind: "spend",
        accountId: w.bank,
        contactId: w.paw.id,
        date: "2026-07-06",
        amountsMode: "inclusive",
        lines: [{ description: "Props", accountCode: "6070", taxCode: "GST", amount: "46.00" }],
      }),
    );
    const sources = await w.sources();
    const line = (description: string) => sources.find((source) => source.description === description)!;
    const printing = line("Printing of menus");
    const fuel = line("Fuel to shoot");
    const props = line("Props");
    const x1 = await w.link(printing.lineId, "bill_line", true, "10");
    const x2 = await w.link(fuel.lineId, "expense_claim_receipt", false);
    const x3 = await w.link(props.lineId, "bank_transaction_line", true);
    return { t1, t2, t3, t4, bill, claim, bankTransaction, x1, x2, x3, lines: { printing, fuel, props } };
  }

  const everything = (project: Project) => ({
    timeEntryIds: project.timeEntries.filter((e) => e.status === "active" && e.chargeType === "hourly" && !e.billedOn && !e.writtenOffAt).map((e) => e.id),
    taskIds: project.tasks.filter((t) => t.chargeType === "fixed" && !t.billedOn && !t.writtenOffAt && t.status === "active").map((t) => t.id),
    expenseIds: project.expenses.filter((x) => x.status === "active" && x.chargeable && !x.billedOn && !x.writtenOffAt).map((x) => x.id),
  });

  it("PJ1: a project for a customer posts nothing and starts in progress", async () => {
    const w = await setup();
    const project = await w.get();
    expect([project.name, project.contactName, project.estimate, project.deadline, project.status]).toEqual([
      "Cafe rebrand",
      "Harbour Cafe",
      "2000.00",
      "2026-08-31",
      "in_progress",
    ]);
    expect((await w.as((tx) => listProjects(tx, { contactId: w.harbour.id }))).map((p) => p.id)).toEqual([project.id]);
    expect(await w.journals()).toBe(0);
    const make = (fields: Record<string, unknown>, idempotencyKey = key("p")) =>
      w.asAroha((tx) => createProject(tx, { idempotencyKey, name: "Other", contactId: w.harbour.id, ...fields }));
    await expect(make({ contactId: w.paw.id })).rejects.toThrow("isn't marked as a customer");
    await expect(make({ name: "" })).rejects.toThrow("name is required");
    await expect(make({ estimate: "-1.00" })).rejects.toThrow("estimate");
    await expect(make({ estimate: "1.005" })).rejects.toThrow("at most 2 decimal places");
    const archived = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Old Cafe", isCustomer: true }))).contact;
    await w.as((tx) => archiveContact(tx, archived.id));
    await expect(make({ contactId: archived.id })).rejects.toThrow("archived");
    // A status typed in isn't a field; only Close and Reopen change it.
    const k = key("p");
    const made = (await make({ status: "closed" }, k)).project;
    expect(made.status).toBe("in_progress");
    expect((await make({}, k)).project.id).toBe(made.id);
    await expect(make({ name: "Renamed" }, k)).rejects.toThrow("idempotency key");
    await expect(w.as((tx) => tx.query("delete from projects where id = $1", [made.id]))).rejects.toThrow("can't be deleted");
    await expect(w.as((tx) => tx.query("update projects set status = 'closed', closed_at = now(), name = 'x' where id = $1", [made.id]))).rejects.toThrow(
      "changes nothing else",
    );
  });

  it("PJ2: tasks are hourly, fixed price or non-chargeable, and archived rather than deleted", async () => {
    const w = await setup();
    const project = await w.get();
    const design = project.tasks.find((t) => t.id === w.design)!;
    expect([design.chargeType, design.rate, design.estimateMinutes]).toEqual(["hourly", "90", 600]);
    expect(project.tasks.find((t) => t.id === w.photo)!.rate).toBe("600.00");
    const task = (fields: Record<string, unknown>) => w.asAroha((tx) => createTask(tx, w.project.id, { idempotencyKey: key("t"), name: "Extra", ...fields }));
    await expect(task({ chargeType: "hourly" })).rejects.toThrow("needs its rate");
    await expect(task({ chargeType: "non_chargeable", rate: "10" })).rejects.toThrow("has no rate");
    await expect(task({ chargeType: "fixed", rate: "600.005" })).rejects.toThrow("at most 2 decimal places");
    await expect(task({ chargeType: "fixed", rate: "0.00" })).rejects.toThrow("zero");
    await expect(task({ name: "design", chargeType: "non_chargeable" })).rejects.toThrow("already has a task called");
    await w.time("jess", w.admin, "2026-07-03", "", "45");
    await w.asAroha((tx) => archiveTask(tx, w.admin));
    await expect(w.as((tx) => tx.query("delete from project_tasks where id = $1", [w.admin]))).rejects.toThrow("can't be deleted");
    await expect(w.time("jess", w.admin, "2026-07-04", "1", "0")).rejects.toThrow("archived");
    const after = await w.get();
    expect(after.tasks.find((t) => t.id === w.admin)!.status).toBe("archived");
    expect(after.figures.minutes).toBe(45);
    expect(after.figures.timeCost).toBe("30.00");
  });

  it("PJ3: time is whole minutes, costed at the member's rate when entered", async () => {
    const w = await setup();
    const t1 = await w.time("jess", w.design, "2026-07-01", "2", "30");
    expect([t1.minutes, t1.costRate, t1.cost, t1.userEmail]).toEqual([150, "40.00", "100.00", jess.email]);
    const t2 = await w.time("aroha", w.design, "2026-07-02", "1", "15");
    expect([t2.minutes, t2.cost]).toEqual([75, "37.50"]);
    const bad = (hours: string, minutes: string, fields: Record<string, unknown> = {}) =>
      w.asAroha((tx) => createTimeEntry(tx, "bookkeeper", w.project.id, { idempotencyKey: key("t"), taskId: w.design, entryDate: "2026-07-01", hours, minutes, ...fields }));
    await expect(bad("0", "0")).rejects.toThrow("at least 1 minute");
    await expect(bad("24", "1")).rejects.toThrow("at most 24 h");
    await expect(bad("0", "1.5")).rejects.toThrow("whole number");
    await expect(bad("1", "0", { entryDate: "2026-02-30" })).rejects.toThrow("entryDate");
    // A task from another project.
    const other = (await w.as((tx) => createProject(tx, { idempotencyKey: key("p"), name: "Other", contactId: w.harbour.id }))).project;
    const otherTask = (await w.as((tx) => createTask(tx, other.id, { idempotencyKey: key("t"), name: "Misc", chargeType: "non_chargeable" }))).taskId;
    await expect(bad("1", "0", { taskId: otherTask })).rejects.toThrow("isn't on this project");
    await expect(w.as((tx) => tx.query("update project_time_entries set task_id = $2 where id = $1", [t1.id, otherTask]))).rejects.toThrow("isn't on this project");
    // Someone else's time: admins only, and only for members.
    await expect(bad("1", "0", { userId: jess.id })).rejects.toThrow("Only admins");
    await expect(w.asAroha((tx) => updateTimeEntry(tx, "bookkeeper", t1.id, { minutes: "10", hours: "0" }))).rejects.toThrow("Only Jess Kelly or an admin");
    await expect(w.asAroha((tx) => setStaffRate(tx, "bookkeeper", { userId: aroha.id, costRate: "99" }))).rejects.toThrow("Only admins");
    const forAroha = (await w.as((tx) => createTimeEntry(tx, "owner", w.project.id, { idempotencyKey: key("t"), userId: aroha.id, taskId: w.design, entryDate: "2026-07-05", hours: "1", minutes: "0" }))).entry;
    expect([forAroha.userEmail, forAroha.cost, forAroha.createdByEmail]).toEqual([aroha.email, "30.00", jess.email]);
    await expect(
      w.as((tx) => createTimeEntry(tx, "owner", w.project.id, { idempotencyKey: key("t"), userId: stranger.id, taskId: w.design, entryDate: "2026-07-05", hours: "1", minutes: "0" })),
    ).rejects.toThrow("member of the organisation");
    // Sam has no rate.
    expect((await w.time("sam", w.design, "2026-07-05", "1", "0")).cost).toBe("0.00");
    // A new rate only applies to new entries.
    await w.as((tx) => setStaffRate(tx, "owner", { userId: jess.id, costRate: "50" }));
    expect((await w.as((tx) => getProject(tx, w.project.id))).timeEntries.find((e) => e.id === t1.id)!.cost).toBe("100.00");
    expect((await w.time("jess", w.design, "2026-07-06", "1", "0")).cost).toBe("50.00");
    // Retrying with the same key returns the same entry.
    const k = key("t");
    const once = (await w.asSam((tx) => createTimeEntry(tx, "bookkeeper", w.project.id, { idempotencyKey: k, taskId: w.admin, entryDate: "2026-07-07", hours: "0", minutes: "30" }))).entry;
    const twice = await w.asSam((tx) => createTimeEntry(tx, "bookkeeper", w.project.id, { idempotencyKey: k, taskId: w.admin, entryDate: "2026-07-07", hours: "0", minutes: "30" }));
    expect([twice.created, twice.entry.id]).toEqual([false, once.id]);
    await expect(w.as((tx) => tx.query("delete from project_time_entries where id = $1", [t1.id]))).rejects.toThrow("can't be deleted");
    expect(await w.journals()).toBe(0);
  });

  it("PJ4: bill lines, receipts and spend money are linked at cost excluding GST, not re-posted", async () => {
    const w = await setup();
    const before = await w.journals();
    expect(before).toBe(0);
    const s = await scenario(w);
    const posted = await w.journals();
    expect(posted).toBe(3);
    const project = await w.get();
    expect(project.expenses.map((x) => [x.description, x.sourceType, x.cost, x.chargeable, x.markupPercent, x.charge])).toEqual([
      ["Printing of menus", "bill_line", "200.00", true, "10", "220.00"],
      ["Fuel to shoot", "expense_claim_receipt", "60.00", false, "0", "0.00"],
      ["Props", "bank_transaction_line", "40.00", true, "0", "40.00"],
    ]);
    // A linked line isn't offered again.
    expect((await w.sources()).map((source) => source.description)).toEqual([]);
    // Refused: a draft bill's line, the same line on another project, receive money, stock, a bad markup.
    const { item: widget } = await w.as((tx) =>
      createItem(tx, { idempotencyKey: key("item"), code: "WIDGET", name: "Widget", itemType: "stock", incomeAccountCode: "4000", salesTaxCode: "GST", purchaseAccountCode: "1400", purchaseTaxCode: "GST", salePrice: "12.00", purchasePrice: "5.00" }),
    );
    const { bill: draft } = await w.as((tx) =>
      createBill(tx, {
        idempotencyKey: key("bill"),
        contactId: w.paw.id,
        billDate: "2026-07-07",
        dueDate: "2026-07-20",
        supplierInvoiceNumber: "PS-301",
        amountsMode: "exclusive",
        lines: [
          { description: "Menu stands", quantity: "1", unitPrice: "80.00", accountCode: "6130", taxCode: "GST" },
          { itemId: widget.id, description: "Stock", quantity: "10", unitPrice: "5.00", accountCode: "1400", taxCode: "GST" },
        ],
      }),
    );
    const draftLines = (await w.as((tx) => tx.query<{ id: string; description: string }>("select id::text, description from bill_lines where bill_id = $1 order by line_order", [draft.id]))).rows;
    await expect(w.link(draftLines[0].id, "bill_line", true)).rejects.toThrow("approved");
    await w.as((tx) => approveBill(tx, draft.id, { idempotencyKey: key("approve") }));
    await expect(w.link(draftLines[1].id, "bill_line", true)).rejects.toThrow("stock");
    await expect(w.link(draftLines[0].id, "bill_line", true, "-5")).rejects.toThrow("markupPercent");
    await expect(w.link(draftLines[0].id, "bill_line", true, "10.001")).rejects.toThrow("at most 2 decimal places");
    const other = (await w.as((tx) => createProject(tx, { idempotencyKey: key("p"), name: "Other", contactId: w.harbour.id }))).project;
    await expect(w.link(s.lines.printing.lineId, "bill_line", true, "0", other.id)).rejects.toThrow("already on project Cafe rebrand");
    await expect(
      w.as((tx) =>
        tx.query(
          `insert into project_expenses (command_source, idempotency_key, request_hash, project_id, source_type, bill_line_id, cost, chargeable)
           values ('api', 'dup-key-1', 'h', $1, 'bill_line', $2, 200, true)`,
          [other.id, s.lines.printing.lineId],
        ),
      ),
    ).rejects.toThrow("project_expenses_bill_line_idx");
    const { bankTransaction: received } = await w.as((tx) =>
      createBankTransaction(tx, {
        idempotencyKey: key("receive"),
        kind: "receive",
        accountId: w.bank,
        contactId: w.harbour.id,
        date: "2026-07-06",
        amountsMode: "inclusive",
        lines: [{ description: "Tip jar", accountCode: "4100", taxCode: "GST", amount: "23.00" }],
      }),
    );
    const receiveLine = (await w.as((tx) => tx.query<{ id: string }>("select id::text from bank_transaction_lines where bank_transaction_id = $1", [received.id]))).rows[0].id;
    await expect(w.link(receiveLine, "bank_transaction_line", true)).rejects.toThrow("spend money");
    // Voiding the bill, claim or spend money while linked is refused by the database.
    await expect(w.as((tx) => voidBill(tx, s.bill.id, { idempotencyKey: key("void"), voidDate: "2026-07-20" }))).rejects.toThrow("on project Cafe rebrand");
    await expect(w.as((tx) => voidExpenseClaim(tx, "owner", s.claim.id, { idempotencyKey: key("void"), voidDate: "2026-07-20" }))).rejects.toThrow("on project Cafe rebrand");
    await expect(w.as((tx) => voidBankTransaction(tx, s.bankTransaction.id, { idempotencyKey: key("void"), voidDate: "2026-07-20" }))).rejects.toThrow(
      "on project Cafe rebrand",
    );
    // Once removed from the project, the bill can be voided.
    await w.asAroha((tx) => removeProjectExpense(tx, s.x1));
    await w.as((tx) => voidBill(tx, s.bill.id, { idempotencyKey: key("void"), voidDate: "2026-07-20" }));
    // Nothing linked posted a journal: only the documents (and their voids).
    expect(await w.journals()).toBe(posted + 2 + 1);
    await expect(w.as((tx) => tx.query("update project_expenses set cost = 1 where id = $1", [s.x2]))).rejects.toThrow("never change");
  });

  it("PJ5: unbilled is hourly time at the task's rate, fixed prices and chargeable expenses", async () => {
    const w = await setup();
    await scenario(w);
    const project = await w.get();
    const design = project.tasks.find((t) => t.id === w.design)!;
    expect([design.minutes, design.unbilledMinutes, design.unbilledAmount]).toEqual([225, 225, "337.50"]);
    expect(project.tasks.find((t) => t.id === w.photo)!.unbilledAmount).toBe("600.00");
    expect(project.tasks.find((t) => t.id === w.admin)!.unbilledAmount).toBe("0.00");
    const f = project.figures;
    expect([f.unbilledTime, f.unbilledFixed, f.unbilledExpenses, f.unbilled]).toEqual(["337.50", "600.00", "260.00", "1197.50"]);
  });

  it("PJ6: invoicing makes a draft invoice from the chosen items and links them so they aren't billed twice", async () => {
    const w = await setup();
    const s = await scenario(w);
    const journalsBefore = await w.journals();
    const chosen = everything(await w.get());
    const k = key("invoice");
    const { invoice, project } = await w.invoice(chosen, k);
    expect([invoice.status, invoice.contactName, invoice.invoiceDate, invoice.dueDate, invoice.reference]).toEqual([
      "draft",
      "Harbour Cafe",
      "2026-07-10",
      "2026-08-20",
      "Cafe rebrand",
    ]);
    expect(invoice.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.accountCode, l.taxCode, l.lineAmount, l.taxAmount])).toEqual([
      ["Design (3 h 45 min)", "3.75", "90", "4000", "GST", "337.50", "50.63"],
      ["Photography", "1", "600", "4000", "GST", "600.00", "90.00"],
      ["Printing of menus", "1", "220", "4000", "GST", "220.00", "33.00"],
      ["Props", "1", "40", "4000", "GST", "40.00", "6.00"],
    ]);
    expect([invoice.subtotal, invoice.taxTotal, invoice.total]).toEqual(["1197.50", "179.63", "1377.13"]);
    expect(await w.journals()).toBe(journalsBefore);
    expect(project.figures.unbilled).toBe("0.00");
    expect(project.timeEntries.find((e) => e.id === s.t1.id)!.billedOn).toEqual({ invoiceId: invoice.id, invoiceNumber: null, invoiceStatus: "draft" });
    // Retry: the same invoice; the same key for other items: refused.
    const again = await w.invoice(chosen, k);
    expect([again.created, again.invoice.id]).toEqual([false, invoice.id]);
    await expect(w.invoice({ ...chosen, expenseIds: [] }, k)).rejects.toThrow("idempotency key");
    // The same items again are refused, by the app and by the database.
    await expect(w.invoice({ timeEntryIds: [s.t1.id] })).rejects.toThrow("already on draft invoice");
    await expect(w.invoice({ taskIds: [w.photo] })).rejects.toThrow("already on draft invoice");
    await expect(w.invoice({ expenseIds: [s.x3] })).rejects.toThrow("already on draft invoice");
    const projectInvoice = (await w.as((tx) => tx.query<{ id: string }>("select id::text from project_invoices where invoice_id = $1", [invoice.id]))).rows[0].id;
    await expect(
      w.as((tx) =>
        tx.query("insert into project_invoice_items (project_invoice_id, project_id, kind, time_entry_id, line_order) values ($1, $2, 'time', $3, 9)", [
          projectInvoice,
          w.project.id,
          s.t1.id,
        ]),
      ),
    ).rejects.toThrow("already on an invoice");
    // Nothing chosen, non-chargeable time and a fixed task's time are refused.
    await expect(w.invoice({})).rejects.toThrow("Choose the time");
    await expect(w.invoice({ timeEntryIds: [s.t3.id] })).rejects.toThrow("non-chargeable");
    await expect(w.invoice({ timeEntryIds: [s.t4.id] })).rejects.toThrow("fixed price task");
    await expect(w.invoice({ expenseIds: [s.x2] })).rejects.toThrow("isn't chargeable");
    // Approving posts it like any invoice.
    const approved = (await w.as((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }))).invoice;
    const journal = await w.as((tx) => getJournal(tx, approved.approvalJournalId!));
    expect(journal.lines.map((l) => [l.accountCode, l.debitAmount, l.creditAmount])).toEqual([
      ["1100", "1377.13", "0.00"],
      ["4000", "0.00", "1197.50"],
      ["2100", "0.00", "179.63"],
    ]);
  });

  it("PJ7: durations that aren't exact hours are invoiced as 1 at the amount", async () => {
    const w = await setup();
    const ten = await w.time("jess", w.design, "2026-07-01", "0", "10");
    const { invoice } = await w.invoice({ timeEntryIds: [ten.id] });
    expect(invoice.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.lineAmount])).toEqual([["Design (10 min)", "1", "15", "15.00"]]);
    const twelve = await w.time("jess", w.design, "2026-07-02", "0", "12");
    const second = (await w.invoice({ timeEntryIds: [twelve.id] })).invoice;
    expect(second.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.lineAmount])).toEqual([["Design (12 min)", "0.2", "90", "18.00"]]);
  });

  it("PJ8: deleting or voiding the invoice makes its items unbilled again; billed items can't change", async () => {
    const w = await setup();
    const s = await scenario(w);
    const first = (await w.invoice(everything(await w.get()))).invoice;
    // Billed items can't change or be removed (the database refuses too).
    await expect(w.as((tx) => updateTimeEntry(tx, "owner", s.t1.id, { description: "Changed" }))).rejects.toThrow("on draft invoice");
    await expect(w.as((tx) => removeTimeEntry(tx, "owner", s.t1.id))).rejects.toThrow("on draft invoice");
    await expect(w.asAroha((tx) => updateProjectExpense(tx, s.x1, { markupPercent: "20" }))).rejects.toThrow("on draft invoice");
    await expect(w.asAroha((tx) => removeProjectExpense(tx, s.x1))).rejects.toThrow("on draft invoice");
    await expect(w.as((tx) => tx.query("update project_time_entries set minutes = 1 where id = $1", [s.t1.id]))).rejects.toThrow("is on an invoice");
    await expect(w.as((tx) => tx.query("update project_expenses set markup_percent = 20 where id = $1", [s.x1]))).rejects.toThrow("is on an invoice");
    await expect(w.as((tx) => tx.query("delete from project_invoices"))).rejects.toThrow("goes only when");
    await expect(w.asAroha((tx) => updateTask(tx, w.photo, { rate: "700" }))).rejects.toThrow("has been invoiced");
    await expect(w.asAroha((tx) => updateTask(tx, w.design, { chargeType: "fixed", rate: "500" }))).rejects.toThrow("has been invoiced");
    // An hourly rate can still change: what's invoiced keeps its amount.
    await w.asAroha((tx) => updateTask(tx, w.design, { rate: "95" }));
    await w.asAroha((tx) => updateTask(tx, w.design, { rate: "90" }));
    // Deleting the draft puts everything back.
    await w.as((tx) => deleteInvoice(tx, first.id));
    expect((await w.get()).figures.unbilled).toBe("1197.50");
    // Invoiced again, approved and voided: unbilled again, and invoiceable a third time.
    const second = (await w.invoice(everything(await w.get()))).invoice;
    await w.as((tx) => approveInvoice(tx, second.id, { idempotencyKey: key("approve") }));
    expect((await w.get()).figures.invoiced).toBe("1197.50");
    await w.as((tx) => voidInvoice(tx, second.id, { idempotencyKey: key("void"), voidDate: "2026-07-15" }));
    const afterVoid = await w.get();
    expect([afterVoid.figures.unbilled, afterVoid.figures.invoiced]).toEqual(["1197.50", "0.00"]);
    // After the void they can change again.
    const changed = await w.as((tx) => updateTimeEntry(tx, "owner", s.t1.id, { description: "Logo concepts (final)" }));
    expect(changed.description).toBe("Logo concepts (final)");
    const third = (await w.invoice(everything(await w.get()))).invoice;
    expect(third.subtotal).toBe("1197.50");
    expect((await w.as((tx) => getInvoice(tx, second.id))).status).toBe("voided");
  });

  it("PJ9: profitability is invoiced less time at cost and expenses at cost, with unbilled and the estimate", async () => {
    const w = await setup();
    await scenario(w);
    let f = (await w.get()).figures;
    expect([f.invoiced, f.timeCost, f.expenseCost, f.costs, f.profit, f.unbilled, f.minutes]).toEqual(["0.00", "287.50", "300.00", "587.50", "-587.50", "1197.50", 510]);
    const { invoice } = await w.invoice(everything(await w.get()));
    f = (await w.get()).figures;
    expect([f.invoiced, f.onDraftInvoices, f.unbilled]).toEqual(["0.00", "1197.50", "0.00"]);
    await w.as((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }));
    const project = await w.get();
    f = project.figures;
    expect([f.invoiced, f.onDraftInvoices, f.costs, f.profit, f.unbilled, f.toDate, f.estimateLeft]).toEqual([
      "1197.50",
      "0.00",
      "587.50",
      "610.00",
      "0.00",
      "1197.50",
      "802.50",
    ]);
    const design = project.tasks.find((t) => t.id === w.design)!;
    expect([design.estimateMinutes, design.minutes]).toEqual([600, 225]);
    const report = await w.as((tx) => projectProfitability(tx));
    expect(report.projects.map((p) => [p.name, p.figures.invoiced, p.figures.costs, p.figures.profit])).toEqual([["Cafe rebrand", "1197.50", "587.50", "610.00"]]);
    expect([report.totals.invoiced, report.totals.profit, report.totals.minutes]).toEqual(["1197.50", "610.00", 510]);
  });

  it("PJ10: closing needs nothing unbilled (or a write-off); a closed project doesn't change", async () => {
    const w = await setup();
    const s = await scenario(w);
    await expect(w.asAroha((tx) => closeProject(tx, w.project.id))).rejects.toThrow("1197.50 unbilled");
    const { invoice } = await w.invoice(everything(await w.get()));
    await expect(w.asAroha((tx) => closeProject(tx, w.project.id))).rejects.toThrow("draft invoice");
    await expect(w.as((tx) => tx.query("update projects set status = 'closed', closed_at = now() where id = $1", [w.project.id]))).rejects.toThrow(
      "still a draft",
    );
    await w.as((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }));
    const closed = await w.asAroha((tx) => closeProject(tx, w.project.id));
    expect([closed.status, closed.closedByEmail]).toEqual(["closed", aroha.email]);
    // A closed project refuses new tasks, time, expenses and invoicing, and its invoice can't be voided.
    await expect(w.asAroha((tx) => createTask(tx, w.project.id, { idempotencyKey: key("t"), name: "More", chargeType: "non_chargeable" }))).rejects.toThrow("is closed");
    await expect(w.time("aroha", w.design, "2026-07-20", "1", "0")).rejects.toThrow("is closed");
    await expect(w.invoice({ timeEntryIds: [s.t1.id] })).rejects.toThrow("is closed");
    await expect(w.link(s.lines.fuel.lineId, "expense_claim_receipt", false)).rejects.toThrow("is closed");
    await expect(
      w.as((tx) =>
        tx.query(
          `insert into project_time_entries (command_source, idempotency_key, request_hash, project_id, task_id, user_id, user_email, entry_date, minutes)
           values ('api', 'closed-key-1', 'h', $1, $2, $3, 'x@example.com', '2026-07-20', 5)`,
          [w.project.id, w.design, aroha.id],
        ),
      ),
    ).rejects.toThrow("is closed");
    await expect(w.as((tx) => voidInvoice(tx, invoice.id, { idempotencyKey: key("void"), voidDate: "2026-07-20" }))).rejects.toThrow("which is closed");
    // Reopened: 30 minutes more Design, then closing with write-off.
    await w.asAroha((tx) => reopenProject(tx, w.project.id));
    const extra = await w.time("aroha", w.design, "2026-07-21", "0", "30");
    await expect(w.asAroha((tx) => closeProject(tx, w.project.id))).rejects.toThrow("45.00 unbilled");
    const writtenOff = await w.asAroha((tx) => closeProject(tx, w.project.id, { writeOff: true }));
    expect([writtenOff.status, writtenOff.figures.unbilled, writtenOff.figures.writtenOff, writtenOff.figures.timeCost]).toEqual(["closed", "0.00", "45.00", "302.50"]);
    expect(writtenOff.timeEntries.find((e) => e.id === extra.id)!.writtenOffAt).not.toBeNull();
    await w.asAroha((tx) => reopenProject(tx, w.project.id));
    const reopened = await w.get();
    expect([reopened.status, reopened.figures.writtenOff]).toEqual(["in_progress", "45.00"]);
    await expect(w.invoice({ timeEntryIds: [extra.id] })).rejects.toThrow("written off");
    await expect(w.as((tx) => tx.query("update project_time_entries set written_off_at = null where id = $1", [extra.id]))).rejects.toThrow("written off");
    // Now the invoice can be voided (the project is open again).
    await w.as((tx) => voidInvoice(tx, invoice.id, { idempotencyKey: key("void"), voidDate: "2026-07-20" }));
    expect((await w.get()).figures.unbilled).toBe("1197.50");
  });

  it("PJ11: the time report totals by person, project and task for a date range", async () => {
    const w = await setup();
    const s = await scenario(w);
    const removed = await w.time("sam", w.admin, "2026-07-02", "3", "0");
    await w.asSam((tx) => removeTimeEntry(tx, "bookkeeper", removed.id));
    const july = await w.as((tx) => timeReport(tx, { from: "2026-07-01", to: "2026-07-31" }));
    expect(july.byPerson.map((g) => [g.label, g.minutes, g.cost])).toEqual([
      ["Aroha Ngata", 315, "157.50"],
      ["Jess Kelly", 195, "130.00"],
    ]);
    expect(july.byTask.map((g) => [g.label, g.minutes])).toEqual([
      ["Cafe rebrand › Admin", 45],
      ["Cafe rebrand › Design", 225],
      ["Cafe rebrand › Photography", 240],
    ]);
    expect([july.totalMinutes, july.totalCost, july.byProject.map((g) => [g.label, g.minutes])]).toEqual([510, "287.50", [["Cafe rebrand", 510]]]);
    expect(july.entries.map((e) => e.id)).toEqual([s.t1.id, s.t2.id, s.t3.id, s.t4.id]);
    expect((await w.as((tx) => timeReport(tx, { from: "2026-07-01", to: "2026-07-02" }))).totalMinutes).toBe(225);
    expect((await w.as((tx) => timeReport(tx, { from: "2026-07-01", to: "2026-07-31", userId: aroha.id }))).totalMinutes).toBe(315);
    expect((await w.as((tx) => timeReport(tx, { from: "2026-07-01", to: "2026-07-31", taskId: w.design }))).totalMinutes).toBe(225);
    await expect(w.as((tx) => timeReport(tx, { from: "2026-07-31", to: "2026-07-01" }))).rejects.toThrow("can't be before");
  });

  it("PJ12: viewers read projects and reports but change nothing; only documents post journals", async () => {
    const w = await setup();
    await scenario(w);
    const viewerCookie = await sessionCookieFor(viewer);
    const arohaCookie = await sessionCookieFor(aroha);
    const body = { organisationId: w.org, idempotencyKey: key("http"), name: "Menu board", contactId: w.harbour.id };
    expect((await projectsRoute.POST(apiRequest("/api/projects", { method: "POST", cookie: viewerCookie, body }), noContext)).status).toBe(403);
    const created = await projectsRoute.POST(apiRequest("/api/projects", { method: "POST", cookie: arohaCookie, body }), noContext);
    expect(created.status).toBe(201);
    const { project: made } = (await created.json()) as { project: Project };
    expect(made.createdByEmail).toBe(aroha.email);
    const listed = await projectsRoute.GET(apiRequest(`/api/projects?organisationId=${w.org}`, { cookie: viewerCookie }), noContext);
    expect(((await listed.json()) as { projects: unknown[] }).projects).toHaveLength(2);
    const opened = await projectRoute.GET(apiRequest(`/api/projects/${w.project.id}?organisationId=${w.org}`, { cookie: viewerCookie }), {
      params: Promise.resolve({ projectId: w.project.id }),
    });
    expect(opened.status).toBe(200);
    const edit = await projectRoute.PUT(apiRequest(`/api/projects/${w.project.id}`, { method: "PUT", cookie: viewerCookie, body: { organisationId: w.org, name: "x" } }), {
      params: Promise.resolve({ projectId: w.project.id }),
    });
    expect(edit.status).toBe(403);
    const report = await profitabilityRoute.GET(apiRequest(`/api/reports/project-profitability?organisationId=${w.org}`, { cookie: viewerCookie }), noContext);
    expect(report.status).toBe(200);
    const time = await timeReportRoute.GET(apiRequest(`/api/reports/project-time?organisationId=${w.org}&from=2026-07-01&to=2026-07-31`, { cookie: viewerCookie }), noContext);
    expect(((await time.json()) as { report: { totalMinutes: number } }).report.totalMinutes).toBe(510);
    const rates = await staffRatesRoute.PUT(
      apiRequest("/api/project-staff-rates", { method: "PUT", cookie: arohaCookie, body: { organisationId: w.org, userId: aroha.id, costRate: "99" } }),
      noContext,
    );
    expect(rates.status).toBe(403);
    // The only journals: the bill, the claim and the spend money (and an approved invoice).
    const origins = async () => (await w.as((tx) => tx.query<{ origin: string }>("select origin from ledger_journals order by id"))).rows.map((row) => row.origin);
    expect(await origins()).toEqual(["bill", "expense_claim", "bank_transaction"]);
    const { invoice } = await w.invoice(everything(await w.get()));
    expect(await origins()).toEqual(["bill", "expense_claim", "bank_transaction"]);
    await w.as((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }));
    expect(await origins()).toEqual(["bill", "expense_claim", "bank_transaction", "invoice"]);
    const events = (await w.as((tx) => tx.query<{ event_type: string }>("select event_type from audit_events where entity_type = 'project' and entity_id = $1 order by id", [w.project.id])))
      .rows.map((row) => row.event_type);
    expect(events).toContain("project.created");
    expect(events).toContain("project.invoiced");
  });
});
