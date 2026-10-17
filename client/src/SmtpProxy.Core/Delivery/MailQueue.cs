using System.Net;
using System.Security.Cryptography;
using MimeKit;
using SmtpProxy.Core.Config;
using SmtpProxy.Core.Logging;
using SmtpProxy.Core.Smtp;

namespace SmtpProxy.Core.Delivery;

/// <summary>Metadata of a queued message (spool/&lt;id&gt;.json next to spool/&lt;id&gt;.eml).</summary>
public sealed class SpoolItem
{
    public string Id { get; set; } = "";
    public DateTimeOffset ReceivedAt { get; set; }
    public string ClientIp { get; set; } = "";
    public string? User { get; set; }
    public string Helo { get; set; } = "";
    public string From { get; set; } = "";
    public List<string> Recipients { get; set; } = [];
    public long Size { get; set; }
    public string? Subject { get; set; }
    public int Attempts { get; set; }
    public DateTimeOffset NextAttemptAt { get; set; }
    public string? LastError { get; set; }
}

/// <summary>
/// Durable queue on disk. The .eml is written first, the .json last: a message without .json was never
/// acknowledged to the client and is removed at start.
/// </summary>
public sealed class MailQueue(Func<ProxyConfig> config) : IMessageSink
{
    public event Action? Enqueued;

    static string Eml(string id) => Path.Combine(Paths.SpoolDir, id + ".eml");
    static string Meta(string id) => Path.Combine(Paths.SpoolDir, id + ".json");

    public async Task<string> AcceptAsync(IncomingMessage m, CancellationToken ct)
    {
        var id = $"{DateTime.UtcNow:yyyyMMddHHmmss}-{Convert.ToHexString(RandomNumberGenerator.GetBytes(4))}";
        var item = new SpoolItem
        {
            Id = id,
            ReceivedAt = DateTimeOffset.UtcNow,
            ClientIp = m.ClientIp.ToString(),
            User = m.User,
            Helo = m.Helo,
            From = m.From,
            Recipients = m.Recipients.ToList(),
            Size = m.Data.Length,
            Subject = config().Delivery.LogSubjects ? ReadSubject(m.Data) : null,
            NextAttemptAt = DateTimeOffset.UtcNow,
        };
        await File.WriteAllBytesAsync(Eml(id), m.Data, ct);
        JsonFile.Write(Meta(id), item);
        Log(MailEvent.Received, item);
        Enqueued?.Invoke();
        return id;
    }

    public void Refused(IPAddress clientIp, string? user, string? from, IReadOnlyList<string> recipients, string reason) =>
        Logs.Mail.Append(new MailLogEntry
        {
            Time = DateTimeOffset.UtcNow, Event = MailEvent.Refused, ClientIp = clientIp.ToString(), User = user,
            From = from, To = recipients.ToList(), Detail = reason,
        });

    static string? ReadSubject(byte[] data)
    {
        try { return HeaderList.Load(new MemoryStream(data))[HeaderId.Subject]?.Trim(); }
        catch (FormatException) { return null; }
    }

    public static List<SpoolItem> List()
    {
        var list = new List<SpoolItem>();
        if (!Directory.Exists(Paths.SpoolDir)) return list;
        foreach (var f in Directory.GetFiles(Paths.SpoolDir, "*.json"))
        {
            try { if (JsonFile.Read<SpoolItem>(f) is { } i) list.Add(i); }
            catch (Exception) { }
        }
        return list.OrderBy(i => i.ReceivedAt).ToList();
    }

    public static List<SpoolItem> ListFailed()
    {
        var list = new List<SpoolItem>();
        if (!Directory.Exists(Paths.DeadDir)) return list;
        foreach (var f in Directory.GetFiles(Paths.DeadDir, "*.json"))
        {
            try { if (JsonFile.Read<SpoolItem>(f) is { } i) list.Add(i); }
            catch (Exception) { }
        }
        return list.OrderByDescending(i => i.ReceivedAt).ToList();
    }

    public static byte[] ReadMessage(string id) => File.ReadAllBytes(Eml(id));

    public static void Update(SpoolItem item) => JsonFile.Write(Meta(item.Id), item);

    public static void Remove(string id)
    {
        File.Delete(Meta(id));
        File.Delete(Eml(id));
    }

    /// <summary>Moves a message to failed/ (kept for inspection and manual retry).</summary>
    public static void MoveToFailed(SpoolItem item)
    {
        Directory.CreateDirectory(Paths.DeadDir);
        File.Move(Eml(item.Id), Path.Combine(Paths.DeadDir, item.Id + ".eml"), overwrite: true);
        JsonFile.Write(Path.Combine(Paths.DeadDir, item.Id + ".json"), item);
        File.Delete(Meta(item.Id));
    }

    /// <summary>Puts a failed message back into the queue (the service picks it up within 30 seconds).</summary>
    public static void Retry(string id)
    {
        var meta = Path.Combine(Paths.DeadDir, id + ".json");
        var item = JsonFile.Read<SpoolItem>(meta) ?? throw new FileNotFoundException(id);
        item.Attempts = 0;
        item.NextAttemptAt = DateTimeOffset.UtcNow;
        item.ReceivedAt = DateTimeOffset.UtcNow;
        File.Move(Path.Combine(Paths.DeadDir, id + ".eml"), Eml(id), overwrite: true);
        JsonFile.Write(Meta(id), item);
        File.Delete(meta);
    }

    public static void DeleteFailed(string id)
    {
        File.Delete(Path.Combine(Paths.DeadDir, id + ".json"));
        File.Delete(Path.Combine(Paths.DeadDir, id + ".eml"));
    }

    /// <summary>Removes half-written messages from an interrupted run.</summary>
    public static void Recover()
    {
        Paths.Ensure();
        foreach (var eml in Directory.GetFiles(Paths.SpoolDir, "*.eml"))
            if (!File.Exists(Path.ChangeExtension(eml, ".json"))) File.Delete(eml);
        foreach (var tmp in Directory.GetFiles(Paths.SpoolDir, "*.tmp")) File.Delete(tmp);
    }

    public static void Log(string ev, SpoolItem i, string? detail = null) =>
        Logs.Mail.Append(new MailLogEntry
        {
            Time = DateTimeOffset.UtcNow, Event = ev, Id = i.Id, ClientIp = i.ClientIp, User = i.User, From = i.From,
            To = i.Recipients, Size = i.Size, Subject = i.Subject, Attempt = i.Attempts, Detail = detail,
        });
}
