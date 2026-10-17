using System.IO;
using System.Collections.ObjectModel;
using System.ServiceProcess;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using SmtpProxy.Core;
using SmtpProxy.Core.Config;
using SmtpProxy.Core.Delivery;
using SmtpProxy.Core.Graph;
using SmtpProxy.Core.Logging;
using SmtpProxy.Core.M365;
using SmtpProxy.Core.Management;
using SmtpProxy.Core.Smtp;

namespace SmtpProxy.Gui;

public sealed class UserRow
{
    public string Name { get; set; } = "";
    public bool Enabled { get; set; } = true;
    public string Description { get; set; } = "";
    public string Senders { get; set; } = "";
    public string PasswordHash { get; set; } = "";
}

public sealed class QueueRow(SpoolItem i)
{
    public string Id => i.Id;
    public DateTime ReceivedAt => i.ReceivedAt.LocalDateTime;
    public string From => i.From;
    public string RecipientsText => string.Join(", ", i.Recipients);
    public int Attempts => i.Attempts;
    public DateTime NextAttemptAt => i.NextAttemptAt.LocalDateTime;
    public string? LastError => i.LastError;
}

public sealed record LogRow(string Time, string Event, string Client, string From, string To, string Detail);

public partial class MainWindow : Window
{
    ProxyConfig _config = new();
    readonly ObservableCollection<UserRow> _users = [];
    readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(3) };
    List<LogRow> _logRows = [];
    bool _busy;

    public MainWindow()
    {
        InitializeComponent();
        UsersGrid.ItemsSource = _users;
        LogDate.SelectedDate = DateTime.Today;
        AboutText.Text = $"Version {Paths.Version} · Daten: {Paths.DataDir}";
        LoadConfig();
        RefreshStatus();
        RefreshQueue();
        _timer.Tick += (_, _) => { RefreshStatus(); if (Tabs.SelectedIndex == 5) RefreshQueue(); };
        _timer.Start();
    }

    // ------------------------------------------------------------------ configuration <-> controls

    void LoadConfig()
    {
        _config = ConfigStore.Load();
        var c = _config;
        SmtpEnabled.IsChecked = c.Smtp.Enabled;
        ListenAddress.Text = c.Smtp.ListenAddress;
        Port.Text = c.Smtp.Port.ToString();
        HostName.Text = c.Smtp.HostName;
        MaxSize.Text = c.Smtp.MaxMessageSizeMb.ToString();
        MaxRecipients.Text = c.Smtp.MaxRecipients.ToString();
        AnonymousNetworks.Text = Lines(c.Smtp.AnonymousNetworks);
        AllowedNetworks.Text = Lines(c.Smtp.AllowedNetworks);
        AllowAuth.IsChecked = c.Smtp.AllowAuthWithoutTls;
        AllowedAddresses.Text = Lines(c.Senders.AllowedAddresses);
        AllowedDomains.Text = Lines(c.Senders.AllowedDomains);
        ServerUrl.Text = c.Management.ServerUrl;
        AcceptConfig.IsChecked = c.Management.AcceptRemoteConfig;
        AcceptUpdates.IsChecked = c.Management.AcceptUpdates;
        ExchangeScopeCheck.IsChecked = !c.M365.IsConnected || c.Senders.ExchangeScopeEnabled;
        _users.Clear();
        foreach (var u in c.Users)
            _users.Add(new UserRow { Name = u.Name, Enabled = u.Enabled, Description = u.Description, Senders = string.Join(", ", u.AllowedSenders), PasswordHash = u.PasswordHash });
        ShowM365();
        FooterText.Text = $"Revision {c.Revision} · zuletzt geändert {c.ModifiedAt.LocalDateTime:g} von {c.ModifiedBy}";
    }

    static string Lines(IEnumerable<string> l) => string.Join(Environment.NewLine, l);
    static List<string> FromLines(string s) =>
        s.Split(['\r', '\n', ',', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

    /// <summary>Reads the controls into a copy of the configuration; null with a message if a value is invalid.</summary>
    ProxyConfig? ReadControls()
    {
        var c = ConfigStore.Clone(ConfigStore.Load());
        string? error = null;
        if (!System.Net.IPAddress.TryParse(ListenAddress.Text.Trim(), out _)) error = "IP-Adresse ist ungültig.";
        else if (!int.TryParse(Port.Text, out var port) || port is < 1 or > 65535) error = "Port muss zwischen 1 und 65535 liegen.";
        else if (!int.TryParse(MaxSize.Text, out var size) || size is < 1 or > 150) error = "Nachrichtengröße: 1 bis 150 MB.";
        else if (!int.TryParse(MaxRecipients.Text, out var rcpt) || rcpt is < 1 or > 500) error = "Empfänger: 1 bis 500.";
        else if (FromLines(AnonymousNetworks.Text).Concat(FromLines(AllowedNetworks.Text)).FirstOrDefault(n => !SmtpPolicy.IsValidNetwork(n)) is { } bad) error = $"Ungültiges Netz: {bad}";
        else if (ManagementClient.ValidateUrl(ServerUrl.Text.Trim()) is { } urlError) error = urlError;
        else if (FromLines(AllowedAddresses.Text).FirstOrDefault(a => !a.Contains('@')) is { } badAddress) error = $"Ungültige Adresse: {badAddress}";
        else
        {
            c.Smtp.Enabled = SmtpEnabled.IsChecked == true;
            c.Smtp.ListenAddress = ListenAddress.Text.Trim();
            c.Smtp.Port = port;
            c.Smtp.HostName = HostName.Text.Trim() is { Length: > 0 } h ? h : Environment.MachineName.ToLowerInvariant();
            c.Smtp.MaxMessageSizeMb = size;
            c.Smtp.MaxRecipients = rcpt;
            c.Smtp.AnonymousNetworks = FromLines(AnonymousNetworks.Text);
            c.Smtp.AllowedNetworks = FromLines(AllowedNetworks.Text);
            c.Smtp.AllowAuthWithoutTls = AllowAuth.IsChecked == true;
            c.Senders.AllowedAddresses = FromLines(AllowedAddresses.Text).Select(a => a.ToLowerInvariant()).ToList();
            c.Senders.AllowedDomains = FromLines(AllowedDomains.Text).Select(d => d.TrimStart('@').ToLowerInvariant()).ToList();
            c.Management.ServerUrl = ServerUrl.Text.Trim().TrimEnd('/');
            c.Management.AcceptRemoteConfig = AcceptConfig.IsChecked == true;
            c.Management.AcceptUpdates = AcceptUpdates.IsChecked == true;
            c.Users = _users.Select(u => new SmtpUser
            {
                Name = u.Name, Enabled = u.Enabled, Description = u.Description ?? "", PasswordHash = u.PasswordHash,
                AllowedSenders = FromLines(u.Senders ?? "").Select(s => s.ToLowerInvariant()).ToList(),
            }).ToList();
            return c;
        }
        MessageBox.Show(this, error, Title, MessageBoxButton.OK, MessageBoxImage.Warning);
        return null;
    }

    bool SaveControls()
    {
        var c = ReadControls();
        if (c is null) return false;
        var exchangeChanged = c.Senders.ExchangeScopeEnabled &&
            !c.Senders.AllowedAddresses.SequenceEqual(_config.Senders.AllowedAddresses, StringComparer.OrdinalIgnoreCase);
        _config = ConfigStore.Save(c, $"Oberfläche ({Environment.UserName})");
        LoadConfig();
        FooterText.Text = $"Gespeichert (Revision {_config.Revision}). Der Dienst übernimmt die Änderungen in wenigen Sekunden.";
        if (exchangeChanged && MessageBox.Show(this,
                "Die erlaubten Adressen haben sich geändert. Jetzt auch in Exchange Online abgleichen? Sonst darf die App nur als die bisherigen Postfächer senden.",
                Title, MessageBoxButton.YesNo, MessageBoxImage.Question) == MessageBoxResult.Yes)
            Exchange_Click(this, new RoutedEventArgs());
        return true;
    }

    void Save_Click(object sender, RoutedEventArgs e) => SaveControls();

    void Discard_Click(object sender, RoutedEventArgs e)
    {
        LoadConfig();
        FooterText.Text = "Änderungen verworfen.";
    }

    // ------------------------------------------------------------------ status

    void RefreshStatus()
    {
        var svc = ServiceState();
        var s = ServiceStatus.Read();
        var running = svc == ServiceControllerStatus.Running && s is { IsFresh: true };
        SvcState.Text = svc switch
        {
            null => "Nicht installiert",
            ServiceControllerStatus.Running => running ? "Läuft" : "Läuft (keine Statusmeldung)",
            ServiceControllerStatus.Stopped => "Gestoppt",
            _ => svc.ToString()!,
        };
        SvcDetail.Text = s is null ? "" : $"Version {s.Version}, gestartet {s.StartedAt.LocalDateTime:g}";

        SmtpState.Text = !running ? "–" : s!.ListeningOn is { } l ? $"Lauscht auf {l}" : _config.Smtp.Enabled ? "Fehler" : "Deaktiviert";
        SmtpDetail.Text = running ? (s!.SmtpError ?? $"{s.ActiveSessions} aktive Verbindungen") : "";

        var c = _config.M365;
        M365State.Text = !c.IsConnected ? "Nicht verbunden" : running && s!.M365Error is { } err ? "Fehler" : "Verbunden";
        M365Detail.Text = !c.IsConnected ? "Unter „Microsoft 365“ verbinden." :
            running && s!.M365Error is { } e2 ? e2 : $"{c.TenantName} · Zertifikat bis {c.CertificateExpires?.LocalDateTime:d}";

        QueueState.Text = running ? $"{s!.QueueLength} wartend, {s.FailedCount} fehlgeschlagen" : "–";
        QueueDetail.Text = running ? $"Seit Start: {s!.DeliveredSinceStart} zugestellt, {s.FailedSinceStart} fehlgeschlagen" +
                                     (s.LastDeliveryError is { } le ? $"\nLetzter Fehler: {le}" : "") : "";

        var m = s?.Management;
        MgmtState.Text = _config.Management.ServerUrl.Length == 0 ? "Eigenständig" : m?.State switch
        {
            ManagementState.Approved => "Verbunden",
            ManagementState.Pending => "Wartet auf Freigabe",
            ManagementState.Rejected => "Abgelehnt",
            ManagementState.Error => "Fehler",
            _ => "Verbindet …",
        };
        MgmtDetail.Text = _config.Management.ServerUrl.Length == 0 ? "Kein Verwaltungsserver eingetragen." :
            $"{_config.Management.ServerUrl}" + (m?.Error is { } me ? $"\n{me}" : m?.LastContact is { } lc ? $"\nLetzter Kontakt {lc.LocalDateTime:T}" : "");
        MgmtInfo.Text = _config.Management.ServerUrl.Length == 0 ? "Nicht verbunden." :
            $"Zustand: {MgmtState.Text}\nKennung: {m?.ClientId ?? "–"}\nSchlüssel: {(m?.KeyStorage == "tpm" ? "TPM" : m?.KeyStorage == "software" ? "Software (nicht exportierbar)" : "–")}\n" +
            $"Letzter Kontakt: {m?.LastContact?.LocalDateTime.ToString("g") ?? "–"}" +
            (m?.PendingUpdate is { } pu ? $"\nVerfügbares Update: {pu}" : "") + (m?.Error is { } me2 ? $"\nFehler: {me2}" : "");

        // reload if the service or the server changed the configuration while nothing is edited here
        var disk = ConfigStore.Load();
        if (disk.Revision != _config.Revision && !IsDirty()) LoadConfig();
    }

    bool IsDirty()
    {
        var c = ConfigStore.Clone(_config);
        try
        {
            return SmtpEnabled.IsChecked != c.Smtp.Enabled || ListenAddress.Text.Trim() != c.Smtp.ListenAddress || Port.Text != c.Smtp.Port.ToString()
                   || AnonymousNetworks.Text != Lines(c.Smtp.AnonymousNetworks) || AllowedNetworks.Text != Lines(c.Smtp.AllowedNetworks)
                   || AllowedAddresses.Text != Lines(c.Senders.AllowedAddresses) || AllowedDomains.Text != Lines(c.Senders.AllowedDomains)
                   || ServerUrl.Text.Trim() != c.Management.ServerUrl || _users.Count != c.Users.Count;
        }
        catch { return true; }
    }

    static ServiceControllerStatus? ServiceState()
    {
        try
        {
            using var sc = new ServiceController(Paths.ServiceName);
            return sc.Status;
        }
        catch (InvalidOperationException) { return null; }
    }

    async Task ControlServiceAsync(Action<ServiceController> action, ServiceControllerStatus target)
    {
        try
        {
            using var sc = new ServiceController(Paths.ServiceName);
            action(sc);
            await Task.Run(() => sc.WaitForStatus(target, TimeSpan.FromSeconds(30)));
        }
        catch (Exception ex) { MessageBox.Show(this, ex.Message, Title, MessageBoxButton.OK, MessageBoxImage.Warning); }
        RefreshStatus();
    }

    async void StartService_Click(object sender, RoutedEventArgs e) => await ControlServiceAsync(sc => sc.Start(), ServiceControllerStatus.Running);
    async void StopService_Click(object sender, RoutedEventArgs e) => await ControlServiceAsync(sc => sc.Stop(), ServiceControllerStatus.Stopped);
    async void RestartService_Click(object sender, RoutedEventArgs e)
    {
        if (ServiceState() == ServiceControllerStatus.Running)
            await ControlServiceAsync(sc => sc.Stop(), ServiceControllerStatus.Stopped);
        await ControlServiceAsync(sc => sc.Start(), ServiceControllerStatus.Running);
    }

    // ------------------------------------------------------------------ Microsoft 365

    void ShowM365()
    {
        var c = _config.M365;
        M365Info.Text = !c.IsConnected
            ? "Noch nicht verbunden."
            : $"Tenant: {c.TenantName} ({c.TenantId})\nApp-ID: {c.ClientId}\nZertifikat: {c.CertificateThumbprint}, gültig bis {c.CertificateExpires?.LocalDateTime:d}\n" +
              $"Verbunden: {c.ConnectedAt?.LocalDateTime:g} durch {c.ConnectedBy}\n" +
              $"Absender in Exchange eingeschränkt: {(_config.Senders.ExchangeScopeEnabled ? $"ja, Gruppe {_config.Senders.ExchangeScopeGroup}, abgeglichen {_config.Senders.ExchangeScopeSyncedAt?.LocalDateTime:g}" : "nein")}\n" +
              $"Domänen: {string.Join(", ", c.Domains)}";
        TenantDomains.Text = c.Domains.Count > 0 ? $"Domänen des Tenants: {string.Join(", ", c.Domains)}" : "";
        ConnectButton.Content = c.IsConnected ? "Neu verbinden" : "Mit Microsoft 365 verbinden";
        ExchangeButton.IsEnabled = DomainsButton.IsEnabled = TestButton.IsEnabled = DisconnectButton.IsEnabled = c.IsConnected;
    }

    void LogM365(string line) => Dispatcher.Invoke(() =>
    {
        M365Log.AppendText($"{DateTime.Now:T}  {line}{Environment.NewLine}");
        M365Log.ScrollToEnd();
    });

    async Task RunBusyAsync(Func<Task> work)
    {
        if (_busy) return;
        _busy = true;
        Cursor = System.Windows.Input.Cursors.AppStarting;
        try { await work(); }
        catch (Exception ex)
        {
            LogM365("Fehler: " + ex.Message);
            MessageBox.Show(this, ex.Message, Title, MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            _busy = false;
            Cursor = null;
        }
    }

    async void Connect_Click(object sender, RoutedEventArgs e) => await RunBusyAsync(async () =>
    {
        var old = _config.M365;
        if (old.IsConnected && MessageBox.Show(this,
                "Es besteht bereits eine Verbindung. Neu verbinden legt eine neue App-Registrierung mit neuem Zertifikat an; die bisherige wird anschließend gelöscht. Fortfahren?",
                Title, MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;

        var scope = ExchangeScopeCheck.IsChecked == true;
        LogM365("Browser wird für die Anmeldung als Administrator geöffnet …");
        var admin = await BrowserLogin.SignInAsync(AppProvisioner.AdminScopes, url => LogM365("Falls sich kein Browser öffnet: " + url), CancellationToken.None);
        LogM365($"Angemeldet als {admin.User}.");

        var conn = await AppProvisioner.ProvisionAsync(admin, scope, LogM365, CancellationToken.None);
        var c = ConfigStore.Load();
        c.M365 = conn;
        c.Senders.ExchangeScopeEnabled = scope;
        if (scope && c.Senders.ExchangeScopeGroup.Length == 0) c.Senders.ExchangeScopeGroup = ExchangeScope.GroupAlias(Environment.MachineName);
        _config = ConfigStore.Save(c, $"Oberfläche ({admin.User})");
        LoadConfig();
        LogM365($"App {conn.ClientId} angelegt, Domänen: {string.Join(", ", conn.Domains)}");

        if (old.IsConnected && old.ClientId != conn.ClientId)
        {
            LogM365("Bisherige App-Registrierung wird gelöscht …");
            try { await AppProvisioner.RemoveAsync(admin, old, CancellationToken.None); }
            catch (Exception ex) { LogM365($"Bisherige App konnte nicht gelöscht werden: {ex.Message}"); }
        }

        if (scope)
        {
            if (_config.Senders.AllowedAddresses.Count == 0)
                LogM365("Hinweis: Noch keine erlaubten Adressen eingetragen. Unter „Absender“ Postfächer eintragen und danach „Absender in Exchange abgleichen“.");
            await ApplyExchangeAsync();
        }
    });

    async void Exchange_Click(object sender, RoutedEventArgs e) => await RunBusyAsync(ApplyExchangeAsync);

    async Task ApplyExchangeAsync()
    {
        LogM365("PowerShell-Fenster für Exchange Online wird geöffnet (Anmeldung als Exchange-Administrator) …");
        var c = ConfigStore.Load();
        var r = await ExchangeScope.ApplyAsync(c, CancellationToken.None);
        if (!r.Ok)
        {
            LogM365($"Exchange-Einschränkung fehlgeschlagen: {r.Error}");
            return;
        }
        c = ConfigStore.Load();
        c.Senders.ExchangeScopeEnabled = true;
        c.Senders.ExchangeScopeGroup = r.Group ?? c.Senders.ExchangeScopeGroup;
        c.Senders.ExchangeScopeSyncedAt = DateTimeOffset.UtcNow;
        _config = ConfigStore.Save(c, $"Oberfläche ({Environment.UserName})");
        LoadConfig();
        LogM365($"Exchange: Gruppe {r.Group}, {r.Members.Count} Postfächer. Wirksam nach bis zu 30 Minuten.");
        if (r.NotFound.Count > 0) LogM365($"Nicht gefunden (kein Postfach): {string.Join(", ", r.NotFound)}");
    }

    async void Domains_Click(object sender, RoutedEventArgs e) => await RunBusyAsync(async () =>
    {
        var graph = new M365Session(() => _config).Graph() ?? throw new InvalidOperationException("Zertifikat der App nicht gefunden.");
        var domains = await M365Session.ReadDomainsAsync(graph, CancellationToken.None);
        var c = ConfigStore.Load();
        c.M365.Domains = domains;
        c.M365.DomainsRefreshedAt = DateTimeOffset.UtcNow;
        _config = ConfigStore.Save(c, $"Oberfläche ({Environment.UserName})");
        LoadConfig();
        LogM365($"Domänen: {string.Join(", ", domains)}");
    });

    async void TestMail_Click(object sender, RoutedEventArgs e) => await RunBusyAsync(async () =>
    {
        var from = _config.Senders.AllowedAddresses.FirstOrDefault() ?? $"absender@{_config.M365.Domains.FirstOrDefault()}";
        var values = Prompt.Ask(this, "Testnachricht", ("Absender (Postfach im Tenant)", from), ("Empfänger", ""));
        if (values is null || values[1].Length == 0) return;
        var reason = SmtpPolicy.CheckSender(_config, values[0], null);
        if (reason is not null) throw new InvalidOperationException(reason);
        var msg = new MimeKit.MimeMessage();
        msg.From.Add(MimeKit.MailboxAddress.Parse(values[0]));
        msg.To.Add(MimeKit.MailboxAddress.Parse(values[1]));
        msg.Subject = "Testnachricht vom M365 SMTP Proxy";
        msg.Body = new MimeKit.TextPart("plain") { Text = $"Diese Nachricht wurde vom M365 SMTP Proxy auf {Environment.MachineName} über Microsoft Graph gesendet ({DateTime.Now:g})." };
        using var ms = new MemoryStream();
        msg.WriteTo(ms);
        var mailer = new M365Session(() => _config).Mailer() ?? throw new InvalidOperationException("Zertifikat der App nicht gefunden.");
        LogM365($"Testnachricht von {values[0]} an {values[1]} …");
        await mailer.SendAsync(values[0], [values[1]], ms.ToArray(), CancellationToken.None);
        LogM365("Testnachricht gesendet.");
    });

    async void Disconnect_Click(object sender, RoutedEventArgs e) => await RunBusyAsync(async () =>
    {
        var answer = MessageBox.Show(this,
            "Verbindung trennen: Ja = App-Registrierung im Tenant löschen (Anmeldung als Administrator), Nein = nur lokal trennen (App bleibt im Tenant bestehen).",
            Title, MessageBoxButton.YesNoCancel, MessageBoxImage.Question);
        if (answer == MessageBoxResult.Cancel) return;
        var c = ConfigStore.Load();
        if (answer == MessageBoxResult.Yes)
        {
            var admin = await BrowserLogin.SignInAsync(AppProvisioner.AdminScopes, url => LogM365("Falls sich kein Browser öffnet: " + url), CancellationToken.None);
            await AppProvisioner.RemoveAsync(admin, c.M365, CancellationToken.None);
            LogM365($"App {c.M365.ClientId} gelöscht.");
        }
        else Certificates.Delete(c.M365.CertificateThumbprint);
        c.M365 = new M365Connection();
        c.Senders.ExchangeScopeEnabled = false;
        _config = ConfigStore.Save(c, $"Oberfläche ({Environment.UserName})");
        LoadConfig();
        LogM365("Verbindung getrennt. Hinweis: Gruppe und Verwaltungsbereich in Exchange bleiben bestehen.");
    });

    // ------------------------------------------------------------------ users

    void AddUser_Click(object sender, RoutedEventArgs e)
    {
        var v = Prompt.Ask(this, "SMTP-Benutzer anlegen", ("Benutzername", ""), ("Beschreibung", ""), ("Erlaubte Absender (optional, durch Komma getrennt)", ""));
        if (v is null || v[0].Length == 0) return;
        if (_users.Any(u => string.Equals(u.Name, v[0], StringComparison.OrdinalIgnoreCase)))
        {
            MessageBox.Show(this, "Diesen Benutzer gibt es bereits.", Title);
            return;
        }
        var password = PasswordHasher.Generate();
        _users.Add(new UserRow { Name = v[0], Description = v[1], Senders = v[2], PasswordHash = PasswordHasher.Hash(password) });
        if (!SaveControls()) { _users.RemoveAt(_users.Count - 1); return; }
        Prompt.ShowSecret(this, "Passwort", $"Passwort für {v[0]}. Es wird nur jetzt angezeigt.", password);
    }

    void ResetPassword_Click(object sender, RoutedEventArgs e)
    {
        if (UsersGrid.SelectedItem is not UserRow u) return;
        var password = PasswordHasher.Generate();
        u.PasswordHash = PasswordHasher.Hash(password);
        if (!SaveControls()) return;
        Prompt.ShowSecret(this, "Neues Passwort", $"Neues Passwort für {u.Name}. Es wird nur jetzt angezeigt.", password);
    }

    void DeleteUser_Click(object sender, RoutedEventArgs e)
    {
        if (UsersGrid.SelectedItem is not UserRow u) return;
        if (MessageBox.Show(this, $"Benutzer {u.Name} löschen?", Title, MessageBoxButton.YesNo) != MessageBoxResult.Yes) return;
        _users.Remove(u);
        SaveControls();
    }

    // ------------------------------------------------------------------ queue

    void RefreshQueue()
    {
        QueueGrid.ItemsSource = MailQueue.List().Select(i => new QueueRow(i)).ToList();
        FailedGrid.ItemsSource = MailQueue.ListFailed().Select(i => new QueueRow(i)).ToList();
    }

    void RefreshQueue_Click(object sender, RoutedEventArgs e) => RefreshQueue();

    void RetryFailed_Click(object sender, RoutedEventArgs e)
    {
        foreach (var r in FailedGrid.SelectedItems.OfType<QueueRow>().ToList()) MailQueue.Retry(r.Id);
        RefreshQueue();
    }

    void DeleteFailed_Click(object sender, RoutedEventArgs e)
    {
        var rows = FailedGrid.SelectedItems.OfType<QueueRow>().ToList();
        if (rows.Count == 0 || MessageBox.Show(this, $"{rows.Count} Nachricht(en) endgültig löschen?", Title, MessageBoxButton.YesNo) != MessageBoxResult.Yes) return;
        foreach (var r in rows) MailQueue.DeleteFailed(r.Id);
        RefreshQueue();
    }

    // ------------------------------------------------------------------ log

    void LoadLog()
    {
        // events of the controls fire while the window is still being built
        if (LogDate is null || LogKind is null || LogGrid is null) return;
        var day = LogDate.SelectedDate ?? DateTime.Today;
        _logRows = LogKind.SelectedIndex == 1
            ? Logs.Service.ReadDay(day).Reverse().Select(e => new LogRow(e.Time.LocalDateTime.ToString("T"), e.Level, "", "", "", e.Message)).ToList()
            : Logs.Mail.ReadDay(day).Reverse().Select(e => new LogRow(e.Time.LocalDateTime.ToString("T"), EventName(e.Event),
                $"{e.ClientIp}{(e.User is null ? "" : $" ({e.User})")}", e.From ?? "", string.Join(", ", e.To),
                string.Join(" · ", new[] { e.Subject, e.Size > 0 ? $"{e.Size / 1024.0:0.#} KB" : null, e.Attempt > 1 ? $"Versuch {e.Attempt}" : null, e.Detail }.Where(x => !string.IsNullOrEmpty(x))))).ToList();
        ApplyLogFilter();
    }

    static string EventName(string e) => e switch
    {
        MailEvent.Received => "Angenommen",
        MailEvent.Delivered => "Zugestellt",
        MailEvent.Deferred => "Verzögert",
        MailEvent.Failed => "Fehlgeschlagen",
        MailEvent.Refused => "Abgewiesen",
        _ => e,
    };

    void ApplyLogFilter()
    {
        if (LogGrid is null) return;
        var f = LogFilter?.Text.Trim() ?? "";
        LogGrid.ItemsSource = f.Length == 0 ? _logRows : _logRows.Where(r =>
            $"{r.Event} {r.Client} {r.From} {r.To} {r.Detail}".Contains(f, StringComparison.OrdinalIgnoreCase)).ToList();
    }

    void LogDate_Changed(object? sender, SelectionChangedEventArgs e) => LoadLog();
    void LogKind_Changed(object sender, SelectionChangedEventArgs e) => LoadLog();
    void LogFilter_Changed(object sender, TextChangedEventArgs e) => ApplyLogFilter();
    void RefreshLog_Click(object sender, RoutedEventArgs e) => LoadLog();

    // ------------------------------------------------------------------ management

    async void LeaveServer_Click(object sender, RoutedEventArgs e) => await RunBusyAsync(async () =>
    {
        if (MessageBox.Show(this, "Vom Verwaltungsserver abmelden? Der Proxy läuft danach eigenständig weiter.", Title, MessageBoxButton.YesNo) != MessageBoxResult.Yes) return;
        var c = ConfigStore.Load();
        c.Management.ServerUrl = "";
        _config = ConfigStore.Save(c, $"Oberfläche ({Environment.UserName})");
        await ManagementClient.UnregisterAsync(CancellationToken.None);
        LoadConfig();
    });
}
