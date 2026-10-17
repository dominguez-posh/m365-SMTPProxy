using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace SmtpProxy.Core.M365;

public sealed record DelegatedToken(string AccessToken, string TenantId, string User);

/// <summary>
/// Interactive admin sign-in in the system browser: authorization code flow with PKCE and loopback redirect
/// (RFC 8252), public client "Microsoft Graph Command Line Tools" (same flow as hrdnr / Connect-MgGraph without WAM).
/// Exchange Online needs its own first-party client (the one of the ExchangeOnlineManagement module); that second
/// request runs with prompt=none in the same browser session, so the administrator signs in only once.
/// No device code flow.
/// </summary>
public static class BrowserLogin
{
    public const string GraphCliClientId = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
    /// <summary>"Microsoft Exchange REST API Based Powershell", the client of Connect-ExchangeOnline.</summary>
    public const string ExchangeClientId = "fb78d390-0c51-40cd-8e17-fdbfab77341b";
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(60) };

    public static Task<DelegatedToken> SignInAsync(IEnumerable<string> graphScopes, Action<string> showUrl, CancellationToken ct) =>
        SignInAsync(GraphCliClientId, string.Join(' ', graphScopes.Select(s => "https://graph.microsoft.com/" + s)), "select_account", null, showUrl, ct);

    /// <summary>
    /// Exchange Online token of the administrator who just signed in: first silently in the existing browser session,
    /// with a normal sign-in only if the browser asks for one.
    /// </summary>
    public static async Task<DelegatedToken> SignInExchangeAsync(string user, Action<string> showUrl, CancellationToken ct)
    {
        try { return await SignInAsync(ExchangeClientId, ExchangeAdmin.Scope, "none", user, showUrl, ct); }
        catch (InteractionRequiredException)
        {
            return await SignInAsync(ExchangeClientId, ExchangeAdmin.Scope, "select_account", user, showUrl, ct);
        }
    }

    sealed class InteractionRequiredException(string message) : Exception(message);

    static async Task<DelegatedToken> SignInAsync(string clientId, string resourceScopes, string prompt, string? loginHint, Action<string> showUrl, CancellationToken ct)
    {
        const string authority = "https://login.microsoftonline.com/organizations";
        static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var verifier = B64(RandomNumberGenerator.GetBytes(32));
        var challenge = B64(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        var state = B64(RandomNumberGenerator.GetBytes(16));
        var scope = $"{resourceScopes} openid profile";

        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        Dictionary<string, string> p = [];
        string redirect;
        try
        {
            redirect = $"http://localhost:{((IPEndPoint)listener.LocalEndpoint).Port}";
            var q = new Dictionary<string, string>
            {
                ["client_id"] = clientId, ["response_type"] = "code", ["redirect_uri"] = redirect,
                ["response_mode"] = "query", ["scope"] = scope, ["state"] = state, ["code_challenge"] = challenge,
                ["code_challenge_method"] = "S256", ["prompt"] = prompt,
            };
            if (loginHint is { Length: > 0 }) q["login_hint"] = loginHint;
            var url = $"{authority}/oauth2/v2.0/authorize?" + string.Join('&', q.Select(kv => $"{kv.Key}={Uri.EscapeDataString(kv.Value)}"));
            showUrl(url);
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromMinutes(5));
            // browsers open speculative connections and ask for /favicon.ico: wait for the one with code or error
            while (!p.ContainsKey("code") && !p.ContainsKey("error"))
            {
                using var client = await listener.AcceptTcpClientAsync(timeout.Token);
                client.ReceiveTimeout = 5000;
                var stream = client.GetStream();
                string? requestLine;
                try { requestLine = new StreamReader(stream, Encoding.ASCII, false, 8192, leaveOpen: true).ReadLine(); }
                catch (IOException) { continue; }
                var m = System.Text.RegularExpressions.Regex.Match(requestLine ?? "", @"^GET [^?\s]*\?(\S*) HTTP");
                if (!m.Success) continue;
                foreach (var pair in m.Groups[1].Value.Split('&'))
                {
                    var kv = pair.Split('=', 2);
                    if (kv.Length == 2) p[kv[0]] = Uri.UnescapeDataString(kv[1].Replace('+', ' '));
                }
                if (!p.ContainsKey("code") && !p.ContainsKey("error")) continue;
                var ok = p.ContainsKey("code") && p.GetValueOrDefault("state") == state;
                var text = ok
                    ? "Anmeldung abgeschlossen. Dieses Fenster kann geschlossen werden; die Einrichtung läuft im M365 SMTP Proxy weiter."
                    : "Anmeldung fehlgeschlagen. Details im M365 SMTP Proxy.";
                var body = Encoding.UTF8.GetBytes($"<!doctype html><meta charset=utf-8><title>M365 SMTP Proxy</title><p style='font:16px Segoe UI,sans-serif;margin:40px'>{text}</p>");
                var head = Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(head, ct);
                await stream.WriteAsync(body, ct);
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException("Die Anmeldung wurde nicht innerhalb von 5 Minuten abgeschlossen.");
        }
        finally { listener.Stop(); }

        if (prompt == "none" && p.GetValueOrDefault("error") is "interaction_required" or "login_required" or "consent_required" or "account_selection_required")
            throw new InteractionRequiredException(p["error"]);
        if (p.TryGetValue("error", out var error)) throw new InvalidOperationException($"Anmeldung fehlgeschlagen: {error} {p.GetValueOrDefault("error_description")}");
        if (p.GetValueOrDefault("state") != state) throw new InvalidOperationException("Anmeldung abgelehnt: ungültiger state-Wert.");

        var res = await Http.PostAsync($"{authority}/oauth2/v2.0/token", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = clientId, ["grant_type"] = "authorization_code", ["code"] = p["code"],
            ["redirect_uri"] = redirect, ["code_verifier"] = verifier, ["scope"] = scope,
        }), ct);
        var json = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct));
        if (!res.IsSuccessStatusCode)
            throw new InvalidOperationException($"Token konnte nicht abgerufen werden: {json?["error_description"]?.GetValue<string>()?.Split('\n')[0]}");

        var access = json!["access_token"]!.GetValue<string>();
        var claims = Claims(access);
        return new DelegatedToken(access, claims?["tid"]?.GetValue<string>() ?? "",
            claims?["upn"]?.GetValue<string>() ?? claims?["unique_name"]?.GetValue<string>() ?? "");
    }

    static JsonNode? Claims(string jwt)
    {
        var parts = jwt.Split('.');
        if (parts.Length < 2) return null;
        var s = parts[1].Replace('-', '+').Replace('_', '/');
        s = s.PadRight(s.Length + (4 - s.Length % 4) % 4, '=');
        try { return JsonNode.Parse(Convert.FromBase64String(s)); } catch { return null; }
    }
}
