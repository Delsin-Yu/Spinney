namespace SpinneyRelay;

internal sealed class RelaySweeper(RoomRegistry registry) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken)) registry.Sweep();
        }
        catch (OperationCanceledException)
        {
        }
    }
}
