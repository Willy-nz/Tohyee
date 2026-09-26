import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { ValidationError } from "@/lib/errors";

type ScryptParams = { N: number; r: number; p: number };

const DEFAULT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MAX_MEMORY = 128 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEMORY },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
}

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

export function validateNewPassword(input: unknown, fieldName = "password"): string {
  if (typeof input !== "string") {
    throw new ValidationError(`${fieldName} is required.`);
  }
  if (input.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`${fieldName} must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (input.length > MAX_PASSWORD_LENGTH) {
    throw new ValidationError(`${fieldName} can be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
  return input;
}

/** Returns "scrypt$N$r$p$<salt base64>$<hash base64>". */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, DEFAULT_PARAMS);
  const { N, r, p } = DEFAULT_PARAMS;
  return ["scrypt", N, r, p, salt.toString("base64"), derived.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const [, n, r, p, saltText, hashText] = parts;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (![params.N, params.r, params.p].every((value) => Number.isInteger(value) && value > 0)) {
    return false;
  }
  const expected = Buffer.from(hashText, "base64");
  const derived = await scrypt(password, Buffer.from(saltText, "base64"), params);
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

let dummyHash: Promise<string> | null = null;

/**
 * Burns the same time as a real check, so sign-in responses don't reveal
 * whether an email address has an account.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword("toeyee-dummy-password-for-timing");
  await verifyPassword(password, await dummyHash);
}
