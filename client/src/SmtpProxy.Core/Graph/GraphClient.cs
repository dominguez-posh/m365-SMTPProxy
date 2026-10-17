using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SmtpProxy.Core.Graph;

public sealed class GraphException(HttpStatusCode status, string code, string message, TimeSpan? retryAfter = null)
    : Exception(message)
{
    public HttpStatusCode Status { get; } = status;
    public string Code { get; } = code;
    public TimeSpan? RetryAfter { get; } = retryAfter;

    /// <summary>Worth another attempt later (throttling, outages, network).</summary>
    public bool IsTransient =>
        Status is HttpStatusCode.TooManyRequests or HttpStatusCode.RequestTimeout or HttpStatusCode.Unauthorized
        || (int)Status >= 500;
}

/// <summary>
/// Microsoft Graph with a bearer token. App-only tokens come from <see cref="CertificateTokenSource"/>,
/// delegated tokens (admin during setup) are passed in directly.
/// </summary>
public sealed class GraphClient(Func<CancellationToken, Task<string>> token)
{
    public const string Root = "https://graph.microsoft.com/v1.0";
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(5) };

    public static GraphClient WithToken(string accessToken) => new(_ => Task.FromResult(accessToken));

    public Task<JsonNode?> GetAsync(string path, CancellationToken ct = default) => SendAsync(HttpMethod.Get, path, null, ct);
    public Task<JsonNode?> PostAsync(string path, object? body, CancellationToken ct = default) => SendAsync(HttpMethod.Post, path, body, ct);
    public Task<JsonNode?> PatchAsync(string path, object? body, CancellationToken ct = default) => SendAsync(HttpMethod.Patch, path, body, ct);
    public Task<JsonNode?> DeleteAsync(string path, CancellationToken ct = default) => SendAsync(HttpMethod.Delete, path, null, ct);

    /// <summary>All pages of a collection.</summary>
    public async Task<List<JsonNode>> GetAllAsync(string path, CancellationToken ct = default)
    {
        var list = new List<JsonNode>();
        string? next = path;
        while (next is not null)
        {
            var page = await GetAsync(next, ct);
            foreach (var v in page?["value"]?.AsArray() ?? []) if (v is not null) list.Add(v);
            next = page?["@odata.nextLink"]?.GetValue<string>();
        }
        return list;
    }

    public async Task<JsonNode?> SendAsync(HttpMethod method, string path, object? body, CancellationToken ct = default)
    {
        HttpContent? content = body switch
        {
            null => null,
            HttpContent c => c,
            _ => new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
        };
        return await SendRawAsync(method, path.StartsWith("https://") ? path : Root + path, content, ct);
    }

    async Task<JsonNode?> SendRawAsync(HttpMethod method, string url, HttpContent? content, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(method, url) { Content = content };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await token(ct));
        HttpResponseMessage res;
        try { res = await Http.SendAsync(req, ct); }
        catch (HttpRequestException ex) { throw new GraphException(HttpStatusCode.ServiceUnavailable, "network", $"Microsoft Graph nicht erreichbar: {ex.Message}"); }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested) { throw new GraphException(HttpStatusCode.RequestTimeout, "timeout", "Zeitüberschreitung bei Microsoft Graph"); }
        using (res)
        {
            var text = await res.Content.ReadAsStringAsync(ct);
            if (res.IsSuccessStatusCode) return text.Length == 0 ? null : JsonNode.Parse(text);
            string code = "", message = text;
            try
            {
                var err = JsonNode.Parse(text)?["error"];
                code = err?["code"]?.GetValue<string>() ?? "";
                message = err?["message"]?.GetValue<string>() ?? text;
            }
            catch (JsonException) { }
            throw new GraphException(res.StatusCode, code, $"{(int)res.StatusCode} {code}: {message}".Trim(), res.Headers.RetryAfter?.Delta);
        }
    }

    /// <summary>Upload of one chunk to an upload session (pre-authenticated URL, no bearer token).</summary>
    public static async Task PutChunkAsync(string uploadUrl, byte[] data, int offset, int count, long total, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Put, uploadUrl) { Content = new ByteArrayContent(data, offset, count) };
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        req.Content.Headers.ContentRange = new ContentRangeHeaderValue(offset, offset + count - 1, total);
        using var res = await Http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
            throw new GraphException(res.StatusCode, "upload", $"Anhang-Upload fehlgeschlagen: {(int)res.StatusCode} {await res.Content.ReadAsStringAsync(ct)}");
    }
}

/// <summary>App-only token with certificate (client assertion, RFC 7523), cached until shortly before expiry.</summary>
public sealed class CertificateTokenSource(string tenantId, string clientId, X509Certificate2 certificate,
    string scope = "https://graph.microsoft.com/.default")
{
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(60) };
    readonly SemaphoreSlim _gate = new(1, 1);
    string? _token;
    DateTimeOffset _expires;

    public string TenantId => tenantId;
    public string ClientId => clientId;
    public string Thumbprint => certificate.Thumbprint;

    public async Task<string> GetAsync(CancellationToken ct)
    {
        if (_token is not null && DateTimeOffset.UtcNow < _expires) return _token;
        await _gate.WaitAsync(ct);
        try
        {
            if (_token is not null && DateTimeOffset.UtcNow < _expires) return _token;
            var endpoint = $"https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token";
            var form = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["client_id"] = clientId,
                ["scope"] = scope,
                ["grant_type"] = "client_credentials",
                ["client_assertion_type"] = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
                ["client_assertion"] = Assertion(endpoint),
            });
            HttpResponseMessage res;
            try { res = await Http.PostAsync(endpoint, form, ct); }
            catch (HttpRequestException ex) { throw new GraphException(HttpStatusCode.ServiceUnavailable, "network", $"Anmeldedienst nicht erreichbar: {ex.Message}"); }
            using (res)
            {
                var json = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct));
                if (!res.IsSuccessStatusCode)
                {
                    var desc = json?["error_description"]?.GetValue<string>()?.Split('\n')[0] ?? res.StatusCode.ToString();
                    // invalid_client etc. do not heal by themselves, but a new app may still be replicating: treat as transient
                    throw new GraphException(HttpStatusCode.Unauthorized, json?["error"]?.GetValue<string>() ?? "token", $"Anmeldung der App fehlgeschlagen: {desc}");
                }
                _token = json!["access_token"]!.GetValue<string>();
                _expires = DateTimeOffset.UtcNow.AddSeconds(json["expires_in"]!.GetValue<int>() - 300);
                return _token;
            }
        }
        finally { _gate.Release(); }
    }

    public void Invalidate() => _token = null;

    string Assertion(string audience)
    {
        static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var header = JsonSerializer.Serialize(new Dictionary<string, string>
        {
            ["alg"] = "PS256",
            ["typ"] = "JWT",
            ["x5t#S256"] = B64(certificate.GetCertHash(HashAlgorithmName.SHA256)),
        });
        var payload = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["aud"] = audience,
            ["iss"] = clientId,
            ["sub"] = clientId,
            ["jti"] = Guid.NewGuid().ToString(),
            ["nbf"] = now - 60,
            ["iat"] = now,
            ["exp"] = now + 600,
        });
        var unsigned = $"{B64(Encoding.UTF8.GetBytes(header))}.{B64(Encoding.UTF8.GetBytes(payload))}";
        using var rsa = certificate.GetRSAPrivateKey() ?? throw new InvalidOperationException("Kein Zugriff auf den privaten Schlüssel des Zertifikats.");
        var sig = rsa.SignData(Encoding.ASCII.GetBytes(unsigned), HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
        return $"{unsigned}.{B64(sig)}";
    }
}
