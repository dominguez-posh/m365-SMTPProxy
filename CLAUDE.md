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
- **Absender** werden eingeschränkt: Das Tool prüft MAIL FROM gegen erlaubte Adressen/Domänen (und die Domänen
  des Tenants). Zusätzlich auf Exchange-Seite: *RBAC for Applications* (Rolle `Application Mail.Send` mit
  Management Scope auf eine mail-aktivierte Sicherheitsgruppe). Dann **keine** Entra-Berechtigung `Mail.Send`
  vergeben, sonst gilt sie tenantweit (Berechtigungen addieren sich).
- **M365-Anbindung** aus der GUI: Admin meldet sich per Browser (PKCE, Loopback, Client „Microsoft Graph Command Line
  Tools“ `14d82eec-…`) an, das Tool legt die App-Registrierung mit Zertifikat an (Schlüssel nicht exportierbar im
  Maschinenspeicher) und vergibt `Domain.Read.All` (+ `Mail.Send`, falls ohne Exchange-Einschränkung).
  Danach App-only mit Zertifikat. Kein Device-Code-Flow (gilt als unsicher).
- **Verwaltungsserver**: Client trägt nur die HTTPS-Adresse ein, meldet sich mit EC-P-256-Schlüsselpaar an
  (Maschinenschlüssel, nicht exportierbar), jede Anfrage signiert (Schema wie hrdnr). Erstverbindung muss im Server
  freigegeben werden. Erster Start des Servers: Ersteinrichtung im Browser legt den Admin mit Passwort an. MFA später.
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
- Server: `npm run typecheck` und `npm run build` vor jedem Commit.
- Ändert sich etwas unter `client/`, die Version in `client/Directory.Build.props` erhöhen, sonst erkennt der
  Server kein Update.
- Patch-Skripte (Node) ins Scratchpad; in JS `replace(a, () => b)` statt `replace(a, b)` (PowerShell-`$`).

## Stand

Siehe `docs/FORTSCHRITT.md`.
