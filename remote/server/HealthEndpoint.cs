namespace SpinneyRelay;

internal static class HealthEndpoint
{
    public static Task GetAsync(HttpContext context)
    {
        var registry = context.RequestServices.GetRequiredService<RoomRegistry>();
        var (rooms, peers) = registry.Counts();
        var response = new HealthResponse
        {
            Ok = true,
            Rooms = rooms,
            Peers = peers,
            UptimeMs = registry.UptimeMs,
        };
        return HttpJson.WriteAsync(context, response, RelayJsonContext.Default.HealthResponse, StatusCodes.Status200OK);
    }
}
