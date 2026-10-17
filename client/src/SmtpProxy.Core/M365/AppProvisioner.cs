using System.Text.Json.Nodes;
using SmtpProxy.Core.Config;
using SmtpProxy.Core.Graph;

namespace SmtpProxy.Core.M365;

/// <summary>
/// Creates the app registration of this proxy with an admin token: certificate in the machine store and the
/// application permissions the service needs to run without any user:
/// - Domain.Read.All: tenant domains
/// - Mail.Send (only without Exchange restriction; with it, Mail.Send comes from RBAC for Applications)
/// - Exchange.ManageAsApp: aliases of the shared mailbox and members of the sender group (Exchange role group whose
///   write scope covers only these two, see <see cref="ExchangeSetup"/>)
/// - Application.ReadWrite.OwnedBy with the app as its own owner: the service renews its certificate itself
/// </summary>
public static class AppProvisioner
{
    public const string GraphAppId = "00000003-0000-0000-c000-000000000000";
    public const string ExchangeAppId = "00000002-0000-0ff1-ce00-000000000000";
    /// <summary>Raise when the app needs new permissions; older connections get them in the next Exchange setup.</summary>
    public const int PermissionsVersion = 2;

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
            }, ct);
            var appId = app!["appId"]!.GetValue<string>();
            var appObjectId = app["id"]!.GetValue<string>();

            progress("Dienstprinzipal wird angelegt …");
            var sp = await RetryAsync(() => graph.PostAsync("/servicePrincipals", new JsonObject { ["appId"] = appId }, ct), ct);
            var spId = sp!["id"]!.GetValue<string>();

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
            await EnsureAppAccessAsync(admin, connection, exchangeScope, progress, ct);

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

    /// <summary>
    /// Gives the app every permission of <see cref="PermissionsVersion"/> (declared and consented) and makes it the
    /// owner of its own registration. Idempotent; also upgrades apps of older versions. Sets PermissionsVersion.
    /// </summary>
    public static async Task EnsureAppAccessAsync(DelegatedToken admin, M365Connection c, bool exchangeScope, Action<string> progress, CancellationToken ct)
    {
        var graph = GraphClient.WithToken(admin.AccessToken);
        var graphSp = await ResourceAsync(graph, GraphAppId, "Microsoft Graph", ct);
        var exoSp = await ResourceAsync(graph, ExchangeAppId, "Office 365 Exchange Online", ct);
        var wanted = new List<(string ResourceAppId, JsonNode Sp, string Role)>
        {
            (GraphAppId, graphSp, "Domain.Read.All"),
            (GraphAppId, graphSp, "Application.ReadWrite.OwnedBy"),
            (ExchangeAppId, exoSp, "Exchange.ManageAsApp"),
        };
        if (!exchangeScope) wanted.Add((GraphAppId, graphSp, "Mail.Send"));

        // declared permissions (shown under "API permissions" of the app)
        var app = await RetryAsync(() => graph.GetAsync($"/applications/{c.AppObjectId}?$select=requiredResourceAccess", ct), ct)
                  ?? throw new InvalidOperationException("App-Registrierung nicht gefunden.");
        var access = JsonNode.Parse(app["requiredResourceAccess"]?.ToJsonString() ?? "[]")!.AsArray();
        var changed = false;
        foreach (var (resource, sp, role) in wanted)
        {
            var roleId = RoleId(sp, role);
            var entry = access.FirstOrDefault(a => a?["resourceAppId"]?.GetValue<string>() == resource);
            if (entry is null) access.Add(entry = new JsonObject { ["resourceAppId"] = resource, ["resourceAccess"] = new JsonArray() });
            if (entry["resourceAccess"]!.AsArray().Any(r => r?["id"]?.GetValue<string>() == roleId)) continue;
            entry["resourceAccess"]!.AsArray().Add(new JsonObject { ["id"] = roleId, ["type"] = "Role" });
            changed = true;
        }
        if (changed)
        {
            progress("Berechtigungen der App werden eingetragen …");
            await graph.PatchAsync($"/applications/{c.AppObjectId}", new JsonObject { ["requiredResourceAccess"] = access }, ct);
        }

        // admin consent
        var assigned = await RetryAsync(async () => new JsonArray((await graph.GetAllAsync($"/servicePrincipals/{c.ServicePrincipalId}/appRoleAssignments", ct))
            .Select(a => a.DeepClone()).ToArray()), ct);
        foreach (var (_, sp, role) in wanted)
        {
            var roleId = RoleId(sp, role);
            var resourceId = sp["id"]!.GetValue<string>();
            if (assigned!.AsArray().Any(a => a?["appRoleId"]?.GetValue<string>() == roleId && a?["resourceId"]?.GetValue<string>() == resourceId)) continue;
            progress($"Administratorzustimmung: {role} …");
            await RetryAsync(() => graph.PostAsync($"/servicePrincipals/{resourceId}/appRoleAssignedTo", new JsonObject
            {
                ["principalId"] = c.ServicePrincipalId,
                ["resourceId"] = resourceId,
                ["appRoleId"] = roleId,
            }, ct), ct);
        }

        // owner of itself: Application.ReadWrite.OwnedBy then covers exactly this one app (certificate renewal)
        var owners = await RetryAsync(async () => new JsonArray((await graph.GetAllAsync($"/applications/{c.AppObjectId}/owners?$select=id", ct))
            .Select(o => o.DeepClone()).ToArray()), ct);
        if (!owners!.AsArray().Any(o => o?["id"]?.GetValue<string>() == c.ServicePrincipalId))
        {
            progress("Die App wird Besitzerin ihrer eigenen Registrierung (für die Zertifikatserneuerung) …");
            await RetryAsync(() => graph.PostAsync($"/applications/{c.AppObjectId}/owners/$ref", new JsonObject
            {
                ["@odata.id"] = $"https://graph.microsoft.com/v1.0/directoryObjects/{c.ServicePrincipalId}",
            }, ct), ct);
        }
        c.PermissionsVersion = PermissionsVersion;
    }

    static async Task<JsonNode> ResourceAsync(GraphClient graph, string appId, string name, CancellationToken ct) =>
        await graph.GetAsync($"/servicePrincipals(appId='{appId}')?$select=id,appRoles", ct)
        ?? throw new InvalidOperationException($"{name} wurde im Tenant nicht gefunden.");

    static string RoleId(JsonNode sp, string value) => sp["appRoles"]!.AsArray()
        .First(r => r!["value"]!.GetValue<string>() == value)!["id"]!.GetValue<string>();

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
