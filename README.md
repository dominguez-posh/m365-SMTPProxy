# M365 SMTP Proxy

SMTP-Relay für Microsoft 365 ohne Basic Auth und ohne Connector: Drucker, Scanner und Altanwendungen liefern
E-Mails per SMTP im lokalen Netz ein, der Proxy stellt sie über **Microsoft Graph** (`sendMail`) im Namen des
Absenderpostfachs zu. Er läuft als Windows-Dienst vollständig eigenständig; optional verwaltet ein schlanker
Server beliebig viele Proxys zentral (Einstellungen, Protokolle, Updates).

## Funktionen

- **SMTP-Empfang** auf frei wählbarem Port: ESMTP mit SIZE, 8BITMIME, PIPELINING, AUTH PLAIN/LOGIN
  (TLS folgt in einer späteren Version).
- **Anmeldung**: lokale SMTP-Benutzer (PBKDF2-Hashes) oder anonym nur aus freigegebenen Netzen. Kein offenes Relay.
- **Erlaubte Absender**: nur Domänen des Tenants, zusätzlich Listen erlaubter Adressen/Domänen, je Benutzer weiter
  einschränkbar. Die Adressen wählst du aus einer Liste aller Adressen, von denen Graph senden kann (Postfächer und
  freigegebene Postfächer mit ihren Aliassen). Graph sendet nur aus einem Postfach; fehlt eine Adresse, in Exchange
  ein Postfach oder freigegebenes Postfach anlegen.
- **Einrichtung per Klick, danach ohne Benutzer**: einmalige Anmeldung als Administrator im Browser; das Tool legt
  die App-Registrierung mit Zertifikat an (privater Schlüssel nicht exportierbar im Zertifikatspeicher des Computers)
  oder verwendet die vorhandene weiter. Danach nur noch App + Zertifikat; das Zertifikat erneuert der Dienst selbst.
- **Zuverlässige Zustellung**: Warteschlange auf der Festplatte, Wiederholung bei vorübergehenden Fehlern, große
  Nachrichten bis 150 MB über Upload-Sitzungen, Empfänger exakt nach SMTP-Umschlag (auch Bcc).
- **Protokolle** ohne Nachrichteninhalt (Betreff optional), Aufbewahrung einstellbar.
- **Verwaltungsserver (optional)**: Proxy meldet sich mit eigenem Schlüsselpaar (TPM, falls vorhanden) an, die
  erste Verbindung wird im Server freigegeben. Danach Status, Einstellungen, Warteschlange, Protokolle und Updates
  aus der Ferne. Fällt der Server aus, arbeitet der Proxy unverändert weiter.

## Installation

PowerShell **als Administrator**:

```powershell
# eigenständig (neuestes Release)
irm https://github.com/dominguez-posh/m365-SMTPProxy/releases/latest/download/install.ps1 | iex

# mit Anmeldung bei einem Verwaltungsserver (Adresse steht im Server unter „Proxys“)
irm https://<server>/install.ps1 | iex

# mit Parametern, z. B. anderem SMTP-Port
& ([scriptblock]::Create((irm https://<server>/install.ps1))) -Port 2525
```

Danach im Startmenü **M365 SMTP Proxy** öffnen und unter **Microsoft 365** verbinden. Voraussetzungen: Windows 10/11
oder Windows Server 2019+ (64 Bit). Deinstallation über „Apps“ oder `install.ps1 -Uninstall`.

## Aufbau

| Teil | Ort | Technik |
| --- | --- | --- |
| Dienst und Oberfläche | `client/` | .NET 10, Windows-Dienst `M365SmtpProxy`, WPF |
| Verwaltungsserver | `server/`, `web/`, `shared/` | Node.js ohne Fremdpakete, React, JSON-Dateien |
| Installation | `install/install.ps1` | PowerShell 5.1/7 |
| Betrieb in Azure | `deployment/`, `.github/workflows/` | Terraform, Container Apps, GitHub Actions (OIDC) |

Daten des Proxys: `C:\ProgramData\M365SmtpProxy` (nur SYSTEM und Administratoren). Server betreiben:
[deployment/README.md](deployment/README.md). Architektur und API: [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md).

## Entwicklung

```powershell
dotnet test client                 # Client-Tests (.NET 10 SDK)
./tools/build-client.ps1           # Client-Paket nach client-package/
npm ci; npm run typecheck; npm run build
node tools/test-server.mjs         # Servertest mit simuliertem Proxy
npm start                          # Server auf Port 8080 (SMTPPROXY_DATA, SMTPPROXY_PACKAGE)
```

Lokal ohne Adminrechte: `SMTPPROXY_DATA` setzt den Datenordner, `SMTPPROXY_KEY_SCOPE=user` legt den
Server-Schlüssel im Benutzerprofil statt im Computer an.

## Lizenz

MIT
