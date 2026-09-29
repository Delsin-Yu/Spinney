namespace SpinneyRelay;

/// <summary>
/// `POST /v1/room/{roomId}/join` — the original contract, unchanged in meaning: any well-formed
/// room id is accepted, and the room is created if nobody had used that id before.
///
/// A wrong token therefore still produces a live empty room here, and that is on purpose: a
/// client built before `/v2` exists must keep working, and the versioning doctrine
/// (`remote/PROTOCOL.md` §5) puts a changed transport contract in a new route rather than in a
/// flag on the old one. What this route *does* gain is the per-address brake and a room record —
/// an old client's room must be joinable by a new phone, so a successful v1 join is recorded.
/// </summary>
internal static class JoinEndpoint
{
    public static Task PostAsync(HttpContext context)
    {
        var roomId = HttpJson.RouteRoomId(context);
        if (!RoomId.IsValid(roomId)) return HttpJson.ErrorAsync(context, StatusCodes.Status404NotFound, "invalid_room_id");

        var limiter = context.RequestServices.GetRequiredService<JoinLimiter>();
        if (!limiter.TryTake(HttpJson.SourceAddress(context)))
        {
            return HttpJson.ErrorAsync(context, StatusCodes.Status429TooManyRequests, "rate_limited");
        }

        var registry = context.RequestServices.GetRequiredService<RoomRegistry>();
        var outcome = registry.Join(roomId!, JoinMode.Create, out var peer, out _);
        return outcome switch
        {
            JoinOutcome.Ok => HttpJson.WriteAsync(
                context,
                new JoinResponse { Peer = peer!.Id },
                RelayJsonContext.Default.JoinResponse,
                StatusCodes.Status200OK),
            JoinOutcome.RoomUnknown => HttpJson.ErrorAsync(context, StatusCodes.Status404NotFound, "room_unknown"),
            JoinOutcome.RoomFull => HttpJson.ErrorAsync(context, StatusCodes.Status429TooManyRequests, "room_full"),
            _ => HttpJson.ErrorAsync(context, StatusCodes.Status429TooManyRequests, "too_many_rooms"),
        };
    }
}
