using SpinneyRelay;

var invocation = CommandLine.Parse(args);

if (invocation.Help)
{
    Console.WriteLine(CommandLine.Usage);
    return 0;
}

if (invocation.Error is not null)
{
    Console.Error.WriteLine(invocation.Error);
    Console.Error.WriteLine();
    Console.Error.WriteLine(CommandLine.Usage);
    return 2;
}

if (invocation.SelfTest)
{
    return await SelfTest.RunAsync();
}

var sources = ConfigurationSources.TryLoad(AppContext.BaseDirectory, out var configurationError);
if (sources is null)
{
    Console.Error.WriteLine(configurationError);
    return 2;
}

if (!invocation.TryResolveLimits(sources, out var limits, out var limitsError))
{
    Console.Error.WriteLine(limitsError);
    return 2;
}

await using var app = RelayApp.Build(limits, limits.Urls, sources.Note);
await app.RunAsync();
return 0;
