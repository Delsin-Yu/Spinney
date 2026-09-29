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

    /// <summary>
    /// How long a room stays on record after its last join. This is what makes a phone able to
    /// join a room whose desktop is asleep, and it is the reason the metadata decays on its own
    /// instead of accumulating: a room nobody uses stops existing after this many days, and the
    /// next desktop connect creates it again (`RoomRecords`).
    /// </summary>
    public int RoomRecordTtlDays { get; init; } = 30;

    /// <summary>Rooms on record at once. A backstop for the ledger, not the policy — the TTL is.</summary>
    public int MaxRoomRecords { get; init; } = 1024;

    /// <summary>The ledger file, relative to the executable unless it is rooted.</summary>
    public string RoomRecordsFile { get; init; } = "rooms.json";

    /// <summary>Per-source join refill. A device joins once when it opens; a guesser walking a
    /// dictionary is the thing this slows down (`JoinLimiter`).</summary>
    public double JoinRatePerSecond { get; init; } = 1;

    /// <summary>Per-source join burst: how many joins in a row are allowed before the refill matters.</summary>
    public double JoinRateBurst { get; init; } = 5;

    public static Limits Default { get; } = new();

    /// <summary>
    /// One ledger file per test process, in the temp directory: the self-test must never write
    /// into the working tree, and must never inherit a ledger a previous run left behind.
    /// Declared before <see cref="SelfTest"/> on purpose — static initializers run in declaration
    /// order, so a property declared after it would still be null when the limits are built.
    /// </summary>
    public static string SelfTestRoomRecordsFile { get; } =
        Path.Combine(Path.GetTempPath(), $"spinney-selftest-{Environment.ProcessId}-rooms.json");

    public static Limits SelfTest { get; } = new()
    {
        Urls = "http://127.0.0.1:0",
        PeerQueueBytes = 262144,
        IdleTimeoutSeconds = 6,
        HeartbeatSeconds = 1,
        // The cases join far more often than a device does, so the join brake is effectively off
        // here; the one case that tests it starts its own relay with tight limits, because a
        // limiter that is on during every other case would make them all flaky.
        JoinRatePerSecond = 100000,
        JoinRateBurst = 100000,
        RoomRecordsFile = SelfTestRoomRecordsFile,
    };

    /// <summary>A relay whose join brake is on: the case that tests the brake starts its own.</summary>
    public static Limits SelfTestPairing { get; } = SelfTest with
    {
        JoinRatePerSecond = 1,
        JoinRateBurst = 2,
        RoomRecordsFile = Path.Combine(Path.GetTempPath(), $"spinney-selftest-{Environment.ProcessId}-rooms-brake.json"),
    };

    /// <summary>A relay whose idle timeout is a second: the case that waits for an eviction starts
    /// its own, so waiting is short and — more importantly — provable, because nothing else in the
    /// process is posting `up` and keeping a peer alive.</summary>
    public static Limits SelfTestIdle { get; } = SelfTest with
    {
        IdleTimeoutSeconds = 1,
        HeartbeatSeconds = 1,
        RoomRecordsFile = Path.Combine(Path.GetTempPath(), $"spinney-selftest-{Environment.ProcessId}-rooms-idle.json"),
    };

    /// <summary>A relay whose room-record store is almost full: the cap case starts its own.</summary>
    public static Limits SelfTestLedger { get; } = SelfTest with
    {
        MaxRoomRecords = 4,
        RoomRecordsFile = Path.Combine(Path.GetTempPath(), $"spinney-selftest-{Environment.ProcessId}-rooms-cap.json"),
    };
}

