using System.Text.Json.Serialization;

namespace SpinneyRelay;

internal sealed class HealthResponse
{
    [JsonPropertyName("ok")] public bool Ok { get; init; }
    [JsonPropertyName("rooms")] public int Rooms { get; init; }
    [JsonPropertyName("peers")] public int Peers { get; init; }
    [JsonPropertyName("uptimeMs")] public long UptimeMs { get; init; }
}

internal sealed class JoinResponse
{
    [JsonPropertyName("peer")] public string Peer { get; init; } = "";
}

/// <summary>
/// The `/v2` join answer. Same shape as <see cref="JoinResponse"/> plus one fact the desktop
/// needs and the old route could not express: whether this join *created* the room. A desktop
/// that thought it was joining an existing room and reads `created: true` has just learned that
/// nobody has ever used this token on this relay — which is the mismatch, said out loud, on the
/// side that holds the token (`PROTOCOL.md` §3).
/// </summary>
internal sealed class JoinV2Response
{
    [JsonPropertyName("peer")] public string Peer { get; init; } = "";

    [JsonPropertyName("created")] public bool Created { get; init; }
}

/// <summary>The `/v2` join request body: `{"mode":"create"}` or `{"mode":"join"}`.</summary>
internal sealed class JoinModeRequest
{
    [JsonPropertyName("mode")] public string? Mode { get; init; }
}

/// <summary>
/// The ledger file (`RoomRecords`): one line per room that exists, as `roomId -> last used, unix
/// seconds`. It holds no token (the relay has never seen one), no content and no peer.
/// </summary>
internal sealed class RoomRecordsFile
{
    [JsonPropertyName("v")] public int Version { get; init; }

    [JsonPropertyName("rooms")] public Dictionary<string, long>? Rooms { get; init; }
}

internal sealed class OkResponse
{
    [JsonPropertyName("ok")] public bool Ok { get; init; }
}

internal sealed class ErrorResponse
{
    [JsonPropertyName("error")] public string Error { get; init; } = "";
}

[JsonSerializable(typeof(HealthResponse))]
[JsonSerializable(typeof(JoinResponse))]
[JsonSerializable(typeof(JoinV2Response))]
[JsonSerializable(typeof(JoinModeRequest))]
[JsonSerializable(typeof(RoomRecordsFile))]
[JsonSerializable(typeof(OkResponse))]
[JsonSerializable(typeof(ErrorResponse))]
internal sealed partial class RelayJsonContext : JsonSerializerContext
{
}
