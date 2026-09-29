import { afterAll, beforeAll, expect, it } from "vitest";
import { updateAccount } from "@/lib/accounts/service";
import type { Actor } from "@/lib/db/org-transaction";
import { postMovement } from "@/lib/inventory/movements";
import { postFxRevaluation } from "@/lib/ledger/fx-revaluation";
import { correctJournal, getJournal, postJournal } from "@/lib/ledger/journals";
import { inventoryValuation, trialBalance } from "@/lib/reports/financial";
import {
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const ORG = "stock-co";

function movement(fields: Record<string, unknown>) {
  return {
    idempotencyKey: key("m"),
    movementDate: "2026-08-01",
    reference: "STOCK",
    inventoryAccountCode: "1400",
    offsetAccountCode: fields.movementType === "receipt" ? "2000" : "5000",
    ...fields,
  };
}

describeWithDatabase("inventory and FX revaluation", () => {
  let server: TestServer;
  let actor: Actor;
  const inOrg = <T>(work: Parameters<typeof inOrganisation<T>>[2]) => inOrganisation(ORG, actor, work);

  beforeAll(async () => {
    server = await startTestServer();
    const owner = await createTestUser("stock@example.com", { serverAdmin: true });
    actor = { userId: owner.id, email: owner.email };
    await createTestOrganisation(owner, ORG);
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("W1: 3 @ $3.33, sell 1 -> COGS $3.33, posted in NZD", async () => {
    await inOrg((tx) => postMovement(tx, movement({ movementType: "receipt", itemCode: "PAW-CHARM", quantity: "3", unitCost: "3.33" })));
    const sale = await inOrg((tx) =>
      postMovement(tx, movement({ movementType: "issue", itemCode: "PAW-CHARM", quantity: "1" })),
    );
    expect(sale.movement.valueDelta).toBe("-3.33");
    expect(sale.movement.valueAfter).toBe("6.66");

    const journal = await inOrg((tx) => getJournal(tx, sale.movement.ledgerJournalId));
    expect(journal.currencyCode).toBe("NZD");
    expect(journal.origin).toBe("inventory");
    expect(journal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["1400", "0.00", "3.33"],
      ["5000", "3.33", "0.00"],
    ]);
  });

  it("W2: 999 @ $2.57, sell 1 -> COGS $2.57 (not $257)", async () => {
    await inOrg((tx) => postMovement(tx, movement({ movementType: "receipt", itemCode: "NOSE-PENDANT", quantity: "999", unitCost: "2.57" })));
    const sale = await inOrg((tx) =>
      postMovement(tx, movement({ movementType: "issue", itemCode: "NOSE-PENDANT", quantity: "1" })),
    );
    expect(sale.movement.valueDelta).toBe("-2.57");
  });

  it("stock subledger equals the inventory account to the cent", async () => {
    const valuation = await inOrg((tx) => inventoryValuation(tx));
    const tb = await inOrg((tx) => trialBalance(tx, { asAt: "2026-12-31" }));
    const inventoryAccount = tb.rows.find((row) => row.code === "1400")!;
    expect(inventoryAccount.debit).toBe(valuation.totalValue);
  });

  it("refuses backdated movements instead of mis-costing them", async () => {
    await expect(
      inOrg((tx) =>
        postMovement(tx, movement({ movementType: "receipt", itemCode: "PAW-CHARM", quantity: "1", unitCost: "4", movementDate: "2026-07-01" })),
      ),
    ).rejects.toThrow(/Backdated stock movements aren't supported yet/);
  });

  it("W7: refuses negative stock", async () => {
    await expect(
      inOrg((tx) => postMovement(tx, movement({ movementType: "issue", itemCode: "PAW-CHARM", quantity: "5" }))),
    ).rejects.toThrow(/Stock can't go negative/);
  });

  it("D3: an identical retry of a sale that emptied the stock returns the original movement", async () => {
    const command = movement({ movementType: "issue", itemCode: "PAW-CHARM", quantity: "2" });
    const first = await inOrg((tx) => postMovement(tx, command));
    expect(first.movement.quantityAfter).toBe("0");
    // Regression: an earlier version re-ran the sale before checking the key and failed here.
    const retry = await inOrg((tx) => postMovement(tx, command));
    expect(retry.created).toBe(false);
    expect(retry.movement.id).toBe(first.movement.id);
  });

  it("C6: stock journals can't be corrected in the ledger (keeps stock and GL in step)", async () => {
    const receipt = await inOrg((tx) =>
      postMovement(tx, movement({ movementType: "receipt", itemCode: "TAG", quantity: "1", unitCost: "10" })),
    );
    await expect(
      inOrg((tx) =>
        correctJournal(tx, {
          idempotencyKey: key("c"),
          originalJournalId: receipt.movement.ledgerJournalId,
          postingDate: "2026-08-02",
          reference: "X",
          lines: [
            { accountCode: "1400", debitAmount: "5" },
            { accountCode: "2000", creditAmount: "5" },
          ],
        }),
      ),
    ).rejects.toThrow(/created by a stock movement/);
  });

  it("W8: customer returns restock at the original sale's cost", async () => {
    await inOrg((tx) => postMovement(tx, movement({ movementType: "receipt", itemCode: "RING", quantity: "10", unitCost: "5" })));
    const sale = await inOrg((tx) => postMovement(tx, movement({ movementType: "issue", itemCode: "RING", quantity: "4" })));
    await inOrg((tx) => postMovement(tx, movement({ movementType: "receipt", itemCode: "RING", quantity: "6", unitCost: "8" })));
    const back = await inOrg((tx) =>
      postMovement(
        tx,
        movement({ movementType: "customer_return", itemCode: "RING", quantity: "1", originalMovementId: sale.movement.id }),
      ),
    );
    expect(back.movement.valueDelta).toBe("5.00");
  });

  it("F1-F5, C6: FX revaluation takes the carrying amount from the ledger and auto-reverses", async () => {
    // A USD bank account holding USD 1,000 booked at NZD 1,600.
    await inOrg(async (tx) => {
      const accounts = await tx.query<{ id: string }>("select id from accounts where code = '1000'");
      await updateAccount(tx, accounts.rows[0].id, { currencyCode: "USD", name: "USD account" });
    });
    await inOrg((tx) =>
      postJournal(tx, {
        idempotencyKey: key("fx-open"),
        postingDate: "2026-08-10",
        reference: "USD-IN",
        lines: [
          { accountCode: "1000", debitAmount: "1600" },
          { accountCode: "3000", creditAmount: "1600" },
        ],
      }),
    );

    const result = await inOrg((tx) =>
      postFxRevaluation(tx, {
        idempotencyKey: key("fx"),
        reference: "FX-2026-08",
        revaluationDate: "2026-08-31",
        reversalPostingDate: "2026-09-01",
        rateDate: "2026-08-31",
        rateSource: "RBNZ close",
        unrealisedGainAccountCode: "7000",
        unrealisedLossAccountCode: "7010",
        balances: [{ accountCode: "1000", foreignAmount: "1000", closingRate: "1.6543" }],
      }),
    );
    const [item] = result.run.items;
    expect(item.carryingAmount).toBe("1600.00");
    expect(item.revaluedAmount).toBe("1654.30");
    expect(item.deltaAmount).toBe("54.30");

    const revaluation = await inOrg((tx) => getJournal(tx, result.run.revaluationJournalId));
    expect(revaluation.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["1000", "54.30", "0.00"],
      ["7000", "0.00", "54.30"],
    ]);
    const reversal = await inOrg((tx) => getJournal(tx, result.run.reversalJournalId));
    expect(reversal.postingDate).toBe("2026-09-01");
    expect(reversal.lines[0]).toMatchObject({ accountCode: "1000", creditAmount: "54.30" });

    // C6: revaluation journals are corrected by revaluing again, not in the ledger.
    await expect(
      inOrg((tx) =>
        correctJournal(tx, {
          idempotencyKey: key("fix-fx"),
          originalJournalId: result.run.revaluationJournalId,
          postingDate: "2026-09-02",
          reference: "X",
          lines: [
            { accountCode: "1000", debitAmount: "1" },
            { accountCode: "7000", creditAmount: "1" },
          ],
        }),
      ),
    ).rejects.toThrow(/created by an FX revaluation/);

    // After the reversal date the unrealised gain is gone again.
    const september = await inOrg((tx) => trialBalance(tx, { asAt: "2026-09-30" }));
    expect(september.rows.find((row) => row.code === "7000")).toBeUndefined();

    // Revaluing the same account on the same date twice is refused.
    await expect(
      inOrg((tx) =>
        postFxRevaluation(tx, {
          idempotencyKey: key("fx-dup"),
          reference: "FX-DUP",
          revaluationDate: "2026-08-31",
          reversalPostingDate: "2026-09-01",
          rateDate: "2026-08-31",
          rateSource: "RBNZ close",
          unrealisedGainAccountCode: "7000",
          unrealisedLossAccountCode: "7010",
          balances: [{ accountCode: "1000", foreignAmount: "1000", closingRate: "1.70" }],
        }),
      ),
    ).rejects.toThrow(/already revalued/);
  });

  it("F6/F7: a USD payable worth more in NZD is a loss; base-currency accounts can't be revalued", async () => {
    await inOrg(async (tx) => {
      await tx.query(
        "insert into accounts (code, name, account_class, account_type, currency_code) values ('2020', 'USD suppliers', 'liability', 'current_liability', 'USD')",
      );
    });
    // Owe USD 500, booked at NZD 800.
    await inOrg((tx) =>
      postJournal(tx, {
        idempotencyKey: key("usd-bill"),
        postingDate: "2026-08-12",
        reference: "USD-BILL",
        lines: [
          { accountCode: "6070", debitAmount: "800" },
          { accountCode: "2020", creditAmount: "800" },
        ],
      }),
    );
    const result = await inOrg((tx) =>
      postFxRevaluation(tx, {
        idempotencyKey: key("fx-liability"),
        reference: "FX-AP",
        revaluationDate: "2026-08-30",
        reversalPostingDate: "2026-08-31",
        rateDate: "2026-08-30",
        rateSource: "RBNZ close",
        unrealisedGainAccountCode: "7000",
        unrealisedLossAccountCode: "7010",
        balances: [{ accountCode: "2020", foreignAmount: "500", closingRate: "1.70" }],
      }),
    );
    // Now worth NZD 850: we owe 50 more, which is a loss.
    expect(result.run.items[0]).toMatchObject({ carryingAmount: "800.00", revaluedAmount: "850.00", deltaAmount: "50.00" });
    const journal = await inOrg((tx) => getJournal(tx, result.run.revaluationJournalId));
    expect(journal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["2020", "0.00", "50.00"],
      ["7010", "50.00", "0.00"],
    ]);

    await expect(
      inOrg((tx) =>
        postFxRevaluation(tx, {
          idempotencyKey: key("fx-base"),
          reference: "FX-BASE",
          revaluationDate: "2026-08-30",
          reversalPostingDate: "2026-08-31",
          rateDate: "2026-08-30",
          rateSource: "RBNZ close",
          unrealisedGainAccountCode: "7000",
          unrealisedLossAccountCode: "7010",
          balances: [{ accountCode: "2000", foreignAmount: "10", closingRate: "1.6" }],
        }),
      ),
    ).rejects.toThrow(/NZD account/);

    // F7: a USD bank account that's overdrawn (a credit balance) isn't revalued.
    await inOrg(async (tx) => {
      await tx.query(
        "insert into accounts (code, name, account_class, account_type, currency_code) values ('1010', 'USD card float', 'asset', 'bank', 'USD')",
      );
    });
    await inOrg((tx) =>
      postJournal(tx, {
        idempotencyKey: key("usd-overdrawn"),
        postingDate: "2026-08-12",
        reference: "USD-OUT",
        lines: [
          { accountCode: "6070", debitAmount: "100" },
          { accountCode: "1010", creditAmount: "100" },
        ],
      }),
    );
    await expect(
      inOrg((tx) =>
        postFxRevaluation(tx, {
          idempotencyKey: key("fx-overdrawn"),
          reference: "FX-OD",
          revaluationDate: "2026-08-30",
          reversalPostingDate: "2026-08-31",
          rateDate: "2026-08-30",
          rateSource: "RBNZ close",
          unrealisedGainAccountCode: "7000",
          unrealisedLossAccountCode: "7010",
          balances: [{ accountCode: "1010", foreignAmount: "60", closingRate: "1.70" }],
        }),
      ),
    ).rejects.toThrow(/has a credit balance/);
  });
});
