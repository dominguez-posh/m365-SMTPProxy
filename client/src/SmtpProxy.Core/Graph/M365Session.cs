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

    public void InvalidateToken()
    {
        _tokens?.Invalidate();
        _exchangeTokens?.Invalidate();
    }

    CertificateTokenSource? _exchangeTokens;

    /// <summary>Exchange Online app-only (aliases of the shared mailbox); null without connection.</summary>
    public M365.ExchangeAdmin? Exchange()
    {
        var c = config().M365;
        // apps of older versions lack Exchange.ManageAsApp and the Exchange role group: they would only fail
        if (c.PermissionsVersion < M365.AppProvisioner.PermissionsVersion) return null;
        if (Tokens() is not { } graph || Organization(c.Domains) is not { } org) return null;
        lock (_gate)
        {
            if (_exchangeTokens is not { } t || t.ClientId != graph.ClientId || t.Thumbprint != graph.Thumbprint || t.TenantId != graph.TenantId)
            {
                var cert = Certificates.Find(c.CertificateThumbprint);
                if (cert is null) return null;
                t = _exchangeTokens = new CertificateTokenSource(c.TenantId, c.ClientId, cert, M365.ExchangeAdmin.Scope);
            }
            return new M365.ExchangeAdmin(c.TenantId, M365.ExchangeAdmin.AppAnchor(org), t.GetAsync);
        }
    }

    /// <summary>The initial domain (contoso.onmicrosoft.com), which Exchange needs as organization.</summary>
    public static string? Organization(IEnumerable<string> domains) =>
        domains.FirstOrDefault(d => d.EndsWith(".onmicrosoft.com", StringComparison.OrdinalIgnoreCase) && !d.EndsWith(".mail.onmicrosoft.com", StringComparison.OrdinalIgnoreCase));

    /// <summary>Verified domains of the tenant (Domain.Read.All).</summary>
    public static async Task<List<string>> ReadDomainsAsync(GraphClient graph, CancellationToken ct)
    {
        var all = await graph.GetAllAsync("/domains?$select=id,isVerified", ct);
        return all.Where(d => d["isVerified"]?.GetValue<bool>() == true)
                  .Select(d => d["id"]!.GetValue<string>().ToLowerInvariant())
                  .Order().ToList();
    }
}
