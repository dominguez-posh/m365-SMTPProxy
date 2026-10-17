using System.Net;
using System.Net.Sockets;
using System.Text;
using MimeKit;
using SmtpProxy.Core.Config;
using SmtpProxy.Core.Graph;
using SmtpProxy.Core.Smtp;

namespace SmtpProxy.Tests;

sealed class FakeSink : IMessageSink
{
    public readonly List<IncomingMessage> Accepted = [];
    public readonly List<string> Refusals = [];
    public Task<string> AcceptAsync(IncomingMessage message, CancellationToken ct)
    {
        Accepted.Add(message);
        return Task.FromResult("TEST1");
    }
    public void Refused(IPAddress clientIp, string? user, string? from, IReadOnlyList<string> recipients, string reason) => Refusals.Add(reason);
}

public class SmtpTests : IAsyncLifetime
{
    readonly FakeSink _sink = new();
    readonly ProxyConfig _config = new()
    {
        Smtp = { ListenAddress = "127.0.0.1", Port = 0, MaxMessageSizeMb = 1 },
        M365 = { TenantId = "t", ClientId = "c", CertificateThumbprint = "x", Domains = ["contoso.com"] },
        Users = [new SmtpUser { Name = "scanner", PasswordHash = PasswordHasher.Hash("geheim"), AllowedSenders = ["scanner@contoso.com"] }],
    };
    SmtpServer _server = null!;
    int _port;

    public async Task InitializeAsync()
    {
        // pick a free port
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        _port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        _config.Smtp.Port = _port;
        _server = new SmtpServer(() => _config, _sink, _ => { });
        await _server.StartAsync();
        Assert.NotNull(_server.ListeningOn);
    }

    public async Task DisposeAsync() => await _server.StopAsync();

    async Task<(StreamReader r, StreamWriter w, TcpClient c)> ConnectAsync()
    {
        var c = new TcpClient();
        await c.ConnectAsync(IPAddress.Loopback, _port);
        var s = c.GetStream();
        var r = new StreamReader(s, Encoding.ASCII);
        var w = new StreamWriter(s, Encoding.ASCII) { NewLine = "\r\n", AutoFlush = true };
        Assert.StartsWith("220", await r.ReadLineAsync());
        return (r, w, c);
    }

    static async Task<string> SendAsync(StreamReader r, StreamWriter w, string line)
    {
        await w.WriteLineAsync(line);
        var reply = await r.ReadLineAsync() ?? "";
        while (reply.Length > 3 && reply[3] == '-') reply = await r.ReadLineAsync() ?? "";
        return reply;
    }

    [Fact]
    public async Task Anonymous_from_loopback_is_queued_with_dot_unstuffing()
    {
        var (r, w, c) = await ConnectAsync();
        using (c)
        {
            Assert.StartsWith("250", await SendAsync(r, w, "EHLO printer"));
            Assert.StartsWith("250", await SendAsync(r, w, "MAIL FROM:<printer@contoso.com> SIZE=100"));
            Assert.StartsWith("250", await SendAsync(r, w, "RCPT TO:<a@fabrikam.com>"));
            Assert.StartsWith("250", await SendAsync(r, w, "RCPT TO:<b@fabrikam.com>"));
            Assert.StartsWith("354", await SendAsync(r, w, "DATA"));
            await w.WriteAsync("Subject: Test\r\n\r\nZeile 1\r\n..Punkt\r\n");
            Assert.StartsWith("250", await SendAsync(r, w, "."));
            Assert.StartsWith("221", await SendAsync(r, w, "QUIT"));
        }
        var m = Assert.Single(_sink.Accepted);
        Assert.Equal("printer@contoso.com", m.From);
        Assert.Equal(["a@fabrikam.com", "b@fabrikam.com"], m.Recipients);
        var text = Encoding.ASCII.GetString(m.Data);
        Assert.StartsWith("Received: from printer", text);
        Assert.EndsWith("Subject: Test\r\n\r\nZeile 1\r\n.Punkt\r\n", text);
    }

    [Fact]
    public async Task Foreign_domain_is_refused()
    {
        var (r, w, c) = await ConnectAsync();
        using (c)
        {
            await SendAsync(r, w, "EHLO x");
            Assert.StartsWith("550", await SendAsync(r, w, "MAIL FROM:<x@gmail.com>"));
        }
        Assert.Contains(_sink.Refusals, x => x.Contains("gmail.com"));
    }

