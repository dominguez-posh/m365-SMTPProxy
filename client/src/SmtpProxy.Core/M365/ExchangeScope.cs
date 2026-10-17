using System.Diagnostics;
using System.Text;
using SmtpProxy.Core.Config;

namespace SmtpProxy.Core.M365;

public sealed class ExchangeScopeResult
{
    public bool Ok { get; set; }
    public string? Error { get; set; }
    public string? Group { get; set; }
    public List<string> Members { get; set; } = [];
    public List<string> NotFound { get; set; } = [];
}

/// <summary>
/// Restricts Mail.Send of the app to the members of a mail-enabled security group (RBAC for Applications in
/// Exchange Online). Runs a visible Windows PowerShell window with Connect-ExchangeOnline, because these cmdlets
/// need an Exchange administrator. Idempotent: the same run also synchronises the members later.
/// </summary>
public static class ExchangeScope
{
    public static string GroupAlias(string host) => $"smtpproxy-{host.ToLowerInvariant()}";
    public static string ScopeName(string appId) => $"M365 SMTP Proxy {appId}";

    public static async Task<ExchangeScopeResult> ApplyAsync(ProxyConfig c, Action<string> progress, CancellationToken ct)
    {
        var dir = Path.Combine(Path.GetTempPath(), $"smtpproxy-exo-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            var input = Path.Combine(dir, "input.json");
            var output = Path.Combine(dir, "result.json");
            var script = Path.Combine(dir, "exchange-scope.ps1");
            var log = Path.Combine(dir, "progress.log");
            JsonFile.Write(input, new
            {
                appId = c.M365.ClientId,
                servicePrincipalId = c.M365.ServicePrincipalId,
                displayName = $"{Paths.DisplayName} ({Environment.MachineName})",
                groupAlias = c.Senders.ExchangeScopeGroup is { Length: > 0 } g ? g : GroupAlias(Environment.MachineName),
                groupName = $"{Paths.DisplayName} Absender ({Environment.MachineName})",
                scopeName = ScopeName(c.M365.ClientId),
                members = c.Senders.AllowedAddresses,
                organization = c.M365.Domains.FirstOrDefault(d => d.EndsWith(".onmicrosoft.com")) ?? "",
            });
            // Windows PowerShell 5.1 reads scripts without BOM as ANSI
            await File.WriteAllTextAsync(script, Script, new UTF8Encoding(true), ct);

            // no window: the sign-in opens in the browser, progress lines go to progress.log and into the GUI
            using var p = Process.Start(new ProcessStartInfo("powershell.exe",
                $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{script}\" -InputFile \"{input}\" -OutputFile \"{output}\" -LogFile \"{log}\"")
            { UseShellExecute = false, CreateNoWindow = true }) ?? throw new InvalidOperationException("Windows PowerShell konnte nicht gestartet werden.");
            var shown = 0;
            void Tail()
            {
                try
                {
                    if (!File.Exists(log)) return;
                    using var fs = new FileStream(log, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                    var lines = new StreamReader(fs).ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries);
                    for (; shown < lines.Length; shown++) progress(lines[shown].TrimEnd('\r'));
                }
                catch (IOException) { }
            }
            var deadline = DateTime.UtcNow.AddMinutes(10);
            while (!p.HasExited)
            {
                Tail();
                if (DateTime.UtcNow > deadline) { try { p.Kill(true); } catch { } break; }
                await Task.Delay(500, ct);
            }
            Tail();
            return JsonFile.Read<ExchangeScopeResult>(output)
                   ?? new ExchangeScopeResult { Error = "Exchange-Skript ohne Ergebnis beendet (Zeitüberschreitung oder Anmeldung abgebrochen)." };
        }
        finally
        {
            try { Directory.Delete(dir, true); } catch { }
        }
    }

