// M365 SMTP Proxy management server: web app, UI API and proxy API. Node.js without third-party packages,
// data as JSON files in SMTPPROXY_DATA. Exactly one instance (sessions and nonces live in memory).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync, createReadStream } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { env } from "node:process";
import { Collection, KeyValue, LineLog, STORES, openStore } from "./store";
import { Sessions, Throttle, hashPassword, parsePublicKey, passwordProblem, sha256, smtpPasswordHash, token, verifyPassword, verifySignature } from "./auth";
import { newRecoveryCodes, newTotpSecret, otpauthUri, recoveryHash, verifyTotp } from "./totp";
import { b64url, newChallenge, relyingParty, verifyAssertion, verifyRegistration, type AssertionJson, type RegistrationJson, type StoredPasskey } from "./webauthn";
import { isNewer } from "../../shared/types";
import type { ApiToken, Command, CurrentUser, EventEntry, MailLogEntry, Overview, PasskeyInfo, Proxy, ProxyConfig, ServiceLogEntry, User } from "../../shared/types";

const CFG = {
  port: Number(env.SMTPPROXY_PORT ?? 8080),
  dataDir: resolve(env.SMTPPROXY_DATA ?? "./data"),
  staticDir: resolve(env.SMTPPROXY_STATIC ?? "./dist"),
  packageDir: resolve(env.SMTPPROXY_PACKAGE ?? "./client-package"),
  behindProxy: env.SMTPPROXY_BEHIND_TLS_PROXY === "1",
  publicUrl: (env.SMTPPROXY_PUBLIC_URL ?? "").replace(/\/+$/, ""),
  productName: env.SMTPPROXY_NAME ?? "M365 SMTP Proxy",
};

/* ------------------------------------------------------------------ data */
type StoredUser = {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
  lastLogin?: string;
  passwordHash: string;
  totp?: { secret: string; enabledAt: string; lastCounter: number };
  totpPending?: { secret: string; createdAt: string };
  recoveryCodes?: string[];
  passkeys?: StoredPasskey[];
};
type StoredProxy = Proxy & { publicKey: string; ackMailSeq: number; ackServiceSeq: number };
type Settings = { autoUpdate: boolean };
type StoredApiToken = ApiToken & { secretHash: string };

const st = openStore(CFG.dataDir);
const users = new Collection<StoredUser>(st.f("users"));
const proxies = new Collection<StoredProxy>(st.f("proxies"));
const events = new Collection<EventEntry>(st.f("events"));
const apiTokens = new Collection<StoredApiToken>(st.f("apitokens"));
const STARTED_AT = new Date().toISOString();
const settings = new KeyValue<Settings>(st.f("settings"), { autoUpdate: false });
const logs = new LineLog(join(CFG.dataDir, "logs"));
const sessions = new Sessions();
const throttle = new Throttle();
const seenNonces = new Map<string, number>();
const SIG_WINDOW_MS = 5 * 60 * 1000;
const USERNAME = /^[a-z0-9._@-]{3,64}$/;

const now = () => new Date().toISOString();

function logEvent(by: string, action: string, p?: StoredProxy, detail?: string) {
  events.put({ id: token(9), at: now(), by, action, proxyId: p?.id, proxyName: p?.name, detail });
  // keep the newest 5000 events
  const all = events.all();
  if (all.length > 5000) for (const e of all.sort((a, b) => a.at.localeCompare(b.at)).slice(0, all.length - 5000)) events.delete(e.id);
}

/** client package of this image (tools/build-client.ps1 → client-package/) */
function clientPackage(): Overview["package"] | undefined {
  const f = join(CFG.packageDir, "version.json");
  if (!existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ http helpers */
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};
const json = (res: ServerResponse, status: number, body?: unknown) => {
  res.statusCode = status;
  if (body === undefined) return res.end();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
};
const rawBodies = new WeakMap<IncomingMessage, Buffer>();
async function readBody(req: IncomingMessage, limit: number): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "Anfrage zu groß");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks);
  rawBodies.set(req, raw);
  if (!size) return undefined;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "Ungültiges JSON");
  }
}
const cookie = (req: IncomingMessage, name: string) =>
  (req.headers.cookie ?? "")
    .split(";")
    .map((x) => x.trim().split("="))
    .find(([k]) => k === name)?.[1];
/** behind the Container Apps proxy the client address is the LAST entry of X-Forwarded-For */
const clientIp = (req: IncomingMessage) =>
  (CFG.behindProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",").pop()?.trim() : "") || req.socket.remoteAddress || "?";
const secureFlag = () => (CFG.behindProxy ? "; Secure" : "");
function publicUrl(req: IncomingMessage) {
  if (CFG.publicUrl) return CFG.publicUrl;
  const proto = CFG.behindProxy ? "https" : "http";
  return `${proto}://${req.headers.host ?? "localhost:" + CFG.port}`;
}
function securityHeaders(res: ServerResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (CFG.behindProxy) res.setHeader("Strict-Transport-Security", "max-age=31536000");
}

/* ------------------------------------------------------------------ routing */
type Perm = "public" | "user" | "proxy";
type Ctx = { req: IncomingMessage; res: ServerResponse; p: Record<string, string>; body: any; user: StoredUser };
type Handler = (c: Ctx) => unknown | Promise<unknown>;
const RAW = Symbol("raw");
const routes: { method: string; re: RegExp; keys: string[]; h: Handler; perm: Perm }[] = [];
function route(method: string, path: string, perm: Perm, h: Handler) {
  const keys: string[] = [];
  const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, re, keys, h, perm });
}
/** session state of the current request (set by sessionUser) */
const reqSession = new WeakMap<IncomingMessage, { token: string; mfa: boolean }>();
function sessionUser(req: IncomingMessage) {
  const t = cookie(req, "sp_session");
  const s = sessions.info(t);
  const u = s ? users.get(s.userId) : undefined;
  if (!u) return null;
  reqSession.set(req, { token: t!, mfa: s!.mfa });
  return u;
}
/** a second factor is set up: authenticator app or at least one passkey */
const hasFactor = (u: StoredUser) => !!u.totp || (u.passkeys ?? []).length > 0;
const passkeyInfo = (k: StoredPasskey): PasskeyInfo => ({ id: k.id, name: k.name, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, backedUp: k.backedUp, discoverable: k.discoverable });
/** what is still missing for this session: setting up a second factor, or confirming it */
function mfaStep(u: StoredUser, req?: IncomingMessage): "setup" | "verify" | undefined {
  const s = req ? reqSession.get(req) : undefined;
  if (!s || s.mfa) return undefined;
  return hasFactor(u) ? "verify" : "setup";
}
/** user as other admins see it (user list) */
const pubUser = (u: StoredUser): User => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  createdAt: u.createdAt,
  lastLogin: u.lastLogin,
  mfaEnabled: hasFactor(u),
  totpEnabled: !!u.totp,
  passkeyCount: (u.passkeys ?? []).length,
});
/** the signed-in user with the state of the own second factor */
const currentUser = (u: StoredUser, req: IncomingMessage): CurrentUser => ({
  ...pubUser(u),
  mfaRequired: mfaStep(u, req),
  passkeys: (u.passkeys ?? []).map(passkeyInfo),
  recoveryCodesLeft: hasFactor(u) ? (u.recoveryCodes ?? []).length : undefined,
});
const sessionCookie = (res: ServerResponse, t: string) =>
  res.setHeader("Set-Cookie", `sp_session=${t}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secureFlag()}`);

