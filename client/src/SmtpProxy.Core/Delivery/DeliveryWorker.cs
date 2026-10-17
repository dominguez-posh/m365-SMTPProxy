using SmtpProxy.Core.Config;
using SmtpProxy.Core.Graph;
using SmtpProxy.Core.Logging;

namespace SmtpProxy.Core.Delivery;

/// <summary>Delivers queued messages through Graph; retries transient errors with growing pauses.</summary>
public sealed class DeliveryWorker(Func<ProxyConfig> config, MailQueue queue, M365Session m365, SenderRouter router)
{
    const int Parallel = 4;
    static readonly int[] BackoffMinutes = [1, 2, 5, 10, 15, 30, 60];
    readonly SemaphoreSlim _wake = new(0);
    readonly HashSet<string> _running = [];
    readonly Lock _gate = new();

    public int Delivered { get; private set; }
    public int Failed { get; private set; }
    public DateTimeOffset? LastDelivery { get; private set; }
    public string? LastError { get; private set; }

    public void Wake()
    {
        if (_wake.CurrentCount == 0) _wake.Release();
    }

    public async Task RunAsync(CancellationToken ct)
    {
        queue.Enqueued += Wake;
        using var slots = new SemaphoreSlim(Parallel);
        while (!ct.IsCancellationRequested)
        {
            var now = DateTimeOffset.UtcNow;
            foreach (var item in MailQueue.List().Where(i => i.NextAttemptAt <= now))
            {
                lock (_gate) if (!_running.Add(item.Id)) continue;
                await slots.WaitAsync(ct);
                _ = Task.Run(async () =>
                {
                    try { await DeliverAsync(item, ct); }
                    finally
                    {
                        lock (_gate) _running.Remove(item.Id);
                        slots.Release();
                    }
                }, CancellationToken.None);
            }
            try { await _wake.WaitAsync(TimeSpan.FromSeconds(30), ct); }
            catch (OperationCanceledException) { break; }
        }
        queue.Enqueued -= Wake;
    }

    async Task DeliverAsync(SpoolItem item, CancellationToken ct)
    {
        item.Attempts++;
        try
        {
            var mailer = m365.Mailer() ?? throw new GraphException(System.Net.HttpStatusCode.ServiceUnavailable, "notConnected",
                "Nicht mit Microsoft 365 verbunden");
            await router.SendAsync(mailer, item.From, item.Recipients, MailQueue.ReadMessage(item.Id), ct);
            MailQueue.Remove(item.Id);
            MailQueue.Log(MailEvent.Delivered, item);
            Delivered++;
            LastDelivery = DateTimeOffset.UtcNow;
            LastError = null;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            item.Attempts--;
        }
        catch (Exception ex)
        {
            var transient = ex is GraphException { IsTransient: true } or IOException or HttpRequestException;
            if (ex is GraphException { Status: System.Net.HttpStatusCode.Unauthorized }) m365.InvalidateToken();
            item.LastError = ex.Message;
            LastError = $"{item.From}: {ex.Message}";
            var expired = DateTimeOffset.UtcNow - item.ReceivedAt > TimeSpan.FromHours(Math.Max(1, config().Delivery.RetryHours));
            if (transient && !expired)
            {
                var wait = TimeSpan.FromMinutes(BackoffMinutes[Math.Min(item.Attempts - 1, BackoffMinutes.Length - 1)]);
                if (ex is GraphException { RetryAfter: { } ra } && ra > wait) wait = ra;
                item.NextAttemptAt = DateTimeOffset.UtcNow + wait;
                MailQueue.Update(item);
                MailQueue.Log(MailEvent.Deferred, item, ex.Message);
            }
            else
            {
                MailQueue.MoveToFailed(item);
                MailQueue.Log(MailEvent.Failed, item, ex.Message);
                Failed++;
                Logs.Warn($"Zustellung endgültig fehlgeschlagen ({item.Id}, {item.From}): {ex.Message}");
            }
        }
    }
}
