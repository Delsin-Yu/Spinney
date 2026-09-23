namespace SpinneyRelay;

internal sealed record Limits
{
    public string Urls { get; init; } = "http://0.0.0.0:8787";
    public int MaxPeersPerRoom { get; init; } = 16;
    public int MaxRooms { get; init; } = 64;
    public int MaxFrameBytes { get; init; } = 65536;
    public double RatePerSecond { get; init; } = 60;
    public double RateBurst { get; init; } = 120;
    public long PeerQueueBytes { get; init; } = 4194304;
    public int IdleTimeoutSeconds { get; init; } = 90;
    public int HeartbeatSeconds { get; init; } = 15;

    public static Limits Default { get; } = new();

    public static Limits SelfTest { get; } = new()
    {
        Urls = "http://127.0.0.1:0",
        PeerQueueBytes = 262144,
        IdleTimeoutSeconds = 6,
        HeartbeatSeconds = 1,
    };
}
