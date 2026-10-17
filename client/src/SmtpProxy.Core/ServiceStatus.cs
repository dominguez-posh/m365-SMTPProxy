using SmtpProxy.Core.Config;

namespace SmtpProxy.Core;

/// <summary>State of the service, written to status.json every few seconds (GUI) and sent to the server.</summary>
public sealed class ServiceStatus
{
    public string Version { get; set; } = Paths.Version;
    public string Host { get; set; } = Environment.MachineName;
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public string? ListeningOn { get; set; }
    public string? SmtpError { get; set; }
    public int ActiveSessions { get; set; }
    public int QueueLength { get; set; }
    public int FailedCount { get; set; }
    public int DeliveredSinceStart { get; set; }
    public int FailedSinceStart { get; set; }
    public DateTimeOffset? LastDelivery { get; set; }
    public string? LastDeliveryError { get; set; }
    public bool M365Connected { get; set; }
    public string? M365Error { get; set; }
    public long ConfigRevision { get; set; }
    public ManagementStatus Management { get; set; } = new();

    public static ServiceStatus? Read() => JsonFile.Read<ServiceStatus>(Paths.StatusFile);

    [System.Text.Json.Serialization.JsonIgnore]
    /// <summary>The service counts as running if it wrote its status within the last 30 seconds.</summary>
    public bool IsFresh => DateTimeOffset.UtcNow - UpdatedAt < TimeSpan.FromSeconds(30);
}

public static class ManagementState
{
    public const string Off = "off";
    public const string Pending = "pending";
    public const string Approved = "approved";
    public const string Rejected = "rejected";
    public const string Error = "error";
}

public sealed class ManagementStatus
{
    public string State { get; set; } = ManagementState.Off;
    public string? ServerUrl { get; set; }
    public string? ClientId { get; set; }
    public DateTimeOffset? LastContact { get; set; }
    public string? Error { get; set; }
    public string? KeyStorage { get; set; }
    public string? PendingUpdate { get; set; }
}
