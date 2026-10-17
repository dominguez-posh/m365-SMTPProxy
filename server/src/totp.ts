// TOTP (RFC 6238: HMAC-SHA1, 6 digits, 30 seconds) for the second factor of the tool login, and one-time
// recovery codes. Works with every common authenticator app (Microsoft/Google Authenticator, Authy, 1Password …).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sha256 } from "./auth";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, "").toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("Ungültiges Base32-Zeichen");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** new secret: 160 bits (RFC 4226 recommendation), Base32 */
export const newTotpSecret = () => base32Encode(randomBytes(20));

/** code for a time step (counter = unix seconds / 30) */
export function totpAt(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

export const totpCounter = (t = Date.now()) => Math.floor(t / 1000 / 30);

/**
 * Checks a code against the current time step and one step before and after (clock drift of the phone).
 * Returns the matching counter, or null. Counters at or below lastCounter are rejected (no reuse of a code).
 */
export function verifyTotp(secret: string, code: string, lastCounter = -1, t = Date.now()): number | null {
  const c = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const now = totpCounter(t);
  for (const counter of [now, now - 1, now + 1]) {
    if (counter <= lastCounter) continue;
    const want = Buffer.from(totpAt(secret, counter));
    if (timingSafeEqual(want, Buffer.from(c))) return counter;
  }
  return null;
}

/** otpauth URI for the QR code */
export const otpauthUri = (secret: string, issuer: string, account: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/** 10 recovery codes "ABCDE-FGHJK" (Base32 without look-alikes); only their SHA-256 hashes are stored */
export function newRecoveryCodes(n = 10): { codes: string[]; hashes: string[] } {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const codes = Array.from({ length: n }, () => {
    const b = randomBytes(10);
    const s = Array.from(b, (x) => alphabet[x % alphabet.length]).join("");
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { codes, hashes: codes.map(recoveryHash) };
}
export const recoveryHash = (code: string) => sha256(String(code).toUpperCase().replace(/[^A-Z0-9]/g, ""));
