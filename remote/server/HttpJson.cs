using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

namespace SpinneyRelay;

internal static class HttpJson
{
    public static async Task WriteAsync<T>(HttpContext context, T value, JsonTypeInfo<T> typeInfo, int statusCode)
    {
        context.Response.StatusCode = statusCode;
        context.Response.ContentType = "application/json";
        await JsonSerializer.SerializeAsync(context.Response.Body, value, typeInfo, context.RequestAborted);
    }

    public static Task ErrorAsync(HttpContext context, int statusCode, string error) =>
        WriteAsync(context, new ErrorResponse { Error = error }, RelayJsonContext.Default.ErrorResponse, statusCode);

    public static string? RouteRoomId(HttpContext context) => context.Request.RouteValues["roomId"] as string;

    public static string QueryPeerId(HttpContext context) => context.Request.Query["peer"].ToString();

    /// <summary>The source address, for the per-address join brake. Never logged.</summary>
    public static string? SourceAddress(HttpContext context) => context.Connection.RemoteIpAddress?.ToString();
}
