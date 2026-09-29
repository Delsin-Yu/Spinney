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
        builder.Services.AddSingleton<RoomRecords>();
        builder.Services.AddSingleton<RoomRegistry>();
        builder.Services.AddSingleton<JoinLimiter>();
        builder.Services.AddHostedService<RelaySweeper>();

        var app = builder.Build();

        // Which rooms exist, read back before the first join can ask. A record that cannot be read
        // fails loudly (RoomRecords.Load logs it) because the failure mode is invisible otherwise:
        // every room would simply look unknown until a publisher re-created it.
        var records = app.Services.GetRequiredService<RoomRecords>();
        records.Load();

        // The sweeper flushes the ledger while the relay runs; this is the last one, so an orderly
        // stop does not cost the refreshes made since the previous sweep.
        app.Services.GetRequiredService<IHostApplicationLifetime>()
            .ApplicationStopping.Register(() => records.Save(force: true));

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
