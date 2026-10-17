using System.Collections.Concurrent;
using System.Net;
using SmtpProxy.Core.Config;
using SmtpProxy.Core.Graph;
using SmtpProxy.Core.Logging;

namespace SmtpProxy.Core.Delivery;

/// <summary>
/// Chooses the mailbox Graph sends from. A sender with an own mailbox sends from it. A sender without a mailbox
/// sends from the shared mailbox (SenderPolicy.SharedMailbox) with its address as alias; missing aliases are added
/// in Exchange by the service, if allowed (AutoCreateAliases).
/// </summary>
public sealed class SenderRouter(Func<ProxyConfig> config, M365Session m365)
{
    /// <summary>Exchange needs this long until a new alias (or SendFromAliasEnabled) works for sending.</summary>
    static readonly TimeSpan Propagation = TimeSpan.FromHours(2);
    readonly SemaphoreSlim _gate = new(1, 1);
    readonly ConcurrentDictionary<string, DateTimeOffset> _added = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>Allowed addresses that are recipients of their own (mailbox, group); checked once per service run.</summary>
    readonly ConcurrentDictionary<string, bool> _ownRecipients = new(StringComparer.OrdinalIgnoreCase);

    public static bool IsAlias(ProxyConfig c, string address) =>
        c.Senders.SharedMailbox.Length > 0 &&
        (string.Equals(c.Senders.SharedMailbox, address, StringComparison.OrdinalIgnoreCase) ||
         c.Senders.SharedMailboxAliases.Contains(address, StringComparer.OrdinalIgnoreCase));

    /// <summary>Graph answer for "there is no mailbox with this address" (ErrorInvalidUser: "'x' is invalid").</summary>
    public static bool IsNoMailbox(GraphException ex) =>
        ex.Code is "ErrorInvalidUser" or "MailboxNotEnabledForRESTAPI" or "ErrorNonExistentMailbox" or "ResourceNotFound"
        || ex.Status == HttpStatusCode.NotFound;

    public async Task SendAsync(GraphMailer mailer, string from, IReadOnlyList<string> recipients, byte[] mime, CancellationToken ct)
    {
        var c = config();
        var shared = c.Senders.SharedMailbox;
        if (!IsAlias(c, from) && !_added.ContainsKey(from))
        {
            try
            {
                await mailer.SendAsync(from, from, recipients, mime, ct);
                return;
            }
            catch (GraphException ex) when (IsNoMailbox(ex))
            {
                if (shared.Length == 0)
                    throw new GraphException(ex.Status, ex.Code,
                        $"Für {from} gibt es kein Postfach im Tenant. Freigegebenes Postfach einrichten (Oberfläche → Microsoft 365), dann wird die Adresse als Alias angelegt. ({ex.Message})");
                if (!c.Senders.AutoCreateAliases)
                    throw new GraphException(ex.Status, ex.Code,
                        $"Für {from} gibt es kein Postfach, und das automatische Anlegen von Aliassen ist aus. Adresse als Alias von {shared} anlegen oder die Option einschalten.");
                await EnsureAliasAsync(from, ct);
            }
            catch (GraphException ex) when (ex.Code == "ErrorAccessDenied" && c.Senders.ExchangeScopeEnabled)
            {
                throw new GraphException(ex.Status, ex.Code,
                    $"Exchange lässt die App nicht aus dem Postfach {from} senden: Es ist nicht in der Gruppe {c.Senders.ExchangeScopeGroup}. " +
                    $"Adresse unter „Erlaubte Adressen“ eintragen und „In Exchange abgleichen“ (wirkt nach bis zu einer Stunde). ({ex.Message})");
            }
        }

        try { await mailer.SendAsync(shared, from, recipients, mime, ct); }
        catch (GraphException ex) when (ex.Code is "ErrorSendAsDenied" or "ErrorAccessDenied" && IsRecent(c, from))
        {
            // not transient by itself, but a fresh alias or SendFromAliasEnabled needs a while in Exchange
            throw new GraphException(HttpStatusCode.ServiceUnavailable, ex.Code,
                $"{from} ist neu als Alias von {shared}; Exchange übernimmt die Änderung noch (bis zu einer Stunde). {ex.Message}");
        }
    }

    bool IsRecent(ProxyConfig c, string from) =>
        (_added.TryGetValue(from, out var at) && DateTimeOffset.UtcNow - at < Propagation)
        || (c.Senders.SharedMailboxSetupAt is { } s && DateTimeOffset.UtcNow - s < Propagation);

