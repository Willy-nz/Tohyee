/**
 * The guided Akahu setup and the bank feed card's statuses (#543, decisions
 * 1288-1291). Pure functions only, so the screens and the server share them
 * and they can be tested without a database or Akahu.
 */

/**
 * A bank account number as Akahu formats it, as digits to compare; null when
 * there isn't a usable one. NZ numbers (bank-branch-account-suffix) have a
 * 2- or 3-digit suffix for the same account, so the suffix is made 3 digits:
 * 03-0123-0456789-00 and 03-0123-0456789-000 are the same account.
 */
export function akahuAccountNumber(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const nz = /^\s*(\d{2})[\s-]?(\d{4})[\s-]?(\d{7})[\s-]?(\d{2,3})\s*$/.exec(input);
  if (nz) return `${nz[1]}${nz[2]}${nz[3]}${nz[4].padStart(3, "0")}`;
  const digits = input.replace(/\D/g, "");
  return digits.length >= 6 && digits.length <= 34 ? digits : null;
}

/** What the setup needs to know about an Akahu account (as /api/bank-feeds/akahu/accounts gives it). */
export type AkahuAccountFacts = {
  type: string | null;
  status: string | null;
  /** Akahu's attributes, e.g. ["TRANSACTIONS", "PAYMENT_TO"]; null when Akahu didn't send any. */
  attributes: string[] | null;
};

export type Linkability = {
  /** False when the account can't bring in transactions (the reason says why). */
  canLink: boolean;
  reason: string | null;
  /** Ticked to link when the setup opens: everyday, savings and credit card accounts. */
  linkByDefault: boolean;
  /** The kind of Tohyee account a new one would be. */
  accountType: "bank" | "credit_card";
};

/**
 * Which Akahu accounts can be linked (decision 1290), from Akahu's account
 * model (developers.akahu.nz, "The Account Model", read 3 Nov 2026): only
 * accounts with the TRANSACTIONS attribute give transactions; an INACTIVE
 * account has lost its bank connection; a FOREIGN account holds another
 * currency, which an Akahu feed can't tell apart from NZD. Loans,
 * KiwiSaver, investments and the like can be linked but aren't ticked.
 */
export function akahuLinkability(account: AkahuAccountFacts): Linkability {
  const type = (account.type ?? "").toUpperCase();
  const accountType = type === "CREDITCARD" ? "credit_card" : "bank";
  if (account.attributes && !account.attributes.includes("TRANSACTIONS")) {
    return { canLink: false, reason: "Akahu can't get transactions for this account.", linkByDefault: false, accountType };
  }
  if ((account.status ?? "").toUpperCase() === "INACTIVE") {
    return {
      canLink: false,
      reason: "Akahu has lost its connection to this bank. Reconnect it at my.akahu.nz, then look again.",
      linkByDefault: false,
      accountType,
    };
  }
  if (type === "FOREIGN") {
    return { canLink: false, reason: "It's in another currency. Use statement files for it.", linkByDefault: false, accountType };
  }
  return { canLink: true, reason: null, linkByDefault: type === "" || type === "CHECKING" || type === "SAVINGS" || type === "CREDITCARD", accountType };
}

type Candidate = { id: string; code: string; name: string; description: string | null };

/**
 * The Tohyee account an Akahu account most likely is (decision 1290): one
 * whose name or description holds the same bank account number, else one
 * with the same name (ignoring case and spaces). Null when nothing fits or
 * more than one does: a guess between two would be a coin toss.
 */
export function suggestTohyeeAccount(akahu: { name: string; formattedAccount: string | null }, candidates: readonly Candidate[]): string | null {
  const number = akahuAccountNumber(akahu.formattedAccount);
  if (number) {
    const byNumber = candidates.filter((candidate) =>
      [candidate.name, candidate.description ?? ""].some((text) =>
        (text.match(/\d[\d\s-]{8,}\d/g) ?? []).some((found) => akahuAccountNumber(found) === number),
      ),
    );
    if (byNumber.length === 1) return byNumber[0].id;
    if (byNumber.length > 1) return null;
  }
  const plain = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
  const byName = candidates.filter((candidate) => plain(candidate.name) === plain(akahu.name));
  return byName.length === 1 ? byName[0].id : null;
}

