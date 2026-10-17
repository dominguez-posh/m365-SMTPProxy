using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using SmtpProxy.Core.Config;

namespace SmtpProxy.Core.Smtp;

/// <summary>
/// One SMTP connection (RFC 5321, ESMTP with SIZE, 8BITMIME, PIPELINING, AUTH PLAIN/LOGIN).
/// Without TLS for now; STARTTLS follows later.
/// </summary>
internal sealed partial class SmtpSession(TcpClient client, ProxyConfig config, IMessageSink sink)
{
    static readonly TimeSpan CommandTimeout = TimeSpan.FromMinutes(5);
    static readonly TimeSpan DataTimeout = TimeSpan.FromMinutes(10);
    const int MaxAuthFailures = 3;
    const int MaxErrors = 10;

    readonly NetworkStream _stream = client.GetStream();
    readonly IPAddress _ip = ((IPEndPoint)client.Client.RemoteEndPoint!).Address is var a && a.IsIPv4MappedToIPv6 ? a.MapToIPv4() : a;
    string _helo = "";
    SmtpUser? _user;
    string? _from;
    readonly List<string> _rcpt = [];
    int _authFailures, _errors;

    long MaxBytes => (long)config.Smtp.MaxMessageSizeMb * 1024 * 1024;
    bool AuthOffered => config.Smtp.AllowAuthWithoutTls && config.Users.Any(u => u.Enabled);

