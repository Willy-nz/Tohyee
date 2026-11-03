import { describe, expect, it } from "vitest";
import {
  akahuLinkability,
  akahuLoginStatus,
  describeSchedule,
  describeSyncResult,
  linkChoiceGaps,
  type LinkedFeed,
  suggestTohyeeAccount,
} from "@/lib/bank/akahu/setup";

const feed = (change: Partial<LinkedFeed> = {}): LinkedFeed => ({
  accountId: "1",
  code: "1000",
  name: "ANZ cheque",
  feedActive: true,
  lastSyncStatus: "never",
  lastSyncedAt: null,
  lastSyncOkAt: null,
  lastSyncAdded: null,
  lastSyncError: null,
  linesBroughtIn: 0,
  ...change,
});

describe("which Akahu accounts can be linked (#543, decision 1290)", () => {
  it("ticks everyday, savings and credit card accounts that give transactions", () => {
    expect(akahuLinkability({ type: "CHECKING", status: "ACTIVE", attributes: ["TRANSACTIONS", "PAYMENT_TO"] })).toEqual({
      canLink: true,
      reason: null,
      linkByDefault: true,
      accountType: "bank",
    });
    expect(akahuLinkability({ type: "CREDITCARD", status: "ACTIVE", attributes: ["TRANSACTIONS"] })).toMatchObject({ canLink: true, accountType: "credit_card" });
    // Attributes missing (an older answer): assumed to give transactions.
    expect(akahuLinkability({ type: "SAVINGS", status: null, attributes: null })).toMatchObject({ canLink: true, linkByDefault: true });
  });

  it("offers a KiwiSaver or loan account without ticking it", () => {
    expect(akahuLinkability({ type: "KIWISAVER", status: "ACTIVE", attributes: ["TRANSACTIONS"] })).toMatchObject({ canLink: true, linkByDefault: false });
  });

  it("won't link an account with no transactions, a lost connection, or another currency", () => {
    expect(akahuLinkability({ type: "TERMDEPOSIT", status: "ACTIVE", attributes: [] }).reason).toBe("Akahu can't get transactions for this account.");
    expect(akahuLinkability({ type: "CHECKING", status: "INACTIVE", attributes: ["TRANSACTIONS"] }).reason).toMatch(/^Akahu has lost its connection/);
    expect(akahuLinkability({ type: "FOREIGN", status: "ACTIVE", attributes: ["TRANSACTIONS"] }).canLink).toBe(false);
  });
});

describe("suggesting the Tohyee account (#543)", () => {
  const chart = [
    { id: "1", code: "1000", name: "ANZ cheque", description: "01-0123-0456789-00" },
    { id: "2", code: "1010", name: "BNZ savings", description: null },
    { id: "3", code: "2100", name: "Visa", description: null },
    { id: "4", code: "2110", name: "visa", description: null },
  ];
  it("matches the bank account number, with a 2- or 3-digit suffix", () => {
    expect(suggestTohyeeAccount({ name: "Go", formattedAccount: "01-0123-0456789-000" }, chart)).toBe("1");
  });
  it("else the same name, ignoring case and spaces", () => {
    expect(suggestTohyeeAccount({ name: "BNZ  Savings", formattedAccount: "02-0000-1111111-00" }, chart)).toBe("2");
  });
  it("guesses nothing when two fit or none do", () => {
    expect(suggestTohyeeAccount({ name: "Visa", formattedAccount: null }, chart)).toBeNull();
    expect(suggestTohyeeAccount({ name: "Kiwibank", formattedAccount: null }, chart)).toBeNull();
  });
});

describe("the choose-accounts step's gaps", () => {
  it("needs one account ticked, each with its own Tohyee account", () => {
    expect(linkChoiceGaps([{ akahuAccountId: "acc_a", label: "ANZ Cheque", link: false, accountId: "" }])).toEqual(["Tick at least one account to link."]);
    expect(
      linkChoiceGaps([
        { akahuAccountId: "acc_a", label: "ANZ Cheque", link: true, accountId: "1" },
        { akahuAccountId: "acc_b", label: "ANZ Saver", link: true, accountId: "1" },
        { akahuAccountId: "acc_c", label: "Visa", link: true, accountId: "" },
      ]),
    ).toEqual(["Choose where Visa goes, or add an account for it.", "ANZ Cheque and ANZ Saver can't both go into the same account. Each needs its own."]);
    expect(linkChoiceGaps([{ akahuAccountId: "acc_a", label: "ANZ Cheque", link: true, accountId: "1" }])).toEqual([]);
  });
});

describe("a login's status on the bank feed card (#543, decision 1289)", () => {
  it("goes from accounts needing linking, to ready, to succeeded", () => {
    expect(akahuLoginStatus({ tokenProblem: null, linkedAccounts: [] })).toMatchObject({ state: "needs_linking", label: "Accounts need linking" });
    expect(akahuLoginStatus({ tokenProblem: null, linkedAccounts: [feed()] })).toMatchObject({ state: "ready", label: "Ready to sync", lastSuccessAt: null });
    const ok = akahuLoginStatus({
      tokenProblem: null,
      linkedAccounts: [feed({ lastSyncStatus: "ok", lastSyncOkAt: "2026-11-03T01:00:00Z", lastSyncAdded: 0 }), feed({ lastSyncStatus: "ok", lastSyncOkAt: "2026-11-03T02:00:00Z" })],
    });
    expect(ok).toMatchObject({ state: "ok", label: "Last sync succeeded", lastSuccessAt: "2026-11-03T02:00:00Z" });
  });
  it("puts refused tokens first, then failed or stopped feeds, keeping the last success", () => {
    const failed = feed({ lastSyncStatus: "failed", lastSyncOkAt: "2026-11-01T00:00:00Z", lastSyncError: "Akahu couldn't be reached." });
    expect(akahuLoginStatus({ tokenProblem: "Akahu needs new tokens.", linkedAccounts: [failed] })).toMatchObject({ state: "tokens_refused" });
    expect(akahuLoginStatus({ tokenProblem: null, linkedAccounts: [failed] })).toMatchObject({ state: "failed", lastSuccessAt: "2026-11-01T00:00:00Z" });
    expect(akahuLoginStatus({ tokenProblem: null, linkedAccounts: [feed({ feedActive: false, lastSyncStatus: "ok" })] }).state).toBe("failed");
  });
  it("tells nothing new apart from never synced, and shows the schedule as a schedule", () => {
    expect(describeSyncResult(null)).toBe("Not synced yet");
    expect(describeSyncResult({ added: 0 })).toBe("Nothing new");
    expect(describeSyncResult({ added: 1, duplicates: 2 })).toBe("1 new line (2 already here)");
    expect(describeSyncResult({ added: 12, duplicates: 0, possibleDuplicates: 1 })).toBe("12 new lines (1 flagged as possible duplicates)");
    expect(describeSchedule(6)).toBe("Checks Akahu every 6 hours");
    expect(describeSchedule(1)).toBe("Checks Akahu every hour");
  });
});
