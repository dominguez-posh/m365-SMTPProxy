using System.Text.Json.Serialization;

namespace SmtpProxy.Core.Config;

/// <summary>
/// Complete configuration of one proxy. The machine is the source of truth; the management server holds a copy
/// and may send a newer revision, which the service applies on its next heartbeat.
/// </summary>
public sealed class ProxyConfig
{
    /// <summary>Raised on every change (GUI, server). The higher revision wins.</summary>
    public long Revision { get; set; }
    public DateTimeOffset ModifiedAt { get; set; } = DateTimeOffset.UtcNow;
    public string ModifiedBy { get; set; } = "";

    public SmtpSettings Smtp { get; set; } = new();
    public List<SmtpUser> Users { get; set; } = [];
    public SenderPolicy Senders { get; set; } = new();
    public M365Connection M365 { get; set; } = new();
    public DeliverySettings Delivery { get; set; } = new();
    public ManagementSettings Management { get; set; } = new();
}

public sealed class SmtpSettings
{
    public bool Enabled { get; set; } = true;
    /// <summary>IP address to listen on; 0.0.0.0 = all IPv4 addresses, :: = all addresses (dual stack).</summary>
    public string ListenAddress { get; set; } = "0.0.0.0";
    public int Port { get; set; } = 25;
    public string HostName { get; set; } = Environment.MachineName.ToLowerInvariant();
    public int MaxMessageSizeMb { get; set; } = 35;
    public int MaxRecipients { get; set; } = 100;
    /// <summary>Networks (CIDR) that may send without SMTP authentication.</summary>
    public List<string> AnonymousNetworks { get; set; } = ["127.0.0.1/32", "::1/128"];
    /// <summary>Networks that may connect at all. Empty = every address.</summary>
    public List<string> AllowedNetworks { get; set; } = [];
    /// <summary>AUTH without TLS sends the password readable over the network. Off disables AUTH completely.</summary>
    public bool AllowAuthWithoutTls { get; set; } = true;
}

public sealed class SmtpUser
{
    public string Name { get; set; } = "";
    /// <summary>PBKDF2 hash, see <see cref="PasswordHasher"/>.</summary>
    public string PasswordHash { get; set; } = "";
    public bool Enabled { get; set; } = true;
    public string Description { get; set; } = "";
    /// <summary>Addresses or domains (@contoso.com) this user may send as. Empty = every allowed sender.</summary>
    public List<string> AllowedSenders { get; set; } = [];
}

public sealed class SenderPolicy
{
    /// <summary>Single addresses allowed as MAIL FROM.</summary>
    public List<string> AllowedAddresses { get; set; } = [];
    /// <summary>Domains whose every address is allowed. Both lists empty = every address of the tenant domains.</summary>
    public List<string> AllowedDomains { get; set; } = [];
}

public sealed class M365Connection
{
    public string TenantId { get; set; } = "";
    public string TenantName { get; set; } = "";
    public string ClientId { get; set; } = "";
    public string AppObjectId { get; set; } = "";
    public string ServicePrincipalId { get; set; } = "";
    public string CertificateThumbprint { get; set; } = "";
    public DateTimeOffset? CertificateExpires { get; set; }
    public List<string> Domains { get; set; } = [];
    public DateTimeOffset? DomainsRefreshedAt { get; set; }
    public DateTimeOffset? ConnectedAt { get; set; }
    public string ConnectedBy { get; set; } = "";
    /// <summary>Addresses the proxy can send from: mailboxes of the tenant with their aliases (read with User.Read.All).</summary>
    public List<SenderAddress> Addresses { get; set; } = [];
    public DateTimeOffset? AddressesRefreshedAt { get; set; }
    /// <summary>Permission set of the app (AppProvisioner.PermissionsVersion); older apps get it with "Neu verbinden".</summary>
    public int PermissionsVersion { get; set; }
    /// <summary>When the service last renewed the certificate of the app itself.</summary>
    public DateTimeOffset? CertificateRenewedAt { get; set; }

    [JsonIgnore]
    public bool IsConnected => TenantId.Length > 0 && ClientId.Length > 0 && CertificateThumbprint.Length > 0;
}

/// <summary>An address Graph can send from: the mailbox itself or one of its aliases.</summary>
public sealed class SenderAddress
{
    public string Address { get; set; } = "";
    /// <summary>Primary address (UPN) of the mailbox the address belongs to.</summary>
    public string Mailbox { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public bool IsAlias { get; set; }
}

public sealed class DeliverySettings
{
    /// <summary>Keep a copy in the sender's Sent Items.</summary>
    public bool SaveToSentItems { get; set; }
    /// <summary>Give up after this many hours of failed attempts.</summary>
    public int RetryHours { get; set; } = 24;
    public int LogRetentionDays { get; set; } = 30;
    /// <summary>Subjects in the mail log (personal data: off by default).</summary>
    public bool LogSubjects { get; set; }
}

public sealed class ManagementSettings
{
    /// <summary>HTTPS address of the management server. Empty = runs standalone.</summary>
    public string ServerUrl { get; set; } = "";
    /// <summary>Install updates the server rolls out. Off = only report them.</summary>
    public bool AcceptUpdates { get; set; } = true;
    /// <summary>Accept configuration changes from the server.</summary>
    public bool AcceptRemoteConfig { get; set; } = true;
}
