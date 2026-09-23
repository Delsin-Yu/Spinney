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
[JsonSerializable(typeof(OkResponse))]
[JsonSerializable(typeof(ErrorResponse))]
internal sealed partial class RelayJsonContext : JsonSerializerContext
{
}
