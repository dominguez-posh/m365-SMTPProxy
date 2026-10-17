# API des Verwaltungsservers

Alle Pfade unter `https://<server>/api`. Typen: `shared/types.ts`.

## Anmeldung

**Browser:** Sitzungs-Cookie `sp_session` (HttpOnly, SameSite=Strict). Zustandsändernde Anfragen brauchen den Header
`X-Requested-With: smtpproxy`. Nach dem Passwort ist der zweite Faktor Pflicht (`CurrentUser.mfaRequired`:
`verify` = Code oder Passkey, `setup` = Passkey oder Authenticator-App einrichten); bis dahin sind nur
`/auth/session` und die `/auth/mfa/*`- bzw. `/auth/passkey/*`-Schritte erlaubt (sonst 403).

**API-Token** (Fehlersuche, Automatisierung): unter *Einstellungen → API-Zugriff* erzeugen, höchstens 24 Stunden
gültig, das Secret wird nur einmal angezeigt.

```
Authorization: Bearer smtpproxy_<id>.<secret>
```

Ein Token handelt wie ein Administrator, braucht weder zweiten Faktor noch CSRF-Header, darf aber nicht an
`/users`, `/api-tokens`, `/auth` und `/setup` (403). Jede Aktion landet mit `api:<name>` als Person in den Ereignissen.

```powershell
$h = @{ Authorization = "Bearer smtpproxy_..." }
Invoke-RestMethod https://<server>/api/proxies -Headers $h
Invoke-RestMethod "https://<server>/api/proxies/<id>/logs?kind=service&limit=100" -Headers $h
```

Fehler kommen als `{ "error": "<Meldung>" }` mit passendem Statuscode.

## Fehlersuche

| Methode | Pfad | Antwort |
|---|---|---|
| GET | `/diagnostics?limit=200` | Server: Version des Client-Pakets, Startzeit, Laufzeit, Node, Speicher, Anzahl Proxys, die letzten Konsolenausgaben (`serverLog`, max. 1000) |
| GET | `/proxies` | Übersicht aller Proxys (Zustand, Status, Version, letzter Kontakt) |
| GET | `/proxies/{id}` | `Proxy`: Status, gemeldete Konfiguration, Warteschlange, Fehlgeschlagene, ausstehende Änderung und deren Fehler, Befehle |
| GET | `/proxies/{id}/logs?kind=mail\|service&event=&q=&limit=` | Protokolle des Proxys, neueste zuerst (max. 2000). `event`: `received`, `delivered`, `deferred`, `failed`, `refused`; `q`: Volltext |
| GET | `/events` | Ereignisse (Freigaben, Änderungen, Befehle, Updates, Anmeldeeinstellungen), neueste 500 |
| GET | `/overview` | Produktname, Client-Paket (`version`, `sha256`, `builtAt`), automatische Updates, Installationsbefehl |

## Steuern

| Methode | Pfad | Body | Wirkung |
|---|---|---|---|
| POST | `/proxies/{id}/approve` · `/reject` | – | Proxy freigeben / ablehnen |
| PATCH | `/proxies/{id}` | `{ name?, notes? }` | Anzeigename, Notiz |
| DELETE | `/proxies/{id}` | – | Proxy entfernen (meldet sich neu an, solange die Serveradresse eingetragen ist) |
| PUT | `/proxies/{id}/config` | `{ config: ProxyConfig }` | Gewünschte Konfiguration; der Proxy übernimmt sie beim nächsten Abgleich, wenn er lokal seit `baseRevision` nicht geändert wurde. SMTP-Benutzer mit `newPassword` erhalten einen neuen PBKDF2-Hash. Microsoft-365-Verbindung und Serveradresse bleiben am Proxy |
| DELETE | `/proxies/{id}/config` | – | Ausstehende Änderung verwerfen |
| POST | `/proxies/{id}/commands` | `{ type, arg? }` | `retryQueue` (alle sofort versuchen), `retryFailed` (`arg` = Nachricht, ohne = alle), `deleteFailed` (`arg` = Nachricht) |
| POST | `/proxies/{id}/update` | – | Client-Paket des Servers auf diesem Proxy ausrollen (nur, wenn es neuer ist) |
| POST | `/proxies-update` | – | An alle freigegebenen Proxys mit älterer Version ausrollen |
| PUT | `/settings` | `{ autoUpdate }` | Neue Versionen automatisch verteilen |

## Nur mit Browser-Sitzung

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/setup` · POST `/setup/admin` | Ersteinrichtung (nur solange es keinen Benutzer gibt) |
| POST | `/auth/login` · `/auth/logout` · GET `/auth/session` | Anmeldung, `CurrentUser` |
| POST | `/auth/password` | Eigenes Passwort `{ current, password }` |
| POST | `/auth/mfa/verify` · `/auth/mfa/setup` · `/auth/mfa/setup/confirm` · `/auth/mfa/recovery-codes`, DELETE `/auth/mfa/totp` | Authenticator-App und Notfallcodes |
| POST | `/auth/passkey/register/options` · `/register/verify` · `/verify/options` · `/verify` · `/login/options` · `/login`, PATCH/DELETE `/auth/passkeys/{id}` | Passkeys (WebAuthn, base64url-JSON) |
| GET/POST/DELETE | `/users`, `/users/{id}`, POST `/users/{id}/password`, `/users/{id}/reset-mfa` | Administratoren verwalten |
| GET/POST/DELETE | `/api-tokens`, `/api-tokens/{id}` | API-Tokens `{ name, hours (1–24) }`; die Antwort beim Anlegen enthält einmalig `token` |

Auf dem Server (Container-Konsole): `node server/dist/server.mjs reset-password <user> <passwort>` und
`node server/dist/server.mjs reset-mfa <user>`.

## Proxy-API

Signierte Anfragen der Proxys (`/api/client/v1/*`), siehe [ARCHITEKTUR.md](ARCHITEKTUR.md).