    // ASCII only: no typographic quotes in PowerShell strings.
    const string Script = """
        param([string]$InputFile, [string]$OutputFile, [string]$LogFile)
        $ErrorActionPreference = 'Stop'
        $ProgressPreference = 'SilentlyContinue'
        # runs without a window: progress lines go to the log file the GUI shows
        function Write-Step([string]$Text) { Add-Content -Path $LogFile -Value $Text -Encoding UTF8 }
        $in = Get-Content -Raw -Path $InputFile | ConvertFrom-Json
        $result = [ordered]@{ ok = $false; error = $null; group = $null; members = @(); notFound = @() }
        try {
            # -DisableWAM (sign-in in the browser) needs ExchangeOnlineManagement 3.7 or newer; WAM fails in elevated processes
            $installed = Get-Module -ListAvailable -Name ExchangeOnlineManagement | Sort-Object Version -Descending | Select-Object -First 1
            if (-not $installed -or $installed.Version -lt [version]'3.7.0') {
                Write-Step 'Modul ExchangeOnlineManagement wird installiert (aktueller Benutzer) ...'
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                if (-not (Get-PackageProvider -ListAvailable -Name NuGet -ErrorAction SilentlyContinue)) {
                    Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Scope CurrentUser -Force | Out-Null
                }
                Install-Module ExchangeOnlineManagement -MinimumVersion 3.7.0 -Scope CurrentUser -Force -AllowClobber
            }
            Import-Module ExchangeOnlineManagement -MinimumVersion 3.7.0
            Write-Step 'Anmeldung an Exchange Online im Browser (Exchange-Administrator) ...'
            $connect = @{ ShowBanner = $false; DisableWAM = $true }
            if ($in.organization) { $connect.Organization = $in.organization }
            Connect-ExchangeOnline @connect

            Write-Step "Gruppe $($in.groupAlias) ..."
            $group = Get-DistributionGroup -Identity $in.groupAlias -ErrorAction SilentlyContinue
            if (-not $group) {
                $group = New-DistributionGroup -Name $in.groupName -Alias $in.groupAlias -Type Security -MemberJoinRestriction Closed -MemberDepartRestriction Closed
                Set-DistributionGroup -Identity $group.Identity -HiddenFromAddressListsEnabled $true -RequireSenderAuthenticationEnabled $true
            }
            $result.group = [string]$group.PrimarySmtpAddress

            $members = @()
            foreach ($m in @($in.members)) {
                if (-not $m) { continue }
                $r = Get-Recipient -Identity $m -ErrorAction SilentlyContinue
                if ($r) { $members += [string]$r.PrimarySmtpAddress } else { $result.notFound += $m }
            }
            Write-Step "Mitglieder werden gesetzt ($($members.Count)) ..."
            Update-DistributionGroupMember -Identity $group.Identity -Members $members -BypassSecurityGroupManagerCheck -Confirm:$false
            $result.members = $members

            Write-Step 'Dienstprinzipal in Exchange ...'
            if (-not (Get-ServicePrincipal -Identity $in.appId -ErrorAction SilentlyContinue)) {
                New-ServicePrincipal -AppId $in.appId -ObjectId $in.servicePrincipalId -DisplayName $in.displayName | Out-Null
            }

            Write-Step 'Verwaltungsbereich ...'
            $filter = "MemberOfGroup -eq '$($group.DistinguishedName)'"
            if (Get-ManagementScope -Identity $in.scopeName -ErrorAction SilentlyContinue) {
                Set-ManagementScope -Identity $in.scopeName -RecipientRestrictionFilter $filter
            } else {
                New-ManagementScope -Name $in.scopeName -RecipientRestrictionFilter $filter | Out-Null
            }

            Write-Step 'Rolle Application Mail.Send ...'
            $assigned = Get-ManagementRoleAssignment -RoleAssignee $in.appId -Role 'Application Mail.Send' -ErrorAction SilentlyContinue
            if (-not $assigned) {
                New-ManagementRoleAssignment -App $in.appId -Role 'Application Mail.Send' -CustomResourceScope $in.scopeName | Out-Null
            }
            $result.ok = $true
            Write-Step 'Fertig. Aenderungen in Exchange wirken nach bis zu 30 Minuten.'
        } catch {
            $result.error = $_.Exception.Message
            Write-Step "Fehler: $($_.Exception.Message)"
        } finally {
            try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue } catch { }
            $result | ConvertTo-Json -Depth 4 | Set-Content -Path $OutputFile -Encoding UTF8
        }
        """;
}
