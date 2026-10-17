using System.Diagnostics;
using System.Text;
using SmtpProxy.Core.Config;

namespace SmtpProxy.Core.M365;

public sealed class ExchangeSetupResult
{
    public bool Ok { get; set; }
    public string? Error { get; set; }
    public string? Group { get; set; }
    public List<string> Members { get; set; } = [];
    public List<string> NotFound { get; set; } = [];
    /// <summary>Primary address of the shared mailbox and all its SMTP addresses (aliases).</summary>
    public string? Mailbox { get; set; }
    public List<string> Aliases { get; set; } = [];
    /// <summary>Wanted aliases that belong to another recipient (own mailbox, group): skipped.</summary>
    public List<string> Taken { get; set; } = [];
}

/// <summary>
/// Exchange Online part of the setup, run in Windows PowerShell with Connect-ExchangeOnline (Exchange administrator,
/// browser sign-in). Idempotent; one sign-in does both parts:
/// - Shared mailbox: creates it with its aliases, turns on SendFromAliasEnabled and gives the app the role
///   "Mail Recipients" limited to this mailbox (role group with write scope), so the service can add aliases.
/// - Sender restriction: Mail.Send of the app only for the members of a mail-enabled security group
///   (RBAC for Applications); the shared mailbox is a member as well.
/// </summary>
public static class ExchangeSetup
{
    public const string DefaultMailboxName = "smtpproxy";
    /// <summary>Aliases every shared mailbox gets (local parts, domain of the mailbox).</summary>
    public static readonly string[] DefaultAliases = ["noreply", "absender"];

    public static string GroupAlias(string host) => $"smtpproxy-{host.ToLowerInvariant()}";
    public static string ScopeName(string appId) => $"M365 SMTP Proxy {appId}";

