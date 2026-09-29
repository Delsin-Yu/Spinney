namespace SpinneyRelay;

/// <summary>
/// The relay's one periodic moment: evict idle peers, age the room records, forget quiet join
/// sources. One timer, one second, no per-connection work — the relay stays a byte pipe, and the
/// three things that must not grow without bound (rooms, records, address buckets) are all bounded
/// here.
/// </summary>
internal sealed class RelaySweeper(RoomRegistry registry, JoinLimiter limiter) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                registry.Sweep();
                limiter.Sweep();
            }
        }
        catch (OperationCanceledException)
        {
        }
    }
}
