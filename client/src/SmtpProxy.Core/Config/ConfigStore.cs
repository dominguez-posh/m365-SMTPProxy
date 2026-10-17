using System.Text.Json;
using System.Text.Json.Serialization;

namespace SmtpProxy.Core.Config;

/// <summary>Reads and writes JSON files atomically (temp file + replace), shared by service and GUI.</summary>
public static class JsonFile
{
    public static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public static T? Read<T>(string path) where T : class
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                if (!File.Exists(path)) return null;
                using var s = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                return JsonSerializer.Deserialize<T>(s, Options);
            }
            catch (IOException) when (attempt < 5) { Thread.Sleep(100); }
        }
    }

    public static void Write<T>(string path, T value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tmp = path + "." + Guid.NewGuid().ToString("N")[..8] + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(value, Options));
        for (var attempt = 0; ; attempt++)
        {
            try { File.Move(tmp, path, overwrite: true); return; }
            catch (IOException) when (attempt < 10) { Thread.Sleep(100); }
            catch { File.Delete(tmp); throw; }
        }
    }
}

public static class ConfigStore
{
    static readonly Lock Gate = new();

    public static ProxyConfig Load() => JsonFile.Read<ProxyConfig>(Paths.ConfigFile) ?? new ProxyConfig();

    /// <summary>Saves with a new revision and returns the saved config.</summary>
    public static ProxyConfig Save(ProxyConfig config, string modifiedBy)
    {
        lock (Gate)
        {
            var current = Load();
            config.Revision = Math.Max(config.Revision, current.Revision) + 1;
            config.ModifiedAt = DateTimeOffset.UtcNow;
            config.ModifiedBy = modifiedBy;
            JsonFile.Write(Paths.ConfigFile, config);
            return config;
        }
    }

    /// <summary>Writes a config received from the management server unchanged (keeps its revision).</summary>
    public static void Replace(ProxyConfig config)
    {
        lock (Gate) JsonFile.Write(Paths.ConfigFile, config);
    }

    public static ProxyConfig Clone(ProxyConfig c) =>
        JsonSerializer.Deserialize<ProxyConfig>(JsonSerializer.Serialize(c, JsonFile.Options), JsonFile.Options)!;
}
