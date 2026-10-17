using System.Net;
using SmtpProxy.Core.Config;

namespace SmtpProxy.Core.Smtp;

/// <summary>Decisions of the SMTP server: who may connect, authenticate and send as whom.</summary>
public static class SmtpPolicy
{
    public static bool InNetworks(IPAddress ip, IEnumerable<string> networks)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        foreach (var n in networks)
        {
            var s = n.Trim();
            if (s.Length == 0) continue;
            if (!s.Contains('/')) s += IPAddress.TryParse(s, out var single) && single.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 ? "/128" : "/32";
            if (IPNetwork.TryParse(s, out var net) && net.Contains(ip)) return true;
        }
        return false;
    }

    public static bool IsValidNetwork(string s) =>
        IPNetwork.TryParse(s.Contains('/') ? s : s + "/32", out _) || IPNetwork.TryParse(s + "/128", out _);

    public static bool MayConnect(ProxyConfig c, IPAddress ip) =>
        c.Smtp.AllowedNetworks.Count == 0 || InNetworks(ip, c.Smtp.AllowedNetworks) || InNetworks(ip, c.Smtp.AnonymousNetworks);

    public static bool MaySendAnonymously(ProxyConfig c, IPAddress ip) => InNetworks(ip, c.Smtp.AnonymousNetworks);

    public static SmtpUser? Authenticate(ProxyConfig c, string user, string password)
    {
        var u = c.Users.FirstOrDefault(x => x.Enabled && string.Equals(x.Name, user, StringComparison.OrdinalIgnoreCase));
        // compare against a dummy hash for unknown users so the response time does not reveal user names
        var ok = PasswordHasher.Verify(password, u?.PasswordHash ?? DummyHash);
        return u is not null && ok ? u : null;
    }

    static readonly string DummyHash = PasswordHasher.Hash(Guid.NewGuid().ToString());

    /// <summary>Null if the sender is allowed, otherwise the reason (for the SMTP reply and the log).</summary>
    public static string? CheckSender(ProxyConfig c, string address, SmtpUser? user)
    {
        var at = address.LastIndexOf('@');
        if (at <= 0 || at == address.Length - 1) return "Ungültige Absenderadresse";
        var domain = address[(at + 1)..].ToLowerInvariant();

        if (c.M365.Domains.Count > 0 && !c.M365.Domains.Contains(domain, StringComparer.OrdinalIgnoreCase))
            return $"Die Domäne {domain} gehört nicht zum Microsoft-365-Tenant";

        var p = c.Senders;
        if ((p.AllowedAddresses.Count > 0 || p.AllowedDomains.Count > 0) && !Matches(address, domain, p.AllowedAddresses.Concat(p.AllowedDomains.Select(d => "@" + d.TrimStart('@')))))
            return $"Absender {address} ist nicht freigegeben";

        if (user is { AllowedSenders.Count: > 0 } && !Matches(address, domain, user.AllowedSenders))
            return $"Benutzer {user.Name} darf nicht als {address} senden";
        return null;
    }

    static bool Matches(string address, string domain, IEnumerable<string> entries) =>
        entries.Any(e =>
        {
            var x = e.Trim();
            return x.StartsWith('@')
                ? string.Equals(x[1..], domain, StringComparison.OrdinalIgnoreCase)
                : string.Equals(x, address, StringComparison.OrdinalIgnoreCase);
        });
}
