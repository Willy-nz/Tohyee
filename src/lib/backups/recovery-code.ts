import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { ValidationError } from "@/lib/errors";

/**
 * The recovery kit's two forms (#389, decision 735; docs/BACKUP-RECOVERY.md).
 * Both hold one version of the backup recovery key and nothing else.
 *
 * - The recovery code: the 32-byte key in Crockford base32 with a
 *   4-character check, in groups of four: RK<version>-XXXX-XXXX-…
 * - The recovery file (.tohyee-recovery): JSON with the code encrypted with
 *   AES-256-GCM under a key from scrypt (N = 2^17, r = 8, p = 1) of a
 *   passphrase. Its version, key id and date are in the clear, and
 *   authenticated with it.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O or U

function toBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text: string, byteLength: number): Buffer | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return out.length >= byteLength ? Buffer.from(out.slice(0, byteLength)) : null;
}

function check(version: number, key: Buffer): string {
  const digest = createHash("sha256").update(`tohyee recovery code v${version}\0`).update(key).digest();
  return toBase32(digest).slice(0, 4);
}

/** The recovery code for one version of the recovery key. */
export function formatRecoveryCode(version: number, key: Buffer): string {
  if (!Number.isInteger(version) || version < 1 || key.length !== 32) throw new Error("Not a recovery key.");
  const body = toBase32(key) + check(version, key); // 52 + 4 characters
  return `RK${version}-${body.match(/.{1,4}/g)!.join("-")}`;
}

/**
 * Reads a recovery code. Spaces, dashes and case don't matter; O is read as
 * 0 and I or L as 1, as Crockford base32 says. A mistyped character is
 * caught by the check at the end.
 */
export function parseRecoveryCode(text: unknown): { version: number; key: Buffer } {
  if (typeof text !== "string" || !text.trim()) throw new ValidationError("Paste or type the recovery code.");
  const match = /^\s*rk\s*(\d{1,4})\s*[-\s]\s*([0-9a-z\s-]+)$/i.exec(text);
  if (!match) throw new ValidationError("That isn't a recovery code. It starts with RK and a number, like RK1-7F3K-….");
  const version = Number(match[1]);
  const body = match[2]
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (body.length !== 56) throw new ValidationError(`A recovery code has 56 characters after RK${version}; that one has ${body.length}. Check nothing is missing.`);
  const key = fromBase32(body.slice(0, 52), 32);
  if (!key || version < 1) throw new ValidationError("That recovery code has a character that can't be in one. Check it again.");
  const expected = Buffer.from(check(version, key));
  const given = Buffer.from(body.slice(52));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new ValidationError("That recovery code has a mistake in it (its last four characters don't match the rest). Check each character again.");
  }
  return { version, key };
}

// ---------------------------------------------------------------- the file

export const RECOVERY_FILE_EXTENSION = ".tohyee-recovery";
export const MIN_PASSPHRASE_LENGTH = 14;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;

type RecoveryFile = {
  tohyee: "recovery-kit";
  format: 1;
  keyVersion: number;
  keyId: string;
  madeAt: string;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
};

function scryptKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize("NFKC"), salt, 32, { ...params, maxmem: SCRYPT.maxmem }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** The parts of the file that aren't secret, in a fixed order: the additional data its encryption is tied to. */
function publicPart(file: Pick<RecoveryFile, "tohyee" | "format" | "keyVersion" | "keyId" | "madeAt" | "kdf" | "cipher">): Buffer {
  return Buffer.from(
    JSON.stringify([file.tohyee, file.format, file.keyVersion, file.keyId, file.madeAt, file.kdf.name, file.kdf.N, file.kdf.r, file.kdf.p, file.kdf.salt, file.cipher]),
    "utf8",
  );
}

export function checkPassphrase(passphrase: unknown): string {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new ValidationError(`The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters. A few unrelated words, or the one Tohyee suggests, are good.`);
  }
  if (new Set(passphrase).size < 6) throw new ValidationError("That passphrase is too easy to guess. Use a few unrelated words, or the one Tohyee suggests.");
  return passphrase;
}