/** One Akahu account's answer in the setup: link it to a Tohyee account (by id), or not. */
export type LinkChoice = { akahuAccountId: string; label: string; link: boolean; accountId: string };

/** What stops the "choose accounts" step going on, in plain words. Empty when it's fine. */
export function linkChoiceGaps(choices: readonly LinkChoice[]): string[] {
  const gaps: string[] = [];
  const chosen = choices.filter((choice) => choice.link);
  if (chosen.length === 0) gaps.push("Tick at least one account to link.");
  for (const choice of chosen) {
    if (!choice.accountId) gaps.push(`Choose where ${choice.label} goes, or add an account for it.`);
  }
  const seen = new Map<string, string>();
  for (const choice of chosen) {
    if (!choice.accountId) continue;
    const other = seen.get(choice.accountId);
    if (other) gaps.push(`${other} and ${choice.label} can't both go into the same account. Each needs its own.`);
    else seen.set(choice.accountId, choice.label);
  }
  return gaps;
}

/** A linked account's feed, as the bank feed card shows it. */
export type LinkedFeed = {
  accountId: string;
  code: string;
  name: string;
  feedActive: boolean;
  lastSyncStatus: "never" | "ok" | "failed";
  lastSyncedAt: string | null;
  lastSyncOkAt: string | null;
  /** New lines the last successful sync brought in; null when not known (synced before #543). */
  lastSyncAdded: number | null;
  lastSyncError: string | null;
  /** Lines the feed has brought in, all told (deleted ones not counted). */
  linesBroughtIn: number;
};

export type LoginState = "tokens_refused" | "needs_linking" | "ready" | "failed" | "ok";

export type LoginStatus = {
  state: LoginState;
  label: string;
  tone: "green" | "amber" | "red" | "blue";
  /** The newest successful sync of any of its accounts, or null. */
  lastSuccessAt: string | null;
};

/**
 * One login's status on the bank feed card (decision 1289), in order of
 * what needs doing first: tokens refused; no accounts linked ("Accounts
 * need linking"); an account whose last sync failed or that stopped; linked
 * but never synced ("Ready to sync"); otherwise "Last sync succeeded".
 * The sync schedule is never a status: it says when Tohyee will look, not
 * that anything came in.
 */
export function akahuLoginStatus(login: { tokenProblem: string | null; linkedAccounts: readonly LinkedFeed[] }): LoginStatus {
  const successes = login.linkedAccounts.map((account) => account.lastSyncOkAt).filter((at): at is string => Boolean(at));
  const lastSuccessAt = successes.length ? successes.reduce((a, b) => (new Date(a) > new Date(b) ? a : b)) : null;
  if (login.tokenProblem) return { state: "tokens_refused", label: "Needs new tokens", tone: "red", lastSuccessAt };
  if (login.linkedAccounts.length === 0) return { state: "needs_linking", label: "Accounts need linking", tone: "amber", lastSuccessAt };
  if (login.linkedAccounts.some((account) => !account.feedActive || account.lastSyncStatus === "failed")) {
    return { state: "failed", label: "Last sync failed", tone: "red", lastSuccessAt };
  }
  if (login.linkedAccounts.every((account) => account.lastSyncStatus === "never")) {
    return { state: "ready", label: "Ready to sync", tone: "blue", lastSuccessAt };
  }
  return { state: "ok", label: "Last sync succeeded", tone: "green", lastSuccessAt };
}

/** A sync's result in words: "12 new lines (3 already here)", "Nothing new", or a never-synced note. */
export function describeSyncResult(result: { added: number | null; duplicates?: number; possibleDuplicates?: number } | null): string {
  if (!result) return "Not synced yet";
  if (result.added === null) return "Synced";
  const extras = [
    result.duplicates ? `${result.duplicates} already here` : null,
    result.possibleDuplicates ? `${result.possibleDuplicates} flagged as possible duplicates` : null,
  ].filter(Boolean);
  const main = result.added === 0 ? "Nothing new" : `${result.added} new ${result.added === 1 ? "line" : "lines"}`;
  return extras.length ? `${main} (${extras.join(", ")})` : main;
}

/** The sync schedule as a schedule: "Checks Akahu every 6 hours". */
export function describeSchedule(hours: number): string {
  return hours === 1 ? "Checks Akahu every hour" : `Checks Akahu every ${hours} hours`;
}

