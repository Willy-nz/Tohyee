import { ValidationError } from "@/lib/errors";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validates a calendar date in YYYY-MM-DD form and returns it unchanged. */
export function parseIsoDate(input: unknown, fieldName: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new ValidationError(`${fieldName} is required (YYYY-MM-DD).`);
  }
  const value = input.trim();
  const match = ISO_DATE.exec(value);
  if (!match) {
    throw new ValidationError(`${fieldName} must use YYYY-MM-DD format.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900 ||
    year > 2999 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new ValidationError(`${fieldName} is not a real date.`);
  }
  return value;
}

export function parseOptionalIsoDate(input: unknown, fieldName: string): string | null {
  if (input == null || (typeof input === "string" && input.trim().length === 0)) {
    return null;
  }
  return parseIsoDate(input, fieldName);
}

/** The server's business time zone. Dates like "today" are taken from here. */
export function businessTimeZone(): string {
  return process.env.TOEYEE_TIME_ZONE?.trim() || "Pacific/Auckland";
}

/** Today's date (YYYY-MM-DD) in the business time zone. */
export function todayIsoDate(timeZone = businessTimeZone()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
