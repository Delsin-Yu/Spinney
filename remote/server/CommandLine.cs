namespace SpinneyRelay;

internal enum CommandLineMode
{
    Run,
    Help,
    SelfTest,
}

internal sealed class CommandLine
{
    private readonly List<(RelayKey Key, string Raw)> _provided = new();

    private CommandLine(CommandLineMode mode) => Mode = mode;

    public CommandLineMode Mode { get; }

    public bool Help => Mode == CommandLineMode.Help;

    public bool SelfTest => Mode == CommandLineMode.SelfTest;

    public string? Error { get; private init; }

    public static string Usage =>
        """
        spinney-relay - dumb byte pipe that pairs the peers of one room, and remembers which rooms exist

        usage: spinney-relay [--flag value ...] [--selftest] [--help]

        settings resolve per key, highest source first:
          command line  >  environment (Relay__Key)  >  appsettings.json (Relay:Key)  >  built-in default

          --urls <url>                    listen address (default http://0.0.0.0:8787)
          --max-peers-per-room <int>      peers per room (default 16)
          --max-rooms <int>               live rooms (default 64)
          --max-frame-bytes <int>         largest accepted up body (default 65536)
          --rate-per-second <num>         per-peer token refill (default 60)
          --rate-burst <num>              per-peer token bucket size (default 120)
          --peer-queue-bytes <int>        per-peer outbound queue (default 4194304)
          --idle-timeout-seconds <int>    eviction timeout (default 90)
          --heartbeat-seconds <int>       SSE ping interval (default 15)
          --room-record-ttl-days <int>    how long a room stays joinable with no members (default 30)
          --max-room-records <int>        rooms on record (default 1024)
          --room-records-file <file>      where the record of existing rooms lives (default rooms.json)
          --join-rate-per-second <num>    per-address join refill (default 1)
          --join-rate-burst <num>         per-address join burst (default 5)
          --selftest                      run the contract in process, print PASS/FAIL
          --help                          this text

        `POST /v1/room/{roomId}/join` creates a room on first use and never refuses an unknown one.
        `POST /v2/room/{roomId}/join` takes `{"mode":"create"|"join"}`: `join` answers 404
        `room_unknown` for a room this relay has no record of, and `create` records it. See README.md.

        appsettings.json is read once, beside the executable. Its "Relay" section sets the same keys
        in PascalCase ("Relay:MaxPeersPerRoom"); the environment form is Relay__MaxPeersPerRoom. A
        misspelled or unknown key is ignored silently, so read the startup line, which prints the
        effective limits.
        """;

    public static string Describe(Limits limits) =>
        $"peers/room {limits.MaxPeersPerRoom}, rooms {limits.MaxRooms}, frame {limits.MaxFrameBytes} B, " +
        $"rate {limits.RatePerSecond}/s burst {limits.RateBurst}, queue {limits.PeerQueueBytes} B, " +
        $"idle {limits.IdleTimeoutSeconds}s, heartbeat {limits.HeartbeatSeconds}s, " +
        $"records {limits.MaxRoomRecords} for {limits.RoomRecordTtlDays}d in {limits.RoomRecordsFile}, " +
        $"join {limits.JoinRatePerSecond}/s burst {limits.JoinRateBurst}";

    public static CommandLine Parse(string[] args)
    {
        var provided = new List<(RelayKey Key, string Raw)>();
        var mode = CommandLineMode.Run;

        for (var i = 0; i < args.Length; i++)
        {
            var name = args[i];
            string? inline = null;
            var separator = name.IndexOf('=');
            if (name.StartsWith("--", StringComparison.Ordinal) && separator > 0)
            {
                inline = name[(separator + 1)..];
                name = name[..separator];
            }

            switch (name)
            {
                case "--help":
                case "-h":
                    mode = CommandLineMode.Help;
                    break;
                case "--selftest":
                    mode = CommandLineMode.SelfTest;
                    break;
                default:
                {
                    var key = RelayKeys.Find(name);
                    if (key is null) return Fail($"unknown argument: {name}");
                    if (!TryValue(args, ref i, inline, name, out var raw, out var missing)) return Fail(missing!);
                    if (!RelayKeys.TryApply(key.Value, raw, name, Limits.Default, out _, out var invalid)) return Fail(invalid!);
                    provided.Add((key.Value, raw!));
                    break;
                }
            }
        }

        var commandLine = new CommandLine(mode);
        commandLine._provided.AddRange(provided);
        return commandLine;

        static CommandLine Fail(string message) => new(CommandLineMode.Run) { Error = message };
    }

    public bool TryResolveLimits(ConfigurationSources sources, out Limits limits, out string? error)
    {
        var result = Limits.Default;

        foreach (var key in RelayKeys.All)
        {
            var raw = sources.Get(key.Key);
            if (raw is null) continue;
            if (!RelayKeys.TryApply(key, raw, $"{key.Key} ({key.Environment})", result, out var fromSource, out error))
            {
                limits = result;
                return false;
            }

            result = fromSource;
        }

        foreach (var (key, raw) in _provided)
        {
            if (!RelayKeys.TryApply(key, raw, key.Flag, result, out var fromFlag, out error))
            {
                limits = result;
                return false;
            }

            result = fromFlag;
        }

        limits = result;
        error = null;
        return true;
    }

    private static bool TryValue(string[] args, ref int i, string? inline, string name, out string? value, out string? error)
    {
        if (inline is not null)
        {
            value = inline;
            error = null;
            return true;
        }

        if (i + 1 >= args.Length)
        {
            value = null;
            error = $"missing value for {name}";
            return false;
        }

        value = args[++i];
        error = null;
        return true;
    }
}
