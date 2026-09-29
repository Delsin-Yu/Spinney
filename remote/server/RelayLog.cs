using System.Security.Cryptography;
using System.Text;

namespace SpinneyRelay;

internal static partial class RelayLog
{
    [LoggerMessage(EventId = 1, Level = LogLevel.Information, Message = "relay listening on {Urls}")]
    public static partial void Listening(ILogger logger, string urls);

    [LoggerMessage(EventId = 2, Level = LogLevel.Information, Message = "limits: {Limits}")]
    public static partial void Configured(ILogger logger, string limits);

    [LoggerMessage(EventId = 3, Level = LogLevel.Information, Message = "room {Room} created (rooms {Rooms})")]
    public static partial void RoomCreated(ILogger logger, string room, int rooms);

    [LoggerMessage(EventId = 4, Level = LogLevel.Information, Message = "room {Room} destroyed (rooms {Rooms})")]
    public static partial void RoomDestroyed(ILogger logger, string room, int rooms);

    [LoggerMessage(EventId = 5, Level = LogLevel.Information, Message = "peer joined room {Room} (peers {Peers}, rooms {Rooms})")]
    public static partial void PeerJoined(ILogger logger, string room, int peers, int rooms);

    [LoggerMessage(EventId = 6, Level = LogLevel.Information, Message = "peer left room {Room} after {Seconds}s without traffic (peers {Peers})")]
    public static partial void PeerLeft(ILogger logger, string room, int seconds, int peers);

    [LoggerMessage(EventId = 7, Level = LogLevel.Information, Message = "peer dropped from room {Room}: outbound queue over {Bytes} bytes (peers {Peers})")]
    public static partial void PeerDropped(ILogger logger, string room, long bytes, int peers);

    [LoggerMessage(EventId = 8, Level = LogLevel.Warning, Message = "request failed {Status} {Method} {Route}")]
    public static partial void RequestFailed(ILogger logger, int status, string method, string route);

    [LoggerMessage(EventId = 9, Level = LogLevel.Debug, Message = "forwarded {Bytes} bytes to {Peers} peers")]
    public static partial void Forwarded(ILogger logger, int bytes, int peers);

    [LoggerMessage(EventId = 10, Level = LogLevel.Information, Message = "configuration: {Note}")]
    public static partial void Configuration(ILogger logger, string note);

    [LoggerMessage(EventId = 11, Level = LogLevel.Information, Message = "room records: {Count} loaded from {Path}")]
    public static partial void RoomRecordsLoaded(ILogger logger, int count, string path);

    [LoggerMessage(EventId = 12, Level = LogLevel.Error, Message = "room records could not be read ({Reason}) — starting with none, every join will look unknown until a publisher re-creates its room: {Path}")]
    public static partial void RoomRecordsUnreadable(ILogger logger, string reason, string path);

    [LoggerMessage(EventId = 13, Level = LogLevel.Error, Message = "room records could not be written ({Reason}): {Path}")]
    public static partial void RoomRecordsUnwritable(ILogger logger, string reason, string path);

    [LoggerMessage(EventId = 14, Level = LogLevel.Information, Message = "room record {Room}: created {Created} (records {Records}, ttl {Days}d)")]
    public static partial void RoomRecordSaved(ILogger logger, bool created, string room, int records, int days);

    [LoggerMessage(EventId = 15, Level = LogLevel.Information, Message = "room records: {Removed} aged out (records {Records}, ttl {Days}d)")]
    public static partial void RoomRecordsPruned(ILogger logger, int removed, int records, int days);

    [LoggerMessage(EventId = 16, Level = LogLevel.Warning, Message = "room {Room} refused: the record store is full ({Records})")]
    public static partial void RoomRecordsFull(ILogger logger, int records, string room);

    [LoggerMessage(EventId = 17, Level = LogLevel.Information, Message = "join refused for room {Room}: no record and no peer")]
    public static partial void JoinRefusedUnknownRoom(ILogger logger, string room);

    public static string Tag(string id) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(id)).AsSpan(0, 4));
}
