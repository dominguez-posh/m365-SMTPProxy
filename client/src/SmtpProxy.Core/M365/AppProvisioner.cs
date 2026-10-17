using System.Text.Json.Nodes;
using SmtpProxy.Core.Config;
using SmtpProxy.Core.Graph;

namespace SmtpProxy.Core.M365;

/// <summary>
/// Creates the app registration of this proxy with an admin token: certificate in the machine store,
/// application permissions Domain.Read.All and (without Exchange restriction) Mail.Send, admin consent.
/// With Exchange restriction Mail.Send comes from RBAC for Applications instead (see <see cref="ExchangeScope"/>).
/// </summary>
public static class AppProvisioner
{
    public const string GraphAppId = "00000003-0000-0000-c000-000000000000";

    /// <summary>Delegated scopes of the admin sign-in.</summary>
    public static readonly string[] AdminScopes =
        ["Application.ReadWrite.All", "AppRoleAssignment.ReadWrite.All", "Domain.Read.All", "Organization.Read.All"];

    public static async Task<M365Connection> ProvisionAsync(DelegatedToken admin, bool exchangeScope, Action<string> progress, CancellationToken ct)
    {
        var graph = GraphClient.WithToken(admin.AccessToken);

        progress("Tenant wird gelesen …");
        var org = (await graph.GetAsync("/organization?$select=id,displayName", ct))?["value"]?[0];
        var tenantId = org?["id"]?.GetValue<string>() ?? admin.TenantId;
        var tenantName = org?["displayName"]?.GetValue<string>() ?? "";

        progress("Berechtigungen von Microsoft Graph werden gelesen …");
        var graphSp = await graph.GetAsync($"/servicePrincipals(appId='{GraphAppId}')?$select=id,appRoles", ct)
                      ?? throw new InvalidOperationException("Microsoft Graph wurde im Tenant nicht gefunden.");
        string RoleId(string value) => graphSp["appRoles"]!.AsArray()
            .First(r => r!["value"]!.GetValue<string>() == value)!["id"]!.GetValue<string>();
        var roles = new List<string> { RoleId("Domain.Read.All") };
        if (!exchangeScope) roles.Add(RoleId("Mail.Send"));

        progress("Zertifikat wird im Zertifikatspeicher des Computers erstellt …");
        var host = Environment.MachineName;
        var cert = Certificates.Create($"{Paths.DisplayName} {host}");

        try
        {
            progress("App-Registrierung wird angelegt …");
            var app = await graph.PostAsync("/applications", new JsonObject
            {
                ["displayName"] = $"{Paths.DisplayName} ({host})",
                ["signInAudience"] = "AzureADMyOrg",
                ["notes"] = $"Angelegt vom {Paths.DisplayName} auf {host} durch {admin.User}. Sendet E-Mails über Microsoft Graph.",
                ["keyCredentials"] = new JsonArray(new JsonObject
                {
                    ["type"] = "AsymmetricX509Cert",
                    ["usage"] = "Verify",
                    ["key"] = Convert.ToBase64String(cert.RawData),
                    ["displayName"] = cert.Subject,
                }),
                ["requiredResourceAccess"] = new JsonArray(new JsonObject
                {
                    ["resourceAppId"] = GraphAppId,
                    ["resourceAccess"] = new JsonArray(roles.Select(r => (JsonNode)new JsonObject { ["id"] = r, ["type"] = "Role" }).ToArray()),
                }),
            }, ct);
            var appId = app!["appId"]!.GetValue<string>();
            var appObjectId = app["id"]!.GetValue<string>();

            progress("Dienstprinzipal wird angelegt …");
            var sp = await RetryAsync(() => graph.PostAsync("/servicePrincipals", new JsonObject { ["appId"] = appId }, ct), ct);
            var spId = sp!["id"]!.GetValue<string>();

            progress("Administratorzustimmung wird erteilt …");
            foreach (var role in roles)
                await RetryAsync(() => graph.PostAsync($"/servicePrincipals/{graphSp["id"]!.GetValue<string>()}/appRoleAssignedTo", new JsonObject
                {
                    ["principalId"] = spId,
                    ["resourceId"] = graphSp["id"]!.GetValue<string>(),
                    ["appRoleId"] = role,
                }, ct), ct);

            var connection = new M365Connection
            {
                TenantId = tenantId,
                TenantName = tenantName,
                ClientId = appId,
                AppObjectId = appObjectId,
                ServicePrincipalId = spId,
                CertificateThumbprint = cert.Thumbprint,
                CertificateExpires = cert.NotAfter.ToUniversalTime(),
                ConnectedAt = DateTimeOffset.UtcNow,
                ConnectedBy = admin.User,
            };

            progress("Anmeldung der App wird geprüft (neue Apps brauchen bis zu zwei Minuten) …");
            var appGraph = new GraphClient(new CertificateTokenSource(tenantId, appId, cert).GetAsync);
            var deadline = DateTime.UtcNow.AddMinutes(3);
            while (true)
            {
                try
                {
                    connection.Domains = await M365Session.ReadDomainsAsync(appGraph, ct);
                    connection.DomainsRefreshedAt = DateTimeOffset.UtcNow;
                    break;
                }
                catch (GraphException) when (DateTime.UtcNow < deadline)
                {
                    await Task.Delay(TimeSpan.FromSeconds(10), ct);
                    appGraph = new GraphClient(new CertificateTokenSource(tenantId, appId, cert).GetAsync);
                }
            }
            progress("Verbunden.");
            return connection;
        }
        catch
        {
            Certificates.Delete(cert.Thumbprint);
            throw;
        }
    }

    /// <summary>Deletes the app registration (admin token) and the local certificate.</summary>
    public static async Task RemoveAsync(DelegatedToken admin, M365Connection c, CancellationToken ct)
    {
        if (c.AppObjectId.Length > 0)
        {
            try { await GraphClient.WithToken(admin.AccessToken).DeleteAsync($"/applications/{c.AppObjectId}", ct); }
            catch (GraphException ex) when (ex.Status == System.Net.HttpStatusCode.NotFound) { }
        }
        Certificates.Delete(c.CertificateThumbprint);
    }

    /// <summary>New objects are not visible everywhere at once: retry 404 and 400 "does not exist" for a while.</summary>
    static async Task<JsonNode?> RetryAsync(Func<Task<JsonNode?>> call, CancellationToken ct)
    {
        for (var i = 0; ; i++)
        {
            try { return await call(); }
            catch (GraphException ex) when (i < 10 && (ex.Status == System.Net.HttpStatusCode.NotFound ||
                                                       (ex.Status == System.Net.HttpStatusCode.BadRequest && ex.Message.Contains("not exist", StringComparison.OrdinalIgnoreCase))))
            {
                await Task.Delay(TimeSpan.FromSeconds(3), ct);
            }
        }
    }
}
