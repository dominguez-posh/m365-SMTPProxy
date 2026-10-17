namespace SmtpProxy.Core;

/// <summary>Fixed locations on the machine. Data live in ProgramData, program files in Program Files.</summary>
public static class Paths
{
    public const string ServiceName = "M365SmtpProxy";
    public const string DisplayName = "M365 SMTP Proxy";

    /// <summary>Override for tests and development (SMTPPROXY_DATA).</summary>
    public static string DataDir { get; set; } =
        Environment.GetEnvironmentVariable("SMTPPROXY_DATA") is { Length: > 0 } d
            ? d
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), ServiceName);

    public static string ConfigFile => Path.Combine(DataDir, "config.json");
    public static string StatusFile => Path.Combine(DataDir, "status.json");
    public static string ManagementFile => Path.Combine(DataDir, "management.json");
    public static string SpoolDir => Path.Combine(DataDir, "spool");
    public static string DeadDir => Path.Combine(DataDir, "failed");
    public static string LogDir => Path.Combine(DataDir, "logs");
    public static string UpdateDir => Path.Combine(DataDir, "update");

    public static string InstallDir => AppContext.BaseDirectory;

    public static string Version =>
        typeof(Paths).Assembly.GetName().Version is { } v ? $"{v.Major}.{v.Minor}.{v.Build}" : "0.0.0";

    public static void Ensure()
    {
        foreach (var d in new[] { DataDir, SpoolDir, DeadDir, LogDir }) Directory.CreateDirectory(d);
    }
}
