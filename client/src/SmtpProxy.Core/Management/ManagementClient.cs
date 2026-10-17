using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using SmtpProxy.Core.Config;
using SmtpProxy.Core.Delivery;
using SmtpProxy.Core.Logging;

namespace SmtpProxy.Core.Management;

/// <summary>Local state of the server connection (management.json).</summary>
public sealed class ManagementLocal
{
    public string ServerUrl { get; set; } = "";
    public string ClientId { get; set; } = "";
    public string State { get; set; } = ManagementState.Off;
    public long AckMailSeq { get; set; }
    public long AckServiceSeq { get; set; }
}

public sealed class RemoteCommand
{
    public string Id { get; set; } = "";
    public string Type { get; set; } = "";
    public string? Arg { get; set; }
}

/// <summary>
/// Optional connection to the management server. The proxy registers with its key pair and waits for approval;
/// afterwards every sync sends status, configuration and new log entries and receives configuration changes,
/// commands and updates. Without server (or while it is unreachable) the proxy keeps working unchanged.
/// </summary>
public sealed class ManagementClient(Func<ProxyConfig> config, Func<ServiceStatus> status, Action<ProxyConfig> applyConfig, Action wakeDelivery)
{
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(2) };
    readonly List<object> _commandResults = [];
    object? _desiredResult;
    (string Version, DateTimeOffset At)? _updateStarted;

    public ManagementStatus Status { get; } = new();

    static ManagementLocal LoadLocal() => JsonFile.Read<ManagementLocal>(Paths.ManagementFile) ?? new ManagementLocal();
    static void SaveLocal(ManagementLocal l) => JsonFile.Write(Paths.ManagementFile, l);

    public static string? ValidateUrl(string url)
    {
        if (url.Length == 0) return null;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return "Ungültige Adresse.";
        if (u.Scheme == "https" || (u.Scheme == "http" && u.IsLoopback)) return null;
        return "Der Verwaltungsserver muss per HTTPS erreichbar sein.";
    }

    public async Task RunAsync(CancellationToken ct)
    {
        var failures = 0;
        while (!ct.IsCancellationRequested)
        {
            var wait = TimeSpan.FromSeconds(30);
            try
            {
                wait = await TickAsync(ct);
                failures = 0;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                failures++;
                if (Status.State == ManagementState.Off) Status.State = ManagementState.Error;
                Status.Error = ex is HttpRequestException or TaskCanceledException ? $"Server nicht erreichbar: {ex.Message}" : ex.Message;
                if (failures == 1 || failures % 20 == 0) Logs.Warn($"Verwaltungsserver: {Status.Error}");
                wait = TimeSpan.FromSeconds(Math.Min(300, 15 * failures));
            }
            try { await Task.Delay(wait, ct); } catch (OperationCanceledException) { break; }
        }
    }

    async Task<TimeSpan> TickAsync(CancellationToken ct)
    {
        var url = config().Management.ServerUrl.Trim().TrimEnd('/');
        var local = LoadLocal();
        Status.ServerUrl = url.Length > 0 ? url : null;

        if (url.Length == 0)
        {
            if (local.ClientId.Length > 0) SaveLocal(new ManagementLocal());
            Status.State = ManagementState.Off;
            Status.ClientId = null;
            Status.Error = null;
            return TimeSpan.FromSeconds(15);
        }
        if (ValidateUrl(url) is { } invalid)
        {
            Status.State = ManagementState.Error;
            Status.Error = invalid;
            return TimeSpan.FromSeconds(30);
        }
        if (!string.Equals(local.ServerUrl, url, StringComparison.OrdinalIgnoreCase))
        {
            local = new ManagementLocal { ServerUrl = url };
            SaveLocal(local);
        }

        using var id = ClientIdentity.OpenOrCreate();
        Status.KeyStorage = id.Storage;

        if (local.ClientId.Length == 0)
        {
            var reg = await PostAsync(url, "/api/client/v1/register", "new", id, new
            {
                publicKey = id.PublicKey,
                keyStorage = id.Storage,
                host = Environment.MachineName,
                domain = Environment.UserDomainName,
                version = Paths.Version,
                os = Environment.OSVersion.VersionString,
            }, ct);
            local.ClientId = reg["clientId"]!.GetValue<string>();
            local.State = reg["state"]?.GetValue<string>() ?? ManagementState.Pending;
            SaveLocal(local);
            Logs.Info($"Beim Verwaltungsserver {url} registriert (Kennung {local.ClientId}); wartet auf Freigabe.");
        }
        Status.ClientId = local.ClientId;

        var cfg = config();
        var body = new
        {
            version = Paths.Version,
            status = status(),
            config = cfg,
            mailLog = Logs.Mail.Since(local.AckMailSeq, 500),
            serviceLog = Logs.Service.Since(local.AckServiceSeq, 500),
            queue = MailQueue.List().Take(200).Select(Summary),
            failed = MailQueue.ListFailed().Take(200).Select(Summary),
            commandResults = TakeResults(),
            desiredResult = Interlocked.Exchange(ref _desiredResult, null),
        };
        JsonNode res;
        try { res = await PostAsync(url, "/api/client/v1/sync", local.ClientId, id, body, ct); }
        catch (ServerException ex) when (ex.Status is HttpStatusCode.Unauthorized or HttpStatusCode.NotFound or HttpStatusCode.Gone)
        {
            // removed on the server: register again (needs a new approval)
            Logs.Warn($"Verwaltungsserver kennt diesen Proxy nicht mehr ({ex.Message}); neue Registrierung.");
            SaveLocal(new ManagementLocal { ServerUrl = url });
            Status.State = ManagementState.Pending;
            return TimeSpan.FromSeconds(5);
        }

        Status.LastContact = DateTimeOffset.UtcNow;
        Status.Error = null;
        var state = res["state"]?.GetValue<string>() ?? ManagementState.Pending;
        if (state != local.State) Logs.Info($"Verwaltungsserver: Zustand {state}.");
        local.State = state;
        Status.State = state;
        if (res["ackMailSeq"] is { } am) local.AckMailSeq = am.GetValue<long>();
        if (res["ackServiceSeq"] is { } asq) local.AckServiceSeq = asq.GetValue<long>();
        SaveLocal(local);

        if (state != ManagementState.Approved) return TimeSpan.FromSeconds(state == ManagementState.Rejected ? 300 : 20);

        if (res["desiredConfig"] is JsonObject desired) ApplyDesired(cfg, desired);
        if (res["commands"] is JsonArray cmds)
            foreach (var c in cmds.Deserialize<List<RemoteCommand>>(JsonFile.Options) ?? []) RunCommand(c);

        Status.PendingUpdate = res["update"]?["version"]?.GetValue<string>();
        if (res["update"] is JsonObject update && cfg.Management.AcceptUpdates)
            await InstallUpdateAsync(url, local.ClientId, id, update, ct);

        // more log entries waiting: come back soon
        var more = Logs.Mail.Since(local.AckMailSeq, 1).Count > 0 || Logs.Service.Since(local.AckServiceSeq, 1).Count > 0;
        return TimeSpan.FromSeconds(more ? 2 : 30);
    }

    static object Summary(SpoolItem i) => new
    {
        i.Id, i.ReceivedAt, i.ClientIp, i.User, i.From, i.Recipients, i.Size, i.Subject, i.Attempts, i.NextAttemptAt, i.LastError,
    };

    List<object> TakeResults()
    {
        lock (_commandResults)
        {
            var list = _commandResults.ToList();
            _commandResults.Clear();
            return list;
        }
    }

    void Result(RemoteCommand c, bool ok, string? message)
    {
        lock (_commandResults) _commandResults.Add(new { id = c.Id, ok, message });
    }

    /// <summary>
    /// A configuration edited on the server is based on a revision. If the proxy was changed locally in the
    /// meantime, the change is refused (the server shows the conflict). Microsoft 365 connection and server address
    /// always stay local.
    /// </summary>
    void ApplyDesired(ProxyConfig current, JsonObject desired)
    {
        var baseRevision = desired["baseRevision"]?.GetValue<long>() ?? -1;
        if (!current.Management.AcceptRemoteConfig)
        {
            _desiredResult = new { baseRevision, applied = false, error = "Der Proxy nimmt keine Einstellungen vom Server an." };
            return;
        }
        if (baseRevision != current.Revision)
        {
            _desiredResult = new { baseRevision, applied = false, error = $"Die Einstellungen wurden lokal geändert (Revision {current.Revision}, Server erwartete {baseRevision})." };
            return;
        }
        var next = desired["config"].Deserialize<ProxyConfig>(JsonFile.Options);
        if (next is null) return;
        next.M365 = current.M365;
        next.Management.ServerUrl = current.Management.ServerUrl;
        next.Revision = current.Revision;
        var saved = ConfigStore.Save(next, desired["by"]?.GetValue<string>() is { } by ? $"Server ({by})" : "Server");
        applyConfig(saved);
        _desiredResult = new { baseRevision, applied = true, revision = saved.Revision };
        Logs.Info($"Einstellungen vom Verwaltungsserver übernommen (Revision {saved.Revision}).");
    }

    void RunCommand(RemoteCommand c)
    {
        try
        {
            switch (c.Type)
            {
                case "retryFailed":
                    if (c.Arg is { Length: > 0 }) MailQueue.Retry(c.Arg);
                    else foreach (var f in MailQueue.ListFailed()) MailQueue.Retry(f.Id);
                    wakeDelivery();
                    break;
                case "deleteFailed":
                    if (c.Arg is { Length: > 0 }) MailQueue.DeleteFailed(c.Arg);
                    break;
                case "retryQueue":
                    foreach (var i in MailQueue.List()) { i.NextAttemptAt = DateTimeOffset.UtcNow; MailQueue.Update(i); }
                    wakeDelivery();
                    break;
                default:
                    Result(c, false, $"Unbekannter Befehl {c.Type}");
                    return;
            }
            Logs.Info($"Befehl vom Verwaltungsserver ausgeführt: {c.Type} {c.Arg}");
            Result(c, true, null);
        }
        catch (Exception ex) { Result(c, false, ex.Message); }
    }

    async Task InstallUpdateAsync(string url, string clientId, ClientIdentity id, JsonObject update, CancellationToken ct)
    {
        var version = update["version"]!.GetValue<string>();
        var sha = update["sha256"]!.GetValue<string>().ToLowerInvariant();
        if (version == Paths.Version) return;
        if (_updateStarted is { } u && u.Version == version && DateTimeOffset.UtcNow - u.At < TimeSpan.FromMinutes(15)) return;
        Logs.Info($"Update auf Version {version} wird geladen.");

        using var req = new HttpRequestMessage(HttpMethod.Get, url + "/api/client/v1/package");
        req.Headers.TryAddWithoutValidation("Authorization", id.Authorization(clientId, "GET", "/api/client/v1/package", []));
        using var res = await Http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode) throw new ServerException(res.StatusCode, $"Update-Paket: {(int)res.StatusCode}");
        var zip = await res.Content.ReadAsByteArrayAsync(ct);
        var got = Convert.ToHexString(SHA256.HashData(zip)).ToLowerInvariant();
        if (got != sha) throw new InvalidOperationException($"Update-Paket {version} hat einen falschen Hash und wird verworfen.");

        var dir = Path.Combine(Paths.UpdateDir, version);
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        Directory.CreateDirectory(dir);
        ZipFile.ExtractToDirectory(new MemoryStream(zip), dir);
        var script = Path.Combine(dir, "install.ps1");
        if (!File.Exists(script)) throw new InvalidOperationException("Update-Paket enthält kein install.ps1.");

        Logs.Info($"Update auf Version {version} wird installiert; der Dienst startet neu.");
        _updateStarted = (version, DateTimeOffset.UtcNow);
        // the script of the NEW version stops this service, replaces the files and starts it again
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("powershell.exe",
            $"-NoProfile -ExecutionPolicy Bypass -File \"{script}\" -Update -Source \"{dir}\"")
        { UseShellExecute = false, CreateNoWindow = true });
    }

    /// <summary>Removes this proxy from the server (GUI: leave management) and deletes the key.</summary>
    public static async Task UnregisterAsync(CancellationToken ct)
    {
        var local = LoadLocal();
        if (local.ClientId.Length > 0 && local.ServerUrl.Length > 0)
        {
            try
            {
                using var id = ClientIdentity.OpenOrCreate();
                await PostAsync(local.ServerUrl, "/api/client/v1/unregister", local.ClientId, id, new { }, ct);
            }
            catch (Exception ex) { Logs.Warn($"Abmeldung beim Verwaltungsserver fehlgeschlagen: {ex.Message}"); }
        }
        SaveLocal(new ManagementLocal());
        ClientIdentity.Delete();
    }

    static async Task<JsonNode> PostAsync(string url, string path, string clientId, ClientIdentity id, object body, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(body, JsonFile.Options));
        using var req = new HttpRequestMessage(HttpMethod.Post, url + path) { Content = new ByteArrayContent(bytes) };
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
        req.Headers.TryAddWithoutValidation("Authorization", id.Authorization(clientId, "POST", path, bytes));
        using var res = await Http.SendAsync(req, ct);
        var text = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
        {
            string msg = text;
            try { msg = JsonNode.Parse(text)?["error"]?.GetValue<string>() ?? text; } catch (JsonException) { }
            throw new ServerException(res.StatusCode, $"{(int)res.StatusCode}: {msg}");
        }
        return JsonNode.Parse(text) ?? new JsonObject();
    }
}

public sealed class ServerException(HttpStatusCode status, string message) : Exception(message)
{
    public HttpStatusCode Status { get; } = status;
}
