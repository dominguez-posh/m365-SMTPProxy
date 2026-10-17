using System.Net;
using System.Net.Sockets;
using SmtpProxy.Core.Config;

namespace SmtpProxy.Core.Smtp;

public sealed record IncomingMessage(
    string From, IReadOnlyList<string> Recipients, byte[] Data, IPAddress ClientIp, string? User, string Helo);

/// <summary>Receives accepted messages (queue) and refused attempts (log).</summary>
public interface IMessageSink
{
    /// <summary>Stores the message durably and returns its queue id. Throws if it cannot be stored.</summary>
    Task<string> AcceptAsync(IncomingMessage message, CancellationToken ct);
    void Refused(IPAddress clientIp, string? user, string? from, IReadOnlyList<string> recipients, string reason);
}

/// <summary>SMTP listener. Restarts itself when address or port change in the configuration.</summary>
public sealed class SmtpServer(Func<ProxyConfig> config, IMessageSink sink, Action<string> log) : IAsyncDisposable
{
    TcpListener? _listener;
    CancellationTokenSource? _cts;
    Task? _loop;
    int _active;
    public string? ListeningOn { get; private set; }
    public string? LastError { get; private set; }
    public int ActiveSessions => _active;

    public const int MaxSessions = 200;

    public async Task StartAsync()
    {
        await StopAsync();
        var c = config().Smtp;
        if (!c.Enabled) { ListeningOn = null; LastError = null; return; }
        try
        {
            var ip = IPAddress.Parse(c.ListenAddress);
            var l = new TcpListener(ip, c.Port);
            if (ip.Equals(IPAddress.IPv6Any)) l.Server.DualMode = true;
            l.Start(100);
            _listener = l;
            _cts = new CancellationTokenSource();
            ListeningOn = $"{c.ListenAddress}:{c.Port}";
            LastError = null;
            _loop = AcceptLoopAsync(l, _cts.Token);
            log($"SMTP lauscht auf {ListeningOn}");
        }
        catch (Exception ex)
        {
            ListeningOn = null;
            LastError = $"Port {c.Port} auf {c.ListenAddress} nicht verfügbar: {ex.Message}";
            log(LastError);
        }
    }

    public async Task StopAsync()
    {
        if (_listener is null) return;
        _cts!.Cancel();
        _listener.Stop();
        try { if (_loop is not null) await _loop; } catch { }
        _listener = null;
        ListeningOn = null;
    }

    async Task AcceptLoopAsync(TcpListener l, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TcpClient client;
            try { client = await l.AcceptTcpClientAsync(ct); }
            catch (OperationCanceledException) { break; }
            catch (ObjectDisposedException) { break; }
            catch (SocketException ex) { log($"Annahme fehlgeschlagen: {ex.Message}"); continue; }

            if (Interlocked.Increment(ref _active) > MaxSessions)
            {
                Interlocked.Decrement(ref _active);
                _ = RefuseAsync(client, "421 4.3.2 Too many connections, try again later");
                continue;
            }
            _ = Task.Run(async () =>
            {
                try
                {
                    using (client) await new SmtpSession(client, config(), sink).RunAsync(ct);
                }
                catch (Exception ex) when (ex is IOException or SocketException or OperationCanceledException) { }
                catch (Exception ex) { log($"SMTP-Sitzung abgebrochen: {ex.Message}"); }
                finally { Interlocked.Decrement(ref _active); }
            }, ct);
        }
    }

    static async Task RefuseAsync(TcpClient client, string reply)
    {
        using (client)
        {
            try { await client.GetStream().WriteAsync(System.Text.Encoding.ASCII.GetBytes(reply + "\r\n")); } catch { }
        }
    }

    public async ValueTask DisposeAsync() => await StopAsync();
}
