import { afterAll, beforeAll, expect, it } from "vitest";
import * as gstReturnsRoute from "@/app/api/gst-returns/route";
import * as gstReturnReportRoute from "@/app/api/reports/gst-return/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import {
  calculateGstReturn,
  fileGstReturn,
  getGstReturn,
  IRD_NOTE_OLD_PURCHASE,
  IRD_NOTE_OVER_LIMIT,
} from "@/lib/reports/gst-return";
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

const APR_MAY = { periodStart: "2026-04-01", periodEnd: "2026-05-31" };
const JUN_JUL = { periodStart: "2026-06-01", periodEnd: "2026-07-31" };
const AUG_SEP = { periodStart: "2026-08-01", periodEnd: "2026-09-30" };
const noContext = undefined as unknown;

/** Examples LG1-LG7 in docs/ACCOUNTING-EXAMPLES.md ("Late changes to filed GST periods"), like Xero's late claims. */
describeWithDatabase("GST late claims", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  /** An organisation with Kobe Ltd (customer) and Paw Supplies (supplier), and the Apr-May 2026 return (G1: I1, B1) filed. */
  async function setup(options: { basis?: "payments" } = {}) {
    organisations += 1;
    const org = `late-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    if (options.basis) await as((tx) => updateOrganisationSettings(tx, { gstBasis: options.basis }));
    const kobe = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Ltd", isCustomer: true }))).contact;
    const paw = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Paw Supplies", isSupplier: true }))).contact;
    const invoice = async (invoiceDate: string, unitPrice: string) => {
      const { invoice: draft } = await as((tx) =>
        createInvoice(tx, {
          idempotencyKey: key("i"),
          contactId: kobe.id,
          invoiceDate,
          dueDate: "2026-12-31",
          amountsMode: "exclusive",
          lines: [{ description: "Work", quantity: "1", unitPrice, accountCode: "4000", taxCode: "GST" }],
        }),
      );
      return (await as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("a") }))).invoice;
    };
    let bills = 0;
    const bill = async (billDate: string, unitPrice: string) => {
      bills += 1;
      const { bill: draft } = await as((tx) =>
        createBill(tx, {
          idempotencyKey: key("b"),
          contactId: paw.id,
          billDate,
          dueDate: "2026-12-31",
          supplierInvoiceNumber: `S-${bills}`,
          amountsMode: "exclusive",
          lines: [{ description: "Laptop", quantity: "1", unitPrice, accountCode: "6010", taxCode: "GST" }],
        }),
      );
      return (await as((tx) => approveBill(tx, draft.id, { idempotencyKey: key("a") }))).bill;
    };
    const calculate = (period: typeof JUN_JUL, excludedLateClaims?: string[]) =>
      as((tx) => calculateGstReturn(tx, { ...period, excludedLateClaims }));
    const file = (period: typeof JUN_JUL, excludedLateClaims?: string[]) =>
      as((tx) => fileGstReturn(tx, { idempotencyKey: key("file"), ...period, excludedLateClaims }));
    return { org, as, kobe, invoice, bill, calculate, file };
  }

  it("LG1, LG2: a missed bill dated in a filed period is claimed in the next return, once", async () => {
    const w = await setup();
    await w.invoice("2026-04-10", "100.00"); // I1, 115.00
    await w.bill("2026-04-12", "200.00"); // B1, 230.00
    const aprMay = (await w.file(APR_MAY)).gstReturn;
    expect(aprMay.boxes.box11).toBe("230.00");

    const b9 = await w.bill("2026-05-20", "2000.00"); // entered 10 Jun: 2,300.00, GST 300.00
    const junJul = await w.calculate(JUN_JUL);
    expect(junJul.lateClaims).toHaveLength(1);
    expect(junJul.lateClaims[0]).toMatchObject({
      from: { gstReturnId: aprMay.id, periodStart: "2026-04-01", periodEnd: "2026-05-31" },
      side: "purchases",
      documentType: "bill",
      documentId: b9.id,
      eventDate: "2026-05-20",
      amount: "2300.00",
      gst: "300.00",
      reversal: false,
      included: true,
      irdNote: null,
    });
    expect(junJul.boxes).toMatchObject({ box11: "2300.00", box12: "300.00", box15: "-300.00" });
    expect(junJul.lines.filter((line) => line.lateFrom).map((line) => line.documentId)).toEqual([b9.id]);

    const stillChanged = await w.as((tx) => getGstReturn(tx, aprMay.id));
    expect(stillChanged.changedSinceFiled).toBe(true);
    expect(stillChanged.changes).toContainEqual(expect.objectContaining({ box: "box11", filed: "230.00", current: "2530.00" }));

    // LG2: filing stores B9 as a late line belonging to Apr-May.
    const filed = (await w.file(JUN_JUL)).gstReturn;
    expect(filed.boxes.box11).toBe("2300.00");
    expect(filed.lines).toEqual([
      expect.objectContaining({ documentId: b9.id, eventDate: "2026-05-20", lateFrom: { gstReturnId: aprMay.id, periodStart: "2026-04-01", periodEnd: "2026-05-31" } }),
    ]);
    const after = await w.as((tx) => getGstReturn(tx, aprMay.id));
    expect(after.claimedLater).toEqual([
      {
        gstReturn: { id: filed.id, periodStart: "2026-06-01", periodEnd: "2026-07-31" },
        documentType: "bill",
        documentNumber: "S-2",
        contactName: "Paw Supplies",
        eventDate: "2026-05-20",
        reversal: false,
        gst: "300.00",
      },
    ]);
    const augSep = await w.calculate(AUG_SEP);
    expect(augSep.lateClaims).toEqual([]);
    expect(augSep.boxes.box11).toBe("0.00");
  });

  it("LG3: a late claim turned off stays out of the boxes and is offered again next time", async () => {
    const w = await setup();
    await w.file(APR_MAY);
    await w.bill("2026-05-20", "2000.00");
    const offered = await w.calculate(JUN_JUL);
    const claimKey = offered.lateClaims[0].key;
    const off = await w.calculate(JUN_JUL, [claimKey]);
    expect(off.lateClaims[0].included).toBe(false);
    expect(off.boxes).toMatchObject({ box11: "0.00", box12: "0.00" });

    const filed = (await w.file(JUN_JUL, [claimKey])).gstReturn;
    expect(filed.lines).toEqual([]);
    const augSep = await w.calculate(AUG_SEP);
    expect(augSep.lateClaims.map((claim) => [claim.key, claim.included])).toEqual([[claimKey, true]]);
    expect(augSep.boxes).toMatchObject({ box11: "2300.00", box12: "300.00" });
  });

  it("LG4, LG5: a late sale within $1,000 has no note; over $1,000 it says what IRD says but still counts", async () => {
    const w = await setup();
    await w.file(APR_MAY);
    await w.invoice("2026-05-15", "1000.00"); // I20: 1,150.00, GST 150.00
    const small = await w.calculate(JUN_JUL);
    expect(small.lateClaims.map((claim) => [claim.amount, claim.gst, claim.irdNote])).toEqual([["1150.00", "150.00", null]]);
    expect(small.boxes).toMatchObject({ box5: "1150.00", box8: "150.00" });

    await w.invoice("2026-05-15", "10000.00"); // I21: 11,500.00, GST 1,500.00
    const big = await w.calculate(JUN_JUL);
    expect(big.lateClaims.map((claim) => [claim.gst, claim.included, claim.irdNote])).toEqual([
      ["150.00", true, IRD_NOTE_OVER_LIMIT],
      ["1500.00", true, IRD_NOTE_OVER_LIMIT],
    ]);
    expect(big.boxes).toMatchObject({ box5: "12650.00", box8: "1650.00" });

    // Turning the big one off brings the rest back under the limit.
    const withoutBig = await w.calculate(JUN_JUL, [big.lateClaims[1].key]);
    expect(withoutBig.lateClaims.map((claim) => claim.irdNote)).toEqual([null, null]);
  });

  it("LG6: a missed purchase more than 2 years old says what IRD says but still counts", async () => {
    const w = await setup();
    const marApr2024 = (await w.file({ periodStart: "2024-03-01", periodEnd: "2024-04-30" })).gstReturn;
    await w.file(APR_MAY);
    await w.bill("2024-03-10", "300.00"); // GST 45.00
    const junJul = await w.calculate(JUN_JUL);
    expect(junJul.lateClaims.map((claim) => [claim.from.gstReturnId, claim.amount, claim.gst, claim.irdNote])).toEqual([
      [marApr2024.id, "345.00", "45.00", IRD_NOTE_OLD_PURCHASE],
    ]);
    expect(junJul.boxes).toMatchObject({ box11: "345.00", box12: "45.00" });
  });

  it("LG7: on the payments basis, a payment dated in a filed period and entered after it is a late claim", async () => {
    const w = await setup({ basis: "payments" });
    const i1 = await w.invoice("2026-04-10", "100.00");
    const aprMay = (await w.file(APR_MAY)).gstReturn;
    expect(aprMay.boxes.box5).toBe("0.00");
    await w.as((tx) => recordPayment(tx, i1.id, { idempotencyKey: key("pay"), paymentDate: "2026-05-25", amount: "115.00", bankAccountCode: "1000" }));
    const junJul = await w.calculate(JUN_JUL);
    expect(junJul.lateClaims.map((claim) => [claim.eventType, claim.eventDate, claim.amount, claim.gst])).toEqual([
      ["customer_payment", "2026-05-25", "115.00", "15.00"],
    ]);
    expect(junJul.boxes).toMatchObject({ box5: "115.00", box8: "15.00" });
  });

  it("nothing is a late claim when nothing changed, and the API passes turned-off claims through", async () => {
    const w = await setup();
    await w.invoice("2026-04-10", "100.00");
    await w.file(APR_MAY);
    expect((await w.calculate(JUN_JUL)).lateClaims).toEqual([]);

    await w.bill("2026-05-20", "2000.00");
    const cookie = await sessionCookieFor(owner);
    const worked = (await (
      await gstReturnReportRoute.POST(apiRequest("/api/reports/gst-return", { method: "POST", cookie, body: { organisationId: w.org, ...JUN_JUL } }), noContext)
    ).json()) as { lateClaims: Array<{ key: string }>; boxes: { box11: string } };
    expect(worked.boxes.box11).toBe("2300.00");
    const off = (await (
      await gstReturnReportRoute.POST(
        apiRequest("/api/reports/gst-return", { method: "POST", cookie, body: { organisationId: w.org, ...JUN_JUL, excludedLateClaims: [worked.lateClaims[0].key] } }),
        noContext,
      )
    ).json()) as { boxes: { box11: string } };
    expect(off.boxes.box11).toBe("0.00");
    const filed = await gstReturnsRoute.POST(
      apiRequest("/api/gst-returns", {
        method: "POST",
        cookie,
        body: { organisationId: w.org, idempotencyKey: key("f"), ...JUN_JUL, excludedLateClaims: [worked.lateClaims[0].key] },
      }),
      noContext,
    );
    expect(filed.status).toBe(201);
    expect(((await filed.json()) as { gstReturn: { boxes: { box11: string } } }).gstReturn.boxes.box11).toBe("0.00");
  });
});
