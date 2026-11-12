import { createPublicKey, verify } from "node:crypto";

/*
 * Who published an installer (#154 part 1, decision 1601). A SHA-256 from
 * GitHub only proves the download is the file on the release; anyone who can
 * put a file on the release can put its fingerprint there too. So the release
 * workflow also signs "<this line>\n<file name>\n<SHA-256>\n" with Tohyee's
 * release key (an Ed25519 key kept only as the TOHYEE_RELEASE_SIGNING_KEY
 * secret on GitHub) and uploads the signature as <file name>.sig. The public
 * half is below, so a server checks the signature with a key it already has,
 * not one from GitHub. To change the key: make a new pair, put the new public
 * key here (keep the old one until every release signed with it is gone), and
 * replace the secret.
 */

export const RELEASE_SIGNATURE_LINE = "tohyee-release-signature-v1";

/** Tohyee's release keys (Ed25519, SPKI PEM). A signature from any of them is accepted. */
export const RELEASE_PUBLIC_KEYS: readonly string[] = [
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEArT/c57VSIOb/ok+1kkq5+5QzNBNiv+zl2uOm2dNjVAc=\n-----END PUBLIC KEY-----\n",
];

/** The exact text the workflow signs for a file. */
export function releaseSignedText(fileName: string, sha256: string): string {
  return `${RELEASE_SIGNATURE_LINE}\n${fileName}\n${sha256.toLowerCase()}\n`;
}

/** The .sig file's contents (one line of base64, a 64-byte Ed25519 signature) as bytes; null if it isn't one. */
export function signatureFromFile(text: string): Buffer | null {
  const line = text.trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(line)) return null;
  const bytes = Buffer.from(line, "base64");
  return bytes.length === 64 ? bytes : null;
}

/** True when the signature is one of the release keys' over this file name and SHA-256. */
export function releaseSignatureValid(fileName: string, sha256: string, signatureText: string, keys: readonly string[] = RELEASE_PUBLIC_KEYS): boolean {
  const signature = signatureFromFile(signatureText);
  if (!signature) return false;
  const data = Buffer.from(releaseSignedText(fileName, sha256), "utf8");
  return keys.some((pem) => {
    try {
      return verify(null, data, createPublicKey(pem), signature);
    } catch {
      return false;
    }
  });
}