    /// <param name="mailbox">Address of the shared mailbox; empty = only the sender restriction.</param>
    public static async Task<ExchangeSetupResult> ApplyAsync(ProxyConfig c, string mailbox, bool restrictSenders, Action<string> progress, CancellationToken ct)
    {
        var dir = Path.Combine(Path.GetTempPath(), $"smtpproxy-exo-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            var input = Path.Combine(dir, "input.json");
            var output = Path.Combine(dir, "result.json");
            var script = Path.Combine(dir, "exchange-setup.ps1");
            var log = Path.Combine(dir, "progress.log");
            mailbox = mailbox.Trim().ToLowerInvariant();
            var at = mailbox.IndexOf('@');
            List<string> aliases = at <= 0 ? [] : DefaultAliases.Select(a => $"{a}@{mailbox[(at + 1)..]}")
                .Concat(c.Senders.SharedMailboxAliases)
                .Concat(c.Senders.AutoCreateAliases ? c.Senders.AllowedAddresses : [])
                .Select(a => a.ToLowerInvariant())
                .Where(a => a != mailbox).Distinct().ToList();
            JsonFile.Write(input, new
            {
                appId = c.M365.ClientId,
                servicePrincipalId = c.M365.ServicePrincipalId,
                displayName = $"{Paths.DisplayName} ({Environment.MachineName})",
                restrictSenders,
                groupAlias = c.Senders.ExchangeScopeGroup is { Length: > 0 } g ? g : GroupAlias(Environment.MachineName),
                groupName = $"{Paths.DisplayName} Absender ({Environment.MachineName})",
                scopeName = ScopeName(c.M365.ClientId),
                members = c.Senders.AllowedAddresses,
                mailbox = at > 0 ? mailbox : "",
                mailboxName = $"{Paths.DisplayName} ({mailbox})",
                mailboxAlias = at > 0 ? mailbox[..at] : "",
                aliases,
                mailboxScopeName = $"{ScopeName(c.M365.ClientId)} Postfach",
                roleGroupName = $"{Paths.DisplayName} Aliasse {c.M365.ClientId}",
                organization = Graph.M365Session.Organization(c.M365.Domains) ?? "",
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
            var deadline = DateTime.UtcNow.AddMinutes(15);
            while (!p.HasExited)
            {
                Tail();
                if (DateTime.UtcNow > deadline) { try { p.Kill(true); } catch { } break; }
                await Task.Delay(500, ct);
            }
            Tail();
            return JsonFile.Read<ExchangeSetupResult>(output)
                   ?? new ExchangeSetupResult { Error = "Exchange-Skript ohne Ergebnis beendet (Zeitüberschreitung oder Anmeldung abgebrochen)." };
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
        # new mailboxes and service principals need a moment until every Exchange server knows them
        function Invoke-Retry([scriptblock]$Action) {
            for ($i = 1; ; $i++) {
                try { return & $Action } catch { if ($i -ge 10) { throw }; Start-Sleep -Seconds 6 }
            }
        }
        $in = Get-Content -Raw -Path $InputFile | ConvertFrom-Json
        $result = [ordered]@{ ok = $false; error = $null; group = $null; members = @(); notFound = @(); mailbox = $null; aliases = @(); taken = @() }
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

            Write-Step 'Dienstprinzipal in Exchange ...'
            if (-not (Get-ServicePrincipal -Identity $in.appId -ErrorAction SilentlyContinue)) {
                New-ServicePrincipal -AppId $in.appId -ObjectId $in.servicePrincipalId -DisplayName $in.displayName | Out-Null
            }

            if ($in.mailbox) {
                if (-not (Get-OrganizationConfig).SendFromAliasEnabled) {
                    Write-Step 'Senden von Aliasadressen wird eingeschaltet (SendFromAliasEnabled) ...'
                    Set-OrganizationConfig -SendFromAliasEnabled $true
                }

                Write-Step "Freigegebenes Postfach $($in.mailbox) ..."
                $mbx = Get-Mailbox -Identity $in.mailbox -ErrorAction SilentlyContinue
                if (-not $mbx) {
                    $other = Get-Recipient -Identity $in.mailbox -ErrorAction SilentlyContinue
                    if ($other) { throw "$($in.mailbox) ist bereits vergeben ($($other.RecipientTypeDetails) $($other.Name)) und kein Postfach." }
                    $mbx = New-Mailbox -Shared -Name $in.mailboxName -DisplayName $in.mailboxName -Alias $in.mailboxAlias -PrimarySmtpAddress $in.mailbox
                    Write-Step 'Postfach angelegt.'
                    Invoke-Retry { Set-Mailbox -Identity $in.mailbox -HiddenFromAddressListsEnabled $true }
                } else {
                    Write-Step 'Postfach ist schon vorhanden.'
                }
                $primary = ([string]$mbx.PrimarySmtpAddress).ToLower()

                foreach ($a in @($in.aliases)) {
                    if (-not $a) { continue }
                    $r = Get-Recipient -Identity $a -ErrorAction SilentlyContinue
                    if ($r) {
                        if (([string]$r.PrimarySmtpAddress).ToLower() -eq $primary) { Write-Step "Alias $a ist schon vorhanden." }
                        else { Write-Step "$a gehoert zu $($r.PrimarySmtpAddress) ($($r.RecipientTypeDetails)), uebersprungen."; $result.taken += $a }
                        continue
                    }
                    Write-Step "Alias $a wird angelegt ..."
                    Invoke-Retry { Set-Mailbox -Identity $primary -EmailAddresses @{ Add = "smtp:$a" } }
                }
                $mbx = Invoke-Retry { Get-Mailbox -Identity $primary }
                $result.mailbox = $primary
                $result.aliases = @($mbx.EmailAddresses | ForEach-Object { [string]$_ } | Where-Object { $_ -like 'smtp:*' } | ForEach-Object { $_.Substring(5).ToLower() } | Sort-Object)

                Write-Step 'Recht der App zum Anlegen von Aliassen (nur dieses Postfach) ...'
                $filter = "PrimarySmtpAddress -eq '$primary'"
                if (Get-ManagementScope -Identity $in.mailboxScopeName -ErrorAction SilentlyContinue) {
                    Set-ManagementScope -Identity $in.mailboxScopeName -RecipientRestrictionFilter $filter
                } else {
                    New-ManagementScope -Name $in.mailboxScopeName -RecipientRestrictionFilter $filter | Out-Null
                }
                if (-not (Get-RoleGroup -Identity $in.roleGroupName -ErrorAction SilentlyContinue)) {
                    New-RoleGroup -Name $in.roleGroupName -Roles 'Mail Recipients' -CustomRecipientWriteScope $in.mailboxScopeName -Description 'M365 SMTP Proxy: Aliasse des freigegebenen Postfachs anlegen' | Out-Null
                }
                $sp = Invoke-Retry { Get-ServicePrincipal -Identity $in.appId }
                Invoke-Retry {
                    try { Add-RoleGroupMember -Identity $in.roleGroupName -Member ([string]$sp.Identity) -BypassSecurityGroupManagerCheck }
                    catch { if ($_.Exception.Message -notmatch 'already a member') { throw } }
                }
            }

            if ($in.restrictSenders) {
                Write-Step "Gruppe $($in.groupAlias) ..."
                $group = Get-DistributionGroup -Identity $in.groupAlias -ErrorAction SilentlyContinue
                if (-not $group) {
                    $group = New-DistributionGroup -Name $in.groupName -Alias $in.groupAlias -Type Security -MemberJoinRestriction Closed -MemberDepartRestriction Closed
                    Set-DistributionGroup -Identity $group.Identity -HiddenFromAddressListsEnabled $true -RequireSenderAuthenticationEnabled $true
                }
                $result.group = [string]$group.PrimarySmtpAddress

                # the shared mailbox and every allowed address (an alias resolves to the shared mailbox)
                $members = @()
                if ($result.mailbox) { $members += $result.mailbox }
                foreach ($m in @($in.members)) {
                    if (-not $m) { continue }
                    $r = Get-Recipient -Identity $m -ErrorAction SilentlyContinue
                    if ($r) { $members += ([string]$r.PrimarySmtpAddress).ToLower() } elseif (-not $result.mailbox) { $result.notFound += $m }
                }
                $members = @($members | Sort-Object -Unique)
                Write-Step "Mitglieder werden gesetzt ($($members.Count)) ..."
                Invoke-Retry { Update-DistributionGroupMember -Identity $group.Identity -Members $members -BypassSecurityGroupManagerCheck -Confirm:$false }
                $result.members = $members

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
            }
            $result.ok = $true
            Write-Step 'Fertig. Aenderungen in Exchange wirken nach bis zu einer Stunde.'
        } catch {
            $result.error = $_.Exception.Message
            Write-Step "Fehler: $($_.Exception.Message)"
        } finally {
            try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue } catch { }
            $result | ConvertTo-Json -Depth 4 | Set-Content -Path $OutputFile -Encoding UTF8
        }
        """;
}
