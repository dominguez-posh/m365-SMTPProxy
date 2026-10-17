using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using SmtpProxy.Core.Graph;

namespace SmtpProxy.Core.M365;

/// <summary>
/// Exchange Online cmdlets app-only over the REST endpoint the ExchangeOnlineManagement module (v3) uses
/// (InvokeCommand), so the service needs neither PowerShell nor the module. Requires Exchange.ManageAsApp and an
/// Exchange role group for the service principal (set up by <see cref="ExchangeSetup"/>): the role "Mail Recipients"
/// with write scope on the shared mailbox only.
/// </summary>
public sealed class ExchangeAdmin(string tenantId, string organization, Func<CancellationToken, Task<string>> token)
{
    public const string Scope = "https://outlook.office365.com/.default";
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(2) };

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
        req.Headers.Add("X-AnchorMailbox", $"UPN:SystemMailbox{{bb558c35-97f1-4cb9-8ff7-d53741dc928c}}@{organization}");
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
            if (message.LastIndexOf('|') is var bar and >= 0 && bar < message.Length - 1) message = message[(bar + 1)..];
            throw new GraphException(res.StatusCode, "exchange", $"Exchange {cmdlet}: {message.Trim()}", res.Headers.RetryAfter?.Delta);
        }
    }

    /// <summary>Primary and secondary SMTP addresses of a recipient, null if there is no such recipient.</summary>
    public async Task<(string Identity, List<string> Addresses)?> FindRecipientAsync(string address, CancellationToken ct)
    {
        JsonArray found;
        try { found = await InvokeAsync("Get-Recipient", new JsonObject { ["Identity"] = address }, ct); }
        catch (GraphException ex) when (ex.Message.Contains("couldn't be found", StringComparison.OrdinalIgnoreCase)
                                        || ex.Message.Contains("ManagementObjectNotFound", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        if (found.Count == 0 || found[0] is not { } r) return null;
        var addresses = (r["EmailAddresses"]?.AsArray() ?? [])
            .Select(a => a?.GetValue<string>() ?? "")
            .Where(a => a.StartsWith("smtp:", StringComparison.OrdinalIgnoreCase))
            .Select(a => a[5..].ToLowerInvariant()).ToList();
        return (r["PrimarySmtpAddress"]?.GetValue<string>() ?? address, addresses);
    }

    /// <summary>Adds a secondary SMTP address to the mailbox (no-op if it is already there).</summary>
    public Task AddAliasAsync(string mailbox, string address, CancellationToken ct) =>
        InvokeAsync("Set-Mailbox", new JsonObject
        {
            ["Identity"] = mailbox,
            ["EmailAddresses"] = new JsonObject { ["@odata.type"] = "#Exchange.GenericHashTable", ["Add"] = new JsonArray("smtp:" + address) },
        }, ct);
}
