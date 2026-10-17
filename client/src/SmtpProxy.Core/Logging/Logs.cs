using System.Text.Json;
using SmtpProxy.Core.Config;

namespace SmtpProxy.Core.Logging;

public static class MailEvent
{
    public const string Received = "received";
    public const string Delivered = "delivered";
    public const string Deferred = "deferred";
    public const string Failed = "failed";
    public const string Refused = "refused";
}

/// <summary>One line in the mail log (logs/mail-yyyy-MM-dd.jsonl). Contains no message content.</summary>
public sealed class MailLogEntry
{
    public long Seq { get; set; }
    public DateTimeOffset Time { get; set; }
    public string Event { get; set; } = "";
    public string? Id { get; set; }
    public string? ClientIp { get; set; }
    public string? User { get; set; }
    public string? From { get; set; }
    public List<string> To { get; set; } = [];
    public long Size { get; set; }
    public string? Subject { get; set; }
    public int Attempt { get; set; }
    public string? Detail { get; set; }
}

/// <summary>One line in the service log (logs/service-yyyy-MM-dd.jsonl).</summary>
public sealed class ServiceLogEntry
{
    public long Seq { get; set; }
    public DateTimeOffset Time { get; set; }
    public string Level { get; set; } = "info";
    public string Message { get; set; } = "";
}

/// <summary>
/// Append-only JSON-lines log with one file per day and a running sequence number. The newest entries are kept
/// in memory so the management client can send everything after the last acknowledged number.
/// </summary>
public sealed class JsonLog<T>(string prefix, Func<T, long> getSeq, Action<T, long> setSeq) where T : class
{
    const int MemoryEntries = 5000;
    readonly Lock _gate = new();
    readonly LinkedList<T> _recent = new();
    long _seq = -1;

    string FileFor(DateTimeOffset day) => Path.Combine(Paths.LogDir, $"{prefix}-{day.ToLocalTime():yyyy-MM-dd}.jsonl");

    public long LastSeq { get { lock (_gate) { Init(); return _seq; } } }

    void Init()
    {
        if (_seq >= 0) return;
        _seq = 0;
        Directory.CreateDirectory(Paths.LogDir);
        // continue the numbering of the newest file; load its tail into memory
        var newest = Directory.GetFiles(Paths.LogDir, $"{prefix}-*.jsonl").OrderDescending().FirstOrDefault();
        if (newest is null) return;
        foreach (var e in ReadFile(newest).TakeLast(MemoryEntries))
        {
            _recent.AddLast(e);
            _seq = Math.Max(_seq, getSeq(e));
        }
    }

    public T Append(T entry)
    {
        lock (_gate)
        {
            Init();
            setSeq(entry, ++_seq);
            File.AppendAllText(FileFor(DateTimeOffset.Now), JsonSerializer.Serialize(entry, Compact) + "\n");
            _recent.AddLast(entry);
            while (_recent.Count > MemoryEntries) _recent.RemoveFirst();
            return entry;
        }
    }

    /// <summary>Entries after the given sequence number (from memory), oldest first.</summary>
    public List<T> Since(long seq, int max)
    {
        lock (_gate)
        {
            Init();
            return _recent.Where(e => getSeq(e) > seq).Take(max).ToList();
        }
    }

    public static IEnumerable<T> ReadFile(string path)
    {
        if (!File.Exists(path)) yield break;
        string[] lines;
        using (var s = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var r = new StreamReader(s))
            lines = r.ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries);
        foreach (var line in lines)
        {
            T? e = null;
            try { e = JsonSerializer.Deserialize<T>(line, Compact); } catch (JsonException) { }
            if (e is not null) yield return e;
        }
    }

    /// <summary>Entries of one day (GUI).</summary>
    public IEnumerable<T> ReadDay(DateTime day) => ReadFile(Path.Combine(Paths.LogDir, $"{prefix}-{day:yyyy-MM-dd}.jsonl"));

    public void Cleanup(int retentionDays)
    {
        var limit = DateTime.Today.AddDays(-Math.Max(1, retentionDays)).ToString("yyyy-MM-dd");
        foreach (var f in Directory.GetFiles(Paths.LogDir, $"{prefix}-*.jsonl"))
        {
            var day = Path.GetFileNameWithoutExtension(f)[(prefix.Length + 1)..];
            if (string.CompareOrdinal(day, limit) < 0) try { File.Delete(f); } catch (IOException) { }
        }
    }

    internal static readonly JsonSerializerOptions Compact = new(JsonFile.Options) { WriteIndented = false };
}

public static class Logs
{
    public static readonly JsonLog<MailLogEntry> Mail = new("mail", e => e.Seq, (e, s) => e.Seq = s);
    public static readonly JsonLog<ServiceLogEntry> Service = new("service", e => e.Seq, (e, s) => e.Seq = s);

    public static void Info(string message) => Write("info", message);
    public static void Warn(string message) => Write("warn", message);
    public static void Error(string message) => Write("error", message);

    static void Write(string level, string message)
    {
        try { Service.Append(new ServiceLogEntry { Time = DateTimeOffset.UtcNow, Level = level, Message = message }); }
        catch (IOException) { }
    }
}
