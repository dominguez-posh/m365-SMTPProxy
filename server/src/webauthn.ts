// WebAuthn (FIDO2 / passkeys) for the tool login, without external packages: registration ("none" attestation, the
// key is trusted on first use like an authenticator app) and verification of sign-ins. Supported algorithms: ES256
// (-7, security keys, Windows Hello, Apple/Google passkeys), RS256 (-257, older Windows Hello) and EdDSA (-8).
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey } from "node:crypto";

export const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
export const fromB64url = (s: string) => Buffer.from(String(s ?? ""), "base64url");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
export const newChallenge = () => b64url(randomBytes(32));

// ------------------------------------------------------------------ CBOR (RFC 8949), the subset WebAuthn uses

export function cborDecode(buf: Buffer): { value: unknown; rest: Buffer } {
  let pos = 0;
  const readLen = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return buf[pos++];
    if (info === 25) { const v = buf.readUInt16BE(pos); pos += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(pos); pos += 4; return v; }
    if (info === 27) { const v = Number(buf.readBigUInt64BE(pos)); pos += 8; return v; }
    throw new Error("CBOR: unbestimmte Längen werden nicht unterstützt");
  };
  const item = (depth: number): unknown => {
    if (depth > 16) throw new Error("CBOR: zu tief verschachtelt");
    if (pos >= buf.length) throw new Error("CBOR: unerwartetes Ende");
    const b = buf[pos++];
    const major = b >> 5;
    const info = b & 31;
    switch (major) {
      case 0: return readLen(info);
      case 1: return -1 - readLen(info);
      case 2: { const n = readLen(info); const v = buf.subarray(pos, pos + n); if (v.length !== n) throw new Error("CBOR: Bytes abgeschnitten"); pos += n; return Buffer.from(v); }
      case 3: { const n = readLen(info); const v = buf.subarray(pos, pos + n).toString("utf8"); pos += n; return v; }
      case 4: { const n = readLen(info); return Array.from({ length: n }, () => item(depth + 1)); }
      case 5: {
        const n = readLen(info);
        const m = new Map<unknown, unknown>();
        for (let i = 0; i < n; i++) { const k = item(depth + 1); m.set(k, item(depth + 1)); }
        return m;
      }
      case 6: readLen(info); return item(depth + 1); // tags: value only
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        throw new Error("CBOR: Gleitkommazahlen werden nicht unterstützt");
    }
    throw new Error("CBOR: ungültig");
  };
  const value = item(0);
  return { value, rest: buf.subarray(pos) };
}

// ------------------------------------------------------------------ authenticator data

export interface AuthData {
  rpIdHash: Buffer;
  up: boolean;
  uv: boolean;
  /** backup eligible / backed up (synced passkey) */
  be: boolean;
  bs: boolean;
  signCount: number;
  aaguid?: string;
  credentialId?: Buffer;
  coseKey?: Map<unknown, unknown>;
}
export function parseAuthData(b: Buffer): AuthData {
  if (b.length < 37) throw new Error("Authenticator-Daten zu kurz");
  const flags = b[32];
  const d: AuthData = { rpIdHash: b.subarray(0, 32), up: !!(flags & 0x01), uv: !!(flags & 0x04), be: !!(flags & 0x08), bs: !!(flags & 0x10), signCount: b.readUInt32BE(33) };
  if (flags & 0x40) {
    const g = b.subarray(37, 53).toString("hex");
    d.aaguid = `${g.slice(0, 8)}-${g.slice(8, 12)}-${g.slice(12, 16)}-${g.slice(16, 20)}-${g.slice(20)}`;
    const len = b.readUInt16BE(53);
    d.credentialId = b.subarray(55, 55 + len);
    const key = cborDecode(b.subarray(55 + len)).value;
    if (!(key instanceof Map)) throw new Error("Öffentlicher Schlüssel fehlt");
    d.coseKey = key;
  }
  return d;
}

/** COSE key -> JWK and algorithm */
export function coseToJwk(k: Map<unknown, unknown>): { jwk: JsonWebKey; alg: number } {
  const kty = k.get(1);
  const alg = Number(k.get(3));
  const bin = (n: number) => { const v = k.get(n); if (!Buffer.isBuffer(v)) throw new Error("Schlüsselteil fehlt"); return b64url(v); };
  if (kty === 2 && alg === -7 && k.get(-1) === 1) return { jwk: { kty: "EC", crv: "P-256", x: bin(-2), y: bin(-3) }, alg };
  if (kty === 3 && alg === -257) return { jwk: { kty: "RSA", n: bin(-1), e: bin(-2) }, alg };
  if (kty === 1 && alg === -8 && k.get(-1) === 6) return { jwk: { kty: "OKP", crv: "Ed25519", x: bin(-2) }, alg };
  throw new Error(`Schlüsseltyp nicht unterstützt (kty ${String(kty)}, alg ${alg})`);
}

function verifySignature(jwk: JsonWebKey, alg: number, data: Buffer, sig: Buffer) {
  const key = createPublicKey({ key: jwk, format: "jwk" });
  if (alg === -7) return verify("sha256", data, { key, dsaEncoding: "der" }, sig);
  if (alg === -257) return verify("sha256", data, key, sig);
  if (alg === -8) return verify(null, data, key, sig);
  return false;
}

// ------------------------------------------------------------------ checks shared by registration and sign-in

