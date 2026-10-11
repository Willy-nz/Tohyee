import { afterAll, beforeAll, expect, it } from "vitest";
import { createAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { recordPayment, voidPayment } from "@/lib/invoices/payments";
import { getInvoice } from "@/lib/invoices/service";
import { recordAccountSale, voidAccountSale } from "@/lib/livestock/account-sales";
import { headCount, setOpenings, updateLivestockSettings } from "@/lib/livestock/movements";
import { dec, sub, toFixedString } from "@/lib/money/decimal";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { calculateGstReturn } from "@/lib/reports/gst-return";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "livestock-account-sales";

/** Examples LV13-LV16 (approved by Jess 11 Oct 2026), decision 506: the agent's account sale, entered once. */
describeWithDatabase("livestock account sales (LV13-LV16)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let agent: Contact;

  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const balance = (code: string) =>
    run(async (tx) =>
      toFixedString(
        dec(
          (
            await tx.query<{ balance: string }>(
              `select coalesce(sum(l.debit_amount - l.credit_amount), 0)::text as balance
                 from ledger_journal_lines l join accounts a on a.id = l.account_id where a.code = $1`,
              [code],
            )
          ).rows[0].balance,
        ),
        2,
      ),
    );
  const sale = (reference: string, idempotencyKey = key("as")) =>
    run((tx) =>
      recordAccountSale(tx, {
        idempotencyKey,
        contactId: agent.id,
        reference,
        saleDate: "2026-03-10",
        dueDate: "2026-03-20",
        lines: [
          { kind: "dairy_cattle", classCode: "ma_cows", head: 50, amount: "55000.00" },
          { kind: "dairy_cattle", classCode: "r2_heifers", head: 10, amount: "11000.00" },
        ],
        deductions: [
          { description: "Commission", accountCode: "6230", amount: "3300.00" },
          { description: "Freight", accountCode: "6060", amount: "600.00" },
        ],
      }),
    );
  const closing = async (classCode: string) => (await run((tx) => headCount(tx, { yearEnd: "2026-05-31" }))).rows.find((row) => row.classCode === classCode)!;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    await run((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 5 }));
    await run((tx) => updateLivestockSettings(tx, { enabled: true, firstYearStart: "2025-06-01" }));
    await run((tx) =>
      setOpenings(tx, {
        lines: [
          { kind: "dairy_cattle", classCode: "ma_cows", head: 300, value: "750000.00" },
          { kind: "dairy_cattle", classCode: "r2_heifers", head: 70, value: "154000.00" },
          { kind: "dairy_cattle", classCode: "r1_heifers", head: 75, value: "86250.00" },
        ],
      }),
    );
    await run((tx) => createAccount(tx, { code: "6230", name: "Stock agent commission", accountType: "expense", defaultTaxCode: "GST" }));
    agent = (await run((tx) => createContact(tx, { idempotencyKey: key("c"), name: "PGG Wrightson", isSupplier: true }))).contact;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("LV13, LV14: the agent owes the net, the stock leaves by class, and GST sees both sides", async () => {
    const gstBefore = await run((tx) => calculateGstReturn(tx, { periodStart: "2026-03-01", periodEnd: "2026-03-31" }));
    const result = await sale("AS-48213");
    expect(result.accountSale).toMatchObject({ reference: "AS-48213", gross: "75900.00", deductions: "4485.00", net: "71415.00", amountDue: "71415.00", status: "active" });
    // The same net as one journal: Dr 1100 71,415.00, 6230 3,300.00, 6060 600.00, 2100 585.00; Cr 4300 66,000.00, 2100 9,900.00.
    expect(await balance("1100")).toBe("71415.00");
    expect(await balance("4300")).toBe("-66000.00");
    expect(await balance("6230")).toBe("3300.00");
    expect(await balance("6060")).toBe("600.00");
    expect(await balance("2100")).toBe("-9315.00");
    expect(await balance("1090")).toBe("0.00");
    expect(await closing("ma_cows")).toMatchObject({ sold: 50 });
    expect(await closing("r2_heifers")).toMatchObject({ sold: 10 });

    const gst = await run((tx) => calculateGstReturn(tx, { periodStart: "2026-03-01", periodEnd: "2026-03-31" }));
    expect(toFixedString(sub(dec(gst.boxes.box5), dec(gstBefore.boxes.box5)), 2)).toBe("75900.00");
    expect(toFixedString(sub(dec(gst.boxes.box11), dec(gstBefore.boxes.box11)), 2)).toBe("4485.00");
  });

  it("LV15: the same account sale again is refused; a retry with the same key is the same one", async () => {
    await expect(sale("as-48213")).rejects.toThrow(/already entered/);
    const retryKey = key("as");
    const first = await sale("AS-50001", retryKey);
    const again = await sale("AS-50001", retryKey);
    expect(again).toMatchObject({ created: false, accountSale: { id: first.accountSale.id } });
    expect(await closing("ma_cows")).toMatchObject({ sold: 100 });
  });

  it("LV16: voiding reverses everything, once the agent's payment is voided first", async () => {
    const entered = await sale("AS-60000");
    const invoiceId = entered.accountSale.invoiceId;
    const paid = await run((tx) => recordPayment(tx, invoiceId, { idempotencyKey: key("p"), paymentDate: "2026-03-20", amount: "71415.00", bankAccountCode: "1000" }));
    expect((await run((tx) => getInvoice(tx, invoiceId))).amountDue).toBe("0.00");
    await expect(run((tx) => voidAccountSale(tx, entered.accountSale.id, { reason: "Entered twice" }))).rejects.toThrow(/Void that payment first/);
    await run((tx) => voidPayment(tx, invoiceId, paid.payment.id, { idempotencyKey: key("vp"), voidDate: "2026-03-20" }));
    const soldBefore = (await closing("ma_cows")).sold;
    const voided = await run((tx) => voidAccountSale(tx, entered.accountSale.id, { reason: "Entered twice" }));
    expect(voided.status).toBe("voided");
    expect((await closing("ma_cows")).sold).toBe(soldBefore - 50);
    expect((await run((tx) => getInvoice(tx, invoiceId))).status).toBe("voided");
    // Two account sales left, each owed in full by the agent; the contra account is back to zero.
    expect(await balance("1100")).toBe("142830.00");
    expect(await balance("1090")).toBe("0.00");
    // Voided, its reference can be entered again.
    await expect(sale("AS-60000")).resolves.toMatchObject({ created: true });
  });
});
