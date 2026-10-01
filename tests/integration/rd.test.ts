import { afterAll, beforeAll, expect, it } from "vitest";
import * as activityArchiveRoute from "@/app/api/rd/activities/[activityId]/archive/route";
import * as activityRoute from "@/app/api/rd/activities/[activityId]/route";
import * as activitiesRoute from "@/app/api/rd/activities/route";
import * as approvalsRoute from "@/app/api/rd/approvals/route";
import * as withdrawRoute from "@/app/api/rd/approvals/[approvalId]/withdraw/route";
import * as costsRoute from "@/app/api/rd/costs/route";
import * as fileRoute from "@/app/api/rd/files/[fileId]/route";
import * as replaceFileRoute from "@/app/api/rd/files/[fileId]/replace/route";
import * as filesRoute from "@/app/api/rd/files/route";
import * as linesRoute from "@/app/api/rd/lines/route";
import * as tagRoute from "@/app/api/rd/tags/[tagId]/route";
import * as tagsRoute from "@/app/api/rd/tags/route";
import * as usageRoute from "@/app/api/rd/assets/[assetId]/usage/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill, voidBill } from "@/lib/bills/service";
import { recordSupplierPayment } from "@/lib/bills/payments";
import { createContact } from "@/lib/contacts/service";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveExpenseClaim, createExpenseClaim, submitExpenseClaim } from "@/lib/expense-claims/service";
import { createFixedAsset, createFixedAssetType, listBillLinesForAssets } from "@/lib/fixed-assets/service";
import { postJournal } from "@/lib/ledger/journals";
import { addAllocation } from "@/lib/payroll/allocations";
import { createEmployee } from "@/lib/payroll/employees";
import { daysBetween } from "@/lib/rd/amounts";
import { addUsage, enterTaxDepreciation, getAssetRd, removeUsage, updateUsage } from "@/lib/rd/assets";
import { listTaggedCosts } from "@/lib/rd/costs";
import { createActivity, createApproval, getActivity, setActivityArchived, updateActivity, type RdActivityDetail } from "@/lib/rd/register";
import { createTag, getTag, listDocumentLines, listUntaggedLines, removeTag, updateTag, type RdLine } from "@/lib/rd/tags";
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

const PDF_HEAD = "%PDF-1.7\n%âãÏÓ\n";
function pdfBytes(size: number, fill = 0x41): Uint8Array {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set(Buffer.from(PDF_HEAD, "latin1"));
  return bytes;
}