/* ------------------------------------------------------------------ setup and sign-in */
const setupOpen = () => users.all().length === 0;
route("GET", "/api/setup", "public", () => ({ required: setupOpen() }));
/** first start: as long as there is no user, the browser creates the first administrator (then sets up MFA) */
route("POST", "/api/setup/admin", "public", ({ req, res, body }) => {
  if (!setupOpen()) fail(409, "Der Server ist bereits eingerichtet. Bitte anmelden.");
  const username = String(body?.username ?? "").trim().toLowerCase();
  if (!USERNAME.test(username)) fail(400, "Benutzername: 3–64 Zeichen, Buchstaben, Ziffern und . _ @ -");
  const problem = passwordProblem(body?.password);
  if (problem) fail(400, problem);
  const u = users.put({ id: "u-" + token(8), username, displayName: String(body?.displayName ?? "").trim().slice(0, 100) || username, createdAt: now(), passwordHash: hashPassword(body.password) });
  users.flush();
  const t = sessions.create(u.id, false);
  reqSession.set(req, { token: t, mfa: false });
  sessionCookie(res, t);
  logEvent(username, "Ersteinrichtung: Administrator angelegt", undefined, clientIp(req));
  console.log(`Ersteinrichtung: Administrator ${username} angelegt von ${clientIp(req)}`);
  return currentUser(u, req);
});
const DUMMY_HASH = hashPassword(token(16));
route("POST", "/api/auth/login", "public", ({ req, res, body }) => {
  const username = String(body?.username ?? "").trim().toLowerCase().slice(0, 64);
  const password = typeof body?.password === "string" ? body.password.slice(0, 256) : "";
  const key = `${clientIp(req)}|${username}`;
  const wait = Math.max(throttle.blocked(key), throttle.blocked(clientIp(req) + "|*"));
  if (wait) fail(429, `Zu viele Fehlversuche. Bitte ${wait} Sekunden warten.`);
  const u = users.find((x) => x.username === username);
  const ok = verifyPassword(password, u?.passwordHash ?? DUMMY_HASH);
  if (!u || !ok) {
    throttle.fail(key);
    throttle.fail(clientIp(req) + "|*");
    fail(401, "Benutzername oder Passwort ist nicht korrekt.");
  }
  throttle.ok(key);
  // full access only with the second factor (POST /auth/mfa/verify, passkey, or the setup)
  const t = sessions.create(u!.id, false);
  reqSession.set(req, { token: t, mfa: false });
  sessionCookie(res, t);
  console.log(`Anmeldung (Passwort): ${u!.username} von ${clientIp(req)}${hasFactor(u!) ? ", zweiter Faktor ausstehend" : ", zweiter Faktor noch nicht eingerichtet"}`);
  return currentUser(u!, req);
});
route("POST", "/api/auth/logout", "public", ({ req, res }) => {
  sessions.destroy(cookie(req, "sp_session"));
  res.setHeader("Set-Cookie", "sp_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  return null;
});
route("GET", "/api/auth/session", "user", ({ req, user }) => currentUser(user, req));
route("POST", "/api/auth/password", "user", ({ req, user, body }) => {
  if (!verifyPassword(String(body?.current ?? ""), user.passwordHash)) fail(400, "Das aktuelle Passwort ist nicht korrekt.");
  const problem = passwordProblem(body?.password);
  if (problem) fail(400, problem);
  user.passwordHash = hashPassword(body.password);
  users.put(user);
  sessions.destroyUser(user.id, cookie(req, "sp_session"));
  logEvent(user.username, "Eigenes Passwort geändert");
  return null;
});

/* ------------------------------------------------------------------ second factor: authenticator app (TOTP) */
const mfaThrottleKey = (req: IncomingMessage, u: StoredUser) => `mfa|${u.id}|${clientIp(req)}`;
function checkMfaThrottle(req: IncomingMessage, u: StoredUser) {
  const wait = Math.max(throttle.blocked(mfaThrottleKey(req, u)), throttle.blocked(`mfa|${u.id}`));
  if (wait) fail(429, `Zu viele falsche Codes. Bitte ${wait} Sekunden warten.`);
}
function mfaFailed(req: IncomingMessage, u: StoredUser, msg: string): never {
  throttle.fail(mfaThrottleKey(req, u));
  throttle.fail(`mfa|${u.id}`);
  throw new HttpError(401, msg);
}
function mfaDone(req: IncomingMessage, u: StoredUser, token: string) {
  throttle.ok(mfaThrottleKey(req, u));
  throttle.ok(`mfa|${u.id}`);
  sessions.setMfa(token);
  reqSession.set(req, { token, mfa: true });
  u.lastLogin = now();
  users.put(u);
}
const browserSession = (req: IncomingMessage) => reqSession.get(req) ?? fail(400, "Nur für Anmeldungen im Browser.");
/** second step of the login: code from the authenticator or a recovery code */
route("POST", "/api/auth/mfa/verify", "user", ({ req, user, body }) => {
  const s = browserSession(req);
  if (s.mfa) return currentUser(user, req);
  if (!hasFactor(user)) fail(409, "Für dieses Konto ist noch kein zweiter Faktor eingerichtet.");
  checkMfaThrottle(req, user);
  const input = String(body?.code ?? "").trim();
  let via = "Authenticator";
  if (/^\d[\d ]{5,6}$/.test(input)) {
    if (!user.totp) mfaFailed(req, user, "Für dieses Konto ist keine Authenticator-App eingerichtet. Bitte den Passkey oder einen Notfallcode verwenden.");
    const counter = verifyTotp(user.totp!.secret, input, user.totp!.lastCounter);
    if (counter === null) mfaFailed(req, user, "Der Code ist nicht gültig. Bitte den aktuellen Code der Authenticator-App eingeben.");
    user.totp!.lastCounter = counter!;
  } else {
    const i = (user.recoveryCodes ?? []).indexOf(recoveryHash(input));
    if (!input || i < 0) mfaFailed(req, user, "Der Notfallcode ist nicht gültig oder wurde schon verwendet.");
    user.recoveryCodes!.splice(i, 1);
    via = `Notfallcode (noch ${user.recoveryCodes!.length} übrig)`;
  }
  mfaDone(req, user, s.token);
  console.log(`Anmeldung abgeschlossen: ${user.username} von ${clientIp(req)} (${via})`);
  return currentUser(user, req);
});
/** TOTP setup: new secret, shown as QR code and as text */
route("POST", "/api/auth/mfa/setup", "user", ({ req, user }) => {
  const s = browserSession(req);
  // an existing factor is only replaced or extended from a fully signed-in session
  if (hasFactor(user) && !s.mfa) fail(403, "Bitte zuerst die Anmeldung mit dem zweiten Faktor abschließen.");
  const secret = newTotpSecret();
  user.totpPending = { secret, createdAt: now() };
  users.put(user);
  return { secret, uri: otpauthUri(secret, CFG.productName, user.username), issuer: CFG.productName, account: user.username };
});
/** confirms the setup with a first code; answers with the recovery codes (shown once) */
route("POST", "/api/auth/mfa/setup/confirm", "user", ({ req, user, body }) => {
  const s = browserSession(req);
  if (hasFactor(user) && !s.mfa) fail(403, "Bitte zuerst die Anmeldung mit dem zweiten Faktor abschließen.");
  const p = user.totpPending;
  if (!p || Date.now() - Date.parse(p.createdAt) > 15 * 60 * 1000) fail(409, "Die Einrichtung ist abgelaufen. Bitte neu starten.");
  checkMfaThrottle(req, user);
  const counter = verifyTotp(p!.secret, String(body?.code ?? ""));
  if (counter === null) mfaFailed(req, user, "Der Code passt nicht. Bitte die Uhrzeit des Smartphones prüfen und den aktuellen Code eingeben.");
  // new recovery codes with the first factor and when the app is replaced; adding the app to a passkey keeps them
  const keep = !user.totp && (user.passkeys ?? []).length > 0 && (user.recoveryCodes ?? []).length > 0;
  const rc = keep ? undefined : newRecoveryCodes();
  const replaced = !!user.totp;
  user.totp = { secret: p!.secret, enabledAt: now(), lastCounter: counter! };
  delete user.totpPending;
  if (rc) user.recoveryCodes = rc.hashes;
  mfaDone(req, user, s.token);
  if (replaced) sessions.destroyUser(user.id, s.token);
  logEvent(user.username, replaced ? "Authenticator-App ersetzt" : "Authenticator-App eingerichtet");
  return { user: currentUser(user, req), recoveryCodes: rc?.codes };
});
/** removes the authenticator app; only when a passkey stays as second factor */
route("DELETE", "/api/auth/mfa/totp", "user", ({ req, user }) => {
  if (!reqSession.get(req)?.mfa) fail(403, "Nur mit abgeschlossener Anmeldung.");
  if (!(user.passkeys ?? []).length) fail(409, "Die Authenticator-App ist der einzige zweite Faktor. Bitte zuerst einen Passkey hinzufügen.");
  delete user.totp;
  delete user.totpPending;
  users.put(user);
  logEvent(user.username, "Authenticator-App entfernt");
  return currentUser(user, req);
});
/** new recovery codes (the old ones become invalid); needs a current code or a passkey confirmation */
route("POST", "/api/auth/mfa/recovery-codes", "user", ({ req, user, body }) => {
  const s = reqSession.get(req);
  if (!s?.mfa || !hasFactor(user)) fail(403, "Nur mit eingerichtetem zweiten Faktor und abgeschlossener Anmeldung.");
  checkMfaThrottle(req, user);
  if (body?.credential) passkeyAssert(req, user, s!.token, body.credential, "Die Bestätigung mit dem Passkey ist fehlgeschlagen.");
  else {
    if (!user.totp) mfaFailed(req, user, "Bitte mit dem Passkey bestätigen.");
    const counter = verifyTotp(user.totp!.secret, String(body?.code ?? ""), user.totp!.lastCounter);
    if (counter === null) mfaFailed(req, user, "Der Code ist nicht gültig.");
    user.totp!.lastCounter = counter!;
  }
  const rc = newRecoveryCodes();
  user.recoveryCodes = rc.hashes;
  users.put(user);
  logEvent(user.username, "Neue Notfallcodes erzeugt");
  return { recoveryCodes: rc.codes, user: currentUser(user, req) };
});

/* ------------------------------------------------------------------ passkeys (WebAuthn) */
const CHALLENGE_TTL = 5 * 60 * 1000;
/** open challenges per session ("reg|<token>", "get|<token>") or per passwordless sign-in ("login|<id>") */
const challenges = new Map<string, { challenge: string; at: number }>();
function putChallenge(key: string) {
  const t = Date.now();
  for (const [k, v] of challenges) if (t - v.at > CHALLENGE_TTL) challenges.delete(k);
  if (challenges.size > 5000) fail(429, "Zu viele offene Anmeldungen. Bitte kurz warten.");
  const challenge = newChallenge();
  challenges.set(key, { challenge, at: t });
  return challenge;
}
function takeChallenge(key: string) {
  const c = challenges.get(key);
  challenges.delete(key);
  if (!c || Date.now() - c.at > CHALLENGE_TTL) fail(409, "Die Anfrage ist abgelaufen. Bitte erneut versuchen.");
  return c!.challenge;
}
const rpOf = (req: IncomingMessage) => relyingParty(String((CFG.behindProxy && req.headers["x-forwarded-host"]) || req.headers.host || ""), CFG.publicUrl);
const credDescriptor = (k: StoredPasskey) => ({ type: "public-key", id: k.id, ...(k.transports?.length ? { transports: k.transports } : {}) });
function passkeyAssert(req: IncomingMessage, user: StoredUser, token: string, cred: AssertionJson, msg: string) {
  const challenge = takeChallenge(`get|${token}`);
  const key = (user.passkeys ?? []).find((k) => k.id === String(cred?.id ?? ""));
  if (!key) mfaFailed(req, user, "Dieser Passkey ist für das Konto nicht hinterlegt.");
  try {
    const r = verifyAssertion(cred, key!, { challenge, ...rpOf(req) });
    key!.counter = r.counter;
    key!.lastUsedAt = now();
    return key!;
  } catch (e) {
    console.log(`Passkey abgelehnt: ${user.username} von ${clientIp(req)}: ${e instanceof Error ? e.message : e}`);
    mfaFailed(req, user, `${msg} ${e instanceof Error ? e.message : ""}`.trim());
  }
}
route("POST", "/api/auth/passkey/register/options", "user", ({ req, user }) => {
  const s = browserSession(req);
  if (hasFactor(user) && !s.mfa) fail(403, "Bitte zuerst die Anmeldung mit dem zweiten Faktor abschließen.");
  if ((user.passkeys ?? []).length >= 10) fail(409, "Es sind schon 10 Passkeys hinterlegt. Bitte zuerst einen entfernen.");
  const rp = rpOf(req);
  return {
    challenge: putChallenge(`reg|${s.token}`),
    rp: { id: rp.rpId, name: CFG.productName },
    user: { id: b64url(Buffer.from(user.id)), name: user.username, displayName: user.displayName || user.username },
    pubKeyCredParams: [-7, -8, -257].map((alg) => ({ type: "public-key", alg })),
    timeout: 120000,
    attestation: "none",
    authenticatorSelection: { residentKey: "preferred", requireResidentKey: false, userVerification: "preferred" },
    excludeCredentials: (user.passkeys ?? []).map(credDescriptor),
    extensions: { credProps: true },
  };
});
route("POST", "/api/auth/passkey/register/verify", "user", ({ req, user, body }) => {
  const s = browserSession(req);
  if (hasFactor(user) && !s.mfa) fail(403, "Bitte zuerst die Anmeldung mit dem zweiten Faktor abschließen.");
  const challenge = takeChallenge(`reg|${s.token}`);
  let k: ReturnType<typeof verifyRegistration>;
  try {
    k = verifyRegistration(body?.credential as RegistrationJson, { challenge, ...rpOf(req) });
  } catch (e) {
    throw new HttpError(400, `Der Passkey konnte nicht registriert werden: ${e instanceof Error ? e.message : e}`);
  }
  if (users.all().some((u) => (u.passkeys ?? []).some((x) => x.id === k.id))) fail(409, "Dieser Passkey ist schon registriert.");
  const first = !hasFactor(user);
  const name = String(body?.name ?? "").trim().slice(0, 60) || `Passkey ${(user.passkeys ?? []).length + 1}`;
  user.passkeys = [...(user.passkeys ?? []), { ...k, name, createdAt: now() }];
  const rc = first || !(user.recoveryCodes ?? []).length ? newRecoveryCodes() : undefined;
  if (rc) user.recoveryCodes = rc.hashes;
  if (s.mfa) users.put(user);
  else mfaDone(req, user, s.token);
  logEvent(user.username, "Passkey registriert", undefined, name);
  return { user: currentUser(user, req), recoveryCodes: rc?.codes };
});
route("POST", "/api/auth/passkey/verify/options", "user", ({ req, user }) => {
  const s = browserSession(req);
  if (!(user.passkeys ?? []).length) fail(409, "Für dieses Konto ist kein Passkey hinterlegt.");
  checkMfaThrottle(req, user);
  return { challenge: putChallenge(`get|${s.token}`), rpId: rpOf(req).rpId, timeout: 120000, userVerification: "preferred", allowCredentials: (user.passkeys ?? []).map(credDescriptor) };
});
route("POST", "/api/auth/passkey/verify", "user", ({ req, user, body }) => {
  const s = browserSession(req);
  if (s.mfa) return currentUser(user, req);
  checkMfaThrottle(req, user);
  const key = passkeyAssert(req, user, s.token, body?.credential, "Die Anmeldung mit dem Passkey ist fehlgeschlagen.");
  mfaDone(req, user, s.token);
  console.log(`Anmeldung abgeschlossen: ${user.username} von ${clientIp(req)} (Passkey ${key.name})`);
  return currentUser(user, req);
});
/** sign-in without password: discoverable passkey with PIN or biometrics (user verification) */
route("POST", "/api/auth/passkey/login/options", "public", ({ req }) => {
  const wait = throttle.blocked(`pk|${clientIp(req)}`);
  if (wait) fail(429, `Zu viele Fehlversuche. Bitte ${wait} Sekunden warten.`);
  const id = token(12);
  return { challengeId: id, challenge: putChallenge(`login|${id}`), rpId: rpOf(req).rpId, timeout: 120000, userVerification: "required", allowCredentials: [] };
});
route("POST", "/api/auth/passkey/login", "public", ({ req, res, body }) => {
  const ip = clientIp(req);
  const wait = throttle.blocked(`pk|${ip}`);
  if (wait) fail(429, `Zu viele Fehlversuche. Bitte ${wait} Sekunden warten.`);
  const challenge = takeChallenge(`login|${String(body?.challengeId ?? "").slice(0, 40)}`);
  const cred = body?.credential as AssertionJson;
  const credId = String(cred?.id ?? "");
  const u = credId ? users.find((x) => (x.passkeys ?? []).some((k) => k.id === credId)) : undefined;
  const key = u?.passkeys?.find((k) => k.id === credId);
  const bad = (why: string): never => {
    throttle.fail(`pk|${ip}`);
    console.log(`Anmeldung mit Passkey abgelehnt von ${ip}: ${why}`);
    throw new HttpError(401, "Die Anmeldung mit dem Passkey ist fehlgeschlagen. Ist der Passkey für diesen Server registriert?");
  };
  if (!u || !key) return bad("unbekannter Passkey");
  if (cred.response?.userHandle && cred.response.userHandle !== b64url(Buffer.from(u.id))) return bad("userHandle passt nicht");
  try {
    const r = verifyAssertion(cred, key, { challenge, ...rpOf(req), requireUv: true });
    key.counter = r.counter;
    key.lastUsedAt = now();
  } catch (e) {
    return bad(`${u.username}: ${e instanceof Error ? e.message : e}`);
  }
  throttle.ok(`pk|${ip}`);
  u.lastLogin = now();
  users.put(u);
  // possession of the passkey plus PIN/biometrics = two factors: the session is complete right away
  const t = sessions.create(u.id, true);
  reqSession.set(req, { token: t, mfa: true });
  sessionCookie(res, t);
  console.log(`Anmeldung ohne Passwort: ${u.username} von ${ip} (Passkey ${key.name})`);
  return currentUser(u, req);
});
route("PATCH", "/api/auth/passkeys/:pid", "user", ({ req, user, p, body }) => {
  if (!reqSession.get(req)?.mfa) fail(403, "Nur mit abgeschlossener Anmeldung.");
  const k = (user.passkeys ?? []).find((x) => x.id === p.pid) ?? fail(404, "Passkey nicht gefunden");
  const name = String(body?.name ?? "").trim().slice(0, 60);
  if (!name) fail(400, "Bitte einen Namen angeben.");
  k.name = name;
  users.put(user);
  return currentUser(user, req);
});
route("DELETE", "/api/auth/passkeys/:pid", "user", ({ req, user, p }) => {
  if (!reqSession.get(req)?.mfa) fail(403, "Nur mit abgeschlossener Anmeldung.");
  const k = (user.passkeys ?? []).find((x) => x.id === p.pid) ?? fail(404, "Passkey nicht gefunden");
  if (!user.totp && user.passkeys!.length === 1) fail(409, "Das ist der einzige zweite Faktor. Bitte zuerst einen weiteren Passkey oder die Authenticator-App einrichten.");
  user.passkeys = user.passkeys!.filter((x) => x !== k);
  users.put(user);
  logEvent(user.username, "Passkey entfernt", undefined, k.name);
  return currentUser(user, req);
});

/* ------------------------------------------------------------------ users */
route("GET", "/api/users", "user", () => users.all().map(pubUser));
route("POST", "/api/users", "user", ({ user, body }) => {
  const username = String(body?.username ?? "").trim().toLowerCase();
  if (!USERNAME.test(username)) fail(400, "Benutzername: 3–64 Zeichen, Buchstaben, Ziffern und . _ @ -");
  if (users.find((x) => x.username === username)) fail(409, "Diesen Benutzer gibt es bereits.");
  const problem = passwordProblem(body?.password);
  if (problem) fail(400, problem);
  const u = users.put({ id: "u-" + token(8), username, displayName: String(body?.displayName ?? "").trim().slice(0, 100) || username, createdAt: now(), passwordHash: hashPassword(body.password) });
  logEvent(user.username, "Benutzer angelegt", undefined, username);
  return pubUser(u);
});
route("DELETE", "/api/users/:id", "user", ({ user, p }) => {
  const u = users.get(p.id) ?? fail(404, "Benutzer nicht gefunden");
  if (u.id === user.id) fail(400, "Das eigene Konto kann nicht gelöscht werden.");
  users.delete(u.id);
  sessions.destroyUser(u.id);
  logEvent(user.username, "Benutzer gelöscht", undefined, u.username);
  return null;
});
/** password of another admin (forgotten password); ends the sessions of that user */
route("POST", "/api/users/:id/password", "user", ({ user, p, body }) => {
  const u = users.get(p.id) ?? fail(404, "Benutzer nicht gefunden");
  if (u.id === user.id) fail(400, "Das eigene Passwort bitte mit dem aktuellen Passwort ändern.");
  const problem = passwordProblem(body?.password);
  if (problem) fail(400, problem);
  u.passwordHash = hashPassword(body.password);
  users.put(u);
  sessions.destroyUser(u.id);
  logEvent(user.username, "Passwort eines Benutzers gesetzt", undefined, u.username);
  return pubUser(u);
});
/** another admin lost app, passkeys and recovery codes: the next sign-in sets up a new second factor */
route("POST", "/api/users/:id/reset-mfa", "user", ({ user, p }) => {
  const u = users.get(p.id) ?? fail(404, "Benutzer nicht gefunden");
  if (u.id === user.id) fail(400, "Den eigenen zweiten Faktor bitte unter „Mein Konto“ verwalten.");
  resetMfa(u);
  logEvent(user.username, "Zweiten Faktor zurückgesetzt", undefined, u.username);
  return pubUser(u);
});
function resetMfa(u: StoredUser) {
  delete u.totp;
  delete u.totpPending;
  delete u.passkeys;
  delete u.recoveryCodes;
  users.put(u);
  users.flush();
  sessions.destroyUser(u.id);
}
/** allowed while the second factor is still open */
const MFA_PATHS = new Set([
  "/api/auth/session", "/api/auth/mfa/verify", "/api/auth/mfa/setup", "/api/auth/mfa/setup/confirm",
  "/api/auth/passkey/register/options", "/api/auth/passkey/register/verify", "/api/auth/passkey/verify/options", "/api/auth/passkey/verify",
]);

/* ------------------------------------------------------------------ overview and settings */
route("GET", "/api/overview", "user", ({ req }): Overview => {
  const url = publicUrl(req);
  return {
    productName: CFG.productName,
    package: clientPackage(),
    autoUpdate: settings.value.autoUpdate,
    publicUrl: url,
    installCommand: `irm ${url}/install.ps1 | iex`,
  };
});
route("PUT", "/api/settings", "user", ({ user, body }) => {
  if (typeof body?.autoUpdate === "boolean" && body.autoUpdate !== settings.value.autoUpdate) {
    settings.value.autoUpdate = body.autoUpdate;
    settings.save();
    logEvent(user.username, body.autoUpdate ? "Automatische Updates eingeschaltet" : "Automatische Updates ausgeschaltet");
  }
  return settings.value;
});
route("GET", "/api/events", "user", () => events.all().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 500));

