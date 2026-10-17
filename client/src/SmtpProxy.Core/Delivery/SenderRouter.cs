using System.Net;
using SmtpProxy.Core.Config;
using SmtpProxy.Core.Graph;

namespace SmtpProxy.Core.Delivery;

/// <summary>
/// Chooses the mailbox Graph sends from. Graph can only send from a mailbox (user or shared mailbox) or from an alias
/// of one; an alias is sent from its mailbox with the alias as From (needs SendFromAliasEnabled in Exchange).
/// </summary>
public static class SenderRouter
{
    /// <summary>Graph answer for "there is no mailbox with this address" (ErrorInvalidUser: "'x' is invalid").</summary>
    public static bool IsNoMailbox(GraphException ex) =>
        ex.Code is "ErrorInvalidUser" or "MailboxNotEnabledForRESTAPI" or "ErrorNonExistentMailbox" or "ResourceNotFound"
        || ex.Status == HttpStatusCode.NotFound;

    /// <summary>Mailbox of the address from the address list of the tenant; the address itself if it is not known.</summary>
    public static string MailboxOf(ProxyConfig c, string from) =>
        c.M365.Addresses.FirstOrDefault(a => string.Equals(a.Address, from, StringComparison.OrdinalIgnoreCase))?.Mailbox is { Length: > 0 } m ? m : from;

    public static async Task SendAsync(GraphMailer mailer, ProxyConfig c, string from, IReadOnlyList<string> recipients, byte[] mime, CancellationToken ct)
    {
        var mailbox = MailboxOf(c, from);
        try { await mailer.SendAsync(mailbox, from, recipients, mime, ct); }
        catch (GraphException ex) when (IsNoMailbox(ex))
        {
            throw new GraphException(ex.Status, ex.Code,
                $"Für {from} gibt es kein Postfach in Exchange Online. Graph sendet nur aus einem Postfach oder freigegebenen Postfach " +
                $"(oder einem Alias davon): das Postfach anlegen, dann in der Oberfläche unter „Absender“ die Adressen neu laden. ({ex.Message})");
        }
        catch (GraphException ex) when (ex.Code == "ErrorSendAsDenied" && mailbox != from)
        {
            throw new GraphException(ex.Status, ex.Code,
                $"{from} ist ein Alias von {mailbox}. Senden mit Aliasadressen muss in Exchange eingeschaltet sein " +
                $"(Set-OrganizationConfig -SendFromAliasEnabled $true), sonst als Absender {mailbox} verwenden. ({ex.Message})");
        }
    }
}
