# Fortschritt

## Stand 18.10.2026 (Client 0.2.1)

- „Neu verbinden“ verwendet die bestehende App-Registrierung weiter (aus der Konfiguration oder per Name gefunden)
  und passt nur Rechte und Exchange an; neues Zertifikat nur, wenn das lokale fehlt oder bald abläuft.
- Exchange-Einrichtung: vorhandene Verwaltungsbereiche/Rollengruppen werden über die volle Liste gefunden (Get-* mit
  Namen findet über REST nicht alles); ein Bereich mit gleichem Filter wird übernommen.
- GUI speichert die Wahl „Freigegebenes Postfach“ und „Einschränken“ (vorher setzte Speichern sie zurück).
- Dienst ruft Exchange erst auf, wenn die App die Rechte von Version 2 hat.

## Stand 18.10.2026 (Client 0.2.0)

- **Eine Anmeldung, danach kein Benutzer mehr:** Beim Verbinden meldet sich der Admin einmal an (Graph CLI Client);
  der Exchange-Token kommt mit prompt=none aus derselben Browsersitzung (Client des EXO-Moduls). Die Exchange-
  Einrichtung läuft per REST (`ExchangeSetup` über `ExchangeAdmin`), kein PowerShell-Modul mehr.
- Freigegebenes Postfach smtpproxy@<Domäne>, Aliasse noreply@ und absender@ (vorhandene übersprungen),
  SendFromAliasEnabled. Der Dienst legt fehlende Absender als Alias an und sendet über `SenderRouter`.
- App-Rechte (PermissionsVersion 2): Domain.Read.All, Exchange.ManageAsApp, Application.ReadWrite.OwnedBy (App ist
  Besitzerin ihrer selbst), Mail.Send nur ohne Einschränkung. Exchange-Rollengruppe der App mit Schreibbereich nur auf
  Postfach und Absendergruppe (Mail Recipients, Distribution Groups, Security Group Creation and Membership).
- Dienst gleicht die Exchange-Gruppe bei geänderten Adressen selbst ab und erneuert das Zertifikat 60 Tage vor Ablauf
  selbst (`CertificateRenewal`: addKey mit Besitznachweis, Anmeldetest, removeKey, altes Zertifikat löschen).
- Ältere Verbindungen: einmal „In Exchange einrichten / abgleichen“ (eine Anmeldung) hebt sie auf Version 2.
- Erlaubte Adressen in GUI und Web: Teil vor dem @ eintragen, Domäne aus den Tenant-Domänen wählen.
- Fehler behoben: Mit Exchange-Einschränkung und leerer Adressliste nahm der Proxy jeden Absender an, Exchange lehnte
  dann mit 403 ErrorAccessDenied ab. Jetzt lehnt der Proxy solche Absender schon bei MAIL FROM ab.
- Noch nicht gegen einen echten Tenant geprüft: stille Exchange-Anmeldung (prompt=none, EXO-Client mit Loopback),
  Einrichtung per InvokeCommand (nicht dokumentierte Schnittstelle des EXO-Moduls v3; New-Mailbox, New-RoleGroup mit
  Dienstprinzipal, Rolle „Security Group Creation and Membership“ mit eigenem Schreibbereich), Senden per MIME mit
  Alias als From, addKey/removeKey der App an sich selbst.

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
- Exchange-Gruppe und Verwaltungsbereich beim Trennen aufräumen.