/** A recovery file for one key version, encrypted with the passphrase. */
export async function makeRecoveryFile(input: { version: number; id: string; key: Buffer; madeAt?: string }, passphrase: string): Promise<string> {
  checkPassphrase(passphrase);
  const salt = randomBytes(32);
  const header = {
    tohyee: "recovery-kit" as const,
    format: 1 as const,
    keyVersion: input.version,
    keyId: input.id,
    madeAt: input.madeAt ?? new Date().toISOString(),
    kdf: { name: "scrypt" as const, N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64") },
    cipher: "aes-256-gcm" as const,
  };
  const key = await scryptKey(passphrase, salt, SCRYPT);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(publicPart(header));
  const data = Buffer.concat([cipher.update(formatRecoveryCode(input.version, input.key), "utf8"), cipher.final()]);
  const file: RecoveryFile = { ...header, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** What a recovery file says about itself, without the passphrase. */
export function describeRecoveryFile(text: unknown): { keyVersion: number; keyId: string; madeAt: string } {
  const file = readFile(text);
  return { keyVersion: file.keyVersion, keyId: file.keyId, madeAt: file.madeAt };
}

function readFile(text: unknown): RecoveryFile {
  if (typeof text !== "string" || !text.trim()) throw new ValidationError("Choose the recovery file.");
  let file: RecoveryFile;
  try {
    file = JSON.parse(text) as RecoveryFile;
  } catch {
    throw new ValidationError("That isn't a Tohyee recovery file (it can't be read).");
  }
  if (!file || file.tohyee !== "recovery-kit") throw new ValidationError("That isn't a Tohyee recovery file.");
  if (file.format !== 1 || file.cipher !== "aes-256-gcm" || file.kdf?.name !== "scrypt") {
    throw new ValidationError("That recovery file was made by a newer version of Tohyee. Update this server first.");
  }
  const { N, r, p } = file.kdf;
  // Only sensible scrypt settings are tried, so a made-up file can't make the server work forever.
  if (![2 ** 15, 2 ** 16, 2 ** 17, 2 ** 18].includes(N) || r !== 8 || p !== 1) throw new ValidationError("That recovery file's settings aren't ones Tohyee makes.");
  if (!Number.isInteger(file.keyVersion) || typeof file.keyId !== "string" || typeof file.iv !== "string" || typeof file.tag !== "string" || typeof file.data !== "string") {
    throw new ValidationError("That recovery file is damaged.");
  }
  return file;
}

/** Opens a recovery file with its passphrase; a wrong passphrase or a changed file is refused. */
export async function openRecoveryFile(text: unknown, passphrase: unknown): Promise<{ version: number; key: Buffer; id: string; madeAt: string }> {
  const file = readFile(text);
  if (typeof passphrase !== "string" || !passphrase) throw new ValidationError("Type the recovery file's passphrase.");
  const key = await scryptKey(passphrase, Buffer.from(file.kdf.salt, "base64"), file.kdf);
  let code: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "base64"));
    decipher.setAAD(publicPart(file));
    decipher.setAuthTag(Buffer.from(file.tag, "base64"));
    code = Buffer.concat([decipher.update(Buffer.from(file.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new ValidationError("That passphrase doesn't open this recovery file (or the file was changed). Check the passphrase and try again.");
  }
  const parsed = parseRecoveryCode(code);
  if (parsed.version !== file.keyVersion) throw new ValidationError("That recovery file is damaged.");
  return { version: parsed.version, key: parsed.key, id: file.keyId, madeAt: file.madeAt };
}

/** A passphrase to suggest: 5 groups of 5 letters and digits (about 125 bits), easy to read aloud and type. */
export function suggestPassphrase(): string {
  const groups: string[] = [];
  for (let g = 0; g < 5; g += 1) {
    let group = "";
    for (let i = 0; i < 5; i += 1) group += ALPHABET[randomInt(32)].toLowerCase();
    groups.push(group);
  }
  return groups.join("-");
}

/** An optional random file name: a convenience only, never security (anyone who can read the file can see what it is). */
export function randomRecoveryFileName(): string {
  return `${toBase32(randomBytes(10)).toLowerCase()}${RECOVERY_FILE_EXTENSION}`;
}

export function recoveryFileName(version: number): string {
  return `tohyee-recovery-kit-v${version}${RECOVERY_FILE_EXTENSION}`;
}