/* ------------------------------------------------------------------ API tokens (troubleshooting, automation) */
/** "Authorization: Bearer smtpproxy_<id>.<secret>": acts like the creating admin, valid for at most 24 hours */
const API_TOKEN_MAX_HOURS = 24;
const pruneTokens = () => {
  for (const x of apiTokens.filter((x) => Date.parse(x.expiresAt) <= Date.now())) apiTokens.delete(x.id);
};
const pubToken = ({ secretHash, ...rest }: StoredApiToken): ApiToken => rest;
function tokenUser(req: IncomingMessage): StoredUser {
  const m = /^Bearer smtpproxy_([A-Za-z0-9]+)\.([A-Za-z0-9_-]+)$/.exec(String(req.headers.authorization ?? "").trim());
  if (!m) fail(401, "Ungültiger API-Token. Erwartet: Authorization: Bearer smtpproxy_<id>.<secret>");
  const tok = apiTokens.get(m![1]);
  if (!tok || sha256(m![2]) !== tok.secretHash) fail(401, "API-Token unbekannt oder widerrufen.");
  if (Date.parse(tok!.expiresAt) <= Date.now()) {
    apiTokens.delete(tok!.id);
    fail(401, `API-Token ist am ${tok!.expiresAt} abgelaufen (höchstens ${API_TOKEN_MAX_HOURS} Stunden gültig). Unter Einstellungen → API-Zugriff einen neuen erzeugen.`);
  }
  tok!.lastUsedAt = now();
  tok!.lastUsedIp = clientIp(req);
  apiTokens.put(tok!);
  return { id: "api:" + tok!.id, username: `api:${tok!.name}`, displayName: `API-Token „${tok!.name}“ (${tok!.createdBy})`, createdAt: tok!.createdAt, passwordHash: "" };
}
/** accounts, tokens and sign-in stay with signed-in people */
function tokenGuard(path: string) {
  if (/^\/api\/(users|api-tokens|auth|setup)(\/|$)/.test(path))
    fail(403, "Mit einem API-Token nicht erlaubt: Benutzer, API-Tokens und Anmeldung bleiben angemeldeten Benutzern vorbehalten.");
}
route("GET", "/api/api-tokens", "user", () => {
  pruneTokens();
  return apiTokens.all().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(pubToken);
});
route("POST", "/api/api-tokens", "user", ({ body, user }) => {
  const name = String(body?.name ?? "").trim().slice(0, 80);
  if (!name) fail(400, "Bitte einen Namen für den Token eingeben.");
  const hours = Math.round(Number(body?.hours ?? 8));
  if (!(hours >= 1 && hours <= API_TOKEN_MAX_HOURS)) fail(400, `Ein API-Token gilt höchstens ${API_TOKEN_MAX_HOURS} Stunden.`);
  const secret = token(32);
  const tok: StoredApiToken = {
    id: token(9).replace(/[^A-Za-z0-9]/g, "x"),
    name,
    createdBy: user.username,
    createdAt: now(),
    expiresAt: new Date(Date.now() + hours * 3600_000).toISOString(),
    secretHash: sha256(secret),
  };
  apiTokens.put(tok);
  logEvent(user.username, "API-Token erzeugt", undefined, `„${name}“, gültig bis ${tok.expiresAt.slice(0, 16).replace("T", " ")} UTC`);
  // the secret is returned only once
  return { ...pubToken(tok), token: `smtpproxy_${tok.id}.${secret}` };
});
route("DELETE", "/api/api-tokens/:id", "user", ({ p, user }) => {
  const tok = apiTokens.get(p.id) ?? fail(404, "API-Token nicht gefunden");
  apiTokens.delete(tok.id);
  logEvent(user.username, "API-Token widerrufen", undefined, `„${tok.name}“`);
  return null;
});

