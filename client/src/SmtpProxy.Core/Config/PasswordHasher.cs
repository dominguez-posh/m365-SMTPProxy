using System.Security.Cryptography;

namespace SmtpProxy.Core.Config;

/// <summary>SMTP user passwords as PBKDF2-SHA256 hashes: pbkdf2$iterations$salt$hash.</summary>
public static class PasswordHasher
{
    const int Iterations = 210_000;

    public static string Hash(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, Iterations, HashAlgorithmName.SHA256, 32);
        return $"pbkdf2${Iterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    public static bool Verify(string password, string stored)
    {
        var parts = stored.Split('$');
        if (parts.Length != 4 || parts[0] != "pbkdf2" || !int.TryParse(parts[1], out var it)) return false;
        try
        {
            var salt = Convert.FromBase64String(parts[2]);
            var expected = Convert.FromBase64String(parts[3]);
            var got = Rfc2898DeriveBytes.Pbkdf2(password, salt, it, HashAlgorithmName.SHA256, expected.Length);
            return CryptographicOperations.FixedTimeEquals(got, expected);
        }
        catch (FormatException) { return false; }
    }

    /// <summary>Random password for new SMTP users (no ambiguous characters).</summary>
    public static string Generate(int length = 20) =>
        RandomNumberGenerator.GetString("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789", length);
}