async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** A date `days` before today (business time zone). */
function daysAgo(days: number): string {
  const [y, m, d] = todayIsoDate().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

const noContext = undefined as never;

/**
 * Examples RD1-RD3, RD7 (the payroll hook), RD8, RD9, RD11-RD13 and RD21-RD23
 * in docs/ACCOUNTING-EXAMPLES.md ("R&D Tax Incentive"), stage R2: the activity
 * register, approvals with their letters, tagging posted costs and an
 * asset's tax depreciation, and the who/when stamps. Each test gets its own
 * organisation (Kea, 31 March balance date).
 */
describeWithDatabase("R&D activity register and tagging (RD1-RD3, RD7-RD9, RD11-RD13, RD21-RD23)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let hana: SessionUser;
  let ana: SessionUser;
  let vic: SessionUser;
  const cookies = new Map<string, string>();
  let organisations = 0;
  const previousSecret = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    // Employees' IRD numbers are stored hashed with the server key (RD7 hook).
    process.env.TOHYEE_SECRET_KEY = "rd-integration-test-secret-key-at-least-32-characters";
    server = await startTestServer();
    jess = await createTestUser("rd-jess@example.com", { serverAdmin: true, displayName: "Jess Kelly" });
    hana = await createTestUser("rd-hana@example.com", { displayName: "Hana" });
    ana = await createTestUser("rd-ana@example.com", { displayName: "Ana Admin" });
    vic = await createTestUser("rd-vic@example.com", { displayName: "Vic Viewer" });
    for (const user of [jess, hana, ana, vic]) cookies.set(user.email, await sessionCookieFor(user));
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  async function setup() {
    organisations += 1;
    const org = `rd-${organisations}-kea`;
    await createTestOrganisation(jess, org);
    for (const [user, role] of [
      [hana, "bookkeeper"],
      [ana, "admin"],
      [vic, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
    }
    const asUser = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
    const as = asUser(jess);
    const asHana = asUser(hana);

    const call = (
      user: SessionUser,
      handler: (request: Request, context: never) => Promise<Response>,
      path: string,
      routeParams: Record<string, string> | null,
      options: { method?: string; body?: unknown } = {},
    ) => handler(apiRequest(path, { cookie: cookies.get(user.email), ...options }), (routeParams ? params(routeParams) : noContext) as never);

    const multipart = async (
      user: SessionUser,
      handler: (request: Request, context: never) => Promise<Response>,
      path: string,
      routeParams: Record<string, string> | null,
      fields: Record<string, string>,
      file: { name: string; content: Uint8Array } | null,
    ) => {
      const form = new FormData();
      form.set("organisationId", org);
      for (const [name, value] of Object.entries(fields)) form.set(name, value);
      if (file) form.set("file", new File([new Uint8Array(file.content)], file.name));
      const encoded = new Response(form);
      const bytes = new Uint8Array(await encoded.arrayBuffer());
      const request = new Request(`http://tohyee.test${path}`, {
        method: "POST",
        headers: {
          cookie: cookies.get(user.email)!,
          origin: "http://tohyee.test",
          "content-type": encoded.headers.get("content-type")!,
          "content-length": String(bytes.length),
        },
        body: bytes,
      });
      return handler(request, (routeParams ? params(routeParams) : noContext) as never);
    };

    const activity = async (fields: Record<string, unknown>, user = hana) =>
      (await asUser(user)((tx) => createActivity(tx, { idempotencyKey: key("activity"), projectName: "Low-power soil sensor", firstIncomeYear: 2027, ...fields }))).activity;
    const c1 = await activity({ code: "C1", name: "Prototype and field-test a low-power soil-moisture sensor", kind: "core", place: "nz" });
    const supplier = async (name: string, extra: Record<string, unknown> = {}) =>
      (await as((tx) => createContact(tx, { idempotencyKey: key("contact"), name, isSupplier: true, ...extra }))).contact;
    const bill = async (
      contactId: string,
      billDate: string,
      lines: Array<Record<string, unknown>>,
      extra: Record<string, unknown> = {},
      options?: { foreignCurrency: boolean },
    ) => {
      const draft = await as((tx) =>
        createBill(
          tx,
          { idempotencyKey: key("bill"), contactId, billDate, dueDate: billDate, supplierInvoiceNumber: key("INV"), amountsMode: "exclusive", lines, ...extra },
          null,
          options,
        ),
      );
      return (await as((tx) => approveBill(tx, draft.bill.id, { idempotencyKey: key("approve") }))).bill;
    };
    const linesOf = async (documentType: string, documentId: string): Promise<RdLine[]> =>
      (await as((tx) => listDocumentLines(tx, documentType, documentId))).lines;
    const tag = async (line: RdLine, fields: Record<string, unknown>, user = hana) =>
      (await asUser(user)((tx) => createTag(tx, { idempotencyKey: key("tag"), sourceType: line.sourceType, lineId: line.lineId, ...fields }))).tag;
    const costs = (incomeYear = 2027) => as((tx) => listTaggedCosts(tx, incomeYear));
    const journals = async () => Number((await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);
    return { org, as, asHana, asUser, call, multipart, activity, c1, supplier, bill, linesOf, tag, costs, journals };
  }

  it("RD1: registering a core activity posts nothing and is stamped with the signed-in user and the server's time", async () => {
    const w = await setup();
    const before = await w.journals();
    const sent = new Date().toISOString();
    const response = await w.call(hana, activitiesRoute.POST, "/api/rd/activities", null, {
      method: "POST",
      body: {
        organisationId: w.org,
        idempotencyKey: key("activity"),
        code: "C2",
        name: "Second core activity",
        projectName: "Low-power soil sensor",
        kind: "core",
        firstIncomeYear: 2027,
        purposeAndUncertainty: "Whether a capacitive sensor can run a season on one battery.",
        systematicApproach: "Hypothesis, prototype, field trial, measure, revise.",
        // Neither is taken from the request.
        createdByEmail: "someone-else@example.com",
        createdAt: "2020-01-01T00:00:00Z",
      },
    });
    expect(response.status).toBe(201);
    const { activity } = await body<{ activity: RdActivityDetail }>(response);
    expect(activity).toMatchObject({
      code: "C2",
      kind: "core",
      place: "nz",
      yearsLabel: "2026-27 onwards",
      createdByEmail: hana.email,
      status: "active",
      approvedYears: [],
      purposeAndUncertainty: "Whether a capacitive sensor can run a season on one battery.",
    });
    expect(activity.createdAt >= sent.slice(0, 19)).toBe(true);
    expect(activity.history).toMatchObject([{ version: 1, action: "created", changedByEmail: hana.email }]);
    expect(await w.journals()).toBe(before);

    // The database stamps the time itself, whatever an insert says.
    const raw = await w.as((tx) =>
      tx.query<{ created_at: string }>("update rd_activities set name = name || '' where id = $1 returning created_at::text", [activity.id]),
    );
    expect(Date.parse(raw.rows[0].created_at)).toBe(Date.parse(activity.createdAt));
    const forged = await w.as((tx) =>
      tx.query<{ year: number }>(
        `insert into rd_history (record_type, record_id, version, action, snapshot, changed_by_email, created_at)
         values ('activity', $1, 99, 'changed', '{}', 'x', '2020-01-01') returning extract(year from created_at)::int as year`,
        [activity.id],
      ),
    );
    expect(forged.rows[0].year).toBeGreaterThan(2020);

    // Viewers read; they can't add.
    const list = await w.call(vic, activitiesRoute.GET, `/api/rd/activities?organisationId=${w.org}`, null);
    expect(list.status).toBe(200);
    expect((await body<{ activities: { code: string }[] }>(list)).activities.map((a) => a.code)).toEqual(["C1", "C2"]);
    const refused = await w.call(vic, activitiesRoute.POST, "/api/rd/activities", null, {
      method: "POST",
      body: { organisationId: w.org, idempotencyKey: key("activity"), code: "C3", name: "x", projectName: "x", kind: "core", firstIncomeYear: 2027 },
    });
    expect(refused.status).toBe(403);
    const signedOut = await activitiesRoute.GET(apiRequest(`/api/rd/activities?organisationId=${w.org}`), noContext);
    expect(signedOut.status).toBe(401);
    await expect(w.activity({ code: "c1", name: "Duplicate", kind: "core" })).rejects.toThrow("There's already an R&D activity with the code c1.");
  });

  it("RD2: supporting activities are linked to core ones (one can support several); refused cases; archived, never deleted", async () => {
    const w = await setup();
    const c2 = await w.activity({ code: "C2", name: "Second core", kind: "core" });
    const s1 = await w.activity({ code: "S1", name: "Literature and patent search for low-power sensing", kind: "supporting", supports: [w.c1.id, c2.id], whyRequired: "To know what's been tried." });
    const s2 = await w.activity({ code: "S2", name: "Sensor calibration at Calibra Labs, Australia", kind: "supporting", place: "overseas", supports: [w.c1.id] });
    expect(s1.supports.map((a) => a.code)).toEqual(["C1", "C2"]);
    expect(s2).toMatchObject({ place: "overseas", kind: "supporting" });
    expect((await w.as((tx) => getActivity(tx, w.c1.id))).supportedBy.map((a) => a.code)).toEqual(["S1", "S2"]);

    await expect(w.activity({ code: "C9", name: "Overseas core", kind: "core", place: "overseas" })).rejects.toThrow("Core R&D must be performed in New Zealand");
    await expect(w.activity({ code: "S9", name: "No core", kind: "supporting" })).rejects.toThrow("A supporting activity needs the core activity");
    await expect(w.activity({ code: "S9", name: "Supports S1", kind: "supporting", supports: [s1.id] })).rejects.toThrow("S1 is a supporting activity");
    // The database refuses it too.
    await expect(
      w.as((tx) => tx.query("insert into rd_activity_supports (supporting_id, core_id) values ($1, $2)", [s2.id, s1.id])),
    ).rejects.toThrow();

    // Changing a description keeps the old version in history.
    const changed = await w.asHana((tx) => updateActivity(tx, s1.id, { version: s1.version, systematicApproach: "Searched IPONZ and Google Patents." }));
    expect(changed.version).toBe(2);
    expect(changed.history.map((entry) => entry.action)).toEqual(["created", "changed"]);
    await expect(w.asHana((tx) => updateActivity(tx, s1.id, { version: 1, name: "Stale" }))).rejects.toThrow("Someone else changed");

    // Bookkeepers can't archive; admins can, and never delete.
    const archive = (user: SessionUser, id: string, archived = true) =>
      w.call(user, activityArchiveRoute.POST, `/api/rd/activities/${id}/archive`, { activityId: id }, { method: "POST", body: { organisationId: w.org, archived } });
    expect((await archive(hana, s2.id)).status).toBe(403);
    const archived = await archive(ana, s2.id);
    expect(archived.status).toBe(200);
    expect((await body<{ activity: RdActivityDetail }>(archived)).activity).toMatchObject({ status: "archived", archivedByEmail: ana.email });
    expect((await archive(ana, w.c1.id)).status).toBe(400); // S1 still supports it
    expect((await archive(ana, s2.id, false)).status).toBe(200);
    await expect(w.as((tx) => tx.query("delete from rd_activities where id = $1", [s2.id]))).rejects.toThrow();
    await expect(w.as((tx) => tx.query("truncate rd_activities cascade"))).rejects.toThrow();
    const detail = await w.call(vic, activityRoute.GET, `/api/rd/activities/${s2.id}?organisationId=${w.org}`, { activityId: s2.id });
    expect((await body<{ activity: RdActivityDetail }>(detail)).activity.history.map((entry) => entry.action)).toEqual(["created", "archived", "restored"]);
  });

  it("RD3: an approval needs IRD's letter, is shown as not checked with IRD, and tags warn until one covers the year", async () => {
    const w = await setup();
    const s1 = await w.activity({ code: "S1", name: "Search", kind: "supporting", supports: [w.c1.id] });
    const sensor = await w.supplier("Sensor Parts Ltd");
    const b = await w.bill(sensor.id, "2026-07-20", [{ description: "Capacitive sensor components", quantity: "1", unitPrice: "100.00", accountCode: "6140", taxCode: "GST" }]);
    const [line] = await w.linesOf("bill", b.id);
    const tagged = await w.tag(line, { activityId: w.c1.id, eligibility: "eligible", category: "materials_overheads" });
    expect(tagged.warnings).toContain("No approval entered for 2026-27.");

    const today = todayIsoDate();
    const fields = { idempotencyKey: key("approval"), reference: "RDGA-12345", letterDate: today, firstIncomeYear: "2027", lastIncomeYear: "2029", activityIds: `${w.c1.id},${s1.id}` };
    const noLetter = await w.multipart(hana, approvalsRoute.POST, "/api/rd/approvals", null, fields, null);
    expect(noLetter.status).toBe(400);
    expect((await body<{ error: string }>(noLetter)).error).toBe("Attach IRD's approval letter. Approval details aren't saved without it.");
    expect((await w.as((tx) => tx.query("select 1 from rd_approvals"))).rowCount).toBe(0);
    // The database refuses an approval with no letter too.
    await expect(
      w.as(async (tx) => {
        const row = await tx.query<{ id: string }>(
          `insert into rd_approvals (idempotency_key, request_hash, kind, reference, letter_date, first_income_year, last_income_year, created_by_email, updated_by_email)
           values ('raw', 'x', 'general', 'R', $1, 2027, 2027, 'x', 'x') returning id`,
          [today],
        );
        await tx.query("insert into rd_approval_activities (approval_id, activity_id) values ($1, $2)", [row.rows[0].id, w.c1.id]);
      }),
    ).rejects.toThrow(/letter/);
    expect((await w.multipart(vic, approvalsRoute.POST, "/api/rd/approvals", null, { ...fields, idempotencyKey: key("a") }, { name: "letter.pdf", content: pdfBytes(500) })).status).toBe(403);
    await expect(
      w.asHana((tx) => createApproval(tx, { ...fields, idempotencyKey: key("a"), lastIncomeYear: "2030", kind: undefined, note: undefined, letter: { fileName: "l.pdf", content: pdfBytes(100) } })),
    ).rejects.toThrow("at most 3 income years");
    await expect(
      w.asHana((tx) => createApproval(tx, { ...fields, idempotencyKey: key("a"), kind: "criteria_methodologies", note: undefined, letter: { fileName: "l.pdf", content: pdfBytes(100) } })),
    ).rejects.toThrow("Only general approvals");

    const saved = await w.multipart(hana, approvalsRoute.POST, "/api/rd/approvals", null, fields, { name: "IRD letter.pdf", content: pdfBytes(500) });
    expect(saved.status).toBe(201);
    const { approval } = await body<{ approval: { id: string; yearsLabel: string; createdByEmail: string; checkedWithIrd: boolean; letters: { id: string; fileName: string }[] } }>(saved);
    expect(approval).toMatchObject({ yearsLabel: "2026-27 to 2028-29", createdByEmail: hana.email, checkedWithIrd: false, letters: [{ fileName: "IRD letter.pdf" }] });
    expect((await w.as((tx) => getTag(tx, tagged.id))).warnings).not.toContain("No approval entered for 2026-27.");
    expect((await w.as((tx) => getActivity(tx, w.c1.id))).approvedYears).toEqual([2027, 2028, 2029]);

    // The letter downloads; it can't be deleted, only replaced with the old one kept.
    const letterId = approval.letters[0].id;
    const download = await w.call(vic, fileRoute.GET, `/api/rd/files/${letterId}?organisationId=${w.org}`, { fileId: letterId });
    expect(download.status).toBe(200);
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await download.arrayBuffer()).length).toBe(500);
    await expect(w.as((tx) => tx.query("delete from rd_files where id = $1", [letterId]))).rejects.toThrow();
    await expect(w.as((tx) => tx.query("update rd_files set file_name = 'x' where id = $1", [letterId]))).rejects.toThrow();
    const replaced = await w.multipart(hana, replaceFileRoute.POST, `/api/rd/files/${letterId}/replace`, { fileId: letterId }, { idempotencyKey: key("file") }, { name: "IRD letter (signed).pdf", content: pdfBytes(600) });
    expect(replaced.status).toBe(201);
    const { file } = await body<{ file: { id: string; fileName: string; replaced: { id: string; fileName: string }[] } }>(replaced);
    expect(file).toMatchObject({ fileName: "IRD letter (signed).pdf", replaced: [{ id: letterId, fileName: "IRD letter.pdf" }] });
    const again = await w.multipart(hana, replaceFileRoute.POST, `/api/rd/files/${letterId}/replace`, { fileId: letterId }, { idempotencyKey: key("file") }, { name: "x.pdf", content: pdfBytes(100) });
    expect(again.status).toBe(409);
    // The old version still downloads.
    expect((await w.call(vic, fileRoute.GET, `/api/rd/files/${letterId}?organisationId=${w.org}`, { fileId: letterId })).status).toBe(200);

    // Only admins withdraw, with a reason; it's kept.
    const withdraw = (user: SessionUser) =>
      w.call(user, withdrawRoute.POST, `/api/rd/approvals/${approval.id}/withdraw`, { approvalId: approval.id }, { method: "POST", body: { organisationId: w.org, reason: "Entered against the wrong activities" } });
    expect((await withdraw(hana)).status).toBe(403);
    expect((await withdraw(ana)).status).toBe(200);
    expect((await w.as((tx) => getTag(tx, tagged.id))).warnings).toContain("No approval entered for 2026-27.");
    await expect(w.as((tx) => tx.query("delete from rd_approvals where id = $1", [approval.id]))).rejects.toThrow();
  });

  it("RD8: a bill line tagged 100% C1 counts 4,000.00, never the GST; goods not used by year end are taken off, stamped", async () => {
    const w = await setup();
    const sensor = await w.supplier("Sensor Parts Ltd");
    const b = await w.bill(sensor.id, "2026-07-20", [
      { description: "Capacitive sensor components for prototypes", quantity: "1", unitPrice: "4000.00", accountCode: "6140", taxCode: "GST" },
    ]);
    expect(b.total).toBe("4600.00");
    const [line] = await w.linesOf("bill", b.id);
    expect(line).toMatchObject({ amount: "4000.00", taggable: true, ineligibleOnly: false, tag: null });
    const tagged = await w.tag(line, { activityId: w.c1.id, eligibility: "eligible", category: "materials_overheads" });
    expect(tagged).toMatchObject({ lineAmount: "4000.00", percentage: "100.00", amount: "4000.00", countedAmount: "4000.00", incomeYear: 2027, incomeYearLabel: "2026-27" });
    expect(tagged.timeliness.workDate).toBe("2026-07-20");
    // Tagged on its own line only once.
    await expect(w.tag(line, { activityId: w.c1.id, eligibility: "eligible", category: "materials_overheads" })).rejects.toThrow("already tagged");

    // The bill's GST (on its journal) is never tagged; a manual journal to GST is refused too.
    const gst = await w.as((tx) =>
      postJournal(tx, { idempotencyKey: key("j"), postingDate: "2026-07-21", reference: "GST-ADJ", lines: [{ accountCode: "2100", debitAmount: "10.00" }, { accountCode: "1000", creditAmount: "10.00" }] }),
    );
    const [gstLine] = (await w.linesOf("journal", gst.journal.id)).filter((l) => l.accountCode === "2100");
    expect(gstLine.taggable).toBe(false);
    await expect(w.tag(gstLine, { activityId: w.c1.id, eligibility: "eligible", category: "materials_overheads" })).rejects.toThrow("GST");

    // 1,000.00 not used by 31 Mar 2027: 3,000.00 counts, and who marked it and when is kept.
    const marked = await w.asHana((tx) => updateTag(tx, tagged.id, { version: tagged.version, unusedAmount: "1000.00" }));
    expect(marked).toMatchObject({ amount: "4000.00", unusedAmount: "1000.00", countedAmount: "3000.00", unusedMarkedByEmail: hana.email, version: 2 });
    expect(marked.unusedMarkedAt).not.toBeNull();
    expect(marked.history.map((entry) => entry.action)).toEqual(["created", "changed"]);
    await expect(w.asHana((tx) => updateTag(tx, tagged.id, { unusedAmount: "4000.01" }))).rejects.toThrow("can't be more than the R&D share");
    // The work date (the bill's date) can't be changed on the tag, even directly.
    await expect(w.as((tx) => tx.query("update rd_tags set work_date = '2026-07-01' where id = $1", [tagged.id]))).rejects.toThrow();

    const list = await w.costs();
    expect(list.activities).toHaveLength(1);
    expect(list.activities[0].groups).toMatchObject([
      { eligibility: "eligible", category: "materials_overheads", amount: "4000.00", unusedAmount: "1000.00", countedAmount: "3000.00" },
    ]);
    expect(list.countedAmount).toBe("3000.00");

    // Tagged long after the bill's date: flagged entered late, not refused (decision 38).
    const days = daysBetween("2026-07-20", todayIsoDate());
    expect(tagged.timeliness).toMatchObject({ daysAfterWork: days, enteredLate: days > 14 });

    // Voiding the bill stops the tag counting; it's listed apart.
    await w.as((tx) => voidBill(tx, b.id, { idempotencyKey: key("void"), voidDate: "2026-07-21" }));
    const after = await w.costs();
    expect(after.activities).toEqual([]);
    expect(after.voidedTags.map((t) => t.id)).toEqual([tagged.id]);
  });

  it("RD9: an expense claim receipt of 230.00 including GST counts 200.00", async () => {
    const w = await setup();
    const { claim } = await w.asHana((tx) =>
      createExpenseClaim(tx, {
        idempotencyKey: key("claim"),
        receipts: [{ receiptDate: "2026-08-05", supplierName: "Garden Centre", description: "Potting mix and pots for soil trials", accountCode: "6140", taxCode: "GST", amount: "230.00" }],
      }),
    );
    expect((await w.linesOf("expense_claim", claim.id))[0]).toMatchObject({ taggable: false });
    await w.asHana((tx) => submitExpenseClaim(tx, claim.id));
    await w.as((tx) => approveExpenseClaim(tx, "owner", claim.id, { idempotencyKey: key("approve"), claimDate: "2026-08-06" }));
    const [line] = await w.linesOf("expense_claim", claim.id);
    expect(line).toMatchObject({ amount: "200.00", taggable: true });
    const tagged = await w.tag(line, { activityId: w.c1.id, eligibility: "eligible", category: "materials_overheads" });
    expect(tagged).toMatchObject({ amount: "200.00", countedAmount: "200.00", documentType: "expense_claim" });
  });

  it("RD11: the oscilloscope's bill line is only ineligible; tax depreciation and Investment Boost 2,400.00 split by usage gives C1 800.00", async () => {
    const w = await setup();
    const type = (
      await w.as((tx) =>
        createFixedAssetType(tx, { idempotencyKey: key("type"), name: "Test equipment", assetAccountCode: "1620", accumulatedDepreciationAccountCode: "1630", depreciationExpenseAccountCode: "6300", method: "dv", rate: "25" }),
      )
    ).type;
    const lab = await w.supplier("Lab Gear Ltd");
    const b = await w.bill(lab.id, "2026-04-01", [{ description: "Oscilloscope", quantity: "1", unitPrice: "6000.00", accountCode: "1620", taxCode: "GST" }]);
    const [line] = await w.linesOf("bill", b.id);
    expect(line).toMatchObject({ amount: "6000.00", taggable: true, ineligibleOnly: true });
    await expect(w.tag(line, { activityId: w.c1.id, eligibility: "eligible", category: "materials_overheads" })).rejects.toThrow("can only be tagged as ineligible");
    const capital = await w.tag(line, { activityId: w.c1.id, eligibility: "ineligible", ineligibleReason: "acquiring_depreciable_property" });
    expect(capital).toMatchObject({ amount: "6000.00", countedAmount: "0.00", ineligibleReasonLabel: "Acquiring depreciable property", ineligibleReasonSource: "Sch 21B B cl 2; IR1240 p 76" });

    const billLine = (await w.as((tx) => listBillLinesForAssets(tx))).find((entry) => entry.billId === b.id)!;
    const asset = (await w.asHana((tx) => createFixedAsset(tx, { idempotencyKey: key("asset"), name: "Oscilloscope", typeId: type.id, billLineId: billLine.billLineId }))).asset;

    // Tax depreciation and Investment Boost for 2026-27, entered from Kea's tax workings.
    const entered = await w.asHana((tx) => enterTaxDepreciation(tx, asset.id, { idempotencyKey: key("dep"), incomeYear: 2027, taxDepreciation: "1200.00", investmentBoost: "1200.00" }));
    expect(entered.asset.years[0]).toMatchObject({ incomeYear: 2027, entry: { total: "2400.00", createdByEmail: hana.email }, shares: [] });

    // Usage: 300 h on C1 and 600 h on other work in 2026-27 (idle time isn't logged).
    const use = (activityId: string | null, workDate: string, hours: string) =>
      w.call(hana, usageRoute.POST, `/api/rd/assets/${asset.id}/usage`, { assetId: asset.id }, { method: "POST", body: { organisationId: w.org, idempotencyKey: key("use"), activityId, workDate, hours } });
    expect((await use(w.c1.id, "2026-05-01", "300")).status).toBe(201);
    expect((await use(null, "2026-05-02", "600")).status).toBe(201);
    expect((await use(w.c1.id, "2026-05-03", "1")).status).toBe(201);
    const rd = await w.as((tx) => getAssetRd(tx, asset.id));
    const wrong = rd.usage.find((u) => u.hours === "1.00")!;
    await w.asHana((tx) => removeUsage(tx, wrong.id, "Logged twice"));
    const year = (await w.as((tx) => getAssetRd(tx, asset.id))).years[0];
    expect(year).toMatchObject({ totalHours: "900.00", otherHours: "600.00", shares: [{ activity: { code: "C1" }, hours: "300.00", amount: "800.00" }], other: "1600.00" });

    // Entered again for the same year: the latest counts, the earlier one is kept.
    await w.asHana((tx) => enterTaxDepreciation(tx, asset.id, { idempotencyKey: key("dep"), incomeYear: 2027, taxDepreciation: "1200.00", investmentBoost: "0" }));
    const redone = (await w.as((tx) => getAssetRd(tx, asset.id))).years[0];
    expect(redone.entry?.total).toBe("1200.00");
    expect(redone.earlierEntries.map((entry) => entry.total)).toEqual(["2400.00"]);
    expect(redone.shares[0].amount).toBe("400.00");
    await w.asHana((tx) => enterTaxDepreciation(tx, asset.id, { idempotencyKey: key("dep"), incomeYear: 2027, taxDepreciation: "1200.00", investmentBoost: "1200.00" }));
    await expect(w.as((tx) => tx.query("delete from rd_asset_tax_depreciation"))).rejects.toThrow();

    const list = await w.costs();
    expect(list.activities[0].groups).toMatchObject([
      { eligibility: "eligible", category: "depreciation", label: "R&D tax depreciation", countedAmount: "800.00", assets: [{ assetNumber: asset.assetNumber, hours: "300.00", totalHours: "900.00", amount: "800.00" }] },
      { eligibility: "ineligible", ineligibleReason: "acquiring_depreciable_property", amount: "6000.00", countedAmount: "0.00" },
    ]);
    expect(list.countedAmount).toBe("800.00");
    expect(list.ineligibleAmount).toBe("6000.00");

    // Book depreciation lines are never tagged (decision 33).
    const untagged = await w.as((tx) => listUntaggedLines(tx));
    expect(untagged.every((l) => l.accountCode !== "6300")).toBe(true);
  });

  it("RD12: contract expenditure less the contractor's own ineligible costs: 3,100.00, or 2,700.00 with 400.00 ineligible", async () => {
    const w = await setup();
    const soilLab = await w.supplier("Soil Lab NZ Ltd");
    const b = await w.bill(soilLab.id, "2026-09-01", [{ description: "Field sample analysis", quantity: "1", unitPrice: "3100.00", accountCode: "6140", taxCode: "GST" }]);
    const [line] = await w.linesOf("bill", b.id);
    const tagged = await w.tag(line, { activityId: w.c1.id, eligibility: "eligible", category: "contract" });
    expect(tagged.countedAmount).toBe("3100.00");
    // The contractor's statement is attached to the tag.
    const statement = await w.multipart(hana, filesRoute.POST, "/api/rd/files", null, { idempotencyKey: key("file"), recordType: "tag", recordId: tagged.id, purpose: "contractor_statement" }, { name: "Soil Lab statement.pdf", content: pdfBytes(300) });
    expect(statement.status).toBe(201);
    await expect(w.asHana((tx) => updateTag(tx, tagged.id, { category: "materials_overheads", contractorIneligibleAmount: "400.00" }))).rejects.toThrow("only to contract");
    const changed = await w.call(hana, tagRoute.PATCH, `/api/rd/tags/${tagged.id}`, { tagId: tagged.id }, { method: "PATCH", body: { organisationId: w.org, version: 1, contractorIneligibleAmount: "400.00" } });
    expect(changed.status).toBe(200);
    const { tag } = await body<{ tag: { countedAmount: string; contractorIneligibleAmount: string; files: { fileName: string }[]; history: unknown[] } }>(changed);
    expect(tag).toMatchObject({ countedAmount: "2700.00", contractorIneligibleAmount: "400.00", files: [{ fileName: "Soil Lab statement.pdf" }] });
    expect(tag.history).toHaveLength(2);
  });

  it("RD13: an AUD bill counts at the bill's rate (9,000.00); the realised exchange loss on payment isn't tagged", async () => {
    const w = await setup();
    const s2 = await w.activity({ code: "S2", name: "Sensor calibration at Calibra Labs, Australia", kind: "supporting", place: "overseas", supports: [w.c1.id] });
    const calibra = await w.supplier("Calibra Labs Pty Ltd", { currencyCode: "AUD" });
    const b = await w.bill(
      calibra.id,
      "2026-07-25",
      [{ description: "Calibration", quantity: "1", unitPrice: "8100.00", accountCode: "6140" }],
      { amountsMode: "no_tax", exchangeRate: "1.11111111" },
      { foreignCurrency: true },
    );
    const [line] = await w.linesOf("bill", b.id);
    expect(line).toMatchObject({ amount: "9000.00", currencyCode: "AUD", documentAmount: "8100.00" });
    const tagged = await w.tag(line, { activityId: s2.id, eligibility: "eligible", category: "contract" });
    expect(tagged).toMatchObject({ amount: "9000.00", overseas: true });

    await w.as((tx) => recordSupplierPayment(tx, b.id, { idempotencyKey: key("pay"), paymentDate: "2026-08-15", amount: "8100.00", bankAccountCode: "1000", exchangeRate: "1.13636364" }));
    const loss = await w.as((tx) =>
      tx.query<{ id: string; debit: string }>(
        `select l.id::text, l.debit_amount::text as debit from ledger_journal_lines l join accounts a on a.id = l.account_id where a.system_key = 'realised_fx'`,
      ),
    );
    expect(loss.rows.map((row) => row.debit)).toEqual(["204.55"]);
    await expect(w.tag({ sourceType: "journal_line", lineId: loss.rows[0].id } as RdLine, { activityId: s2.id, eligibility: "eligible", category: "contract" })).rejects.toThrow();
    expect((await w.costs()).activities.find((a) => a.activity.code === "S2")?.countedAmount).toBe("9000.00");
  });

  it("RD21-RD23: who and when come from the server; entries over 14 days after the work are flagged; changes keep history", async () => {
    const w = await setup();
    const type = (
      await w.as((tx) =>
        createFixedAssetType(tx, { idempotencyKey: key("type"), name: "Test equipment", assetAccountCode: "1620", accumulatedDepreciationAccountCode: "1630", depreciationExpenseAccountCode: "6300", method: "dv", rate: "25" }),
      )
    ).type;
    const asset = (await w.as((tx) => createFixedAsset(tx, { idempotencyKey: key("asset"), name: "Data logger", typeId: type.id, purchaseDate: "2026-04-01", cost: "1200.00" }))).asset;
    const log = async (workDate: string, hours: string) => {
      const result = await w.asHana((tx) => addUsage(tx, asset.id, { idempotencyKey: key("use"), activityId: w.c1.id, workDate, hours, createdAt: "2020-01-01", createdByEmail: "x@example.com" }));
      return result.asset.usage.find((u) => u.id === result.usageId)!;
    };

    // RD21: entered 2 days after the work: not flagged.
    const onTime = await log(daysAgo(2), "6");
    expect(onTime.timeliness).toMatchObject({ daysAfterWork: 2, enteredLate: false, timelinessText: "entered 2 days after the work" });
    expect(onTime.createdByEmail).toBe(hana.email);
    expect(Date.now() - Date.parse(onTime.createdAt)).toBeLessThan(60_000);
    // RD22: more than 14 days after: flagged, not refused.
    const late = await log(daysAgo(15), "40");
    expect(late.timeliness).toMatchObject({ daysAfterWork: 15, enteredLate: true });
    const fourteen = await log(daysAgo(14), "1");
    expect(fourteen.timeliness.enteredLate).toBe(false);
    await expect(log(daysAgo(-1), "1")).rejects.toThrow("future");

    // RD23: changed from 6 h to 7 h; the history keeps both, with who and when.
    const changed = (await w.asHana((tx) => updateUsage(tx, onTime.id, { version: 1, hours: "7" }))).usage.find((u) => u.id === onTime.id)!;
    expect(changed).toMatchObject({ hours: "7.00", version: 2, updatedByEmail: hana.email });
    expect(changed.timeliness.changedDaysAfterEntry).toBe(0);
    expect(changed.history.map((entry) => [entry.action, entry.snapshot.hours, entry.changedByEmail])).toEqual([
      ["created", "6.00", hana.email],
      ["changed", "7.00", hana.email],
    ]);
    await expect(w.asHana((tx) => updateUsage(tx, onTime.id, { workDate: daysAgo(1) }))).rejects.toThrow("keeps its date");
    await expect(w.as((tx) => tx.query("update rd_asset_usage set work_date = $2 where id = $1", [onTime.id, daysAgo(1)]))).rejects.toThrow();
    await expect(w.as((tx) => tx.query("update rd_history set snapshot = '{}'"))).rejects.toThrow();
    await expect(w.as((tx) => tx.query("delete from rd_history"))).rejects.toThrow();
  });

  it("RD7 hook: an employee's default allocation can name a registered R&D activity (a real foreign key)", async () => {
    const w = await setup();
    const { employee } = await w.as((tx) =>
      createEmployee(tx, {
        idempotencyKey: key("employee"),
        firstName: "Hana",
        lastName: "Smith",
        taxCode: "M",
        irdNumber: "123456789",
        kiwiSaverStatus: "enrolled",
        kiwiSaverEmployeeRate: "4",
        kiwiSaverEmployerRate: "3.5",
        studentLoan: false,
        bankAccount: "03-1234-0123456-00",
        payFrequency: "fortnightly",
        payBasis: "salary",
        annualSalary: "62400.00",
        startDate: "2026-04-01",
      }),
    );
    const add = (lines: unknown[]) => w.as((tx) => addAllocation(tx, employee.id, { idempotencyKey: key("allocation"), effectiveFrom: "2026-04-01", lines }));
    const c3 = await w.activity({ code: "C3", name: "Third core", kind: "core" });
    const { allocation } = await add([
      { percentage: "60", rdActivityId: w.c1.id },
      { percentage: "40", rdActivityId: c3.id },
    ]);
    expect(allocation.lines[0]).toMatchObject({ percentage: "60", rdActivityId: w.c1.id, rdActivityCode: "C1" });
    await expect(
      w.as((tx) => tx.query("insert into payroll_cost_allocation_lines (allocation_id, line_number, percentage, rd_activity_id) values ($1, 9, 1, gen_random_uuid())", [allocation.id])),
    ).rejects.toThrow();
    const c2 = await w.activity({ code: "C2", name: "Archived core", kind: "core" });
    await w.as((tx) => setActivityArchived(tx, c2.id, true));
    await expect(add([{ percentage: "100", rdActivityId: c2.id }])).rejects.toThrow("C2 is archived");
  });

  it("tags: roles, line picker, removal with history, and the tagged costs list", async () => {
    const w = await setup();
    const sensor = await w.supplier("Sensor Parts Ltd");
    const b = await w.bill(sensor.id, "2026-07-20", [
      { description: "Sensor components", quantity: "1", unitPrice: "1000.00", accountCode: "6140", taxCode: "GST" },
      { description: "Office supplies", quantity: "1", unitPrice: "33.33", accountCode: "6140", taxCode: "GST" },
    ]);
    const lines = await w.call(vic, linesRoute.GET, `/api/rd/lines?organisationId=${w.org}&documentType=bill&documentId=${b.id}`, null);
    expect(lines.status).toBe(200);
    const [components, office] = (await body<{ lines: RdLine[] }>(lines)).lines;
    const post = (user: SessionUser, line: RdLine, fields: Record<string, unknown>) =>
      w.call(user, tagsRoute.POST, "/api/rd/tags", null, {
        method: "POST",
        body: { organisationId: w.org, idempotencyKey: key("tag"), sourceType: line.sourceType, lineId: line.lineId, ...fields },
      });
    expect((await post(vic, components, { activityId: w.c1.id, eligibility: "eligible", category: "materials_overheads" })).status).toBe(403);
    const created = await post(hana, office, { activityId: w.c1.id, eligibility: "eligible", category: "materials_overheads", percentage: "50", createdByEmail: "x@example.com" });
    expect(created.status).toBe(201);
    const { tag } = await body<{ tag: { id: string; amount: string; createdByEmail: string } }>(created);
    // 33.33 × 50% = 16.665, rounded down to the cent.
    expect(tag).toMatchObject({ amount: "16.66", createdByEmail: hana.email });
    expect((await post(hana, components, { activityId: w.c1.id, eligibility: "ineligible", ineligibleReason: "other" })).status).toBe(400);
    expect((await post(hana, components, { activityId: w.c1.id, eligibility: "ineligible", ineligibleReason: "commercialisation" })).status).toBe(201);

    const untagged = await w.as((tx) => listUntaggedLines(tx, { search: "Sensor" }));
    expect(untagged.map((l) => l.description)).not.toContain("Sensor components");

    const removed = await w.asHana((tx) => removeTag(tx, tag.id, "Not R&D after all"));
    expect(removed).toMatchObject({ status: "removed", removedReason: "Not R&D after all", removedByEmail: hana.email });
    expect(removed.history.map((entry) => entry.action)).toEqual(["created", "removed"]);
    await expect(w.as((tx) => tx.query("update rd_tags set status = 'active' where id = $1", [tag.id]))).rejects.toThrow();
    await expect(w.as((tx) => tx.query("delete from rd_tags where id = $1", [tag.id]))).rejects.toThrow();

    const response = await w.call(vic, costsRoute.GET, `/api/rd/costs?organisationId=${w.org}&incomeYear=2027`, null);
    expect(response.status).toBe(200);
    const { costs } = await body<{ costs: Awaited<ReturnType<typeof w.costs>> }>(response);
    expect(costs).toMatchObject({ incomeYearLabel: "2026-27", start: "2026-04-01", end: "2027-03-31", countedAmount: "0.00", ineligibleAmount: "1000.00" });
    expect(costs.activities[0].groups).toMatchObject([{ eligibility: "ineligible", label: "Commercialisation", amount: "1000.00" }]);
    expect((await w.call(vic, tagRoute.GET, `/api/rd/tags/${tag.id}?organisationId=${w.org}`, { tagId: tag.id })).status).toBe(200);
  });

  it("applies tenant migration 0060 last", async () => {
    const { tenantMigrations } = await import("@/lib/db/migrations/tenant");
    expect(tenantMigrations.at(-1)?.version).toBe("0060");
  });
});
