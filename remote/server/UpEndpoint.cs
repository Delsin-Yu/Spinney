namespace SpinneyRelay;

internal static class UpEndpoint
{
    public static async Task PostAsync(HttpContext context)
    {
        var roomId = HttpJson.RouteRoomId(context);
        if (!RoomId.IsValid(roomId)) { await HttpJson.ErrorAsync(context, StatusCodes.Status404NotFound, "invalid_room_id"); return; }

        var registry = context.RequestServices.GetRequiredService<RoomRegistry>();
        var peer = registry.FindPeer(roomId!, HttpJson.QueryPeerId(context));
        if (peer is null) { await HttpJson.ErrorAsync(context, StatusCodes.Status404NotFound, "unknown_peer"); return; }

        peer.Touch();
        if (!peer.Limit.TryTake())
        {
            await HttpJson.ErrorAsync(context, StatusCodes.Status429TooManyRequests, "rate_limited");
            return;
        }

        var limits = context.RequestServices.GetRequiredService<Limits>();
        var (status, segment) = await FrameReader.ReadAsync(context.Request.Body, limits.MaxFrameBytes, context.RequestAborted);
        if (status != FrameStatus.Ok)
        {
            var (code, error) = status switch
            {
                FrameStatus.Empty => (StatusCodes.Status400BadRequest, "empty_frame"),
                FrameStatus.Newline => (StatusCodes.Status400BadRequest, "frame_contains_newline"),
                _ => (StatusCodes.Status413PayloadTooLarge, "frame_too_large"),
            };
            await HttpJson.ErrorAsync(context, code, error);
            return;
        }

        var recipients = 0;
        foreach (var other in peer.Room.Peers)
        {
            if (ReferenceEquals(other, peer)) continue;
            if (other.Outbox.TryEnqueue(segment!)) { recipients++; continue; }
            registry.DropPeer(other);
        }

        var logger = context.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("Relay.Forward");
        RelayLog.Forwarded(logger, segment!.Length, recipients);

        await HttpJson.WriteAsync(context, new OkResponse { Ok = true }, RelayJsonContext.Default.OkResponse, StatusCodes.Status202Accepted);
    }
}
