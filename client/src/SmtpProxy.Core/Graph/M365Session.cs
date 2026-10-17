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
}
