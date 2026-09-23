namespace SpinneyRelay;

internal static class JoinEndpoint
{
    public static Task PostAsync(HttpContext context)
    {
        var roomId = HttpJson.RouteRoomId(context);
        if (!RoomId.IsValid(roomId)) return HttpJson.ErrorAsync(context, StatusCodes.Status404NotFound, "invalid_room_id");

        var registry = context.RequestServices.GetRequiredService<RoomRegistry>();
        var outcome = registry.Join(roomId!, out var peer);
        return outcome switch
        {
            JoinOutcome.Ok => HttpJson.WriteAsync(
                context,
                new JoinResponse { Peer = peer!.Id },
                RelayJsonContext.Default.JoinResponse,
                StatusCodes.Status200OK),
            JoinOutcome.RoomFull => HttpJson.ErrorAsync(context, StatusCodes.Status429TooManyRequests, "room_full"),
            _ => HttpJson.ErrorAsync(context, StatusCodes.Status429TooManyRequests, "too_many_rooms"),
        };
    }
}
