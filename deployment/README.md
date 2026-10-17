# Verwaltungsserver in Azure

Eine Umgebung (`prod`) in Azure Container Apps. Jeder Push auf `main` testet und baut Client und Server, legt bei
neuer Client-Version ein GitHub-Release an und rollt das Image automatisch aus (`.github/workflows/deploy.yml`).

## Einmalige Einrichtung

1. **Bootstrap** (lokal, als Owner der Subscription): State-Speicher und Managed Identity für GitHub Actions.

   ```powershell
   cd deployment/bootstrap
   copy terraform.tfvars.example terraform.tfvars   # subscription_id eintragen
   az login
   terraform init
   terraform apply
   terraform output github_secrets
   ```

   `terraform.tfstate` in `bootstrap/` bleibt nur lokal (nicht committen, nicht löschen).
   Ist der Name `stsmtpproxytfstate` vergeben, `storage_account_name` ändern und `../backend.hcl` anpassen.

2. **GitHub-Secrets** im Repository (Settings → Secrets and variables → Actions):
   `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` aus der Ausgabe oben.

3. **Workflow starten**: Push auf `main` oder *Build und Ausrollen* von Hand. Nach dem ersten Lauf das Paket
   `m365-smtpproxy` unter github.com → Profil → Packages auf **Public** stellen, sonst kann Azure das Image nicht
   laden (dann den Workflow erneut starten).

4. **Ersteinrichtung**: die Adresse aus dem Workflow (Umgebung *prod*) bzw. `terraform output url` aufrufen und den
   ersten Administrator mit eigenem Passwort anlegen. Bis dahin ist die Ersteinrichtung für jeden offen, der die
   Adresse kennt: direkt nach dem ersten Ausrollen erledigen.

## Betrieb

- Genau eine Instanz (Sitzungen und Nonces liegen im Arbeitsspeicher), Daten als JSON auf Azure Files unter `/data`.
- `min_replicas = 0`: Ohne Anfragen schläft der Server; jeder verbundene Proxy meldet sich alle 30 Sekunden und hält
  ihn wach. Kosten mit 0,25 vCPU grob 3–10 € im Monat plus wenige Cent für Speicher und Protokolle.
- Passwort vergessen: in der Container-App-Konsole `node server/dist/server.mjs reset-password <user> <passwort>`.
- Lokal ausrollen (Fehlersuche): `terraform init -backend-config=backend.hcl` und
  `terraform apply -var image_tag=<commit-sha>` (Subscription über `subscription.auto.tfvars` oder `ARM_SUBSCRIPTION_ID`).

## Variablen

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `name` | `smtpproxy` | Basisname der Ressourcen und der Adresse |
| `resource_group_name` | `rg-smtpproxy` | Ressourcengruppe |
| `location` | `westeurope` | Region |
| `image_repository` | `ghcr.io/dominguez-posh/m365-smtpproxy` | Image ohne Tag |
| `image_tag` | – | Commit-SHA, setzt die Pipeline |
| `cpu` / `memory` | `0.25` / `0.5Gi` | Größe des Containers |
| `min_replicas` | `0` | 0 = schläft ohne Anfragen, 1 = läuft immer |
| `idle_minutes` | `30` | Abmeldung im Browser nach Inaktivität |
| `data_share_quota_gb` | `5` | Größe der Dateifreigabe |
| `log_daily_quota_gb` | `0.2` | Tageslimit der Protokolle (Kostenbremse) |
