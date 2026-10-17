using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace SmtpProxy.Core.Graph;

/// <summary>Certificate of the app registration in the machine store (LocalMachine\My), key not exportable.</summary>
public static class Certificates
{
    public static X509Certificate2? Find(string thumbprint)
    {
        if (string.IsNullOrWhiteSpace(thumbprint)) return null;
        using var store = new X509Store(StoreName.My, StoreLocation.LocalMachine);
        store.Open(OpenFlags.ReadOnly);
        var found = store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, validOnly: false);
        return found.Count > 0 ? found[0] : null;
    }

    /// <summary>Creates a self-signed certificate whose RSA key lives as a machine key in CNG and cannot be exported.</summary>
    public static X509Certificate2 Create(string subjectName, int years = 2)
    {
        var keyName = $"{Paths.ServiceName}-{Guid.NewGuid():N}";
        var p = new CngKeyCreationParameters
        {
            ExportPolicy = CngExportPolicies.None,
            KeyCreationOptions = CngKeyCreationOptions.MachineKey,
            KeyUsage = CngKeyUsages.AllUsages,
            Provider = CngProvider.MicrosoftSoftwareKeyStorageProvider,
        };
        p.Parameters.Add(new CngProperty("Length", BitConverter.GetBytes(3072), CngPropertyOptions.None));
        using var key = CngKey.Create(CngAlgorithm.Rsa, keyName, p);
        using var rsa = new RSACng(key);

        var req = new CertificateRequest($"CN={subjectName}", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        req.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, critical: true));
        req.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, false));
        var cert = req.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-10), DateTimeOffset.UtcNow.AddYears(years));
        cert.FriendlyName = $"{Paths.DisplayName} (Microsoft Graph)";

        using var store = new X509Store(StoreName.My, StoreLocation.LocalMachine);
        store.Open(OpenFlags.ReadWrite);
        store.Add(cert);
        return Find(cert.Thumbprint) ?? throw new InvalidOperationException("Zertifikat wurde nicht im Speicher gefunden.");
    }

    /// <summary>Removes the certificate and its key (after disconnecting or replacing it).</summary>
    public static void Delete(string thumbprint)
    {
        var cert = Find(thumbprint);
        if (cert is null) return;
        using var store = new X509Store(StoreName.My, StoreLocation.LocalMachine);
        store.Open(OpenFlags.ReadWrite);
        store.Remove(cert);
        try
        {
            if (cert.GetRSAPrivateKey() is RSACng rsa) rsa.Key.Delete();
        }
        catch (CryptographicException) { }
    }
}
