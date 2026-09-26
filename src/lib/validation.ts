import { ValidationError } from "@/lib/errors";

export function requireString(
  input: unknown,
  fieldName: string,
  options: { maxLength?: number; pattern?: RegExp; patternHint?: string } = {},
): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new ValidationError(`${fieldName} is required.`);
  }
  const value = input.trim();
  const maxLength = options.maxLength ?? 200;
  if (value.length > maxLength) {
    throw new ValidationError(`${fieldName} can be at most ${maxLength} characters.`);
  }
  if (options.pattern && !options.pattern.test(value)) {
    throw new ValidationError(options.patternHint ?? `${fieldName} has an invalid format.`);
  }
  return value;
}

export function optionalString(
  input: unknown,
  fieldName: string,
  options: { maxLength?: number } = {},
): string | null {
  if (input == null) {
    return null;
  }
  if (typeof input !== "string") {
    throw new ValidationError(`${fieldName} must be text.`);
  }
  const value = input.trim();
  if (value.length === 0) {
    return null;
  }
  const maxLength = options.maxLength ?? 500;
  if (value.length > maxLength) {
    throw new ValidationError(`${fieldName} can be at most ${maxLength} characters.`);
  }
  return value;
}

/** Database ids travel as strings (bigint columns). */
export function requireId(input: unknown, fieldName: string): string {
  const raw = typeof input === "number" ? String(input) : input;
  if (typeof raw !== "string" || !/^[1-9]\d{0,17}$/.test(raw.trim())) {
    throw new ValidationError(`${fieldName} must be a positive whole number.`);
  }
  return raw.trim();
}

export function optionalId(input: unknown, fieldName: string): string | null {
  if (input == null || (typeof input === "string" && input.trim().length === 0)) {
    return null;
  }
  return requireId(input, fieldName);
}

export function requireBoolean(input: unknown, fieldName: string): boolean {
  if (typeof input === "boolean") return input;
  if (input === "true") return true;
  if (input === "false") return false;
  throw new ValidationError(`${fieldName} must be true or false.`);
}

export function optionalBoolean(input: unknown, fieldName: string): boolean | null {
  if (input == null || input === "") return null;
  return requireBoolean(input, fieldName);
}

export function requireOneOf<T extends string>(
  input: unknown,
  fieldName: string,
  allowed: readonly T[],
): T {
  if (typeof input !== "string" || !allowed.includes(input.trim() as T)) {
    throw new ValidationError(`${fieldName} must be one of: ${allowed.join(", ")}.`);
  }
  return input.trim() as T;
}

export function requireArray(input: unknown, fieldName: string, maxItems = 500): unknown[] {
  if (!Array.isArray(input)) {
    throw new ValidationError(`${fieldName} must be a list.`);
  }
  if (input.length > maxItems) {
    throw new ValidationError(`${fieldName} can have at most ${maxItems} items.`);
  }
  return input;
}

export function asRecord(input: unknown, fieldName: string): Record<string, unknown> {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError(`${fieldName} must be an object.`);
  }
  return input as Record<string, unknown>;
}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,120}$/;

export function requireIdempotencyKey(input: unknown): string {
  return requireString(input, "idempotencyKey", {
    maxLength: 120,
    pattern: IDEMPOTENCY_KEY_PATTERN,
    patternHint:
      "idempotencyKey must be 8-120 characters of letters, numbers, dots, colons, dashes or underscores.",
  });
}

export function optionalSource(input: unknown): string {
  if (input == null || input === "") {
    return "api";
  }
  return requireString(input, "source", {
    maxLength: 40,
    pattern: /^[a-z][a-z0-9_-]{0,39}$/,
    patternHint: "source must be lower-case letters, numbers, dashes or underscores.",
  });
}
