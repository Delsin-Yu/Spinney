using Microsoft.AspNetCore.Http.Features;

namespace SpinneyRelay;

internal static class DownEndpoint
{
    private static readonly byte[] Ping = ": ping\n\n"u8.ToArray();

    public static async Task GetAsync(HttpContext context)
    {
        var roomId = HttpJson.RouteRoomId(context);
        if (!RoomId.IsValid(roomId)) { await HttpJson.ErrorAsync(context, StatusCodes.Status404NotFound, "invalid_room_id"); return; }

        var registry = context.RequestServices.GetRequiredService<RoomRegistry>();
        var peer = registry.FindPeer(roomId!, HttpJson.QueryPeerId(context));
        if (peer is null) { await HttpJson.ErrorAsync(context, StatusCodes.Status404NotFound, "unknown_peer"); return; }

        var limits = context.RequestServices.GetRequiredService<Limits>();
        var response = context.Response;
        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = "text/event-stream";
        response.Headers.CacheControl = "no-store";
        response.Headers["X-Accel-Buffering"] = "no";
        context.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

        var down = peer.AttachDown(context.RequestAborted);
        try
        {
            await response.Body.FlushAsync(down.Token);

            // The pinger only enqueues; this loop stays the single writer of the body, and the
            // finally below cancels the token that ends the pinger.
            _ = PingAsync(peer, limits.HeartbeatSeconds, down.Token);

            while (true)
            {
                var segment = await peer.Outbox.DequeueAsync(down.Token);
                if (segment is null) break;
                await response.Body.WriteAsync(segment, down.Token);
                await response.Body.FlushAsync(down.Token);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (IOException)
        {
        }
        finally
        {
            peer.DetachDown(down);
            down.Cancel();
        }
    }

    private static async Task PingAsync(Peer peer, int heartbeatSeconds, CancellationToken token)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(heartbeatSeconds));
        try
        {
            while (await timer.WaitForNextTickAsync(token))
            {
                if (!peer.Outbox.TryEnqueue(Ping)) break;
            }
        }
        catch (OperationCanceledException)
        {
        }
    }
}
