using System.Security.Cryptography;
using System.Text;

namespace SmtpProxy.Core.Management;

/// <summary>
/// Key pair the proxy signs every request to the management server with: EC P-256 as a machine key in CNG,
/// in the TPM if available, otherwise in software; never exportable.
/// Signature over "METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(body)" (IEEE P1363), as in hrdnr.
/// </summary>
public sealed class ClientIdentity : IDisposable
{
    public const string KeyName = "M365SmtpProxy-Management";

    /// <summary>Development only (SMTPPROXY_KEY_SCOPE=user): key in the user profile, no admin rights needed.</summary>
    static readonly bool UserScope = Environment.GetEnvironmentVariable("SMTPPROXY_KEY_SCOPE") == "user";
    static CngKeyOpenOptions OpenScope => UserScope ? CngKeyOpenOptions.None : CngKeyOpenOptions.MachineKey;
    static CngKeyCreationOptions CreateScope => UserScope ? CngKeyCreationOptions.None : CngKeyCreationOptions.MachineKey;
    readonly ECDsaCng _key;
    public string Storage { get; }

    ClientIdentity(CngKey key, string storage)
    {
        _key = new ECDsaCng(key);
        Storage = storage;
    }

    public static ClientIdentity OpenOrCreate()
    {
        foreach (var (provider, storage) in new[] { (new CngProvider("Microsoft Platform Crypto Provider"), "tpm"), (CngProvider.MicrosoftSoftwareKeyStorageProvider, "software") })
        {
            try
            {
                if (CngKey.Exists(KeyName, provider, OpenScope))
                    return new ClientIdentity(CngKey.Open(KeyName, provider, OpenScope), storage);
            }
            catch (CryptographicException) { }
        }
        foreach (var (provider, storage) in new[] { (new CngProvider("Microsoft Platform Crypto Provider"), "tpm"), (CngProvider.MicrosoftSoftwareKeyStorageProvider, "software") })
        {
            try
            {
                var key = CngKey.Create(CngAlgorithm.ECDsaP256, KeyName, new CngKeyCreationParameters
                {
                    Provider = provider,
                    KeyCreationOptions = CreateScope,
                    ExportPolicy = CngExportPolicies.None,
                    KeyUsage = CngKeyUsages.Signing,
                });
                return new ClientIdentity(key, storage);
            }
            catch (CryptographicException) when (storage == "tpm") { }
        }
        throw new CryptographicException("Schlüssel für den Verwaltungsserver konnte nicht erstellt werden.");
    }

    /// <summary>Deletes the key (leaving the management server; a new registration gets a new key).</summary>
    public static void Delete()
    {
        foreach (var provider in new[] { new CngProvider("Microsoft Platform Crypto Provider"), CngProvider.MicrosoftSoftwareKeyStorageProvider })
        {
            try
            {
                if (CngKey.Exists(KeyName, provider, OpenScope))
                    CngKey.Open(KeyName, provider, OpenScope).Delete();
            }
            catch (CryptographicException) { }
        }
    }

    /// <summary>Public key as SubjectPublicKeyInfo (DER, Base64).</summary>
    public string PublicKey => Convert.ToBase64String(_key.ExportSubjectPublicKeyInfo());

    public string Fingerprint => Convert.ToHexString(SHA256.HashData(_key.ExportSubjectPublicKeyInfo()))[..16].ToLowerInvariant();

    public string Authorization(string clientId, string method, string pathAndQuery, byte[] body)
    {
        var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
        var nonce = Convert.ToBase64String(RandomNumberGenerator.GetBytes(18)).Replace('+', '-').Replace('/', '_');
        var text = $"{method}\n{pathAndQuery}\n{ts}\n{nonce}\n{Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant()}";
        var sig = _key.SignData(Encoding.UTF8.GetBytes(text), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return $"SmtpProxySig {clientId}:{ts}:{nonce}:{Convert.ToBase64String(sig)}";
    }

    public void Dispose() => _key.Dispose();
}
