import "server-only";
import crypto from "node:crypto";
import * as config from "./config";
import { getSecret } from "./dataDir";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;
const SESSION_DAYS = 30;

export function isOpen(): boolean {
  return config.get().passwordHash === null;
}

export function setPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
    .toString("hex");
  config.patch({ passwordHash: `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt}:${hash}` });
}

export function clearPassword() {
  config.patch({ passwordHash: null });
}

export function verifyPassword(password: string): boolean {
  const stored = config.get().passwordHash;
  if (stored === null) return true;
  const [scheme, n, r, p, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, KEYLEN, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function hmac(value: string): string {
  return crypto.createHmac("sha256", getSecret()).update(value).digest("hex");
}

/** Cookie value: `<expiryTs>.<hmac>` */
export function createSession(): { value: string; expires: Date } {
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  const ts = String(Math.floor(expires.getTime() / 1000));
  return { value: `${ts}.${hmac(ts)}`, expires };
}

export function verifySession(value: string | undefined): boolean {
  if (isOpen()) return true;
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot < 0) return false;
  const ts = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^\d+$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = hmac(ts);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(ts) * 1000 > Date.now();
}

export const SESSION_COOKIE = "refr_session";