    public async Task RunAsync(CancellationToken serviceToken)
    {
        var reader = new LineReader(_stream);
        var host = config.Smtp.HostName;

        if (!SmtpPolicy.MayConnect(config, _ip))
        {
            sink.Refused(_ip, null, null, [], "Verbindung aus nicht freigegebenem Netz");
            await ReplyAsync("554 5.7.1 Access denied", serviceToken);
            return;
        }
        await ReplyAsync($"220 {host} ESMTP M365 SMTP Proxy ready", serviceToken);

        while (true)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(serviceToken);
            timeout.CancelAfter(CommandTimeout);
            string? line;
            try { line = await reader.ReadLineAsync(4096, timeout.Token); }
            catch (SmtpLineTooLongException) { await ReplyAsync("500 5.5.2 Line too long", serviceToken); return; }
            catch (OperationCanceledException) when (!serviceToken.IsCancellationRequested)
            {
                await ReplyAsync("421 4.4.2 Timeout, closing connection", serviceToken);
                return;
            }
            if (line is null) return;

            var (verb, arg) = Split(line);
            switch (verb)
            {
                case "EHLO":
                    if (arg.Length == 0) { await ErrorAsync("501 5.5.4 Syntax: EHLO hostname", serviceToken); break; }
                    _helo = arg; Reset();
                    var ext = new List<string> { $"{host} Hello [{_ip}]", $"SIZE {MaxBytes}", "8BITMIME", "PIPELINING", "ENHANCEDSTATUSCODES" };
                    if (AuthOffered) ext.Add("AUTH PLAIN LOGIN");
                    ext.Add("HELP");
                    for (var i = 0; i < ext.Count; i++)
                        await ReplyAsync($"250{(i < ext.Count - 1 ? "-" : " ")}{ext[i]}", serviceToken);
                    break;

                case "HELO":
                    if (arg.Length == 0) { await ErrorAsync("501 5.5.4 Syntax: HELO hostname", serviceToken); break; }
                    _helo = arg; Reset();
                    await ReplyAsync($"250 {host} Hello [{_ip}]", serviceToken);
                    break;

                case "AUTH":
                    if (!await AuthAsync(reader, arg, serviceToken)) return;
                    break;

                case "MAIL":
                    await MailAsync(arg, serviceToken);
                    break;

                case "RCPT":
                    await RcptAsync(arg, serviceToken);
                    break;

                case "DATA":
                    if (_from is null) { await ErrorAsync("503 5.5.1 MAIL first", serviceToken); break; }
                    if (_rcpt.Count == 0) { await ErrorAsync("554 5.5.1 No valid recipients", serviceToken); break; }
                    await ReplyAsync("354 Start mail input; end with <CRLF>.<CRLF>", serviceToken);
                    if (!await DataAsync(reader, serviceToken)) return;
                    break;

                case "RSET":
                    Reset();
                    await ReplyAsync("250 2.0.0 OK", serviceToken);
                    break;

                case "NOOP":
                    await ReplyAsync("250 2.0.0 OK", serviceToken);
                    break;

                case "VRFY":
                    await ReplyAsync("252 2.5.0 Cannot verify user, but will accept message", serviceToken);
                    break;

                case "HELP":
                    await ReplyAsync("214 2.0.0 Commands: EHLO HELO AUTH MAIL RCPT DATA RSET NOOP QUIT", serviceToken);
                    break;

                case "STARTTLS":
                    await ErrorAsync("502 5.5.1 TLS not available", serviceToken);
                    break;

                case "QUIT":
                    await ReplyAsync("221 2.0.0 Bye", serviceToken);
                    return;

                default:
                    await ErrorAsync("500 5.5.2 Command not recognized", serviceToken);
                    break;
            }
            if (_errors >= MaxErrors)
            {
                await ReplyAsync("421 4.7.0 Too many errors, closing connection", serviceToken);
                return;
            }
        }
    }

    void Reset()
    {
        _from = null;
        _rcpt.Clear();
    }

    async Task<bool> AuthAsync(LineReader reader, string arg, CancellationToken ct)
    {
        if (!AuthOffered) { await ErrorAsync("502 5.5.1 AUTH not available", ct); return true; }
        if (_helo.Length == 0) { await ErrorAsync("503 5.5.1 EHLO first", ct); return true; }
        if (_user is not null) { await ErrorAsync("503 5.5.1 Already authenticated", ct); return true; }
        if (_from is not null) { await ErrorAsync("503 5.5.1 AUTH not allowed during a mail transaction", ct); return true; }

        var parts = arg.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
        var mech = parts.Length > 0 ? parts[0].ToUpperInvariant() : "";
        var initial = parts.Length > 1 ? parts[1] : null;
        string? user = null, password = null;

        if (mech == "PLAIN")
        {
            var resp = initial ?? await ChallengeAsync(reader, "", ct);
            if (resp is null) return false;
            if (resp == "*") { await ReplyAsync("501 5.7.0 Authentication cancelled", ct); return true; }
            var decoded = Decode(resp)?.Split('\0');
            if (decoded is { Length: 3 }) { user = decoded[1]; password = decoded[2]; }
        }
        else if (mech == "LOGIN")
        {
            var u = initial ?? await ChallengeAsync(reader, "VXNlcm5hbWU6", ct);
            if (u is null) return false;
            if (u == "*") { await ReplyAsync("501 5.7.0 Authentication cancelled", ct); return true; }
            var p = await ChallengeAsync(reader, "UGFzc3dvcmQ6", ct);
            if (p is null) return false;
            if (p == "*") { await ReplyAsync("501 5.7.0 Authentication cancelled", ct); return true; }
            user = Decode(u);
            password = Decode(p);
        }
        else
        {
            await ErrorAsync("504 5.5.4 Unrecognized authentication type", ct);
            return true;
        }

        if (user is null || password is null) { await ErrorAsync("501 5.5.2 Cannot decode response", ct); return true; }

        var ok = SmtpPolicy.Authenticate(config, user, password);
        if (ok is not null)
        {
            _user = ok;
            await ReplyAsync("235 2.7.0 Authentication successful", ct);
            return true;
        }
        _authFailures++;
        sink.Refused(_ip, user, null, [], "Anmeldung fehlgeschlagen");
        await Task.Delay(TimeSpan.FromSeconds(2 * _authFailures), ct);
        if (_authFailures >= MaxAuthFailures)
        {
            await ReplyAsync("421 4.7.0 Too many authentication failures", ct);
            return false;
        }
        await ReplyAsync("535 5.7.8 Authentication credentials invalid", ct);
        return true;
    }

    async Task<string?> ChallengeAsync(LineReader reader, string challenge, CancellationToken ct)
    {
        await ReplyAsync($"334 {challenge}".TrimEnd(), ct);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(CommandTimeout);
        return await reader.ReadLineAsync(4096, timeout.Token);
    }

    static string? Decode(string b64)
    {
        try { return Encoding.UTF8.GetString(Convert.FromBase64String(b64.Trim())); }
        catch (FormatException) { return null; }
    }

    async Task MailAsync(string arg, CancellationToken ct)
    {
        if (_helo.Length == 0) { await ErrorAsync("503 5.5.1 EHLO first", ct); return; }
        if (_from is not null) { await ErrorAsync("503 5.5.1 Nested MAIL command", ct); return; }
        var m = MailFromRegex().Match(arg);
        if (!m.Success) { await ErrorAsync("501 5.5.4 Syntax: MAIL FROM:<address>", ct); return; }
        var address = m.Groups[1].Value.Trim();
        var parameters = m.Groups[2].Value;

        var size = SizeRegex().Match(parameters);
        if (size.Success && long.TryParse(size.Groups[1].Value, out var declared) && declared > MaxBytes)
        {
            await ErrorAsync($"552 5.3.4 Message size exceeds limit of {MaxBytes} bytes", ct);
            return;
        }
        if (_user is null && !SmtpPolicy.MaySendAnonymously(config, _ip))
        {
            sink.Refused(_ip, null, address, [], "Anonym aus nicht freigegebenem Netz");
            await ErrorAsync("530 5.7.0 Authentication required", ct);
            return;
        }
        if (address.Length == 0)
        {
            await ErrorAsync("550 5.7.1 Null sender not supported, a sender mailbox is required", ct);
            return;
        }
        if (!config.M365.IsConnected)
        {
            await ReplyAsync("451 4.3.0 Proxy not connected to Microsoft 365, try again later", ct);
            return;
        }
        var reason = SmtpPolicy.CheckSender(config, address, _user);
        if (reason is not null)
        {
            sink.Refused(_ip, _user?.Name, address, [], reason);
            await ErrorAsync($"550 5.7.1 Sender not allowed: {address}", ct);
            return;
        }
        _from = address;
        await ReplyAsync("250 2.1.0 Sender OK", ct);
    }

    async Task RcptAsync(string arg, CancellationToken ct)
    {
        if (_from is null) { await ErrorAsync("503 5.5.1 MAIL first", ct); return; }
        var m = RcptToRegex().Match(arg);
        if (!m.Success || !IsAddress(m.Groups[1].Value)) { await ErrorAsync("501 5.1.3 Syntax: RCPT TO:<address>", ct); return; }
        if (_rcpt.Count >= config.Smtp.MaxRecipients) { await ReplyAsync("452 4.5.3 Too many recipients", ct); return; }
        var address = m.Groups[1].Value.Trim();
        if (!_rcpt.Contains(address, StringComparer.OrdinalIgnoreCase)) _rcpt.Add(address);
        await ReplyAsync("250 2.1.5 Recipient OK", ct);
    }

    async Task<bool> DataAsync(LineReader reader, CancellationToken ct)
    {
        byte[]? data;
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            timeout.CancelAfter(DataTimeout);
            try { data = await reader.ReadDataAsync(MaxBytes, timeout.Token); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                await ReplyAsync("421 4.4.2 Timeout during DATA", ct);
                return false;
            }
        }
        if (data is null)
        {
            sink.Refused(_ip, _user?.Name, _from, _rcpt.ToList(), "Nachricht zu groß");
            Reset();
            await ReplyAsync($"552 5.3.4 Message size exceeds limit of {MaxBytes} bytes", ct);
            return true;
        }

        var received = Encoding.ASCII.GetBytes(
            $"Received: from {Sanitize(_helo)} ([{_ip}]){(_user is null ? "" : $"\r\n\t(authenticated as {Sanitize(_user.Name)})")}\r\n" +
            $"\tby {config.Smtp.HostName} (M365 SMTP Proxy) with {(_user is null ? "ESMTP" : "ESMTPA")};\r\n" +
            $"\t{MimeKit.Utils.DateUtils.FormatDate(DateTimeOffset.Now)}\r\n");
        var full = new byte[received.Length + data.Length];
        received.CopyTo(full, 0);
        data.CopyTo(full, received.Length);

        try
        {
            var id = await sink.AcceptAsync(new IncomingMessage(_from!, _rcpt.ToList(), full, _ip, _user?.Name, _helo), ct);
            await ReplyAsync($"250 2.0.0 OK queued as {id}", ct);
        }
        catch (Exception)
        {
            await ReplyAsync("451 4.3.0 Could not queue message, try again later", ct);
        }
        Reset();
        return true;
    }

    static string Sanitize(string s) => new(s.Where(ch => ch > 32 && ch < 127 && ch != '(' && ch != ')').Take(100).ToArray());

    static bool IsAddress(string s)
    {
        var at = s.LastIndexOf('@');
        return at > 0 && at < s.Length - 1 && !s.Any(char.IsWhiteSpace);
    }

    static (string verb, string arg) Split(string line)
    {
        var i = line.IndexOf(' ');
        return i < 0 ? (line.ToUpperInvariant(), "") : (line[..i].ToUpperInvariant(), line[(i + 1)..].Trim());
    }

    async Task ErrorAsync(string reply, CancellationToken ct)
    {
        _errors++;
        await ReplyAsync(reply, ct);
    }

    Task ReplyAsync(string reply, CancellationToken ct) =>
        _stream.WriteAsync(Encoding.ASCII.GetBytes(reply + "\r\n"), ct).AsTask();

    [GeneratedRegex(@"^FROM:\s*<([^>]*)>(.*)$", RegexOptions.IgnoreCase)]
    private static partial Regex MailFromRegex();

    [GeneratedRegex(@"^TO:\s*<([^>]+)>", RegexOptions.IgnoreCase)]
    private static partial Regex RcptToRegex();

    [GeneratedRegex(@"\bSIZE=(\d+)", RegexOptions.IgnoreCase)]
    private static partial Regex SizeRegex();
}
