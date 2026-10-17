// Server test for the pipeline: first-run setup, sign-in, a simulated proxy (signed requests) through
// registration, approval, sync with logs, remote configuration, commands, update rollout and removal.
// Needs the built server (npm run build). Usage: node tools/test-server.mjs
import { spawn } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const data = mkdtempSync(join(tmpdir(), "smtpproxy-test-"));
const pkgDir = join(data, "pkg");
mkdirSync(pkgDir);
writeFileSync(join(pkgDir, "version.json"), JSON.stringify({ version: "9.9.9", sha256: "ab".repeat(32), size: 3, builtAt: new Date().toISOString() }));
writeFileSync(join(pkgDir, "M365SmtpProxy.zip"), "zip");
writeFileSync(join(pkgDir, "install.ps1"), "param([string]$ServerUrl = '__SERVER_URL__', [string]$PackageUrl = '__PACKAGE_URL__')");

const server = spawn(process.execPath, ["server/dist/server.mjs"], {
  env: { ...process.env, SMTPPROXY_PORT: String(port), SMTPPROXY_DATA: join(data, "data"), SMTPPROXY_PACKAGE: pkgDir, SMTPPROXY_STATIC: "dist" },
  stdio: ["ignore", "inherit", "inherit"],
});
let failed = 0;
const ok = (cond, text) => {
  console.log(`${cond ? "ok  " : "FEHLER"} ${text}`);
  if (!cond) failed++;
};

/** TOTP code (RFC 6238) for a time step, as an authenticator app computes it */
function totp(secret, counter) {
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of secret) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", Buffer.from(bytes)).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, "0");
}

let cookie = "";
let bearer = "";
async function ui(method, path, body) {
  const res = await fetch(base + "/api" + path, {
    method,
    headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: bearer } : { "X-Requested-With": "smtpproxy", Cookie: cookie }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}

// simulated proxy: EC P-256 key, requests signed like ClientIdentity.cs
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
let clientId = "new";
async function proxy(method, path, body) {
  const raw = Buffer.from(body ? JSON.stringify(body) : "");
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(18).toString("base64url");
  const text = `${method}\n${path}\n${ts}\n${nonce}\n${createHash("sha256").update(raw).digest("hex")}`;
  const sig = sign("sha256", Buffer.from(text), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Authorization: `SmtpProxySig ${clientId}:${ts}:${nonce}:${sig}` }, body: body ? raw : undefined });
  const t = await res.text();
  return { status: res.status, data: t && res.headers.get("content-type")?.includes("json") ? JSON.parse(t) : t };
}

const config = (revision) => ({
  revision, modifiedAt: new Date().toISOString(), modifiedBy: "test",
  smtp: { enabled: true, listenAddress: "0.0.0.0", port: 25, hostName: "x", maxMessageSizeMb: 35, maxRecipients: 100, anonymousNetworks: ["127.0.0.1/32"], allowedNetworks: [], allowAuthWithoutTls: true },
  users: [{ name: "scanner", passwordHash: "pbkdf2$1$a$b", enabled: true, description: "", allowedSenders: [] }],
  senders: { allowedAddresses: [], allowedDomains: [], exchangeScopeEnabled: false, exchangeScopeGroup: "" },
  m365: { tenantId: "t", tenantName: "Contoso", clientId: "c", certificateThumbprint: "x", domains: ["contoso.com"], connectedBy: "a" },
  delivery: { retryHours: 24, logRetentionDays: 30, logSubjects: false },
  management: { serverUrl: base, acceptUpdates: true, acceptRemoteConfig: true },
});