export interface Expected {
  challenge: string;
  rpId: string;
  /** allowed origins of the browser (https://<domain>[:port]; http only for localhost) */
  originOk: (origin: string) => boolean;
  /** passwordless sign-in: user verification (PIN, biometrics) required */
  requireUv?: boolean;
}
function checkClientData(raw: Buffer, type: string, e: Expected) {
  let c: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
  try {
    c = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("clientDataJSON ungültig");
  }
  if (c.type !== type) throw new Error(`Falscher Vorgang (${c.type})`);
  const got = Buffer.from(String(c.challenge ?? ""));
  const want = Buffer.from(e.challenge);
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error("Challenge passt nicht (abgelaufen oder aus einem anderen Vorgang)");
  if (!c.origin || !e.originOk(c.origin)) throw new Error(`Ursprung nicht erlaubt: ${c.origin}`);
  if (c.crossOrigin) throw new Error("Eingebettete Anmeldung (crossOrigin) nicht erlaubt");
}
function checkAuthData(a: AuthData, e: Expected) {
  if (!a.rpIdHash.equals(sha256(e.rpId))) throw new Error("Der Passkey gehört zu einer anderen Domäne");
  if (!a.up) throw new Error("Keine Bestätigung am Gerät (User Presence)");
  if (e.requireUv && !a.uv) throw new Error("Für die Anmeldung ohne Passwort ist PIN oder Biometrie am Gerät nötig");
}

export interface RegistrationJson {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
  clientExtensionResults?: { credProps?: { rk?: boolean } };
}
export interface StoredPasskey {
  id: string;
  jwk: JsonWebKey;
  alg: number;
  counter: number;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  aaguid?: string;
  transports?: string[];
  /** synced passkey (iCloud, Google, Microsoft) */
  backedUp?: boolean;
  /** discoverable credential: usable for the sign-in without user name and password */
  discoverable?: boolean;
}

export function verifyRegistration(cred: RegistrationJson, e: Expected): Omit<StoredPasskey, "name" | "createdAt"> {
  if (cred?.type !== "public-key") throw new Error("Kein Passkey");
  checkClientData(fromB64url(cred.response?.clientDataJSON), "webauthn.create", e);
  const att = cborDecode(fromB64url(cred.response?.attestationObject)).value;
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get("authData"))) throw new Error("attestationObject ungültig");
  const a = parseAuthData(att.get("authData") as Buffer);
  checkAuthData(a, e);
  if (!a.credentialId || !a.coseKey) throw new Error("Keine Schlüsseldaten in der Registrierung");
  if (b64url(a.credentialId) !== cred.rawId && b64url(a.credentialId) !== cred.id) throw new Error("Schlüssel-ID passt nicht");
  const { jwk, alg } = coseToJwk(a.coseKey);
  createPublicKey({ key: jwk, format: "jwk" }); // the key must be valid
  return {
    id: b64url(a.credentialId),
    jwk,
    alg,
    counter: a.signCount,
    aaguid: a.aaguid,
    transports: Array.isArray(cred.response.transports) ? cred.response.transports.map(String).slice(0, 8) : undefined,
    backedUp: a.bs,
    discoverable: cred.clientExtensionResults?.credProps?.rk === true ? true : cred.clientExtensionResults?.credProps?.rk === false ? false : undefined,
  };
}

export interface AssertionJson {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
}

/** verifies a sign-in; returns the new signature counter and whether the user was verified */
export function verifyAssertion(cred: AssertionJson, key: StoredPasskey, e: Expected): { counter: number; uv: boolean } {
  if (cred?.type !== "public-key") throw new Error("Kein Passkey");
  const clientData = fromB64url(cred.response?.clientDataJSON);
  checkClientData(clientData, "webauthn.get", e);
  const authRaw = fromB64url(cred.response?.authenticatorData);
  const a = parseAuthData(authRaw);
  checkAuthData(a, e);
  const ok = verifySignature(key.jwk, key.alg, Buffer.concat([authRaw, sha256(clientData)]), fromB64url(cred.response?.signature));
  if (!ok) throw new Error("Signatur ungültig");
  // a counter that does not increase points to a cloned authenticator (0 = the authenticator has no counter)
  if (a.signCount !== 0 || key.counter !== 0) {
    if (a.signCount <= key.counter) throw new Error("Signaturzähler nicht gestiegen – möglicherweise ein kopierter Schlüssel");
  }
  return { counter: a.signCount, uv: a.uv };
}

/**
 * RP ID (domain) and allowed origins: the address the browser uses (Host of the request), otherwise SMTPPROXY_PUBLIC_URL.
 * A passkey belongs to one domain: registered under the dev address it does not work under a custom domain.
 */
export function relyingParty(host: string | undefined, publicUrl: string | undefined): { rpId: string; originOk: (o: string) => boolean } {
  let rpId = "localhost";
  try {
    rpId = host ? new URL(`https://${host}`).hostname : publicUrl ? new URL(publicUrl).hostname : "localhost";
  } catch {
    /* invalid Host header: localhost never matches a real origin */
  }
  const originOk = (o: string) => {
    try {
      const u = new URL(o);
      if (u.hostname !== rpId) return false;
      if (u.protocol === "https:") return true;
      return u.protocol === "http:" && (rpId === "localhost" || rpId.endsWith(".localhost"));
    } catch {
      return false;
    }
  };
  return { rpId, originOk };
}
