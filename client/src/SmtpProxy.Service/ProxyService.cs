using SmtpProxy.Core;
using SmtpProxy.Core.Config;
using SmtpProxy.Core.Delivery;
using SmtpProxy.Core.Graph;
using SmtpProxy.Core.Logging;
using SmtpProxy.Core.Management;
using SmtpProxy.Core.Smtp;

namespace SmtpProxy.Service;

/// <summary>
/// The Windows service: SMTP listener, delivery queue, optional management connection. Picks up changes of
/// config.json (GUI, server) by itself and writes its state to status.json.
/// </summary>
public sealed class ProxyService : BackgroundService
{
    volatile ProxyConfig _config = new();
    readonly DateTimeOffset _started = DateTimeOffset.UtcNow;
    MailQueue _queue = null!;
    SmtpServer _smtp = null!;
    DeliveryWorker _delivery = null!;
    M365Session _m365 = null!;
    ManagementClient _management = null!;
    string? _m365Error;
    DateTimeOffset _domainsChecked = DateTimeOffset.MinValue;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        Paths.Ensure();
        MailQueue.Recover();
        _config = ConfigStore.Load();
        if (!File.Exists(Paths.ConfigFile)) _config = ConfigStore.Save(_config, "Erststart");
        Logs.Info($"Dienst gestartet, Version {Paths.Version}.");

        _queue = new MailQueue(() => _config);
        _m365 = new M365Session(() => _config);
        _delivery = new DeliveryWorker(() => _config, _queue, _m365);
        _smtp = new SmtpServer(() => _config, _queue, msg => Logs.Info(msg));
        _management = new ManagementClient(() => _config, BuildStatus, Apply, _delivery.Wake);

        await _smtp.StartAsync();
        using var watcher = WatchConfig(ct);

        var tasks = new[]
        {
            _delivery.RunAsync(ct),
            _management.RunAsync(ct),
            StatusLoopAsync(ct),
            MaintenanceLoopAsync(ct),
        };
        try { await Task.WhenAll(tasks); }
        catch (OperationCanceledException) { }
        await _smtp.StopAsync();
        Logs.Info("Dienst beendet.");
    }

    FileSystemWatcher WatchConfig(CancellationToken ct)
    {
        var w = new FileSystemWatcher(Paths.DataDir, "config.json") { NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName };
        var debounce = new Timer(_ => Reload(), null, Timeout.Infinite, Timeout.Infinite);
        void Changed(object? s, FileSystemEventArgs e) => debounce.Change(500, Timeout.Infinite);
        w.Changed += Changed;
        w.Created += Changed;
        w.Renamed += (s, e) => debounce.Change(500, Timeout.Infinite);
        w.EnableRaisingEvents = true;
        ct.Register(() => debounce.Dispose());
        return w;
    }

    void Reload()
    {
        try
        {
            var next = ConfigStore.Load();
            if (next.Revision == _config.Revision) return;
            Apply(next);
            Logs.Info($"Einstellungen neu geladen (Revision {next.Revision}, {next.ModifiedBy}).");
        }
        catch (Exception ex) { Logs.Error($"Einstellungen konnten nicht geladen werden: {ex.Message}"); }
    }

    void Apply(ProxyConfig next)
    {
        var old = _config;
        _config = next;
        if (old.Smtp.Enabled != next.Smtp.Enabled || old.Smtp.ListenAddress != next.Smtp.ListenAddress || old.Smtp.Port != next.Smtp.Port || _smtp.ListeningOn is null)
            _ = _smtp.StartAsync();
        if (old.M365.CertificateThumbprint != next.M365.CertificateThumbprint) _delivery.Wake();
    }

    ServiceStatus BuildStatus()
    {
        var c = _config;
        _management.Status.ServerUrl = c.Management.ServerUrl is { Length: > 0 } u ? u : null;
        return new ServiceStatus
        {
            StartedAt = _started,
            UpdatedAt = DateTimeOffset.UtcNow,
            ListeningOn = _smtp.ListeningOn,
            SmtpError = _smtp.LastError,
            ActiveSessions = _smtp.ActiveSessions,
            QueueLength = SafeCount(() => MailQueue.List().Count),
            FailedCount = SafeCount(() => MailQueue.ListFailed().Count),
            DeliveredSinceStart = _delivery.Delivered,
            FailedSinceStart = _delivery.Failed,
            LastDelivery = _delivery.LastDelivery,
            LastDeliveryError = _delivery.LastError,
            M365Connected = c.M365.IsConnected && _m365.Tokens() is not null,
            M365Error = c.M365.IsConnected && Certificates.Find(c.M365.CertificateThumbprint) is null
                ? "Zertifikat der App wurde im Zertifikatspeicher nicht gefunden." : _m365Error,
            ConfigRevision = c.Revision,
            Management = _management.Status,
        };
    }

    static int SafeCount(Func<int> f)
    {
        try { return f(); } catch { return -1; }
    }

    async Task StatusLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { JsonFile.Write(Paths.StatusFile, BuildStatus()); }
            catch (Exception) { }
            try { await Task.Delay(TimeSpan.FromSeconds(5), ct); } catch (OperationCanceledException) { break; }
        }
    }

    /// <summary>Daily: refresh tenant domains, delete old logs, warn before the certificate expires.</summary>
    async Task MaintenanceLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var c = _config;
            Logs.Mail.Cleanup(c.Delivery.LogRetentionDays);
            Logs.Service.Cleanup(c.Delivery.LogRetentionDays);
            if (_m365.Graph() is { } graph && DateTimeOffset.UtcNow - _domainsChecked > TimeSpan.FromHours(12))
            {
                try
                {
                    var domains = await M365Session.ReadDomainsAsync(graph, ct);
                    _domainsChecked = DateTimeOffset.UtcNow;
                    _m365Error = null;
                    // saved only on change: every save raises the revision
                    var fresh = ConfigStore.Load();
                    if (!domains.SequenceEqual(fresh.M365.Domains))
                    {
                        Logs.Info($"Domänen des Tenants: {string.Join(", ", domains)}");
                        fresh.M365.Domains = domains;
                        fresh.M365.DomainsRefreshedAt = DateTimeOffset.UtcNow;
                        Apply(ConfigStore.Save(fresh, "Dienst (Domänenabgleich)"));
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
                catch (Exception ex)
                {
                    _m365Error = $"Domänen konnten nicht gelesen werden: {ex.Message}";
                    Logs.Warn(_m365Error);
                }
            }
            if (c.M365.CertificateExpires is { } exp && exp - DateTimeOffset.UtcNow < TimeSpan.FromDays(30))
                Logs.Warn($"Das Zertifikat der App läuft am {exp.ToLocalTime():d} ab. In der Oberfläche unter Microsoft 365 erneuern.");
            try { await Task.Delay(TimeSpan.FromHours(1), ct); } catch (OperationCanceledException) { break; }
        }
    }
}
