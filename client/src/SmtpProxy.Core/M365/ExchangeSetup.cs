using System.Text.Json.Nodes;
using SmtpProxy.Core.Config;
using SmtpProxy.Core.Graph;

namespace SmtpProxy.Core.M365;

public sealed class ExchangeSetupResult
{
    public string? Group { get; set; }
    public List<string> Members { get; set; } = [];
    public List<string> NotFound { get; set; } = [];
    /// <summary>Primary address of the shared mailbox and all its SMTP addresses (aliases).</summary>
    public string? Mailbox { get; set; }
    public List<string> Aliases { get; set; } = [];
    /// <summary>Wanted aliases that belong to another recipient (own mailbox, group): skipped.</summary>
    public List<string> Taken { get; set; } = [];
    /// <summary>Roles the app could not get (the service then cannot do that part alone).</summary>
    public List<string> MissingRoles { get; set; } = [];
}

/// <summary>
/// Exchange Online part of the setup with the token of the administrator who connected (one sign-in, no PowerShell).
/// Idempotent. Afterwards the service works app-only with its certificate:
/// - Shared mailbox: created with its aliases, SendFromAliasEnabled on.
/// - Sender restriction: Mail.Send of the app only for the members of a mail-enabled security group
///   (RBAC for Applications); the shared mailbox is a member as well.
/// - Role group of the app with write scope on exactly the shared mailbox and this group: the service adds aliases
///   and keeps the group members in line without an administrator.
/// </summary>
public static class ExchangeSetup
{
    public const string DefaultMailboxName = "smtpproxy";
    /// <summary>Aliases every shared mailbox gets (local parts, domain of the mailbox).</summary>
    public static readonly string[] DefaultAliases = ["noreply", "absender"];

    public static string GroupAlias(string host) => $"smtpproxy-{host.ToLowerInvariant()}";
    public static string ScopeName(string appId) => $"M365 SMTP Proxy {appId}";
    static string WriteScopeName(string appId) => $"M365 SMTP Proxy {appId} Verwaltung";
    static string RoleGroupName(string appId) => $"M365 SMTP Proxy {appId}";

