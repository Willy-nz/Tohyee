import { afterAll, beforeAll, expect, it } from "vitest";
import * as runRoute from "@/app/api/repeating-invoices/[repeatingInvoiceId]/run/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { archiveContact, createContact } from "@/lib/contacts/service";
import { setCreditLimitAction } from "@/lib/customers/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { deleteInvoice, getInvoice, listInvoices } from "@/lib/invoices/service";
import { getJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import {
  createRepeatingInvoice,
  getRepeatingInvoice,
  repeatingForInvoice,
  runRepeatingInvoices,
  setRepeatingStatus,
  updateRepeatingInvoice,
} from "@/lib/repeating/service";
import { runOrganisationRepeatingInvoices } from "@/lib/repeating/scheduler";
import { getOrganisation } from "@/lib/organisations/registry";
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

/** Examples RI1-RI10 in docs/ACCOUNTING-EXAMPLES.md ("Repeating invoices"). Each test gets its own organisation. */
describeWithDatabase("repeating invoices", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("repeating-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("repeating-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `repeat-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const job = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: null, email: "repeating-invoices@tohyee" }, work);
    const kobe = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Cafe", isCustomer: true }))).contact;
    const template = async (extra: Record<string, unknown> = {}) =>
      (
        await as((tx) =>
          createRepeatingInvoice(tx, {
            idempotencyKey: key("ri"),
            contactId: kobe.id,
            amountsMode: "exclusive",
            lines: [{ description: "Monthly retainer", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "GST" }],
            period: "month",
            every: 1,
            startDate: "2026-01-31",
            dueRule: "days_after",
            dueDays: 20,
            saveAs: "draft",
            ...extra,
          }),
        )
      ).repeatingInvoice;
    const run = (today: string, id?: string) => job((tx) => runRepeatingInvoices(tx, { today, repeatingInvoiceId: id }));
    const invoices = async () =>
      (await as((tx) => listInvoices(tx, {}))).invoices
        .map((i) => [i.invoiceDate, i.dueDate, i.status, i.invoiceNumber, i.total])
        .reverse();
    return { org, as, kobe, template, run, invoices };
  }

  it("RI1 and RI2: saved as drafts, a run makes each missed month in order", async () => {
    const w = await setup();
    const template = await w.template();
    expect([template.status, template.nextDate, template.runs]).toEqual(["active", "2026-01-31", []]);
    expect((await w.as((tx) => tx.query("select 1 from sales_invoices"))).rowCount).toBe(0);
    const result = await w.run("2026-03-05");
    expect(result).toEqual({ made: 2, approved: 0, refused: 0, failed: 0 });
    expect(await w.invoices()).toEqual([
      ["2026-01-31", "2026-02-20", "draft", null, "115.00"],
      ["2026-02-28", "2026-03-20", "draft", null, "115.00"],
    ]);
    const after = await w.as((tx) => getRepeatingInvoice(tx, template.id));
    expect(after.runs.map((r) => [r.scheduledDate, r.outcome])).toEqual([["2026-02-28", "draft"], ["2026-01-31", "draft"]]);
    expect(after.nextDate).toBe("2026-03-31");
    expect(await w.as((tx) => repeatingForInvoice(tx, after.runs[1].invoiceId!))).toEqual({ id: template.id, scheduledDate: "2026-01-31" });
    expect((await w.as((tx) => tx.query("select 1 from ledger_journals"))).rowCount).toBe(0);
  });

  it("RI3: running twice never makes two, and a later run makes just the new date", async () => {
    const w = await setup();
    await w.template();
    await w.run("2026-03-05");
    expect((await w.run("2026-03-05")).made).toBe(0);
    // Two runs at once: the template lock makes them take turns.
    const both = await Promise.all([w.run("2026-03-31"), w.run("2026-03-31")]);
    expect(both.map((r) => r.made).sort()).toEqual([0, 1]);
    expect((await w.invoices()).map((i) => i[0])).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("RI3: the hourly job runs each template on its own, once per date", async () => {
    const w = await setup();
    const good = await w.template();
    const paws = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Paw Walkers", isCustomer: true }))).contact;
    const stuck = await w.template({ contactId: paws.id });
    await w.as((tx) => archiveContact(tx, paws.id));
    const organisation = (await getOrganisation(w.org))!;
    // The archived customer's template fails; the other still makes its invoices.
    expect(await runOrganisationRepeatingInvoices(organisation, "2026-03-05")).toEqual({ made: 2, failed: 1 });
    expect(await runOrganisationRepeatingInvoices(organisation, "2026-03-05")).toEqual({ made: 0, failed: 1 });
    expect((await w.as((tx) => getRepeatingInvoice(tx, good.id))).runs.map((r) => r.scheduledDate)).toEqual(["2026-02-28", "2026-01-31"]);
    expect((await w.as((tx) => getRepeatingInvoice(tx, stuck.id))).lastError).toMatch(/^2026-01-31: Paw Walkers is archived/);
    expect((await w.invoices()).map((i) => i[0])).toEqual(["2026-01-31", "2026-02-28"]);
  });

  it("RI4: approve automatically posts each invoice on its own date", async () => {
    const w = await setup();
    await w.template({ saveAs: "approve" });
    expect(await w.run("2026-03-05")).toEqual({ made: 2, approved: 2, refused: 0, failed: 0 });
    expect(await w.invoices()).toEqual([
      ["2026-01-31", "2026-02-20", "approved", "INV-0001", "115.00"],
      ["2026-02-28", "2026-03-20", "approved", "INV-0002", "115.00"],
    ]);
    const second = (await w.as((tx) => listInvoices(tx, {}))).invoices[0];
    const journal = await w.as((tx) => getJournal(tx, second.approvalJournalId!));
    expect([journal.postingDate, ...journal.lines.map((l) => [l.accountCode, l.debitAmount, l.creditAmount])]).toEqual([
      "2026-02-28",
      ["1100", "115.00", "0.00"],
      ["4000", "0.00", "100.00"],
      ["2100", "0.00", "15.00"],
    ]);
  });

  it("RI5: every 2 weeks until the end date, then the template ends itself", async () => {
    const w = await setup();
    const template = await w.template({ period: "week", every: 2, startDate: "2026-01-05", endDate: "2026-02-02" });
    expect((await w.run("2026-02-10")).made).toBe(3);
    expect((await w.invoices()).map((i) => i[0])).toEqual(["2026-01-05", "2026-01-19", "2026-02-02"]);
    const after = await w.as((tx) => getRepeatingInvoice(tx, template.id));
    expect([after.status, after.nextDate]).toEqual(["ended", null]);
  });

  it("RI6: quarterly from the 31st keeps to each month's last day", async () => {
    const w = await setup();
    await w.template({ every: 3, startDate: "2026-08-31" });
    await w.run("2027-05-31");
    expect((await w.invoices()).map((i) => i[0])).toEqual(["2026-08-31", "2026-11-30", "2027-02-28", "2027-05-31"]);
  });

  it("RI7: pausing stops the job, resuming skips the paused dates, ending is final", async () => {
    const w = await setup();
    const template = await w.template();
    await w.run("2026-03-05");
    await w.as((tx) => setRepeatingStatus(tx, template.id, "paused", "2026-03-05"));
    expect((await w.run("2026-05-05")).made).toBe(0);
    const resumed = await w.as((tx) => setRepeatingStatus(tx, template.id, "active", "2026-05-10"));
    expect(resumed.nextDate).toBe("2026-05-31");
    await w.run("2026-06-01");
    expect((await w.invoices()).map((i) => i[0])).toEqual(["2026-01-31", "2026-02-28", "2026-05-31"]);
    await w.as((tx) => setRepeatingStatus(tx, template.id, "ended"));
    expect((await w.run("2026-08-01")).made).toBe(0);
    await expect(w.as((tx) => setRepeatingStatus(tx, template.id, "active"))).rejects.toThrow("has ended");
    await expect(w.as((tx) => updateRepeatingInvoice(tx, template.id, { reference: "x" }))).rejects.toThrow("has ended");
    await expect(w.as((tx) => tx.query("delete from repeating_invoices where id = $1", [template.id]))).rejects.toThrow("can't be deleted");
  });

  it("RI8: changing the template changes later invoices only", async () => {
    const w = await setup();
    const template = await w.template();
    await w.run("2026-03-05");
    await w.as((tx) =>
      updateRepeatingInvoice(
        tx,
        template.id,
        { lines: [{ description: "Monthly retainer", quantity: "1", unitPrice: "120.00", accountCode: "4000", taxCode: "GST" }] },
        "2026-03-05",
      ),
    );
    await w.run("2026-03-31");
    expect((await w.invoices()).map((i) => [i[0], i[4]])).toEqual([
      ["2026-01-31", "115.00"],
      ["2026-02-28", "115.00"],
      ["2026-03-31", "138.00"],
    ]);
  });

  it("RI9: a refused approval leaves a draft and says why; a customer that can't be invoiced stops the run", async () => {
    const w = await setup();
    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-01-31" }));
    const locked = await w.template({ saveAs: "approve" });
    expect(await w.run("2026-03-05")).toEqual({ made: 2, approved: 1, refused: 1, failed: 0 });
    expect(await w.invoices()).toEqual([
      ["2026-01-31", "2026-02-20", "draft", null, "115.00"],
      ["2026-02-28", "2026-03-20", "approved", "INV-0001", "115.00"],
    ]);
    const history = (await w.as((tx) => getRepeatingInvoice(tx, locked.id))).runs;
    expect(history[1].outcome).toBe("approval_refused");
    expect(history[1].message).toMatch(/^Left as a draft: 2026-01-31 is in a locked period/);

    const v = await setup();
    await v.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    await v.as((tx) => setCreditLimitAction(tx, "block"));
    await v.as((tx) => tx.query("update contacts set credit_limit = 150 where id = $1", [v.kobe.id]));
    const limited = await v.template({ saveAs: "approve" });
    expect(await v.run("2026-03-05")).toEqual({ made: 2, approved: 1, refused: 1, failed: 0 });
    const runs = (await v.as((tx) => getRepeatingInvoice(tx, limited.id))).runs;
    expect(runs.map((r) => r.outcome)).toEqual(["approval_refused", "approved"]);
    expect(runs[0].message).toContain("over their credit limit of 150.00");

    const u = await setup();
    const stopped = await u.template();
    await u.as((tx) => archiveContact(tx, u.kobe.id));
    expect(await u.run("2026-03-05")).toEqual({ made: 0, approved: 0, refused: 0, failed: 1 });
    const failed = await u.as((tx) => getRepeatingInvoice(tx, stopped.id));
    expect(failed.lastError).toMatch(/^2026-01-31: Kobe Cafe is archived/);
    expect(failed.nextDate).toBe("2026-01-31");
  });

  it("RI10: a deleted draft stays in the history and isn't made again", async () => {
    const w = await setup();
    const template = await w.template();
    await w.run("2026-02-01");
    const [run] = (await w.as((tx) => getRepeatingInvoice(tx, template.id))).runs;
    await w.as((tx) => deleteInvoice(tx, run.invoiceId!));
    await expect(w.as((tx) => getInvoice(tx, run.invoiceId!))).rejects.toThrow("Invoice not found");
    const after = await w.as((tx) => getRepeatingInvoice(tx, template.id));
    expect(after.runs.map((r) => [r.scheduledDate, r.invoiceId, r.invoiceDeleted])).toEqual([["2026-01-31", null, true]]);
    expect((await w.run("2026-02-01")).made).toBe(0);
    // A viewer can't run it.
    const cookie = await sessionCookieFor(viewer);
    const response = await runRoute.POST(
      apiRequest(`/api/repeating-invoices/${template.id}/run`, { method: "POST", cookie, body: { organisationId: w.org } }),
      params({ repeatingInvoiceId: template.id }),
    );
    expect(response.status).toBe(403);
  });
});
