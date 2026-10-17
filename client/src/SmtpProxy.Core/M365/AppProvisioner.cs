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

    static string AppName => $"{Paths.DisplayName} ({Environment.MachineName})";

    /// <summary>
    /// Connects with the app registration of this proxy: the existing one (from the configuration or found by its
    /// name) is kept and only brought up to date (permissions, certificate if the local one is missing or expiring);
    /// a new one is created only if there is none.
    /// </summary>
    public static async Task<M365Connection> ConnectAsync(DelegatedToken admin, M365Connection existing, bool exchangeScope, Action<string> progress, CancellationToken ct)
    {
        var graph = GraphClient.WithToken(admin.AccessToken);
        JsonNode? app = null;
        if (existing.AppObjectId.Length > 0)
        {
            try { app = await graph.GetAsync($"/applications/{existing.AppObjectId}?$select=id,appId,displayName", ct); }
            catch (GraphException ex) when (ex.Status == System.Net.HttpStatusCode.NotFound) { }
        }
        app ??= (await graph.GetAsync($"/applications?$filter=displayName eq '{AppName.Replace("'", "''")}'&$select=id,appId,displayName", ct))?["value"]?.AsArray().FirstOrDefault();
        if (app is null) return await ProvisionAsync(admin, exchangeScope, progress, ct);

        var appId = app["appId"]!.GetValue<string>();
        var appObjectId = app["id"]!.GetValue<string>();
        progress($"Bestehende App-Registrierung {appId} wird weiterverwendet.");
        var org = (await graph.GetAsync("/organization?$select=id,displayName", ct))?["value"]?[0];

        var sp = await graph.GetAsync($"/servicePrincipals(appId='{appId}')?$select=id", ct)
                 .ContinueWith(t => t.IsCompletedSuccessfully ? t.Result : null, ct)
                 ?? await RetryAsync(() => graph.PostAsync("/servicePrincipals", new JsonObject { ["appId"] = appId }, ct), ct);

        // keep the local certificate if it belongs to this app and is not about to expire
        var same = existing.ClientId == appId;
        var cert = same ? Certificates.Find(existing.CertificateThumbprint) : null;
        if (cert is not null && cert.NotAfter.ToUniversalTime() - DateTime.UtcNow < CertificateRenewal.Before) cert = null;
        var created = false;
        if (cert is null)
        {
            progress("Neues Zertifikat wird erstellt und in der App hinterlegt (ersetzt die bisherigen) …");
            cert = Certificates.Create($"{Paths.DisplayName} {Environment.MachineName}");
            created = true;
            await graph.PatchAsync($"/applications/{appObjectId}", new JsonObject
            {
                ["keyCredentials"] = new JsonArray(new JsonObject
                {
                    ["type"] = "AsymmetricX509Cert",
                    ["usage"] = "Verify",
                    ["key"] = Convert.ToBase64String(cert.RawData),
                    ["displayName"] = cert.Subject,
                }),
            }, ct);
        }
        else progress("Zertifikat dieses Computers ist gültig und bleibt.");

        try
        {
            var connection = new M365Connection
            {
                TenantId = org?["id"]?.GetValue<string>() ?? admin.TenantId,
                TenantName = org?["displayName"]?.GetValue<string>() ?? "",
                ClientId = appId,
                AppObjectId = appObjectId,
                ServicePrincipalId = sp!["id"]!.GetValue<string>(),
                CertificateThumbprint = cert.Thumbprint,
                CertificateExpires = cert.NotAfter.ToUniversalTime(),
                CertificateRenewedAt = same ? existing.CertificateRenewedAt : null,
                ConnectedAt = DateTimeOffset.UtcNow,
                ConnectedBy = admin.User,
            };
            await EnsureAppAccessAsync(admin, connection, exchangeScope, progress, ct);
            await VerifyAsync(connection, cert, progress, ct);
            if (created && same && existing.CertificateThumbprint != cert.Thumbprint) Certificates.Delete(existing.CertificateThumbprint);
            return connection;
        }
        catch
        {
            if (created) Certificates.Delete(cert.Thumbprint);
            throw;
        }
    }

    /// <summary>Signs in with the certificate (a new key needs up to two minutes) and reads the tenant domains.</summary>
    static async Task VerifyAsync(M365Connection connection, System.Security.Cryptography.X509Certificates.X509Certificate2 cert, Action<string> progress, CancellationToken ct)
    {
        progress("Anmeldung der App wird geprüft (neue Schlüssel brauchen bis zu zwei Minuten) …");
        var deadline = DateTime.UtcNow.AddMinutes(3);
        while (true)
        {
            try
            {
                var appGraph = new GraphClient(new CertificateTokenSource(connection.TenantId, connection.ClientId, cert).GetAsync);
                connection.Domains = await M365Session.ReadDomainsAsync(appGraph, ct);
                connection.DomainsRefreshedAt = DateTimeOffset.UtcNow;
                progress("Verbunden.");
                return;
            }
            catch (GraphException) when (DateTime.UtcNow < deadline)
            {
                await Task.Delay(TimeSpan.FromSeconds(10), ct);
            }
        }
    }

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
                ["displayName"] = AppName,
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
            await VerifyAsync(connection, cert, progress, ct);
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