    /// <summary>Makes the address an alias of the shared mailbox (or confirms it is one) and remembers it.</summary>
    public async Task EnsureAliasAsync(string address, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var c = config();
            var shared = c.Senders.SharedMailbox;
            if (shared.Length == 0 || IsAlias(c, address)) return;
            var exo = m365.Exchange() ?? throw new GraphException(HttpStatusCode.ServiceUnavailable, "notConnected", "Exchange Online ist nicht verbunden.");
            var found = await exo.FindRecipientAsync(address, ct);
            if (found is { } r && !string.Equals(r.Identity, shared, StringComparison.OrdinalIgnoreCase) && !r.Addresses.Contains(shared.ToLowerInvariant()))
                throw new GraphException(HttpStatusCode.Conflict, "aliasTaken",
                    $"{address} gehört in Exchange bereits zu {r.Identity} (kein Postfach, aus dem gesendet werden kann). Als Alias von {shared} nicht möglich.");
            if (found is null)
            {
                await exo.AddAliasAsync(shared, address, ct);
                _added[address] = DateTimeOffset.UtcNow;
                Logs.Info($"{address} als Alias von {shared} angelegt.");
            }
            Remember(address, found is null);
        }
        catch (GraphException ex) when (ex.Status is HttpStatusCode.Forbidden)
        {
            throw new GraphException(ex.Status, ex.Code,
                $"Die App darf in Exchange keine Aliasse anlegen. Freigegebenes Postfach in der Oberfläche erneut einrichten. ({ex.Message})");
        }
        finally { _gate.Release(); }
    }

    static void Remember(string address, bool added)
    {
        var fresh = ConfigStore.Load();
        if (fresh.Senders.SharedMailboxAliases.Contains(address, StringComparer.OrdinalIgnoreCase)) return;
        fresh.Senders.SharedMailboxAliases.Add(address.ToLowerInvariant());
        fresh.Senders.SharedMailboxAliases.Sort(StringComparer.OrdinalIgnoreCase);
        ConfigStore.Save(fresh, added ? $"Dienst (Alias {address} angelegt)" : $"Dienst (Alias {address} gefunden)");
    }

    string? _groupSynced;

    /// <summary>
    /// Exchange side of the allowed addresses, without an administrator: addresses without a recipient become aliases
    /// (so Exchange has time to pick them up before the first message), then the sender group gets the shared
    /// mailbox and the recipients of all allowed addresses (only when the list changed since the last run).
    /// </summary>
    public async Task SyncAsync(CancellationToken ct)
    {
        await SyncAliasesAsync(ct);
        var c = config();
        var s = c.Senders;
        if (!s.ExchangeScopeEnabled || s.ExchangeScopeGroup.Length == 0 || m365.Exchange() is not { } exo) return;
        var key = string.Join(',', s.AllowedAddresses.Order().Prepend(s.SharedMailbox).Prepend(s.ExchangeScopeGroup)).ToLowerInvariant();
        if (key == _groupSynced) return;
        var (members, notFound) = await exo.SyncGroupAsync(s.ExchangeScopeGroup, s.SharedMailbox, s.AllowedAddresses, ct);
        _groupSynced = key;
        Logs.Info($"Exchange-Gruppe {s.ExchangeScopeGroup} abgeglichen: {string.Join(", ", members)}" +
                  (notFound.Count > 0 ? $"; ohne Empfänger: {string.Join(", ", notFound)}" : ""));
        var fresh = ConfigStore.Load();
        fresh.Senders.ExchangeScopeSyncedAt = DateTimeOffset.UtcNow;
        ConfigStore.Save(fresh, "Dienst (Exchange-Gruppe abgeglichen)");
    }

    async Task SyncAliasesAsync(CancellationToken ct)
    {
        var c = config();
        if (c.Senders.SharedMailbox.Length == 0 || !c.Senders.AutoCreateAliases || m365.Exchange() is not { } exo) return;
        foreach (var address in c.Senders.AllowedAddresses)
        {
            if (IsAlias(config(), address) || _ownRecipients.ContainsKey(address)) continue;
            try
            {
                var found = await exo.FindRecipientAsync(address, ct);
                if (found is { } r && !string.Equals(r.Identity, c.Senders.SharedMailbox, StringComparison.OrdinalIgnoreCase)) _ownRecipients[address] = true;
                else await EnsureAliasAsync(address, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception ex) { Logs.Warn($"Alias {address} konnte nicht geprüft oder angelegt werden: {ex.Message}"); }
        }
    }
}