try {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(base + "/healthz");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  ok((await ui("GET", "/setup")).data.required === true, "Ersteinrichtung offen");
  ok((await ui("POST", "/setup/admin", { username: "admin", password: "kurz" })).status === 400, "zu kurzes Passwort abgelehnt");
  ok((await ui("POST", "/setup/admin", { username: "admin", password: "Sehr-sicheres-Passwort-1" })).status === 200, "Administrator angelegt");
  ok((await ui("POST", "/setup/admin", { username: "x", password: "Sehr-sicheres-Passwort-1" })).status === 409, "Ersteinrichtung danach geschlossen");
  ok((await ui("GET", "/proxies")).status === 403, "ohne zweiten Faktor gesperrt");
  const mfaSetup = (await ui("POST", "/auth/mfa/setup")).data;
  ok(/^otpauth:\/\/totp\//.test(mfaSetup?.uri ?? ""), "Authenticator-Einrichtung liefert otpauth-URI");
  const step = Math.floor(Date.now() / 30000);
  ok((await ui("POST", "/auth/mfa/setup/confirm", { code: "000000" === totp(mfaSetup.secret, step) ? "111111" : "000000" })).status === 401, "falscher Code abgelehnt");
  const confirmed = await ui("POST", "/auth/mfa/setup/confirm", { code: totp(mfaSetup.secret, step) });
  ok(confirmed.status === 200 && confirmed.data.recoveryCodes?.length === 10, "Authenticator eingerichtet, 10 Notfallcodes");
  const recoveryCodes = confirmed.data.recoveryCodes;
  ok((await ui("GET", "/proxies")).status === 200, "angemeldet nach Ersteinrichtung und zweitem Faktor");
  const csrf = await fetch(base + "/api/proxies-update", { method: "POST", headers: { Cookie: cookie } });
  ok(csrf.status === 403, "ohne CSRF-Header abgelehnt");

  const inst = await (await fetch(base + "/install.ps1")).text();
  ok(inst.includes(`'${base}'`) && inst.includes(`/download/M365SmtpProxy.zip'`), "install.ps1 enthält Serveradresse");

  const reg = await proxy("POST", "/api/client/v1/register", { publicKey: spki, keyStorage: "software", host: "PRINTSRV", version: "0.1.0" });
  ok(reg.status === 200 && reg.data.state === "pending", "Registrierung wartet auf Freigabe");
  clientId = reg.data.clientId;
  const replay = await proxy("POST", "/api/client/v1/sync", { version: "0.1.0" });
  ok(replay.data.state === "pending" && replay.data.ackMailSeq === undefined, "vor Freigabe keine Daten");

  const forged = await fetch(base + "/api/client/v1/sync", { method: "POST", headers: { Authorization: `SmtpProxySig ${clientId}:${Math.floor(Date.now() / 1000)}:${"a".repeat(20)}:${"A".repeat(88)}` }, body: "{}" });
  ok(forged.status === 401, "falsche Signatur abgelehnt");

  ok((await ui("POST", `/proxies/${clientId}/approve`)).status === 200, "Proxy freigegeben");
  const mailLog = [1, 2, 3].map((seq) => ({ seq, time: new Date().toISOString(), event: "delivered", from: "a@contoso.com", to: ["b@fabrikam.com"], size: 10, attempt: 1 }));
  let s = await proxy("POST", "/api/client/v1/sync", { version: "0.1.0", status: { listeningOn: "0.0.0.0:25", queueLength: 0, failedCount: 0 }, config: config(5), mailLog, serviceLog: [] });
  ok(s.data.state === "approved" && s.data.ackMailSeq === 3, "Sync bestätigt Protokolle bis 3");
  const logs = await ui("GET", `/proxies/${clientId}/logs?kind=mail`);
  ok(logs.data.length === 3, "Mail-Protokoll am Server");

  const cfg = config(5);
  cfg.smtp.port = 2525;
  cfg.users.push({ name: "app", enabled: true, description: "", allowedSenders: [], newPassword: "Neues-Passwort-123" });
  ok((await ui("PUT", `/proxies/${clientId}/config`, { config: cfg })).status === 200, "Einstellungen geändert");
  s = await proxy("POST", "/api/client/v1/sync", { version: "0.1.0", config: config(5) });
  const desired = s.data.desiredConfig;
  ok(desired?.baseRevision === 5 && desired.config.smtp.port === 2525, "Proxy erhält gewünschte Einstellungen");
  ok(desired.config.users.find((u) => u.name === "app")?.passwordHash?.startsWith("pbkdf2$210000$") && !("newPassword" in desired.config.users[1]), "Passwort nur als PBKDF2-Hash");
  ok(desired.config.users.find((u) => u.name === "scanner")?.passwordHash === "pbkdf2$1$a$b", "bestehender Hash bleibt");
  s = await proxy("POST", "/api/client/v1/sync", { version: "0.1.0", config: { ...config(6), smtp: { ...config(6).smtp, port: 2525 } }, desiredResult: { baseRevision: 5, applied: true, revision: 6 } });
  ok(!s.data.desiredConfig, "übernommene Einstellungen erledigt");

  await ui("POST", `/proxies/${clientId}/commands`, { type: "retryFailed", arg: "abc" });
  s = await proxy("POST", "/api/client/v1/sync", { version: "0.1.0" });
  const cmd = s.data.commands?.[0];
  ok(cmd?.type === "retryFailed" && cmd.arg === "abc", "Befehl wird ausgeliefert");
  s = await proxy("POST", "/api/client/v1/sync", { version: "0.1.0", commandResults: [{ id: cmd.id, ok: true }] });
  ok(s.data.commands.length === 0, "Befehl nach Ergebnis erledigt");

  ok(!s.data.update, "ohne Rollout kein Update");
  await ui("POST", `/proxies/${clientId}/update`);
  s = await proxy("POST", "/api/client/v1/sync", { version: "0.1.0" });
  ok(s.data.update?.version === "9.9.9", "ausgerolltes Update wird angeboten");
  const pkg = await proxy("GET", "/api/client/v1/package");
  ok(pkg.status === 200 && pkg.data === "zip", "Paket mit Signatur abrufbar");
  s = await proxy("POST", "/api/client/v1/sync", { version: "9.9.9" });
  ok(!s.data.update && !(await ui("GET", `/proxies/${clientId}`)).data.updateTarget, "Update nach Installation erledigt");

  // API token: admin rights without account management, at most 24 hours
  ok((await ui("POST", "/api-tokens", { name: "zu lang", hours: 25 })).status === 400, "API-Token länger als 24 Stunden abgelehnt");
  const tok = await ui("POST", "/api-tokens", { name: "Test", hours: 1 });
  ok(tok.status === 200 && /^smtpproxy_[A-Za-z0-9]+\.[\w-]+$/.test(tok.data.token) && !("secretHash" in tok.data), "API-Token erzeugt");
  bearer = `Bearer ${tok.data.token}`;
  ok((await ui("GET", `/proxies/${clientId}/logs?kind=mail`)).data.length === 3, "API-Token liest Protokolle");
  ok((await ui("POST", `/proxies/${clientId}/commands`, { type: "retryQueue" })).status === 200, "API-Token sendet Befehle (ohne CSRF-Header)");
  ok((await ui("GET", "/diagnostics")).data?.serverLog?.length > 0, "API-Token liest Serverausgaben");
  ok((await ui("GET", "/users")).status === 403, "API-Token darf keine Benutzer verwalten");
  ok((await ui("POST", "/api-tokens", { name: "x", hours: 1 })).status === 403, "API-Token darf keine Tokens erzeugen");
  bearer = "Bearer smtpproxy_abc.falsch";
  ok((await ui("GET", "/proxies")).status === 401, "falscher API-Token abgelehnt");
  bearer = "";
  ok((await ui("DELETE", `/api-tokens/${tok.data.id}`)).status === 204, "API-Token widerrufen");
  bearer = `Bearer ${tok.data.token}`;
  ok((await ui("GET", "/proxies")).status === 401, "widerrufener API-Token abgelehnt");
  bearer = "";

  // sign in again: password, then the second factor
  await ui("POST", "/auth/logout");
  const relogin = await ui("POST", "/auth/login", { username: "admin", password: "Sehr-sicheres-Passwort-1" });
  ok(relogin.data?.mfaRequired === "verify", "nach dem Passwort wird der zweite Faktor verlangt");
  ok((await ui("GET", "/proxies")).status === 403, "vor dem zweiten Faktor gesperrt");
  ok((await ui("POST", "/auth/mfa/verify", { code: totp(mfaSetup.secret, step) })).status === 401, "bereits benutzter Code abgelehnt");
  ok((await ui("POST", "/auth/mfa/verify", { code: totp(mfaSetup.secret, step + 1) })).status === 200, "Anmeldung mit neuem Code");
  ok((await ui("GET", "/proxies")).status === 200, "danach voller Zugriff");
  await ui("POST", "/auth/logout");
  await ui("POST", "/auth/login", { username: "admin", password: "Sehr-sicheres-Passwort-1" });
  ok((await ui("POST", "/auth/mfa/verify", { code: recoveryCodes[0] })).data?.recoveryCodesLeft === 9, "Anmeldung mit Notfallcode, 9 übrig");
  await ui("POST", "/auth/logout");
  await ui("POST", "/auth/login", { username: "admin", password: "Sehr-sicheres-Passwort-1" });
  ok((await ui("POST", "/auth/mfa/verify", { code: recoveryCodes[0] })).status === 401, "Notfallcode gilt nur einmal");
  ok((await ui("POST", "/auth/mfa/verify", { code: recoveryCodes[1] })).status === 200, "zweiter Notfallcode");

  ok((await proxy("POST", "/api/client/v1/unregister", {})).status === 200, "Abmeldung");
  ok((await ui("GET", "/proxies")).data.length === 0, "Proxy entfernt");
  ok((await ui("POST", "/auth/logout")).status === 204 && (await ui("GET", "/proxies")).status === 401, "Abmeldung beendet Sitzung");
} catch (e) {
  console.error(e);
  failed++;
} finally {
  // on Linux SIGTERM lets the server flush its stores: wait for the exit before removing the data folder
  const exited = new Promise((r) => server.once("exit", r));
  server.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  try {
    rmSync(data, { recursive: true, force: true });
  } catch (e) {
    console.warn(`Hinweis: Testordner nicht entfernt: ${e.message}`);
  }
}
console.log(failed ? `${failed} Fehler` : "Alle Servertests bestanden.");
process.exit(failed ? 1 : 0);
