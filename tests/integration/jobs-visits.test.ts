import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, getInvoice } from "@/lib/invoices/service";
import { createItem } from "@/lib/items/service";
import { getJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import {
  addMaterial,
  confirmVisitHours,
  finishVisit,
  listJobs,
  listMaterials,
  listVisits,
  removeMaterial,
  rescheduleVisit,
  scheduleVisit,
  serviceReminders,
  setJobDetails,
  signVisit,
  startVisit,
  tickVisitCheck,
  visitsToIcs,
} from "@/lib/projects/jobs";
import { closeProject, createProject, createTask, getProject, invoiceProject, setStaffRate } from "@/lib/projects/service";
import { addAttachment, getRecordExtras } from "@/lib/records/extras";
import { inventoryValuation } from "@/lib/reports/financial";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const PNG = (() => {
  const bytes = new Uint8Array(200).fill(0x41);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
})();

/** Examples JV1-JV9 in docs/ACCOUNTING-EXAMPLES.md ("Jobs and visits inside Projects"). Each test gets its own organisation. */
describeWithDatabase("jobs and visits", () => {
  let server: TestServer;
  let jess: SessionUser;
  let will: SessionUser;
  let sam: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    jess = await createTestUser("jv-jess@example.com", { serverAdmin: true, displayName: "Jess Kelly" });
    will = await createTestUser("jv-will@example.com", { displayName: "Will" });
    sam = await createTestUser("jv-sam@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `jv-${organisations}-co`;
    await createTestOrganisation(jess, org);
    for (const user of [will, sam]) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [org, user.id]);
    }
    const asUser = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
    const as = asUser(jess);
    const asWill = asUser(will);
    const asSam = asUser(sam);
    await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const kobe = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Cafe", isCustomer: true }))).contact;
    const paw = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Paw Supplies", isSupplier: true }))).contact;
    await as((tx) => setStaffRate(tx, "owner", { userId: will.id, costRate: "40.00" }));
    const hinge = (
      await as((tx) =>
        createItem(tx, {
          idempotencyKey: key("item"),
          code: "HINGE",
          name: "Cabinet hinge",
          itemType: "stock",
          salePrice: "12.00",
          purchasePrice: "6.00",
          incomeAccountCode: "4000",
          purchaseAccountCode: "1400",
          salesTaxCode: "GST",
          purchaseTaxCode: "GST",
        }),
      )
    ).item;
    // Ten hinges in stock at 6.00, so their average cost is 6.00.
    const bill = await as((tx) =>
      createBill(tx, {
        idempotencyKey: key("bill"),
        contactId: paw.id,
        billDate: "2026-10-01",
        dueDate: "2026-10-20",
        supplierInvoiceNumber: "PS-1",
        amountsMode: "exclusive",
        lines: [{ itemId: hinge.id, quantity: "10", unitPrice: "6.00" }],
      }),
    );
    await as((tx) => approveBill(tx, bill.bill.id, { idempotencyKey: key("a") }));
    const { project } = await as((tx) => createProject(tx, { idempotencyKey: key("p"), name: "Install display cabinet", contactId: kobe.id }));
    const labour = (await as((tx) => createTask(tx, project.id, { idempotencyKey: key("t"), name: "Labour", chargeType: "hourly", rate: "90.00" }))).taskId;
    const journals = async () => Number((await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);
    const makeJob = () =>
      as((tx) =>
        setJobDetails(tx, project.id, {
          isJob: true,
          siteAddress: "12 Princes Street, Dunedin",
          siteContact: "Mere (manager)",
          serviceIntervalMonths: 12,
          checklistItems: ["Measure", "Fit", "Clean up", "Customer walkthrough"],
        }),
      );
    const visit = async (startsAt: string, endsAt: string, userId = will.id) =>
      (await as((tx) => scheduleVisit(tx, { idempotencyKey: key("v"), projectId: project.id, taskId: labour, userId, startsAt, endsAt }))).visit;
    const stock = async () =>
      Object.fromEntries((await as((tx) => inventoryValuation(tx))).items.map((row) => [row.itemCode, [row.quantity, row.value]]));
    return { org, as, asWill, asSam, kobe, hinge, project, labour, journals, makeJob, visit, stock };
  }

  it("JV1: a job has a site and shows on the jobs list with its next visit; nothing is posted", async () => {
    const w = await setup();
    const before = await w.journals();
    expect(await w.as((tx) => listJobs(tx))).toEqual([]);
    await expect(w.as((tx) => setJobDetails(tx, w.project.id, { isJob: true }))).rejects.toThrow("A job needs its site address.");
    const job = await w.makeJob();
    expect(job).toMatchObject({ isJob: true, siteAddress: "12 Princes Street, Dunedin", siteContact: "Mere (manager)", serviceIntervalMonths: 12 });
    // Another project that isn't a job stays off the list.
    await w.as((tx) => createProject(tx, { idempotencyKey: key("p"), name: "Not a job", contactId: w.kobe.id }));
    await w.visit("2026-10-13T09:00:00+13:00", "2026-10-13T11:30:00+13:00");
    const jobs = await w.as((tx) => listJobs(tx));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ name: "Install display cabinet", contactName: "Kobe Cafe", siteAddress: "12 Princes Street, Dunedin" });
    expect(new Date(jobs[0].nextVisit!).toISOString()).toBe("2026-10-12T20:00:00.000Z");
    expect(await w.journals()).toBe(before);
  });

  it("JV2: a visit is on the calendar; two overlapping visits for one person are allowed and flagged", async () => {
    const w = await setup();
    const before = await w.journals();
    await expect(w.visit("2026-10-13T09:00:00+13:00", "2026-10-13T11:30:00+13:00")).rejects.toThrow("isn't a job");
    await w.makeJob();
    const first = await w.visit("2026-10-13T09:00:00+13:00", "2026-10-13T11:30:00+13:00");
    expect(first.clash).toBeNull();
    await w.visit("2026-10-13T10:00:00+13:00", "2026-10-13T12:00:00+13:00");
    const day = await w.as((tx) => listVisits(tx, { from: "2026-10-13", to: "2026-10-13" }));
    expect(day).toHaveLength(2);
    expect(day[0].clash).toBe("Will is booked twice 10:00-11:30");
    expect(day[1].clash).toBe("Will is booked twice 10:00-11:30");
    // By staff member: Sam has none; the day before has none.
    expect(await w.as((tx) => listVisits(tx, { from: "2026-10-13", to: "2026-10-13", userId: sam.id }))).toEqual([]);
    expect(await w.as((tx) => listVisits(tx, { from: "2026-10-12", to: "2026-10-12" }))).toEqual([]);
    // Moving the second one to Sam clears the flag.
    await w.as((tx) => rescheduleVisit(tx, day[1].id, { userId: sam.id }));
    expect((await w.as((tx) => listVisits(tx, { from: "2026-10-13", to: "2026-10-13" }))).map((visit) => visit.clash)).toEqual([null, null]);
    // Only Tohyee users can be on the calendar (Jess, 12 Oct 2026).
    await expect(w.visit("2026-10-14T09:00:00+13:00", "2026-10-14T10:00:00+13:00", "00000000-0000-0000-0000-000000000000")).rejects.toThrow("must be a member");
    expect(await w.journals()).toBe(before);
  });

  it("JV3: Start and Finish fill in 2 h 16 m, which Will confirms into project time: cost 90.67, charge 204.00", async () => {
    const w = await setup();
    await w.makeJob();
    const visit = await w.visit("2026-10-13T09:00:00+13:00", "2026-10-13T11:30:00+13:00");
    // Someone else's visit can't be worked by another bookkeeper.
    await expect(w.asSam((tx) => startVisit(tx, "bookkeeper", visit.id, { at: "2026-10-13T09:04:00+13:00" }))).rejects.toThrow("jv-will@example.com's");
    await w.asWill((tx) => startVisit(tx, "bookkeeper", visit.id, { at: "2026-10-13T09:04:00+13:00" }));
    await expect(w.asWill((tx) => confirmVisitHours(tx, "bookkeeper", visit.id, { idempotencyKey: key("h") }))).rejects.toThrow("Finish the visit");
    const finished = await w.asWill((tx) => finishVisit(tx, "bookkeeper", visit.id, { at: "2026-10-13T11:20:00+13:00", finishAnyway: true }));
    expect(finished.workedMinutes).toBe(136);
    // Nothing counts until Will confirms.
    expect((await w.as((tx) => getProject(tx, w.project.id))).timeEntries).toEqual([]);
    const { visit: confirmed } = await w.asWill((tx) => confirmVisitHours(tx, "bookkeeper", visit.id, { idempotencyKey: key("h") }));
    const project = await w.as((tx) => getProject(tx, w.project.id));
    expect(project.timeEntries).toHaveLength(1);
    expect(project.timeEntries[0]).toMatchObject({ id: confirmed.timeEntryId, userEmail: "jv-will@example.com", entryDate: "2026-10-13", minutes: 136, taskName: "Labour", cost: "90.67" });
    expect(project.tasks.find((task) => task.id === w.labour)!.unbilledAmount).toBe("204.00");
    // Confirming again changes nothing.
    await w.asWill((tx) => confirmVisitHours(tx, "bookkeeper", visit.id, { idempotencyKey: key("h") }));
    expect((await w.as((tx) => getProject(tx, w.project.id))).timeEntries).toHaveLength(1);
  });

  it("JV4: materials are priced from the item; stock doesn't move until the job is invoiced", async () => {
    const w = await setup();
    await w.makeJob();
    const visit = await w.visit("2026-10-13T09:00:00+13:00", "2026-10-13T11:30:00+13:00");
    const before = await w.journals();
    const materials = await w.asWill((tx) => addMaterial(tx, w.project.id, { itemId: w.hinge.id, quantity: "4", visitId: visit.id }));
    expect(materials).toHaveLength(1);
    expect(materials[0]).toMatchObject({ itemName: "Cabinet hinge", quantity: "4", unitPrice: "12.00", amount: "48.00", invoiceNumber: null });
    expect(await w.journals()).toBe(before);
    expect(await w.stock()).toEqual({ HINGE: ["10", "60.00"] });
    // Taken off before invoicing, it's just gone.
    const removed = await w.asWill((tx) => removeMaterial(tx, materials[0].id));
    expect(removed[0].status).toBe("removed");
  });

  it("JV5: each tick records who and when; finishing with unticked items asks first and records the answer", async () => {
    const w = await setup();
    await w.makeJob();
    const visit = await w.visit("2026-10-13T09:00:00+13:00", "2026-10-13T11:30:00+13:00");
    await w.asWill((tx) => startVisit(tx, "bookkeeper", visit.id, { at: "2026-10-13T09:04:00+13:00" }));
    for (const item of ["Measure", "Fit", "Clean up"]) await w.asWill((tx) => tickVisitCheck(tx, "bookkeeper", visit.id, { item, ticked: true }));
    await expect(w.asWill((tx) => tickVisitCheck(tx, "bookkeeper", visit.id, { item: "Paint", ticked: true }))).rejects.toThrow("isn't on this job's checklist");
    const ticked = await w.as((tx) => listVisits(tx, { from: "2026-10-13", to: "2026-10-13" }));
    expect(ticked[0].checks.map((check) => [check.item, check.tickedByEmail])).toEqual([
      ["Measure", "jv-will@example.com"],
      ["Fit", "jv-will@example.com"],
      ["Clean up", "jv-will@example.com"],
      ["Customer walkthrough", null],
    ]);
    await expect(w.asWill((tx) => finishVisit(tx, "bookkeeper", visit.id, { at: "2026-10-13T11:20:00+13:00" }))).rejects.toThrow(
      "Not ticked yet: Customer walkthrough. Finish anyway?",
    );
    const finished = await w.asWill((tx) => finishVisit(tx, "bookkeeper", visit.id, { at: "2026-10-13T11:20:00+13:00", finishAnyway: true }));
    expect(finished).toMatchObject({ status: "finished", finishedWithOpenChecks: true });
  });

  it("JV6: photos and the signature are kept with the visit", async () => {
    const w = await setup();
    await w.makeJob();
    const visit = await w.visit("2026-10-13T09:00:00+13:00", "2026-10-13T11:30:00+13:00");
    for (const fileName of ["before.png", "after.png", "signature.png"]) {
      await w.asWill((tx) => addAttachment(tx, "bookkeeper", "visit", visit.id, { idempotencyKey: key("f"), fileName, content: PNG }));
    }
    const signed = await w.asWill((tx) => signVisit(tx, "bookkeeper", visit.id, { signedBy: "Mere" }));
    expect(signed.signedBy).toBe("Mere");
    expect(signed.signedAt).not.toBeNull();
    const { attachments } = await w.as((tx) => getRecordExtras(tx, "owner", "visit", visit.id));
    expect(attachments.map((file) => file.fileName).sort()).toEqual(["after.png", "before.png", "signature.png"]);
  });

  it("JV7: the project invoice brings in labour and hinges: 289.80, and the hinges' cost on approval", async () => {
    const w = await setup();
    await w.makeJob();
    const visit = await w.visit("2026-10-13T09:00:00+13:00", "2026-10-13T11:30:00+13:00");
    await w.asWill((tx) => startVisit(tx, "bookkeeper", visit.id, { at: "2026-10-13T09:04:00+13:00" }));
    await w.asWill((tx) => finishVisit(tx, "bookkeeper", visit.id, { at: "2026-10-13T11:20:00+13:00", finishAnyway: true }));
    const { visit: confirmed } = await w.asWill((tx) => confirmVisitHours(tx, "bookkeeper", visit.id, { idempotencyKey: key("h") }));
    const [material] = await w.asWill((tx) => addMaterial(tx, w.project.id, { itemId: w.hinge.id, quantity: "4", visitId: visit.id }));
    // Unbilled materials stop the job closing.
    await expect(w.as((tx) => closeProject(tx, w.project.id))).rejects.toThrow("unbilled");
    const { invoice } = await w.as((tx) =>
      invoiceProject(tx, w.project.id, {
        idempotencyKey: key("inv"),
        invoiceDate: "2026-10-14",
        dueDate: "2026-10-20",
        accountCode: "4000",
        taxCode: "GST",
        timeEntryIds: [confirmed.timeEntryId],
        materialIds: [material.id],
      }),
    );
    expect(invoice.lines.map((line) => [line.description, line.quantity, line.unitPrice, line.lineAmount])).toEqual([
      ["Labour (2 h 16 min)", "1", "204", "204.00"],
      ["Cabinet hinge", "4", "12", "48.00"],
    ]);
    expect([invoice.subtotal, invoice.taxTotal, invoice.total]).toEqual(["252.00", "37.80", "289.80"]);
    expect(invoice.lines[1].itemId).toBe(w.hinge.id);
    expect((await w.asWill((tx) => listMaterials(tx, w.project.id)))[0].invoiceNumber).toBe("a draft invoice");
    await expect(w.asWill((tx) => removeMaterial(tx, material.id))).rejects.toThrow("Void or delete that invoice first.");
    await expect(
      w.as((tx) =>
        invoiceProject(tx, w.project.id, { idempotencyKey: key("inv"), invoiceDate: "2026-10-14", dueDate: "2026-10-20", accountCode: "4000", taxCode: "GST", materialIds: [material.id] }),
      ),
    ).rejects.toThrow("already on a draft invoice");
    const approved = (await w.as((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("a") }))).invoice;
    const journal = await w.as((tx) => getJournal(tx, approved.approvalJournalId!));
    expect(journal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual(
      expect.arrayContaining([
        ["5000", "24.00", "0.00"],
        ["1400", "0.00", "24.00"],
      ]),
    );
    expect(await w.stock()).toEqual({ HINGE: ["6", "36.00"] });
    expect((await w.as((tx) => getInvoice(tx, invoice.id))).total).toBe("289.80");
  });

  it("JV8: a year after the last visit a service reminder appears, until another visit is booked", async () => {
    const w = await setup();
    await w.makeJob();
    const visit = await w.visit("2026-10-13T09:00:00+13:00", "2026-10-13T11:30:00+13:00");
    await w.asWill((tx) => startVisit(tx, "bookkeeper", visit.id, { at: "2026-10-13T09:04:00+13:00" }));
    await w.asWill((tx) => finishVisit(tx, "bookkeeper", visit.id, { at: "2026-10-13T11:20:00+13:00", finishAnyway: true }));
    expect(await w.as((tx) => serviceReminders(tx, { today: "2027-10-12" }))).toEqual([]);
    const due = await w.as((tx) => serviceReminders(tx, { today: "2027-10-13" }));
    expect(due).toEqual([
      { projectId: w.project.id, projectName: "Install display cabinet", contactName: "Kobe Cafe", lastVisit: "2026-10-13", dueOn: "2027-10-13", message: "Kobe Cafe: annual service due" },
    ]);
    await w.visit("2027-10-20T09:00:00+13:00", "2027-10-20T10:00:00+13:00");
    expect(await w.as((tx) => serviceReminders(tx, { today: "2027-10-13" }))).toEqual([]);
  });

  it("JV9: visits download as a calendar file (one way)", async () => {
    const w = await setup();
    await w.makeJob();
    await w.visit("2026-10-13T09:00:00+13:00", "2026-10-13T11:30:00+13:00");
    const cancelled = await w.visit("2026-10-14T09:00:00+13:00", "2026-10-14T10:00:00+13:00");
    await w.as((tx) => rescheduleVisit(tx, cancelled.id, { cancel: true }));
    const visits = await w.as((tx) => listVisits(tx, { from: "2026-10-01", to: "2026-10-31", userId: will.id }));
    const ics = visitsToIcs(visits, w.org);
    expect(ics).toContain("BEGIN:VCALENDAR\r\n");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain("DTSTART:20261012T200000Z\r\n");
    expect(ics).toContain("DTEND:20261012T223000Z\r\n");
    expect(ics).toContain("SUMMARY:Kobe Cafe: Install display cabinet\r\n");
    expect(ics).toContain("LOCATION:12 Princes Street\\, Dunedin\r\n");
  });
});
