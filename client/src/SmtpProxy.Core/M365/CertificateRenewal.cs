using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using SmtpProxy.Core.Config;
using SmtpProxy.Core.Graph;

namespace SmtpProxy.Core.M365;

/// <summary>
/// The service renews the certificate of its app without an administrator: new key in the machine store, added to
/// the app registration with addKey (proof of possession signed with the current certificate; the app owns itself
/// and has Application.ReadWrite.OwnedBy), checked by a sign-in, then the old key is removed.
/// </summary>
public static class CertificateRenewal
{
    public static readonly TimeSpan Before = TimeSpan.FromDays(60);

    public static bool Due(M365Connection c) =>
        c.IsConnected && c.CertificateExpires is { } e && e - DateTimeOffset.UtcNow < Before;

    /// <summary>Returns the connection with the new certificate; the caller saves it and deletes the old certificate.</summary>
    public static async Task<M365Connection> RenewAsync(M365Connection c, Action<string> log, CancellationToken ct)
    {
        var current = Certificates.Find(c.CertificateThumbprint) ?? throw new InvalidOperationException("Aktuelles Zertifikat nicht gefunden.");
        var graph = new GraphClient(new CertificateTokenSource(c.TenantId, c.ClientId, current).GetAsync);
        var app = await graph.GetAsync($"/applications/{c.AppObjectId}?$select=keyCredentials", ct);
        var currentId = Convert.ToBase64String(Convert.FromHexString(current.Thumbprint));
        var oldKeys = (app?["keyCredentials"]?.AsArray() ?? [])
            .Where(k => k?["customKeyIdentifier"]?.GetValue<string>() == currentId)
            .Select(k => k!["keyId"]!.GetValue<string>()).ToList();

        var fresh = Certificates.Create($"{Paths.DisplayName} {Environment.MachineName}");
        try
        {
            log($"Neues Zertifikat {fresh.Thumbprint} wird in der App hinterlegt …");
            await graph.PostAsync($"/applications/{c.AppObjectId}/addKey", new JsonObject
            {
                ["keyCredential"] = new JsonObject
                {
                    ["type"] = "AsymmetricX509Cert",
                    ["usage"] = "Verify",
                    ["key"] = Convert.ToBase64String(fresh.RawData),
                    ["displayName"] = fresh.Subject,
                },
                ["passwordCredential"] = null,
                ["proof"] = Proof(c.AppObjectId, current),
            }, ct);

            // the new key takes a moment until the sign-in accepts it
            var deadline = DateTime.UtcNow.AddMinutes(5);
            while (true)
            {
                try
                {
                    await new GraphClient(new CertificateTokenSource(c.TenantId, c.ClientId, fresh).GetAsync).GetAsync("/domains?$select=id&$top=1", ct);
                    break;
                }
                catch (GraphException) when (DateTime.UtcNow < deadline) { await Task.Delay(TimeSpan.FromSeconds(15), ct); }
            }
        }
        catch
        {
            Certificates.Delete(fresh.Thumbprint);
            throw;
        }

        foreach (var keyId in oldKeys)
        {
            try
            {
                await new GraphClient(new CertificateTokenSource(c.TenantId, c.ClientId, fresh).GetAsync)
                    .PostAsync($"/applications/{c.AppObjectId}/removeKey", new JsonObject { ["keyId"] = keyId, ["proof"] = Proof(c.AppObjectId, fresh) }, ct);
            }
            catch (GraphException ex) { log($"Altes Zertifikat konnte nicht aus der App entfernt werden: {ex.Message}"); }
        }

        var next = JsonSerializer.Deserialize<M365Connection>(JsonSerializer.Serialize(c, JsonFile.Options), JsonFile.Options)!;
        next.CertificateThumbprint = fresh.Thumbprint;
        next.CertificateExpires = fresh.NotAfter.ToUniversalTime();
        next.CertificateRenewedAt = DateTimeOffset.UtcNow;
        return next;
    }

    /// <summary>Proof of possession for addKey/removeKey: JWT signed with a key the app already has.</summary>
    static string Proof(string appObjectId, X509Certificate2 cert)
    {
        static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var header = JsonSerializer.Serialize(new Dictionary<string, string> { ["alg"] = "RS256", ["typ"] = "JWT", ["x5t"] = B64(cert.GetCertHash()) });
        var payload = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["aud"] = "00000002-0000-0000-c000-000000000000",
            ["iss"] = appObjectId,
            ["nbf"] = now - 60,
            ["exp"] = now + 600,
        });
        var unsigned = $"{B64(Encoding.UTF8.GetBytes(header))}.{B64(Encoding.UTF8.GetBytes(payload))}";
        using var rsa = cert.GetRSAPrivateKey() ?? throw new InvalidOperationException("Kein Zugriff auf den privaten Schlüssel des Zertifikats.");
        return $"{unsigned}.{B64(rsa.SignData(Encoding.ASCII.GetBytes(unsigned), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1))}";
    }
}
