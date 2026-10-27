import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

/*
 * A made-up passkey authenticator for tests (#450): makes passkeys and signs
 * sign-ins the way a phone or security key does (WebAuthn level 3, "none"
 * attestation, ES256), so Tohyee's checks run against real signatures. It
 * lets a test do what a real authenticator wouldn't: answer for another
 * address, skip the face or finger check, send a lower use count, or claim to
 * be another login.
 */

// --- A small CBOR encoder: just what attestation objects and COSE keys need.
function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(length, 1);
  return out;
}

type Cbor = number | string | Buffer | Map<number | string, Cbor>;

function cbor(value: Cbor): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  const parts: Buffer[] = [head(5, value.size)];
  for (const [key, entry] of value) parts.push(cbor(key), cbor(entry));
  return Buffer.concat(parts);
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();
const b64url = (data: Buffer) => data.toString("base64url");

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export type SoftPasskey = {
  id: string;
  rpId: string;
  userHandle: string;
  privateKey: KeyObject;
  counter: number;
};

type CreationOptions = { challenge: string; rp: { id?: string }; user: { id: string }; authenticatorSelection?: { userVerification?: string } };
type RequestOptions = { challenge: string; rpId?: string; allowCredentials?: unknown[] };

export class SoftAuthenticator {
  readonly passkeys: SoftPasskey[] = [];

  constructor(private readonly options: { synced?: boolean; counting?: boolean } = {}) {}

  private flags(extra: number, overrides: { userVerified?: boolean }): number {
    let flags = FLAG_UP | extra;
    if (overrides.userVerified !== false) flags |= FLAG_UV;
    if (this.options.synced) flags |= FLAG_BE | FLAG_BS;
    return flags;
  }

  /** navigator.credentials.create(), as @simplewebauthn/browser's startRegistration returns it. */
  create(options: CreationOptions, origin: string, overrides: { rpId?: string; userVerified?: boolean; challenge?: string } = {}) {
    const rpId = overrides.rpId ?? options.rp.id!;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const credentialId = randomBytes(32);
    const cose = cbor(
      new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
    const counter = this.options.counting ? 1 : 0;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(credentialId.length);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.flags(FLAG_AT, overrides)]), count, Buffer.alloc(16), idLength, credentialId, cose]);
    const attestationObject = cbor(new Map<string, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: overrides.challenge ?? options.challenge, origin, crossOrigin: false }));
    const passkey: SoftPasskey = { id: b64url(credentialId), rpId, userHandle: options.user.id, privateKey, counter };
    this.passkeys.push(passkey);
    return {
      id: passkey.id,
      rawId: passkey.id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ["internal", "hybrid"],
      },
    };
  }

  /** navigator.credentials.get(), as @simplewebauthn/browser's startAuthentication returns it. */
  get(
    options: RequestOptions,
    origin: string,
    overrides: { passkey?: SoftPasskey; rpId?: string; userVerified?: boolean; counter?: number; userHandle?: string | null; challenge?: string } = {},
  ) {
    const passkey = overrides.passkey ?? this.passkeys.at(-1)!;
    const rpId = overrides.rpId ?? options.rpId ?? passkey.rpId;
    if (overrides.counter !== undefined) passkey.counter = overrides.counter;
    else if (this.options.counting) passkey.counter += 1;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(passkey.counter);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.flags(0, overrides)]), count]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: overrides.challenge ?? options.challenge, origin, crossOrigin: false }));
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), passkey.privateKey);
    const userHandle = overrides.userHandle === undefined ? passkey.userHandle : overrides.userHandle;
    return {
      id: passkey.id,
      rawId: passkey.id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        ...(userHandle === null ? {} : { userHandle }),
      },
    };
  }
}
