# Fortschritt

## Stand 18.10.2026 (Client 0.2.0)

- Freigegebenes Postfach für Absender ohne eigenes Postfach: Einrichtung in der GUI (Microsoft 365 → „In Exchange
  einrichten / abgleichen“, auch automatisch beim Verbinden): Postfach smtpproxy@<Domäne>, Aliasse noreply@ und
  absender@ (vorhandene übersprungen), SendFromAliasEnabled, Rollengruppe „Mail Recipients“ nur für dieses Postfach,
  App-Berechtigung Exchange.ManageAsApp. Der Dienst legt fehlende Absender als Alias an (Exchange-REST InvokeCommand,
  `ExchangeAdmin`) und sendet über `SenderRouter`.
- Erlaubte Adressen in GUI und Web: Teil vor dem @ eintragen, Domäne aus den Tenant-Domänen wählen.
- Fehler behoben: Mit Exchange-Einschränkung und leerer Adressliste nahm der Proxy jeden Absender an, Exchange lehnte
  dann mit 403 ErrorAccessDenied ab. Jetzt lehnt der Proxy solche Absender schon bei MAIL FROM ab.
- Noch nicht gegen einen echten Tenant geprüft: Einrichtungsskript (New-Mailbox, New-RoleGroup mit Dienstprinzipal),
  Alias-Anlage per InvokeCommand (nicht dokumentierte Schnittstelle des EXO-Moduls v3), Senden per MIME mit Alias als From.

## Stand 17.10.2026 spät (Client 0.1.2)

- Server läuft in Azure (Pipeline grün), erster Proxy installiert und freigegeben.
- 0.1.1: Absturz der GUI beim Start behoben. 0.1.2: Exchange-Einschränkung ohne WAM und ohne sichtbares Fenster.
- Server: Web-Oberfläche im hrdnr-Design, MFA (Passkey, Authenticator-App, Notfallcodes), Passkey-Anmeldung,
  API-Tokens (24 h) und `/api/diagnostics`. `tools/test-server.mjs`: 49 Prüfungen.

## Stand 17.10.2026 (Client 0.1.0)

Fertig und getestet:
- Client: SMTP-Server, Richtlinien, Warteschlange, Graph-Zustellung, Protokolle, Dienst, WPF-Oberfläche,
  M365-Einrichtung (App + Zertifikat), Exchange-Einschränkung (PowerShell-Fenster), Server-Anbindung, Updates.
  `dotnet test client`: 12 Tests (SMTP-Protokoll, AUTH, Größe, Netze, Absender, Empfängerabgleich).
- Server: Ersteinrichtung, Anmeldung, Benutzer, Proxys (Freigabe, Status, Einstellungen, Befehle, Protokolle,
  Updates), Ereignisse. `tools/test-server.mjs`: 27 Prüfungen.
- Lokal Ende-zu-Ende geprüft: echter Dienst gegen lokalen Server (Registrierung mit TPM-Schlüssel, Freigabe,
  Fernänderung von Port und SMTP-Benutzer, AUTH mit am Server gesetztem Passwort, Befehle, Protokolle).
- Installer (`install/install.ps1`), Paket-Build, Terraform (validiert), Pipeline.

Noch nicht gegen echte Systeme geprüft:
- Anmeldung als Admin und App-Anlage in einem echten Tenant, Zustellung über Graph, Exchange-RBAC-Skript.
- Installation per Einzeiler auf einer frischen Maschine, Self-Update über den Server.
- Erster Lauf der Pipeline und Bereitstellung in Azure.

## Offen / später

- TLS (STARTTLS und implizites TLS) mit Zertifikat aus dem Computerspeicher.
- Zertifikat der App erneuern, ohne neu zu verbinden (derzeit: „Neu verbinden“ legt eine neue App an).
- Exchange-Gruppe und Verwaltungsbereich beim Trennen aufräumen.
