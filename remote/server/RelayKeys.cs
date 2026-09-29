using System.Globalization;

namespace SpinneyRelay;

internal enum LimitsField
{
    Urls,
    MaxPeersPerRoom,
    MaxRooms,
    MaxFrameBytes,
    RatePerSecond,
    RateBurst,
    PeerQueueBytes,
    IdleTimeoutSeconds,
    HeartbeatSeconds,
    RoomRecordTtlDays,
    MaxRoomRecords,
    RoomRecordsFile,
    JoinRatePerSecond,
    JoinRateBurst,
}

internal readonly record struct RelayKey(LimitsField Field, string Key, string Flag)
{
    public string Environment => Key.Replace(":", "__", StringComparison.Ordinal);
}

internal static class RelayKeys
{
    public static readonly RelayKey[] All =
    {
        new(LimitsField.Urls, "Relay:Urls", "--urls"),
        new(LimitsField.MaxPeersPerRoom, "Relay:MaxPeersPerRoom", "--max-peers-per-room"),
        new(LimitsField.MaxRooms, "Relay:MaxRooms", "--max-rooms"),
        new(LimitsField.MaxFrameBytes, "Relay:MaxFrameBytes", "--max-frame-bytes"),
        new(LimitsField.RatePerSecond, "Relay:RatePerSecond", "--rate-per-second"),
        new(LimitsField.RateBurst, "Relay:RateBurst", "--rate-burst"),
        new(LimitsField.PeerQueueBytes, "Relay:PeerQueueBytes", "--peer-queue-bytes"),
        new(LimitsField.IdleTimeoutSeconds, "Relay:IdleTimeoutSeconds", "--idle-timeout-seconds"),
        new(LimitsField.HeartbeatSeconds, "Relay:HeartbeatSeconds", "--heartbeat-seconds"),
        new(LimitsField.RoomRecordTtlDays, "Relay:RoomRecordTtlDays", "--room-record-ttl-days"),
        new(LimitsField.MaxRoomRecords, "Relay:MaxRoomRecords", "--max-room-records"),
        new(LimitsField.RoomRecordsFile, "Relay:RoomRecordsFile", "--room-records-file"),
        new(LimitsField.JoinRatePerSecond, "Relay:JoinRatePerSecond", "--join-rate-per-second"),
        new(LimitsField.JoinRateBurst, "Relay:JoinRateBurst", "--join-rate-burst"),
    };

    public static RelayKey? Find(string flag)
    {
        foreach (var key in All)
        {
            if (key.Flag == flag) return key;
        }

        return null;
    }

    public static bool TryApply(RelayKey key, string? raw, string name, Limits input, out Limits result, out string? error)
    {
        result = input;
        error = null;
        switch (key.Field)
        {
            case LimitsField.Urls:
                if (string.IsNullOrWhiteSpace(raw))
                {
                    error = $"{name} expects a listen URL such as http://0.0.0.0:8787, got '{raw}'";
                    return false;
                }

                result = input with { Urls = raw };
                return true;
            case LimitsField.MaxPeersPerRoom:
                if (!TryInt(raw, name, 1, 1024, out var maxPeers, out error)) return false;
                result = input with { MaxPeersPerRoom = maxPeers };
                return true;
            case LimitsField.MaxRooms:
                if (!TryInt(raw, name, 1, 65536, out var maxRooms, out error)) return false;
                result = input with { MaxRooms = maxRooms };
                return true;
            case LimitsField.MaxFrameBytes:
                if (!TryInt(raw, name, 1, 16 * 1024 * 1024, out var maxFrameBytes, out error)) return false;
                result = input with { MaxFrameBytes = maxFrameBytes };
                return true;
            case LimitsField.RatePerSecond:
                if (!TryDouble(raw, name, 0.001, 1000000, out var ratePerSecond, out error)) return false;
                result = input with { RatePerSecond = ratePerSecond };
                return true;
            case LimitsField.RateBurst:
                if (!TryDouble(raw, name, 1, 1000000, out var rateBurst, out error)) return false;
                result = input with { RateBurst = rateBurst };
                return true;
            case LimitsField.PeerQueueBytes:
                if (!TryLong(raw, name, 1024, 1L << 40, out var peerQueueBytes, out error)) return false;
                result = input with { PeerQueueBytes = peerQueueBytes };
                return true;
            case LimitsField.IdleTimeoutSeconds:
                if (!TryInt(raw, name, 1, 86400, out var idleTimeoutSeconds, out error)) return false;
                result = input with { IdleTimeoutSeconds = idleTimeoutSeconds };
                return true;
            case LimitsField.HeartbeatSeconds:
                if (!TryInt(raw, name, 1, 3600, out var heartbeatSeconds, out error)) return false;
                result = input with { HeartbeatSeconds = heartbeatSeconds };
                return true;
            case LimitsField.RoomRecordTtlDays:
                if (!TryInt(raw, name, 1, 3650, out var roomRecordTtlDays, out error)) return false;
                result = input with { RoomRecordTtlDays = roomRecordTtlDays };
                return true;
            case LimitsField.MaxRoomRecords:
                if (!TryInt(raw, name, 1, 1000000, out var maxRoomRecords, out error)) return false;
                result = input with { MaxRoomRecords = maxRoomRecords };
                return true;
            case LimitsField.RoomRecordsFile:
                if (string.IsNullOrWhiteSpace(raw))
                {
                    error = $"{name} expects a file name such as rooms.json, got '{raw}'";
                    return false;
                }

                result = input with { RoomRecordsFile = raw };
                return true;
            case LimitsField.JoinRatePerSecond:
                if (!TryDouble(raw, name, 0.001, 1000000, out var joinRatePerSecond, out error)) return false;
                result = input with { JoinRatePerSecond = joinRatePerSecond };
                return true;
            case LimitsField.JoinRateBurst:
                if (!TryDouble(raw, name, 1, 1000000, out var joinRateBurst, out error)) return false;
                result = input with { JoinRateBurst = joinRateBurst };
                return true;
            default:
                error = $"unknown configuration key {key.Key}";
                return false;
        }
    }

    private static bool TryInt(string? raw, string name, int min, int max, out int value, out string? error)
    {
        value = 0;
        if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
        {
            error = $"{name} expects a whole number in {min}..{max}, got '{raw}'";
            return false;
        }

        if (value < min || value > max)
        {
            error = $"{name} expects {min}..{max}, got '{raw}'";
            return false;
        }

        error = null;
        return true;
    }

    private static bool TryLong(string? raw, string name, long min, long max, out long value, out string? error)
    {
        value = 0;
        if (!long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
        {
            error = $"{name} expects a whole number in {min}..{max}, got '{raw}'";
            return false;
        }

        if (value < min || value > max)
        {
            error = $"{name} expects {min}..{max}, got '{raw}'";
            return false;
        }

        error = null;
        return true;
    }

    private static bool TryDouble(string? raw, string name, double min, double max, out double value, out string? error)
    {
        value = 0;
        if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out value))
        {
            error = $"{name} expects a number in {min}..{max}, got '{raw}'";
            return false;
        }

        if (value < min || value > max)
        {
            error = $"{name} expects {min}..{max}, got '{raw}'";
            return false;
        }

        error = null;
        return true;
    }
}
