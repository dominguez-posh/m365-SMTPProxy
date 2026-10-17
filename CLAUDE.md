# M365 SMTP Proxy

Nimmt E-Mails per SMTP im lokalen Netz an (Drucker, Scanner, Altanwendungen) und stellt sie über Microsoft Graph
(`sendMail`) im Namen des Absenderpostfachs zu. Läuft vollständig autark als Windows-Dienst; optional meldet er sich
bei einem schlanken Verwaltungsserver an (Einstellungen, Protokolle, Updates aus der Ferne).

Repository **öffentlich** (Open Source): https://github.com/dominguez-posh/m365-SMTPProxy,
Image `ghcr.io/dominguez-posh/m365-smtpproxy` öffentlich. Vorbild für Plattform und Muster ist hrdnr
(`c:\git\MS-SecurityHardening`).

| Teil | Ort | Technik |
| --- | --- | --- |
| Client (Dienst + GUI) | `client/` | .NET 10 (LTS), Windows-Dienst `M365SmtpProxy`, WPF-GUI, self-contained |
| Verwaltungsserver | `server/src/`, Web-App `web/` | Node.js ohne Fremdpakete, React + esbuild, Daten als JSON-Dateien |
| Rollout | `install/install.ps1` | PowerShell-Einzeiler |
| Deployment | `deployment/`, `.github/workflows/` | Terraform, GitHub Actions, Azure Container Apps |

## Entscheidungen (Stand 17.10.2026)

- **Client ist die Quelle der Wahrheit.** Konfiguration, SMTP-Benutzer, Protokolle liegen auf der Maschine
  (`C:\ProgramData\M365SmtpProxy`). Der Server hält eine Kopie; Änderungen am Server werden beim nächsten Heartbeat
  vom Client übernommen (Revisionen, `config.revision`). Ohne Server läuft alles weiter.
- **Programmdateien** in `C:\Program Files\M365SmtpProxy`, Dienst `M365SmtpProxy` (LocalSystem).
- **GUI** braucht Adminrechte; sie schreibt `config.json` direkt, der Dienst lädt Änderungen per FileSystemWatcher.
  Der Dienst schreibt seinen Zustand nach `status.json`. Kein IPC-Kanal nötig.
- **SMTP**: Port frei wählbar, erst ohne TLS (kommt später). Anmeldung mit lokalen SMTP-Benutzern
  (AUTH PLAIN/LOGIN, PBKDF2-Hashes) oder anonym nur aus freigegebenen Netzen. Kein offenes Relay.
- **Absender** werden nur im Proxy eingeschränkt: MAIL FROM gegen erlaubte Adressen/Domänen und die Domänen des
  Tenants. Die App hat tenantweit `Mail.Send` (Entscheidung des Nutzers: einfach, kein Exchange-Abgleich, kein Warten).
  Graph sendet nur aus einem Postfach (Benutzer oder freigegeben) oder einem Alias davon; die Adressliste
  (`m365.addresses`, User.Read.All, proxyAddresses) dient als Auswahl in GUI und Web, ein Alias wird aus seinem
  Postfach gesendet (`SenderRouter`, braucht SendFromAliasEnabled in Exchange).
- **M365-Anbindung** aus der GUI: Admin meldet sich einmal per Browser an (PKCE, Loopback, Client „Microsoft Graph
  Command Line Tools“ `14d82eec-…`). Das Tool verwendet die vorhandene App-Registrierung weiter (aus der Konfiguration
  oder per Name) oder legt sie an, mit Zertifikat (nicht exportierbar im Maschinenspeicher) und den Rechten aus
  `AppProvisioner` (Mail.Send, User.Read.All, Domain.Read.All, Application.ReadWrite.OwnedBy + App ist ihre eigene
  Besitzerin). Danach App-only; der Dienst erneuert das Zertifikat selbst (`CertificateRenewal`). Kein Device-Code-Flow.
