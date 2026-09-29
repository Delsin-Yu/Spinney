namespace SpinneyRelay;

internal static class RelayEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/healthz", HealthEndpoint.GetAsync);
        app.MapPost("/v1/room/{roomId}/join", JoinEndpoint.PostAsync);
        app.MapPost("/v2/room/{roomId}/join", JoinV2Endpoint.PostAsync);
        app.MapGet("/v1/room/{roomId}/down", DownEndpoint.GetAsync);
        app.MapPost("/v1/room/{roomId}/up", UpEndpoint.PostAsync);
    }
}
