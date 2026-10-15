// Everything secret-shaped: passwords, API keys, session/invite tokens and
// encryption of upstream credentials. Only node:crypto, no native addons.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

// ---- Passwords: scrypt (memory-hard), parameters stored with the hash so they can be raised later.
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    // Burn comparable time for unknown users / pending invites so response
    // time doesn't reveal which emails exist.
    await scryptAsync(password, randomBytes(16), SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return false;
  }
  const [alg, N, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

// ---- Opaque tokens (API keys, sessions, invites): high-entropy random, stored as SHA-256.
// A fast hash is fine here (unlike passwords): 256 random bits can't be brute-forced,
// and lookups happen on every MCP request.
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export const API_KEY_PREFIX = "mcpg_";

export function newApiKey(): { key: string; prefix: string; hash: string } {
  const key = API_KEY_PREFIX + randomToken(32);
  // Shown in the UI so people can tell their keys apart; 4 random chars reveal nothing useful.
  return { key, prefix: key.slice(0, API_KEY_PREFIX.length + 4), hash: sha256(key) };
}

// ---- Upstream credentials at rest: AES-256-GCM.
// Format: "v1:" + base64(iv[12] | tag[16] | ciphertext). The server slug is
// bound in as additional authenticated data, so a ciphertext copied onto a
// different server row fails to decrypt instead of leaking to that upstream.
export class CredentialBox {
  #key: Buffer;

  constructor(key: Buffer) {
    this.#key = key;
  }

  encrypt(plaintext: string, slug: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(`server:${slug}`));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return "v1:" + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
  }

  decrypt(stored: string, slug: string): string {
    if (!stored.startsWith("v1:")) throw new Error("unknown credential format");
    const raw = Buffer.from(stored.slice(3), "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`server:${slug}`));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }
}
