namespace SpinneyRelay;

internal sealed class Peer
{
    private readonly long _joinedMs;
    private long _lastUpMs;
    private CancellationTokenSource? _down;
    private int _evicted;

    public Peer(string id, Room room, Limits limits)
    {
        Id = id;
        Room = room;
        Outbox = new PeerOutbox(limits.PeerQueueBytes);
        Limit = new TokenBucket(limits.RatePerSecond, limits.RateBurst);
        _joinedMs = Environment.TickCount64;
        _lastUpMs = _joinedMs;
    }

    public string Id { get; }

    public Room Room { get; }

    public PeerOutbox Outbox { get; }

    public TokenBucket Limit { get; }

    public bool Evicted => Volatile.Read(ref _evicted) != 0;

    public bool HasLiveDown => Volatile.Read(ref _down) is not null;

    public void Touch() => Volatile.Write(ref _lastUpMs, Environment.TickCount64);

    public CancellationTokenSource AttachDown(CancellationToken requestAborted)
    {
        var next = CancellationTokenSource.CreateLinkedTokenSource(requestAborted);
        var previous = Interlocked.Exchange(ref _down, next);
        previous?.Cancel();
        return next;
    }

    public void DetachDown(CancellationTokenSource down) => Interlocked.CompareExchange(ref _down, null, down);

    public bool CancelDown()
    {
        var down = Interlocked.Exchange(ref _down, null);
        if (down is null) return false;
        down.Cancel();
        return true;
    }

    public bool MarkEvicted() => Interlocked.Exchange(ref _evicted, 1) == 0;

    public bool IsIdle(long nowMs, int idleTimeoutSeconds) =>
        !HasLiveDown && nowMs - Volatile.Read(ref _lastUpMs) > idleTimeoutSeconds * 1000L;
}