    /// <param name="mailbox">Address of the shared mailbox; empty = only the sender restriction.</param>
    public static async Task<ExchangeSetupResult> ApplyAsync(ExchangeAdmin exo, ProxyConfig c, string mailbox, bool restrictSenders, Action<string> progress, CancellationToken ct)
    {
        var result = new ExchangeSetupResult();
        var appId = c.M365.ClientId;
        mailbox = mailbox.Trim().ToLowerInvariant();

        progress("Dienstprinzipal der App in Exchange …");
        var sp = await exo.GetAsync("Get-ServicePrincipal", appId, ct);
        if (sp is null)
        {
            await Retry(() => exo.InvokeAsync("New-ServicePrincipal", new JsonObject
            {
                ["AppId"] = appId,
                ["ObjectId"] = c.M365.ServicePrincipalId,
                ["DisplayName"] = $"{Paths.DisplayName} ({Environment.MachineName})",
            }, ct), ct);
            sp = await Retry(async () => await exo.GetAsync("Get-ServicePrincipal", appId, ct) ?? throw NotYet("Dienstprinzipal"), ct);
        }
        var spIdentity = sp["Identity"]?.ToString() ?? c.M365.ServicePrincipalId;

        if (mailbox.Length > 0)
        {
            var org = (await exo.InvokeAsync("Get-OrganizationConfig", new JsonObject(), ct)).FirstOrDefault();
            if (org?["SendFromAliasEnabled"]?.GetValue<bool>() != true)
            {
                progress("Senden von Aliasadressen wird eingeschaltet (SendFromAliasEnabled) …");
                await exo.InvokeAsync("Set-OrganizationConfig", new JsonObject { ["SendFromAliasEnabled"] = true }, ct);
            }

            progress($"Freigegebenes Postfach {mailbox} …");
            var mbx = await exo.GetAsync("Get-Mailbox", mailbox, ct);
            if (mbx is null)
            {
                if (await exo.FindRecipientAsync(mailbox, ct) is { } other)
                    throw new InvalidOperationException($"{mailbox} ist bereits vergeben ({other.Type} {other.Identity}) und kein Postfach.");
                await exo.InvokeAsync("New-Mailbox", new JsonObject
                {
                    ["Shared"] = true,
                    ["Name"] = $"{Paths.DisplayName} ({mailbox})",
                    ["DisplayName"] = $"{Paths.DisplayName} ({mailbox})",
                    ["Alias"] = mailbox[..mailbox.IndexOf('@')],
                    ["PrimarySmtpAddress"] = mailbox,
                }, ct);
                progress("Postfach angelegt.");
                await Retry(() => exo.InvokeAsync("Set-Mailbox", new JsonObject { ["Identity"] = mailbox, ["HiddenFromAddressListsEnabled"] = true }, ct), ct);
            }
            else progress("Postfach ist schon vorhanden.");
            var primary = (mbx?["PrimarySmtpAddress"]?.GetValue<string>() ?? mailbox).ToLowerInvariant();

            var domain = primary[(primary.IndexOf('@') + 1)..];
            var wanted = DefaultAliases.Select(a => $"{a}@{domain}")
                .Concat(c.Senders.SharedMailboxAliases)
                .Concat(c.Senders.AutoCreateAliases ? c.Senders.AllowedAddresses : [])
                .Select(a => a.ToLowerInvariant()).Where(a => a != primary).Distinct();
            foreach (var a in wanted)
            {
                if (await exo.FindRecipientAsync(a, ct) is { } r)
                {
                    if (r.Identity == primary) progress($"Alias {a} ist schon vorhanden.");
                    else
                    {
                        progress($"{a} gehört zu {r.Identity} ({r.Type}), übersprungen.");
                        result.Taken.Add(a);
                    }
                    continue;
                }
                progress($"Alias {a} wird angelegt …");
                await Retry(() => exo.AddAliasAsync(primary, a, ct), ct);
            }
            var final = await Retry(async () => await exo.FindRecipientAsync(primary, ct) ?? throw NotYet("Postfach"), ct);
            result.Mailbox = primary;
            result.Aliases = final.Addresses.Order().ToList();
        }

        JsonNode? group = null;
        if (restrictSenders)
        {
            var alias = c.Senders.ExchangeScopeGroup is { Length: > 0 } g ? g : GroupAlias(Environment.MachineName);
            progress($"Gruppe {alias} …");
            group = await exo.GetAsync("Get-DistributionGroup", alias, ct);
            if (group is null)
            {
                await exo.InvokeAsync("New-DistributionGroup", new JsonObject
                {
                    ["Name"] = $"{Paths.DisplayName} Absender ({Environment.MachineName})",
                    ["Alias"] = alias[..(alias.IndexOf('@') is var i and > 0 ? i : alias.Length)],
                    ["Type"] = "Security",
                    ["MemberJoinRestriction"] = "Closed",
                    ["MemberDepartRestriction"] = "Closed",
                }, ct);
                group = await Retry(async () => await exo.GetAsync("Get-DistributionGroup", alias, ct) ?? throw NotYet("Gruppe"), ct);
                await Retry(() => exo.InvokeAsync("Set-DistributionGroup", new JsonObject
                {
                    ["Identity"] = group["PrimarySmtpAddress"]!.ToString(),
                    ["HiddenFromAddressListsEnabled"] = true,
                    ["RequireSenderAuthenticationEnabled"] = true,
                }, ct), ct);
            }
            result.Group = group["PrimarySmtpAddress"]!.ToString().ToLowerInvariant();

            progress("Mitglieder der Gruppe …");
            (result.Members, result.NotFound) = await Retry(() => exo.SyncGroupAsync(result.Group, result.Mailbox ?? c.Senders.SharedMailbox, c.Senders.AllowedAddresses, ct), ct);

            progress("Verwaltungsbereich und Rolle Application Mail.Send …");
            var sendScope = await EnsureScopeAsync(exo, ScopeName(appId), $"MemberOfGroup -eq '{group["DistinguishedName"]}'", progress, ct);
            var assigned = await TryListAsync(exo, "Get-ManagementRoleAssignment", new JsonObject { ["RoleAssignee"] = appId, ["Role"] = "Application Mail.Send" }, ct);
            if (assigned.Count == 0)
                await IgnoreExisting(() => Retry(() => exo.InvokeAsync("New-ManagementRoleAssignment", new JsonObject
                {
                    ["App"] = appId,
                    ["Role"] = "Application Mail.Send",
                    ["CustomResourceScope"] = sendScope,
                }, ct), ct));
        }

        // what the service may change itself: only the shared mailbox and the sender group
        var targets = new[] { result.Mailbox, result.Group }.OfType<string>().ToList();
        if (targets.Count > 0)
        {
            progress("Rechte der App für Aliasse und Gruppenmitglieder (nur dieses Postfach und diese Gruppe) …");
            var writeScope = await EnsureScopeAsync(exo, WriteScopeName(appId), string.Join(" -or ", targets.Select(t => $"(PrimarySmtpAddress -eq '{t}')")), progress, ct);
            var rg = RoleGroupName(appId);
            if (await FindByNameAsync(exo, "Get-RoleGroup", rg, ct) is null)
                await IgnoreExisting(() => exo.InvokeAsync("New-RoleGroup", new JsonObject
                {
                    ["Name"] = rg,
                    ["Description"] = "M365 SMTP Proxy: Aliasse des freigegebenen Postfachs und Mitglieder der Absendergruppe pflegen",
                }, ct));
            var roles = new List<string>();
            if (result.Mailbox is not null) roles.Add("Mail Recipients");
            if (result.Group is not null) roles.AddRange(["Distribution Groups", "Security Group Creation and Membership"]);
            var existing = await TryListAsync(exo, "Get-ManagementRoleAssignment", new JsonObject { ["RoleAssignee"] = rg }, ct);
            foreach (var role in roles.Where(r => !existing.Any(e => e?["Role"]?.ToString() == r)))
            {
                try
                {
                    await Retry(() => exo.InvokeAsync("New-ManagementRoleAssignment", new JsonObject
                    {
                        ["SecurityGroup"] = rg,
                        ["Role"] = role,
                        ["CustomRecipientWriteScope"] = writeScope,
                    }, ct), ct);
                }
                catch (GraphException ex) when (IsExisting(ex)) { }
                catch (GraphException ex)
                {
                    progress($"Rolle {role} konnte nicht zugewiesen werden: {ex.Message}");
                    result.MissingRoles.Add(role);
                }
            }
            await Retry(async () =>
            {
                try
                {
                    await exo.InvokeAsync("Add-RoleGroupMember", new JsonObject
                    {
                        ["Identity"] = rg,
                        ["Member"] = spIdentity,
                        ["BypassSecurityGroupManagerCheck"] = true,
                    }, ct);
                }
                catch (GraphException ex) when (ex.Message.Contains("already a member", StringComparison.OrdinalIgnoreCase)) { }
            }, ct);
        }
        progress("Exchange ist eingerichtet. Änderungen wirken nach einigen Minuten bis zu einer Stunde.");
        return result;
    }