    [Fact]
    public async Task Auth_login_and_user_sender_restriction()
    {
        _config.Smtp.AnonymousNetworks = [];
        var (r, w, c) = await ConnectAsync();
        using (c)
        {
            await SendAsync(r, w, "EHLO scanner");
            Assert.StartsWith("530", await SendAsync(r, w, "MAIL FROM:<scanner@contoso.com>"));
            Assert.StartsWith("334", await SendAsync(r, w, "AUTH LOGIN"));
            Assert.StartsWith("334", await SendAsync(r, w, Convert.ToBase64String(Encoding.UTF8.GetBytes("scanner"))));
            Assert.StartsWith("235", await SendAsync(r, w, Convert.ToBase64String(Encoding.UTF8.GetBytes("geheim"))));
            Assert.StartsWith("550", await SendAsync(r, w, "MAIL FROM:<boss@contoso.com>"));
            Assert.StartsWith("250", await SendAsync(r, w, "MAIL FROM:<scanner@contoso.com>"));
        }
    }

    [Fact]
    public async Task Auth_plain_wrong_password_is_refused()
    {
        var (r, w, c) = await ConnectAsync();
        using (c)
        {
            await SendAsync(r, w, "EHLO scanner");
            var plain = Convert.ToBase64String(Encoding.UTF8.GetBytes("\0scanner\0falsch"));
            Assert.StartsWith("535", await SendAsync(r, w, "AUTH PLAIN " + plain));
        }
    }

    [Fact]
    public async Task Too_large_message_is_refused()
    {
        var (r, w, c) = await ConnectAsync();
        using (c)
        {
            await SendAsync(r, w, "EHLO x");
            await SendAsync(r, w, "MAIL FROM:<printer@contoso.com>");
            await SendAsync(r, w, "RCPT TO:<a@fabrikam.com>");
            Assert.StartsWith("354", await SendAsync(r, w, "DATA"));
            var line = new string('x', 998);
            for (var i = 0; i < 1200; i++) await w.WriteAsync(line + "\r\n");
            Assert.StartsWith("552", await SendAsync(r, w, "."));
            Assert.StartsWith("250", await SendAsync(r, w, "NOOP"));
        }
        Assert.Empty(_sink.Accepted);
    }
}

public class PolicyTests
{
    [Theory]
    [InlineData("10.1.2.3", "10.0.0.0/8", true)]
    [InlineData("10.1.2.3", "192.168.0.0/16", false)]
    [InlineData("192.168.1.5", "192.168.1.5", true)]
    [InlineData("::ffff:10.0.0.1", "10.0.0.0/24", true)]
    public void Networks(string ip, string net, bool expected) =>
        Assert.Equal(expected, SmtpPolicy.InNetworks(IPAddress.Parse(ip), [net]));

    [Fact]
    public void Sender_lists()
    {
        var c = new ProxyConfig { M365 = { Domains = ["contoso.com", "fabrikam.com"] } };
        Assert.Null(SmtpPolicy.CheckSender(c, "a@contoso.com", null));
        c.Senders.AllowedDomains = ["fabrikam.com"];
        c.Senders.AllowedAddresses = ["scan@contoso.com"];
        Assert.NotNull(SmtpPolicy.CheckSender(c, "a@contoso.com", null));
        Assert.Null(SmtpPolicy.CheckSender(c, "SCAN@contoso.com", null));
        Assert.Null(SmtpPolicy.CheckSender(c, "x@fabrikam.com", null));
        Assert.NotNull(SmtpPolicy.CheckSender(c, "x@other.com", null));
    }

    [Fact]
    public void Password_hash_roundtrip()
    {
        var h = PasswordHasher.Hash("Pa55wort!");
        Assert.True(PasswordHasher.Verify("Pa55wort!", h));
        Assert.False(PasswordHasher.Verify("pa55wort!", h));
    }
}

public class MailerTests
{
    [Fact]
    public void Recipients_follow_the_envelope()
    {
        var m = new MimeMessage();
        m.From.Add(MailboxAddress.Parse("printer@contoso.com"));
        m.To.Add(MailboxAddress.Parse("a@fabrikam.com"));
        m.Cc.Add(MailboxAddress.Parse("notinenvelope@fabrikam.com"));
        GraphMailer.AlignRecipients(m, ["a@fabrikam.com", "hidden@fabrikam.com"]);
        Assert.Equal(["a@fabrikam.com"], m.To.Mailboxes.Select(x => x.Address));
        Assert.Empty(m.Cc);
        Assert.Equal(["hidden@fabrikam.com"], m.Bcc.Mailboxes.Select(x => x.Address));
    }
}
