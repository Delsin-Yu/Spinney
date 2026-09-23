using Microsoft.AspNetCore.Http.Features;

namespace SpinneyRelay;

internal static class RelayApp
{
    public static WebApplication Build(Limits limits, string urls, string? configuration = null, Action<ILoggingBuilder>? configureLogging = null)
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.Logging.AddSimpleConsole(options =>
        {
            options.SingleLine = true;
            options.TimestampFormat = "HH:mm:ss ";
        });
        builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
        configureLogging?.Invoke(builder.Logging);

        builder.WebHost.UseUrls(urls);
        builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = null);

        builder.Services.AddSingleton(limits);
        builder.Services.AddSingleton<RoomRegistry>();
        builder.Services.AddHostedService<RelaySweeper>();

        var app = builder.Build();
        if (configuration is not null) RelayLog.Configuration(app.Logger, configuration);
        RelayLog.Listening(app.Logger, urls);
        RelayLog.Configured(app.Logger, CommandLine.Describe(limits));

        app.Use(RequestErrors);
        RelayEndpoints.Map(app);
        return app;
    }

    private static async Task RequestErrors(HttpContext context, RequestDelegate next)
    {
        await next(context);
        if (context.Response.StatusCode < 400) return;

        var logger = context.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("Relay.Requests");
        RelayLog.RequestFailed(logger, context.Response.StatusCode, context.Request.Method, RouteTemplate(context));
    }

    private static string RouteTemplate(HttpContext context) =>
        context.GetEndpoint() is RouteEndpoint endpoint ? endpoint.RoutePattern.RawText ?? "unmatched" : "unmatched";
}
