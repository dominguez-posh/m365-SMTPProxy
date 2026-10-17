using SmtpProxy.Core.Config;

namespace SmtpProxy.Core.Graph;

/// <summary>App-only connection of the proxy, rebuilt when app or certificate change in the configuration.</summary>
public sealed class M365Session(Func<ProxyConfig> config)
{
    readonly Lock _gate = new();
    CertificateTokenSource? _tokens;

    public CertificateTokenSource? Tokens()
    {
        var c = config().M365;
        if (!c.IsConnected) return null;
        lock (_gate)
        {
            if (_tokens is { } t && t.TenantId == c.TenantId && t.ClientId == c.ClientId &&
                string.Equals(t.Thumbprint, c.CertificateThumbprint, StringComparison.OrdinalIgnoreCase))
                return t;
            var cert = Certificates.Find(c.CertificateThumbprint);
            if (cert is null) return null;
            return _tokens = new CertificateTokenSource(c.TenantId, c.ClientId, cert);
        }
    }

    public GraphClient? Graph() => Tokens() is { } t ? new GraphClient(t.GetAsync) : null;

    public GraphMailer? Mailer() => Graph() is { } g ? new GraphMailer(g) : null;

    public void InvalidateToken() => _tokens?.Invalidate();

    /// <summary>Verified domains of the tenant (Domain.Read.All).</summary>
    public static async Task<List<string>> ReadDomainsAsync(GraphClient graph, CancellationToken ct)
    {
        var all = await graph.GetAllAsync("/domains?$select=id,isVerified", ct);
        return all.Where(d => d["isVerified"]?.GetValue<bool>() == true)
                  .Select(d => d["id"]!.GetValue<string>().ToLowerInvariant())
                  .Order().ToList();
    }

    /// <summary>
    /// Every address Graph can send from (User.Read.All): the SMTP addresses (proxyAddresses) of the members of the
    /// tenant, i.e. user and shared mailboxes with their aliases. Accounts without mailbox have no SMTP addresses.
    /// </summary>
    public static async Task<List<SenderAddress>> ReadAddressesAsync(GraphClient graph, CancellationToken ct)
    {
        var users = await graph.GetAllAsync("/users?$select=displayName,userPrincipalName,userType,proxyAddresses&$top=999", ct);
        var list = new List<SenderAddress>();
        foreach (var u in users)
        {
            if (u["userType"]?.GetValue<string>() is "Guest") continue;
            var upn = (u["userPrincipalName"]?.GetValue<string>() ?? "").ToLowerInvariant();
            var name = u["displayName"]?.GetValue<string>() ?? "";
            foreach (var p in u["proxyAddresses"]?.AsArray() ?? [])
            {
                var v = p?.GetValue<string>() ?? "";
                if (!v.StartsWith("smtp:", StringComparison.OrdinalIgnoreCase)) continue;
                list.Add(new SenderAddress
                {
                    Address = v[5..].ToLowerInvariant(),
                    Mailbox = upn,
                    DisplayName = name,
                    // the primary address is written SMTP:, aliases smtp:
                    IsAlias = !v.StartsWith("SMTP:", StringComparison.Ordinal),
                });
            }
        }
        return list.DistinctBy(a => a.Address).OrderBy(a => a.Address).ToList();
    }
}