- **Verwaltungsserver**: Client trägt nur die HTTPS-Adresse ein, meldet sich mit EC-P-256-Schlüsselpaar an
  (Maschinenschlüssel, nicht exportierbar), jede Anfrage signiert (Schema wie hrdnr). Erstverbindung muss im Server
  freigegeben werden. Erster Start des Servers: Ersteinrichtung im Browser legt den Admin mit Passwort an.
- **Anmeldung am Server** wie hrdnr: Passwort + Pflicht-Zweitfaktor (Passkey oder Authenticator-App, Notfallcodes),
  Anmeldung ohne Passwort mit Passkey. `server/src/totp.ts` und `server/src/webauthn.ts` stammen unverändert aus hrdnr.
- **API-Tokens** (`Bearer smtpproxy_<id>.<secret>`, höchstens 24 Stunden) für Fehlersuche: Proxys, Protokolle,
  Ereignisse, Befehle, `/api/diagnostics` (Serverausgaben). Beschreibung: `docs/API.md`. Für Fehlersuche den Nutzer
  nach einem Token fragen statt zu raten.
- **Web-Oberfläche** im Design von hrdnr (`web/public/app.css`, Tokens, dunkle Seitenleiste, react-icons).
- **Kein Exchange-PowerShell, keine Exchange-Objekte** (Postfächer, Aliasse, Gruppen legt der Admin selbst an).
  Ein Versuch mit freigegebenem Postfach, automatischen Aliassen und RBAC for Applications (0.2.0/0.2.1) war dem
  Nutzer zu kompliziert und zu langsam und wurde in 0.3.0 wieder entfernt.
- Updates werden nur angeboten, wenn das Paket neuer ist (`isNewer` in `shared/types.ts`).
- **Updates**: Das Image enthält das Client-Paket (Zip + SHA-256). Der Server rollt Updates gezielt aus
  (pro Client oder alle); der Client prüft den Hash und aktualisiert sich über einen Updater-Prozess.
- **Eine Umgebung** (`prod`), kein dev/test. Push auf `main` → Build → Image → Terraform apply, alles automatisch.

## Sicherheit

- Keine Secrets, Passwörter, Tokens, Subscription- oder Tenant-IDs committen (öffentliches Repo).
  `terraform.tfvars`, `*.auto.tfvars` und State-Dateien sind per `.gitignore` ausgeschlossen.
- Pipeline meldet sich per OIDC (Managed Identity mit Federated Credential) an. Der Nutzer hat keine Rechte im
  Entra-Tenant der Subscription, nur Owner der Subscription; Bootstrap (`deployment/bootstrap/`) führt er selbst aus.

## Kosten

Eigene Test-Subscription mit kleinem Guthaben. Container Apps Consumption, `min_replicas = 0`, 0,25 vCPU,
Azure Files für `/data`, Log Analytics mit Tageslimit. Kosten neuer Ressourcen vorab nennen.

## Arbeitsweise

- Client bauen/testen: `dotnet build client` / `dotnet test client` (SDK liegt beim Nutzer unter
  `%LOCALAPPDATA%\Microsoft\dotnet`, ggf. in den PATH nehmen).
- Server: `npm run typecheck`, `npm run build` und `node tools/test-server.mjs` vor jedem Commit.
- GUI-Änderungen lokal starten: `__COMPAT_LAYER=RunAsInvoker` und `SMTPPROXY_DATA` setzen (keine Adminrechte nötig);
  Startfehler stehen in `logsgui-error.log`.
- Ändert sich etwas unter `client/`, die Version in `client/Directory.Build.props` erhöhen, sonst erkennt der
  Server kein Update.
- Patch-Skripte (Node) ins Scratchpad; in JS `replace(a, () => b)` statt `replace(a, b)` (PowerShell-`$`).

## Stand

Siehe `docs/FORTSCHRITT.md`.
