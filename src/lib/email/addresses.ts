import { ValidationError } from "@/lib/errors";

/**
 * Email addresses and header text for emails Tohyee sends from an
 * organisation's own account (browser-safe, so the dialog checks the same
 * way). Addresses are plain `name@domain` only: no display names, quotes,
 * angle brackets, spaces or line breaks, so nothing typed in can add a
 * header (header injection) or smuggle in another recipient.
 */

/** A plain address: the usual characters before the @, and a domain with a dot. */
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export const MAX_RECIPIENTS = 20;

export function isEmailAddress(value: string): boolean {
  return value.length <= 254 && ADDRESS.test(value) && !value.startsWith(".") && !value.includes("..");
}

/**
 * Splits what someone typed (commas, semicolons, spaces or new lines between
 * addresses, or an array) into addresses, lower-cased with duplicates
 * removed, plus anything that isn't a valid address.
 */
export function splitAddresses(input: unknown): { addresses: string[]; invalid: string[] } {
  const parts = Array.isArray(input)
    ? input.flatMap((item) => (typeof item === "string" ? item.split(/[,;\s]+/) : [String(item)]))
    : typeof input === "string"
      ? input.split(/[,;\s]+/)
      : input == null
        ? []
        : [String(input)];
  const addresses: string[] = [];
  const invalid: string[] = [];
  for (const raw of parts) {
    const value = raw.trim();
    if (!value) continue;
    if (!isEmailAddress(value)) {
      invalid.push(value);
      continue;
    }
    const lower = value.toLowerCase();
    if (!addresses.includes(lower)) addresses.push(lower);
  }
  return { addresses, invalid };
}

/** Addresses for a field (To, Cc), or a message saying what's wrong. */
export function requireAddresses(input: unknown, label: string, options: { required: boolean }): string[] {
  const { addresses, invalid } = splitAddresses(input);
  if (invalid.length > 0) {
    throw new ValidationError(
      `${label}: ${invalid.map((value) => `"${value.slice(0, 80)}"`).join(", ")} ${invalid.length === 1 ? "isn't an email address" : "aren't email addresses"}. Enter addresses like accounts@example.co.nz, separated by commas.`,
    );
  }
  if (options.required && addresses.length === 0) throw new ValidationError(`${label}: enter at least one email address.`);
  if (addresses.length > MAX_RECIPIENTS) throw new ValidationError(`${label}: at most ${MAX_RECIPIENTS} addresses.`);
  return addresses;
}

/** One address (e.g. the from or reply-to address), or null when blank. */
export function optionalAddress(input: unknown, label: string): string | null {
  if (input == null || (typeof input === "string" && input.trim() === "")) return null;
  if (typeof input !== "string" || !isEmailAddress(input.trim())) {
    throw new ValidationError(`${label} must be one email address, like accounts@example.co.nz.`);
  }
  return input.trim().toLowerCase();
}

/**
 * Text that goes in a header (subject, from name): line breaks and other
 * control characters become spaces, runs of spaces become one.
 */
export function headerText(input: string, maxLength: number): string {
  return input.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}
