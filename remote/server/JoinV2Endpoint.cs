using System.Text.Json;

namespace SpinneyRelay;

internal enum JoinModeStatus
{
    Ok,
    Unreadable,
    BadMode,
    TooLong,
}

/// <summary>
/// `POST /v2/room/{roomId}/join` — the join that says what it is allowed to do.
///
/// Body: `{"mode":"create"}` or `{"mode":"join"}`.
///
/// * `create` — the publisher's mode. The room is recorded if this relay has never seen that id,
///   and the answer carries `created`, which is how a desktop that expected to *find* a room
///   learns that it just made one.
/// * `join` — the replica's mode. The room must exist (on record, or alive because a peer is in
///   it), and otherwise the answer is `404 room_unknown`. **This is the fix**: a wrong token
///   derives a different room id, that id names nothing anybody has ever created, and the caller
///   is told so instead of being handed a fresh empty room that looks exactly like "nobody is
///   publishing right now".
///
/// The mode is required and has no default. A default would be the old silent behaviour wearing a
/// new route's name — a client that forgot the field would keep failing invisibly, which is the
/// bug this route exists to end. `PROTOCOL.md` §5 puts a changed transport contract in a new route
/// version; `/v1` keeps the old meaning for clients built before this one, and `up`/`down` are
/// unchanged routes because nothing about them changed.
/// </summary>
internal static class JoinV2Endpoint
{
    /// <summary>`{"mode":"join"}` is 16 bytes. The cap is here because the relay sets
    /// `MaxRequestBodySize = null` for the frame stream's sake, so every other body is bounded by
    /// its own handler.</summary>
    private const int MaxBodyBytes = 256;

    public static async Task PostAsync(HttpContext context)
    {
        var roomId = HttpJson.RouteRoomId(context);
        if (!RoomId.IsValid(roomId))
        {
            await HttpJson.ErrorAsync(context, StatusCodes.Status404NotFound, "invalid_room_id");
            return;
        }

        var limiter = context.RequestServices.GetRequiredService<JoinLimiter>();
        if (!limiter.TryTake(HttpJson.SourceAddress(context)))
        {
            await HttpJson.ErrorAsync(context, StatusCodes.Status429TooManyRequests, "rate_limited");
            return;
        }

        var (status, mode) = await ReadModeAsync(context.Request.Body, context.RequestAborted);
        switch (status)
        {
            case JoinModeStatus.TooLong:
                await HttpJson.ErrorAsync(context, StatusCodes.Status413PayloadTooLarge, "body_too_large");
                return;
            case JoinModeStatus.Unreadable:
            case JoinModeStatus.BadMode:
                await HttpJson.ErrorAsync(context, StatusCodes.Status400BadRequest, "bad_mode");
                return;
        }

        var registry = context.RequestServices.GetRequiredService<RoomRegistry>();
        var outcome = registry.Join(roomId!, mode, out var peer, out var created);
        switch (outcome)
        {
            case JoinOutcome.Ok:
                await HttpJson.WriteAsync(
                    context,
                    new JoinV2Response { Peer = peer!.Id, Created = created },
                    RelayJsonContext.Default.JoinV2Response,
                    StatusCodes.Status200OK);
                return;
            case JoinOutcome.RoomUnknown:
                await HttpJson.ErrorAsync(context, StatusCodes.Status404NotFound, "room_unknown");
                return;
            case JoinOutcome.RoomFull:
                await HttpJson.ErrorAsync(context, StatusCodes.Status429TooManyRequests, "room_full");
                return;
            default:
                await HttpJson.ErrorAsync(context, StatusCodes.Status429TooManyRequests, "too_many_rooms");
                return;
        }
    }

    internal static async Task<(JoinModeStatus Status, JoinMode Mode)> ReadModeAsync(Stream body, CancellationToken token)
    {
        var buffer = new byte[MaxBodyBytes + 1];
        var total = 0;
        while (total < buffer.Length)
        {
            var read = await body.ReadAsync(buffer.AsMemory(total, buffer.Length - total), token);
            if (read == 0) break;
            total += read;
        }

        if (total > MaxBodyBytes) return (JoinModeStatus.TooLong, default);

        try
        {
            var request = JsonSerializer.Deserialize(buffer.AsSpan(0, total), RelayJsonContext.Default.JoinModeRequest);
            return request?.Mode switch
            {
                "create" => (JoinModeStatus.Ok, JoinMode.Create),
                "join" => (JoinModeStatus.Ok, JoinMode.Join),
                _ => (JoinModeStatus.BadMode, default),
            };
        }
        catch (JsonException)
        {
            return (JoinModeStatus.Unreadable, default);
        }
    }
}
