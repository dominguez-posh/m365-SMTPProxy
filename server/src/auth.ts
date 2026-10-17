// Sign-in with user name and password (scrypt hashes), sessions as random tokens in memory, sent as
// HttpOnly, SameSite=Strict cookie. SMTP user passwords for the proxies use PBKDF2 in the proxy's format.
import { createHash, createPublicKey, pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual, verify } from "node:crypto";

export function hashPassword(secret: string) {
  const salt = randomBytes(16);
  const N = 2 ** 15;
  const h = scryptSync(secret, salt, 64, { N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${salt.toString("base64")}$${h.toString("base64")}`;
}

export function verifyPassword(secret: string, stored: string | undefined) {
  if (!stored) return false;
  const [alg, n, salt, hash] = stored.split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const got = scryptSync(secret, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return timingSafeEqual(expected, got);
}

/** same format as PasswordHasher in the client: pbkdf2$iterations$salt$hash (SHA-256, 32 bytes) */
export function smtpPasswordHash(password: string) {
  const it = 210_000;
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, it, 32, "sha256");
  return `pbkdf2$${it}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const token = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** proxy key: EC P-256 as SubjectPublicKeyInfo (Base64); null if invalid */
export function parsePublicKey(b64: unknown) {
  if (typeof b64 !== "string" || b64.length > 400) return null;
  try {
    const key = createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    return key;
  } catch {
    return null;
  }
}

export function verifySignature(publicKeyB64: string, text: string, signatureB64: string) {
  const key = parsePublicKey(publicKeyB64);
  if (!key) return false;
  try {
    return verify("sha256", Buffer.from(text), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

const SESSION_TTL = 12 * 60 * 60 * 1000;
const IDLE_TTL = Math.max(5, Number(process.env.SMTPPROXY_IDLE_MINUTES ?? 30)) * 60 * 1000;

/** a session after the password but before the second factor is valid for at most 15 minutes */
const MFA_PENDING_TTL = 15 * 60 * 1000;

export class Sessions {
  private map = new Map<string, { userId: string; created: number; seen: number; mfa: boolean }>();
  /** mfa: the second factor is confirmed (otherwise only the MFA steps are allowed) */
  create(userId: string, mfa = false) {
    const t = token(32);
    this.map.set(sha256(t), { userId, created: Date.now(), seen: Date.now(), mfa });
    return t;
  }
  /** user id and MFA state of a valid session */
  info(t: string | undefined): { userId: string; mfa: boolean } | null {
    if (!t) return null;
    const k = sha256(t);
    const s = this.map.get(k);
    if (!s) return null;
    const now = Date.now();
    if (now - s.created > SESSION_TTL || now - s.seen > IDLE_TTL || (!s.mfa && now - s.created > MFA_PENDING_TTL)) {
      this.map.delete(k);
      return null;
    }
    s.seen = now;
    return { userId: s.userId, mfa: s.mfa };
  }
  /** second factor confirmed: the session gets full access */
  setMfa(t: string | undefined) {
    const s = t ? this.map.get(sha256(t)) : undefined;
    if (s) s.mfa = true;
  }
  destroy(t: string | undefined) {
    if (t) this.map.delete(sha256(t));
  }
  destroyUser(userId: string, except?: string) {
    const keep = except ? sha256(except) : null;
    for (const [k, v] of this.map) if (v.userId === userId && k !== keep) this.map.delete(k);
  }
}

/** at least 12 characters, not only letters or only digits */
export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== "string" || pw.length < 12) return "Das Passwort muss mindestens 12 Zeichen lang sein.";
  if (pw.length > 256) return "Das Passwort ist zu lang.";
  if (/^[A-Za-zÄÖÜäöüß]+$/.test(pw) || /^\d+$/.test(pw)) return "Das Passwort muss Buchstaben und Ziffern oder Sonderzeichen enthalten.";
  return null;
}

/** sign-in throttling per client address and user name: exponential pause after failures */
export class Throttle {
  private fails = new Map<string, { n: number; until: number }>();
  blocked(key: string) {
    const f = this.fails.get(key);
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
  }
  fail(key: string) {
    const f = this.fails.get(key) ?? { n: 0, until: 0 };
    f.n++;
    f.until = f.n <= 3 ? 0 : Date.now() + Math.min(15 * 60, 2 ** (f.n - 3)) * 1000;
    this.fails.set(key, f);
  }
  ok(key: string) {
    this.fails.delete(key);
  }
}
