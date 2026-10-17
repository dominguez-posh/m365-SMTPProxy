using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using SmtpProxy.Core.Graph;

namespace SmtpProxy.Core.M365;

/// <summary>
/// Exchange Online cmdlets over the REST endpoint the ExchangeOnlineManagement module (v3) uses (InvokeCommand),
/// so neither the setup nor the service needs PowerShell or the module. Works with the token of an administrator
/// (setup) and app-only with the certificate (service: Exchange.ManageAsApp plus the role group of
/// <see cref="ExchangeSetup"/>, whose write scope covers only the shared mailbox and the sender group).
/// </summary>
public sealed class ExchangeAdmin(string tenantId, string anchorMailbox, Func<CancellationToken, Task<string>> token)
{
    public const string Scope = "https://outlook.office365.com/.default";
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(2) };

    /// <summary>App-only: routing over the system mailbox of the organization.</summary>
    public static string AppAnchor(string organization) => $"UPN:SystemMailbox{{bb558c35-97f1-4cb9-8ff7-d53741dc928c}}@{organization}";
    /// <summary>Delegated: routing over the mailbox (UPN) of the signed-in administrator.</summary>
    public static string UserAnchor(string upn) => $"UPN:{upn}";

    public async Task<JsonArray> InvokeAsync(string cmdlet, JsonObject parameters, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, $"https://outlook.office365.com/adminapi/beta/{tenantId}/InvokeCommand")
        {
            Content = new StringContent(new JsonObject
            {
                ["CmdletInput"] = new JsonObject { ["CmdletName"] = cmdlet, ["Parameters"] = parameters },
            }.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await token(ct));
        req.Headers.Add("X-AnchorMailbox", anchorMailbox);
        req.Headers.Add("X-CmdletName", cmdlet);
        req.Headers.Add("X-ResponseFormat", "json");
        HttpResponseMessage res;
        try { res = await Http.SendAsync(req, ct); }
        catch (HttpRequestException ex) { throw new GraphException(HttpStatusCode.ServiceUnavailable, "network", $"Exchange Online nicht erreichbar: {ex.Message}"); }
        using (res)
        {
            var text = await res.Content.ReadAsStringAsync(ct);
            if (res.IsSuccessStatusCode) return text.Length == 0 ? [] : JsonNode.Parse(text)?["value"]?.AsArray() ?? [];
            var message = text;
            try
            {
                var err = JsonNode.Parse(text)?["error"];
                message = err?["details"]?[0]?["message"]?.GetValue<string>() ?? err?["message"]?.GetValue<string>() ?? text;
            }
            catch (JsonException) { }
            // messages look like "|Microsoft.Exchange.Management....|Text": keep the text
            if (message.LastIndexOf('|') is var bar and >= 0 && message[(bar + 1)..].Trim().Length > 0) message = message[(bar + 1)..];
            if (message.Trim().Length == 0) message = $"HTTP {(int)res.StatusCode} {res.ReasonPhrase}";
            throw new GraphException(res.StatusCode, "exchange", $"Exchange {cmdlet}: {message.Trim()}", res.Headers.RetryAfter?.Delta);
        }
    }

    public static bool IsNotFound(GraphException ex) =>
        ex.Code == "exchange" && (ex.Message.Contains("couldn't be found", StringComparison.OrdinalIgnoreCase)
                                  || ex.Message.Contains("could not be found", StringComparison.OrdinalIgnoreCase)
                                  || ex.Message.Contains("wasn't found", StringComparison.OrdinalIgnoreCase)
                                  || ex.Message.Contains("ManagementObjectNotFound", StringComparison.OrdinalIgnoreCase));

    /// <summary>First object of a Get-* cmdlet, null if Exchange does not know it.</summary>
    public async Task<JsonNode?> GetAsync(string cmdlet, string identity, CancellationToken ct)
    {
        try { return (await InvokeAsync(cmdlet, new JsonObject { ["Identity"] = identity }, ct)).FirstOrDefault(); }
        catch (GraphException ex) when (IsNotFound(ex)) { return null; }
    }

    /// <summary>Primary and secondary SMTP addresses of a recipient, null if there is no such recipient.</summary>
    public async Task<(string Identity, List<string> Addresses, string Type)?> FindRecipientAsync(string address, CancellationToken ct)
    {
        if (await GetAsync("Get-Recipient", address, ct) is not { } r) return null;
        var addresses = (r["EmailAddresses"]?.AsArray() ?? [])
            .Select(a => a?.GetValue<string>() ?? "")
            .Where(a => a.StartsWith("smtp:", StringComparison.OrdinalIgnoreCase))
            .Select(a => a[5..].ToLowerInvariant()).ToList();
        return ((r["PrimarySmtpAddress"]?.GetValue<string>() ?? address).ToLowerInvariant(), addresses,
                r["RecipientTypeDetails"]?.ToString() ?? "");
    }

    /// <summary>Adds a secondary SMTP address to the mailbox (no-op if it is already there).</summary>
    public Task AddAliasAsync(string mailbox, string address, CancellationToken ct) =>
        InvokeAsync("Set-Mailbox", new JsonObject
        {
            ["Identity"] = mailbox,
            ["EmailAddresses"] = new JsonObject { ["@odata.type"] = "#Exchange.GenericHashTable", ["Add"] = new JsonArray("smtp:" + address) },
        }, ct);

    /// <summary>
    /// Sets the members of the sender group (RBAC for Applications): the shared mailbox and the recipients of the
    /// allowed addresses (an alias resolves to the shared mailbox). Returns members and addresses without recipient.
    /// </summary>
    public async Task<(List<string> Members, List<string> NotFound)> SyncGroupAsync(string group, string sharedMailbox, IEnumerable<string> allowed, CancellationToken ct)
    {
        var members = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        var notFound = new List<string>();
        if (sharedMailbox.Length > 0) members.Add(sharedMailbox.ToLowerInvariant());
        foreach (var a in allowed)
        {
            if (await FindRecipientAsync(a, ct) is { } r) members.Add(r.Identity);
            else notFound.Add(a);
        }
        await InvokeAsync("Update-DistributionGroupMember", new JsonObject
        {
            ["Identity"] = group,
            ["Members"] = new JsonArray(members.Select(m => (JsonNode)JsonValue.Create(m)!).ToArray()),
            ["BypassSecurityGroupManagerCheck"] = true,
            ["Confirm"] = false,
        }, ct);
        return (members.ToList(), notFound);
    }
}
