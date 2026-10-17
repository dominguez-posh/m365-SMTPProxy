# Architektur

## Proxy (Client)

```
Gerät ──SMTP──▶ SmtpServer/SmtpSession ──▶ MailQueue (spool/*.eml + *.json) ──▶ DeliveryWorker ──Graph──▶ Empfänger
                    │ SmtpPolicy (Netze, AUTH, Absender)                           │ GraphMailer (sendMail / Entwurf + Upload)
                    ▼                                                               ▼
               logs/mail-*.jsonl ◀────────────── Logs ─────────────────▶ logs/service-*.jsonl
config.json ◀── GUI (WPF, als Admin) / ManagementClient (Server) ──▶ ProxyService lädt per FileSystemWatcher
status.json ◀── ProxyService (alle 5 s) ──▶ GUI
```

- `client/src/SmtpProxy.Core`: gesamte Logik (auch von der GUI genutzt).
- `client/src/SmtpProxy.Service`: Windows-Dienst `M365SmtpProxy` (LocalSystem), Einstiegspunkt `ProxyService`.
- `client/src/SmtpProxy.Gui`: Oberfläche `M365SmtpProxy.exe`, verlangt Adminrechte.
- Konfiguration mit Revision: jede Speicherung erhöht `revision`. Der Server ändert nur auf Basis einer bekannten
  Revision (`baseRevision`); wurde lokal inzwischen geändert, lehnt der Proxy ab und der Server zeigt das an.
- Microsoft 365: App-only mit Zertifikat (Client Assertion PS256, `x5t#S256`). Domänen täglich per `Domain.Read.All`.
- Graph nimmt die Empfänger aus den Kopfzeilen: Umschlag-Empfänger ohne Kopfzeile werden Bcc, Kopfzeilen-Empfänger
  ohne Umschlag entfernt. Bis ca. 3 MB MIME direkt an `sendMail`, darüber Entwurf ohne Anhänge + Upload-Sitzungen.
  Graph legt eine Kopie in „Gesendete Elemente“ des Absenders ab.

## Verwaltungsserver

Node.js ohne Fremdpakete (`server/src/main.ts`), Web-App in React (`web/src`), gemeinsame Typen in `shared/`.
Daten als JSON in `SMTPPROXY_DATA`: `users`, `proxies`, `events`, `settings`, `logs/<proxy>-mail|service.jsonl`.

### Proxy-API (signiert)

`Authorization: SmtpProxySig <id|new>:<unix-zeit>:<nonce>:<signatur>`; Signatur ECDSA P-256/SHA-256 (P1363) über
`METHOD\nPFAD\nZEIT\nNONCE\nSHA256(body)`, Zeitfenster 5 Minuten, Nonce nur einmal.

| Methode | Pfad | Zweck |
| --- | --- | --- |
| POST | `/api/client/v1/register` | `{publicKey, keyStorage, host, domain, version, os}` → `{clientId, state}` |
| POST | `/api/client/v1/sync` | Status, Konfiguration, neue Protokollzeilen, Warteschlange, Ergebnisse → Bestätigungen, gewünschte Konfiguration, Befehle, Update |
| GET | `/api/client/v1/package` | Client-Paket (nur freigegebene Proxys) |
| POST | `/api/client/v1/unregister` | Proxy entfernt sich |

Öffentlich: `/install.ps1` (Serveradresse eingesetzt), `/download/M365SmtpProxy.zip[.sha256]`, `/healthz`.
Web-API unter `/api/*` mit Sitzungs-Cookie und CSRF-Header `X-Requested-With: smtpproxy`.

### Updates

Das Image enthält das Client-Paket (`client-package/`, gebaut auf Windows in der Pipeline). Der Server bietet es
einem Proxy an, wenn ein Admin es ausgerollt hat (je Proxy oder alle) oder automatische Updates an sind. Der Proxy
lädt es signiert, prüft SHA-256, entpackt nach `ProgramData\M365SmtpProxy\update\<version>` und startet das
`install.ps1` **der neuen Version** mit `-Update`: Dienst stoppen, Dateien ersetzen, Dienst starten
(Protokoll: `logs\update.log`).