    static async Task<JsonArray> TryListAsync(ExchangeAdmin exo, string cmdlet, JsonObject parameters, CancellationToken ct)
    {
        try { return await exo.InvokeAsync(cmdlet, parameters, ct); }
        catch (GraphException ex) when (ExchangeAdmin.IsNotFound(ex)) { return []; }
    }

    /// <summary>
    /// Management scope with this filter; returns the name to use. Looked up in the full list (Get-* with a name as
    /// identity does not find every object over REST). Exchange refuses a second scope with the same filter, so an
    /// existing one (e.g. from an earlier version) is used instead.
    /// </summary>
    static async Task<string> EnsureScopeAsync(ExchangeAdmin exo, string name, string filter, Action<string> progress, CancellationToken ct)
    {
        if (await FindByNameAsync(exo, "Get-ManagementScope", name, ct) is { } existing)
        {
            if (!string.Equals(existing["RecipientFilter"]?.ToString(), filter, StringComparison.OrdinalIgnoreCase))
                await exo.InvokeAsync("Set-ManagementScope", new JsonObject { ["Identity"] = Id(existing, name), ["RecipientRestrictionFilter"] = filter }, ct);
            return name;
        }
        try
        {
            await exo.InvokeAsync("New-ManagementScope", new JsonObject { ["Name"] = name, ["RecipientRestrictionFilter"] = filter }, ct);
            return name;
        }
        catch (GraphException ex) when (System.Text.RegularExpressions.Regex.Match(ex.Message, @"The (.+?) management scope has the same") is { Success: true } m)
        {
            progress($"Vorhandener Verwaltungsbereich „{m.Groups[1].Value}“ wird verwendet.");
            return m.Groups[1].Value;
        }
    }

    static async Task<JsonNode?> FindByNameAsync(ExchangeAdmin exo, string cmdlet, string name, CancellationToken ct) =>
        (await TryListAsync(exo, cmdlet, new JsonObject(), ct))
        .FirstOrDefault(o => string.Equals(o?["Name"]?.ToString(), name, StringComparison.OrdinalIgnoreCase));

    /// <summary>Most stable identity of a listed object (Guid), otherwise its name.</summary>
    static string Id(JsonNode o, string fallback) => o["Guid"]?.ToString() is { Length: > 0 } g ? g : o["Identity"]?.ToString() ?? fallback;

    static bool IsExisting(GraphException ex) =>
        ex.Message.Contains("already exist", StringComparison.OrdinalIgnoreCase) || ex.Message.Contains("already a member", StringComparison.OrdinalIgnoreCase)
        || ex.Message.Contains("is already assigned", StringComparison.OrdinalIgnoreCase);

    static async Task IgnoreExisting(Func<Task> action)
    {
        try { await action(); }
        catch (GraphException ex) when (IsExisting(ex)) { }
    }

    static GraphException NotYet(string what) => new(System.Net.HttpStatusCode.NotFound, "exchange", $"{what} ist in Exchange noch nicht sichtbar");

    /// <summary>New objects need a moment until every Exchange server knows them.</summary>
    static async Task<T> Retry<T>(Func<Task<T>> action, CancellationToken ct)
    {
        for (var i = 1; ; i++)
        {
            try { return await action(); }
            catch (GraphException ex) when (i < 10 && !IsExisting(ex)) { await Task.Delay(TimeSpan.FromSeconds(6), ct); }
        }
    }

    static Task Retry(Func<Task> action, CancellationToken ct) => Retry(async () => { await action(); return true; }, ct);
}