/* ------------------------------------------------------------------ server output (troubleshooting) */
/** the last 1000 lines of console output, also reachable with an API token */
const serverLog: { at: string; level: "info" | "error"; text: string }[] = [];
for (const [fn, level] of [["log", "info"], ["warn", "error"], ["error", "error"]] as const) {
  const orig = console[fn].bind(console);
  console[fn] = (...args: unknown[]) => {
    serverLog.push({ at: now(), level, text: args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ").slice(0, 4000) });
    if (serverLog.length > 1000) serverLog.splice(0, serverLog.length - 1000);
    orig(...args);
  };
}
route("GET", "/api/diagnostics", "user", ({ req }) => {
  const q = new URL(req.url ?? "", "http://x").searchParams;
  const limit = Math.min(1000, Number(q.get("limit") ?? 200) || 200);
  return {
    version: clientPackage()?.version,
    startedAt: STARTED_AT,
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    proxies: proxies.all().length,
    serverLog: serverLog.slice(-limit),
  };
});

/* ------------------------------------------------------------------ proxies (UI) */
const pubProxy = ({ publicKey, ackMailSeq, ackServiceSeq, ...p }: StoredProxy): Proxy => p;
const summary = (p: StoredProxy) => {
  const { config, queue, failed, desired, ...rest } = pubProxy(p);
  return { ...rest, hasDesired: !!desired, tenant: config?.m365?.tenantName ?? "", port: config?.smtp?.port };
};
const getProxy = (id: string) => proxies.get(id) ?? fail(404, "Proxy nicht gefunden");

route("GET", "/api/proxies", "user", () => proxies.all().sort((a, b) => a.name.localeCompare(b.name)).map(summary));
route("GET", "/api/proxies/:id", "user", ({ p }) => pubProxy(getProxy(p.id)));
route("PATCH", "/api/proxies/:id", "user", ({ p, body, user }) => {
  const x = getProxy(p.id);
  if (typeof body?.name === "string" && body.name.trim()) x.name = body.name.trim().slice(0, 80);
  if (typeof body?.notes === "string") x.notes = body.notes.slice(0, 2000);
  proxies.put(x);
  logEvent(user.username, "Proxy umbenannt/Notiz geändert", x);
  return pubProxy(x);
});
route("POST", "/api/proxies/:id/approve", "user", ({ p, user }) => {
  const x = getProxy(p.id);
  x.state = "approved";
  x.approvedAt = now();
  x.approvedBy = user.username;
  proxies.put(x);
  logEvent(user.username, "Proxy freigegeben", x, `Fingerabdruck ${x.fingerprint}`);
  return pubProxy(x);
});
route("POST", "/api/proxies/:id/reject", "user", ({ p, user }) => {
  const x = getProxy(p.id);
  x.state = "rejected";
  proxies.put(x);
  logEvent(user.username, "Proxy abgelehnt", x);
  return pubProxy(x);
});
route("DELETE", "/api/proxies/:id", "user", ({ p, user }) => {
  const x = getProxy(p.id);
  proxies.delete(x.id);
  logs.remove(`${x.id}-mail`);
  logs.remove(`${x.id}-service`);
  logEvent(user.username, "Proxy entfernt", x);
  return null;
});

/** Settings edited in the web app become the desired configuration; the proxy applies it on its next sync. */
route("PUT", "/api/proxies/:id/config", "user", ({ p, body, user }) => {
  const x = getProxy(p.id);
  if (x.state !== "approved" || !x.config) fail(409, "Der Proxy ist nicht freigegeben oder hat noch keine Einstellungen gemeldet.");
  const next = body?.config as ProxyConfig;
  if (!next?.smtp || !Array.isArray(next.users)) fail(400, "Ungültige Einstellungen.");
  const problem = validateConfig(next);
  if (problem) fail(400, problem);
  const base = (x.desired?.config ?? x.config)!;
  const passwords: string[] = [];
  next.users = next.users.map((u) => {
    const old = base.users.find((o) => o.name.toLowerCase() === u.name.toLowerCase());
    const out = { name: u.name.trim(), enabled: !!u.enabled, description: String(u.description ?? ""), allowedSenders: (u.allowedSenders ?? []).map(String), passwordHash: old?.passwordHash ?? "" };
    if (u.newPassword) {
      if (passwordProblem(u.newPassword)) fail(400, `Passwort für ${u.name}: ${passwordProblem(u.newPassword)}`);
      out.passwordHash = smtpPasswordHash(u.newPassword);
      passwords.push(u.name);
    }
    if (!out.passwordHash) fail(400, `Für den neuen Benutzer ${u.name} fehlt ein Passwort.`);
    return out;
  });
  // the Microsoft 365 connection, the shared mailbox (set up in Exchange) and the server address stay with the proxy
  next.m365 = x.config!.m365;
  const own = x.config!.senders;
  next.senders = { ...next.senders, sharedMailbox: own.sharedMailbox, sharedMailboxAliases: own.sharedMailboxAliases, sharedMailboxSetupAt: own.sharedMailboxSetupAt };
  next.management = { ...next.management, serverUrl: x.config!.management.serverUrl };
  x.desired = { baseRevision: x.config!.revision, config: next, by: user.username, at: now() };
  delete x.desiredError;
  proxies.put(x);
  logEvent(user.username, "Einstellungen geändert (wartet auf Übernahme)", x, passwords.length ? `Neue Passwörter: ${passwords.join(", ")}` : undefined);
  return pubProxy(x);
});
route("DELETE", "/api/proxies/:id/config", "user", ({ p, user }) => {
  const x = getProxy(p.id);
  delete x.desired;
  proxies.put(x);
  logEvent(user.username, "Ausstehende Einstellungen verworfen", x);
  return pubProxy(x);
});
function validateConfig(c: ProxyConfig): string | null {
  const port = Number(c.smtp.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "Port muss zwischen 1 und 65535 liegen.";
  if (!/^[0-9a-fA-F.:]+$/.test(String(c.smtp.listenAddress))) return "IP-Adresse ist ungültig.";
  if (!(c.smtp.maxMessageSizeMb >= 1 && c.smtp.maxMessageSizeMb <= 150)) return "Nachrichtengröße: 1 bis 150 MB.";
  if (!(c.smtp.maxRecipients >= 1 && c.smtp.maxRecipients <= 500)) return "Empfänger: 1 bis 500.";
  const net = /^[0-9a-fA-F.:]+(\/\d{1,3})?$/;
  const bad = [...c.smtp.anonymousNetworks, ...c.smtp.allowedNetworks].find((n) => !net.test(n));
  if (bad) return `Ungültiges Netz: ${bad}`;
  const names = c.users.map((u) => u.name.trim().toLowerCase());
  if (names.some((n) => !n || n.length > 64)) return "Benutzernamen: 1 bis 64 Zeichen.";
  if (new Set(names).size !== names.length) return "Benutzernamen müssen eindeutig sein.";
  if (c.senders.allowedAddresses.some((a) => !/^[^@\s]+@[^@\s]+$/.test(a))) return "Ungültige Absenderadresse.";
  return null;
}

route("POST", "/api/proxies/:id/commands", "user", ({ p, body, user }) => {
  const x = getProxy(p.id);
  const type = String(body?.type ?? "");
  if (!["retryFailed", "deleteFailed", "retryQueue"].includes(type)) fail(400, "Unbekannter Befehl");
  const cmd: Command = { id: token(9), type: type as Command["type"], arg: body?.arg ? String(body.arg).slice(0, 80) : undefined, createdAt: now(), createdBy: user.username };
  x.pendingCommands = [...(x.pendingCommands ?? []), cmd].slice(-50);
  proxies.put(x);
  logEvent(user.username, `Befehl ${type}${cmd.arg ? ` (${cmd.arg})` : ""}`, x);
  return pubProxy(x);
});
route("POST", "/api/proxies/:id/update", "user", ({ p, user }) => {
  const x = getProxy(p.id);
  const pkg = clientPackage() ?? fail(404, "Kein Client-Paket auf dem Server.");
  x.updateTarget = pkg.version;
  proxies.put(x);
  logEvent(user.username, `Update auf ${pkg.version} ausgerollt`, x);
  return pubProxy(x);
});
route("POST", "/api/proxies-update", "user", ({ user }) => {
  const pkg = clientPackage() ?? fail(404, "Kein Client-Paket auf dem Server.");
  let n = 0;
  for (const x of proxies.filter((x) => x.state === "approved" && isNewer(pkg.version, x.version))) {
    x.updateTarget = pkg.version;
    proxies.put(x);
    n++;
  }
  logEvent(user.username, `Update auf ${pkg.version} an ${n} Proxys ausgerollt`);
  return { count: n };
});
route("GET", "/api/proxies/:id/logs", "user", ({ req, p }) => {
  const x = getProxy(p.id);
  const q = new URL(req.url ?? "", "http://x").searchParams;
  const kind = q.get("kind") === "service" ? "service" : "mail";
  const text = (q.get("q") ?? "").toLowerCase();
  const ev = q.get("event") ?? "";
  const limit = Math.min(2000, Number(q.get("limit") ?? 500) || 500);
  return logs.read<MailLogEntry | ServiceLogEntry>(`${x.id}-${kind}`, (e) => (!ev || (e as MailLogEntry).event === ev) && (!text || JSON.stringify(e).toLowerCase().includes(text)), limit);
});

/* ------------------------------------------------------------------ proxy API (signed requests) */
/**
 * Authorization: SmtpProxySig <id|new>:<unix time>:<nonce>:<signature>. Signature (ECDSA P-256, SHA-256, P1363) over
 * "METHOD\nPATH\nTIME\nNONCE\nSHA256(body)". "new" only for the registration, verified with the key in the body.
 */
function verifyRequest(req: IncomingMessage, publicKeyForNew?: string): StoredProxy | null {
  const m = String(req.headers.authorization ?? "").match(/^SmtpProxySig ([\w-]+):(\d{9,12}):([A-Za-z0-9_-]{16,64}):([A-Za-z0-9+/=]{40,200})$/);
  if (!m) fail(401, "Proxy nicht authentifiziert");
  const [, id, ts, nonce, signature] = m!;
  const p = id === "new" ? null : proxies.get(id);
  const key = id === "new" ? publicKeyForNew : p?.publicKey;
  if (!key) fail(id === "new" ? 400 : 404, "Proxy unbekannt");
  if (Math.abs(Date.now() - Number(ts) * 1000) > SIG_WINDOW_MS) fail(401, "Zeitstempel der Anfrage ungültig. Uhrzeit des Proxy-Rechners prüfen (Abweichung höchstens 5 Minuten).");
  const seen = `${id}:${nonce}`;
  if (seenNonces.has(seen)) fail(401, "Anfrage wurde bereits verwendet.");
  const bodyHash = sha256(rawBodies.get(req) ?? Buffer.alloc(0));
  if (!verifySignature(key!, `${req.method}\n${req.url}\n${ts}\n${nonce}\n${bodyHash}`, signature)) fail(401, "Signatur ungültig");
  seenNonces.set(seen, Date.now() + 2 * SIG_WINDOW_MS);
  if (seenNonces.size > 20_000) for (const [k, exp] of seenNonces) if (exp < Date.now()) seenNonces.delete(k);
  return p ?? null;
}
const fingerprintOf = (publicKey: string) => sha256(Buffer.from(publicKey, "base64")).slice(0, 16);
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : undefined);

route("POST", "/api/client/v1/register", "proxy", ({ req, body }) => {
  if (!parsePublicKey(body?.publicKey)) fail(400, "Ungültiger öffentlicher Schlüssel (erwartet: EC P-256, SPKI).");
  verifyRequest(req, body.publicKey);
  // same key again (local state lost): same proxy
  const existing = proxies.find((x) => x.publicKey === body.publicKey);
  if (existing) return { clientId: existing.id, state: existing.state };
  const host = str(body.host, 64) ?? "?";
  const p = proxies.put({
    id: "p-" + token(9),
    name: host,
    host,
    domain: str(body.domain, 100),
    os: str(body.os, 100),
    version: str(body.version, 20) ?? "?",
    state: "pending",
    publicKey: body.publicKey,
    fingerprint: fingerprintOf(body.publicKey),
    keyStorage: body.keyStorage === "tpm" ? "tpm" : "software",
    registeredAt: now(),
    lastSeen: now(),
    lastIp: clientIp(req),
    pendingCommands: [],
    ackMailSeq: 0,
    ackServiceSeq: 0,
  });
  logEvent("System", "Neuer Proxy wartet auf Freigabe", p, `${host} von ${clientIp(req)}, Fingerabdruck ${p.fingerprint}`);
  console.log(`Neuer Proxy ${host} (${p.id}) von ${clientIp(req)} wartet auf Freigabe`);
  return { clientId: p.id, state: p.state };
});

route("POST", "/api/client/v1/sync", "proxy", ({ req, body }) => {
  const p = verifyRequest(req)!;
  p.lastSeen = now();
  p.lastIp = clientIp(req);
  if (body?.version) p.version = String(body.version).slice(0, 20);
  if (p.state !== "approved") {
    proxies.put(p);
    return { state: p.state };
  }
  if (body?.status) p.status = body.status;
  if (body?.config) p.config = body.config;
  if (Array.isArray(body?.queue)) p.queue = body.queue.slice(0, 200);
  if (Array.isArray(body?.failed)) p.failed = body.failed.slice(0, 200);

  // logs: append everything after the last acknowledged number
  const mail = (Array.isArray(body?.mailLog) ? body.mailLog : []).filter((e: MailLogEntry) => e.seq > p.ackMailSeq);
  const service = (Array.isArray(body?.serviceLog) ? body.serviceLog : []).filter((e: ServiceLogEntry) => e.seq > p.ackServiceSeq);
  // a reinstalled proxy starts counting at 1 again
  if (Array.isArray(body?.mailLog) && body.mailLog.length && body.mailLog[0].seq <= 1 && p.ackMailSeq > 1) p.ackMailSeq = 0;
  if (Array.isArray(body?.serviceLog) && body.serviceLog.length && body.serviceLog[0].seq <= 1 && p.ackServiceSeq > 1) p.ackServiceSeq = 0;
  logs.append(`${p.id}-mail`, mail);
  logs.append(`${p.id}-service`, service);
  if (mail.length) p.ackMailSeq = Math.max(...mail.map((e: MailLogEntry) => e.seq));
  if (service.length) p.ackServiceSeq = Math.max(...service.map((e: ServiceLogEntry) => e.seq));

  const dr = body?.desiredResult;
  if (dr && p.desired && dr.baseRevision === p.desired.baseRevision) {
    if (dr.applied) logEvent("System", `Einstellungen übernommen (Revision ${dr.revision})`, p);
    else {
      p.desiredError = { message: String(dr.error ?? "abgelehnt").slice(0, 500), at: now() };
      logEvent("System", "Einstellungen nicht übernommen", p, p.desiredError.message);
    }
    delete p.desired;
  }
  for (const r of Array.isArray(body?.commandResults) ? body.commandResults : []) {
    const cmd = p.pendingCommands.find((c) => c.id === r.id);
    if (!cmd) continue;
    p.pendingCommands = p.pendingCommands.filter((c) => c.id !== r.id);
    logEvent("System", `Befehl ${cmd.type} ${r.ok ? "ausgeführt" : "fehlgeschlagen"}`, p, r.message ?? undefined);
  }
  // a reached update target is done
  if (p.updateTarget && p.version === p.updateTarget) {
    logEvent("System", `Update auf ${p.version} installiert`, p);
    delete p.updateTarget;
  }
  proxies.put(p);

  const pkg = clientPackage();
  const wantsUpdate = pkg && isNewer(pkg.version, p.version) && (p.updateTarget === pkg.version || settings.value.autoUpdate);
  return {
    state: p.state,
    ackMailSeq: p.ackMailSeq,
    ackServiceSeq: p.ackServiceSeq,
    desiredConfig: p.desired ? { baseRevision: p.desired.baseRevision, config: p.desired.config, by: p.desired.by } : undefined,
    commands: p.pendingCommands,
    update: wantsUpdate ? { version: pkg!.version, sha256: pkg!.sha256, size: pkg!.size } : undefined,
  };
});

route("POST", "/api/client/v1/unregister", "proxy", ({ req }) => {
  const p = verifyRequest(req)!;
  proxies.delete(p.id);
  logEvent("System", "Proxy hat sich abgemeldet", p, clientIp(req));
  return { ok: true };
});

route("GET", "/api/client/v1/package", "proxy", ({ req, res }) => {
  const p = verifyRequest(req)!;
  if (p.state !== "approved") fail(403, "Proxy nicht freigegeben");
  sendFile(res, join(CFG.packageDir, "M365SmtpProxy.zip"), "application/zip") || fail(404, "Kein Client-Paket auf dem Server.");
  return RAW;
});

/* ------------------------------------------------------------------ static files */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8",
  ".zip": "application/zip", ".ps1": "text/plain; charset=utf-8", ".sha256": "text/plain; charset=utf-8",
};
function sendFile(res: ServerResponse, file: string, type?: string) {
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  res.statusCode = 200;
  res.setHeader("Content-Type", type ?? TYPES[extname(file)] ?? "application/octet-stream");
  res.setHeader("Content-Length", statSync(file).size);
  res.setHeader("Cache-Control", file.endsWith("index.html") ? "no-store" : "public, max-age=300");
  createReadStream(file).pipe(res);
  return true;
}
function serveStatic(res: ServerResponse, dir: string, rel: string) {
  const full = normalize(join(dir, rel));
  if (!full.startsWith(dir + sep)) return false;
  return sendFile(res, full);
}

/* ------------------------------------------------------------------ request handling */
async function handle(req: IncomingMessage, res: ServerResponse) {
  securityHeaders(res);
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  try {
    if (path.startsWith("/api/")) {
      const r = routes.find((x) => x.method === req.method && x.re.test(path));
      if (!r) fail(404, "Unbekannter Endpunkt");
      let user: StoredUser | null = null;
      const bearer = String(req.headers.authorization ?? "").startsWith("Bearer ");
      if (r!.perm === "user" && bearer) {
        user = tokenUser(req);
        tokenGuard(path);
      } else if (r!.perm === "user") {
        user = sessionUser(req);
        if (!user) fail(401, "Nicht angemeldet");
        // browser sessions: second factor first (confirm it, or set it up at the first sign-in)
        const step = mfaStep(user!, req);
        if (step && !MFA_PATHS.has(path)) fail(403, step === "verify" ? "Bitte zuerst die Anmeldung mit dem zweiten Faktor abschließen." : "Bitte zuerst einen zweiten Faktor einrichten (Authenticator-App oder Passkey).");
      }
      // CSRF protection for browser sessions
      if (r!.perm !== "proxy" && !bearer && req.method !== "GET" && req.headers["x-requested-with"] !== "smtpproxy") fail(403, "Ungültige Anfrage");
      const m = path.match(r!.re)!;
      const params = Object.fromEntries(r!.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = req.method === "GET" || req.method === "DELETE" ? (rawBodies.set(req, Buffer.alloc(0)), undefined) : await readBody(req, r!.perm === "proxy" ? 16 * 1024 * 1024 : 2 * 1024 * 1024);
      const out = await r!.h({ req, res, p: params, body, user: user! });
      if (out === RAW) return;
      return out === null ? json(res, 204) : json(res, 200, out);
    }
    if (req.method !== "GET" && req.method !== "HEAD") fail(405, "Methode nicht erlaubt");
    if (path === "/healthz") return json(res, 200, { ok: true });
    if (path === "/install.ps1") {
      const f = join(CFG.packageDir, "install.ps1");
      if (!existsSync(f)) fail(404, "Kein Client-Paket auf dem Server.");
      const base = publicUrl(req);
      const script = readFileSync(f, "utf8")
        .replace(/^﻿/, "")
        .split("'__SERVER_URL__'").join(`'${base}'`)
        .split("'__PACKAGE_URL__'").join(`'${base}/download/M365SmtpProxy.zip'`);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.end(script);
    }
    if (path === "/download/M365SmtpProxy.zip" || path === "/download/M365SmtpProxy.zip.sha256") {
      if (sendFile(res, join(CFG.packageDir, path.slice("/download/".length)))) return;
      fail(404, "Kein Client-Paket auf dem Server.");
    }
    const rel = decodeURIComponent(path === "/" ? "index.html" : path.slice(1));
    if (serveStatic(res, CFG.staticDir, rel)) return;
    if (!extname(rel) && serveStatic(res, CFG.staticDir, "index.html")) return;
    fail(404, "Nicht gefunden");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (res.headersSent) return;
    json(res, status, { error: status === 500 ? "Interner Fehler" : e instanceof Error ? e.message : String(e) });
  }
}

/* ------------------------------------------------------------------ start */
const command = process.argv[2];
if (command === "reset-password") {
  // npm run reset-password -- <user> <new password>
  const [, , , username, password] = process.argv;
  const u = users.find((x) => x.username === String(username ?? "").toLowerCase());
  if (!u) {
    console.error("Benutzer nicht gefunden.");
    process.exit(1);
  }
  const problem = passwordProblem(password);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  u!.passwordHash = hashPassword(password);
  users.put(u!);
  users.flush();
  console.log(`Passwort von ${u!.username} gesetzt.`);
  process.exit(0);
}

if (command === "reset-mfa") {
  // npm run reset-mfa -- <user>: the next sign-in sets up a new second factor
  const u = users.find((x) => x.username === String(process.argv[3] ?? "").toLowerCase());
  if (!u) {
    console.error("Benutzer nicht gefunden.");
    process.exit(1);
  }
  resetMfa(u!);
  console.log(`Zweiter Faktor von ${u!.username} zurückgesetzt.`);
  process.exit(0);
}

const server = createServer((req, res) => void handle(req, res));
server.listen(CFG.port, () => {
  const pkg = clientPackage();
  console.log(`${CFG.productName} Verwaltungsserver auf Port ${CFG.port}, Daten in ${CFG.dataDir}, Client-Paket ${pkg?.version ?? "fehlt"}`);
  if (setupOpen()) console.log("Ersteinrichtung offen: im Browser den ersten Administrator anlegen.");
});
const shutdown = () => {
  for (const s of STORES) s.flush();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
