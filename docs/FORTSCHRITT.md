# Fortschritt

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
- MFA für die Anmeldung am Verwaltungsserver.
- Zertifikat der App erneuern, ohne neu zu verbinden (derzeit: „Neu verbinden“ legt eine neue App an).
- Exchange-Gruppe und Verwaltungsbereich beim Trennen aufräumen.
