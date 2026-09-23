using Microsoft.Extensions.Configuration;

namespace SpinneyRelay;

internal sealed class ConfigurationSources
{
    public const string FileName = "appsettings.json";

    private readonly IConfiguration _configuration;

    private ConfigurationSources(IConfiguration configuration, string filePath, bool found)
    {
        _configuration = configuration;
        FilePath = filePath;
        Found = found;
    }

    public string FilePath { get; }

    public bool Found { get; }

    public string Note => Found
        ? $"{FileName} loaded from {FilePath}"
        : $"{FileName} not found in {FilePath} (built-in defaults in force)";

    public static ConfigurationSources? TryLoad(string baseDirectory, out string? error)
    {
        var filePath = Path.Combine(baseDirectory, FileName);
        try
        {
            var configuration = new ConfigurationBuilder()
                .SetBasePath(baseDirectory)
                .AddJsonFile(FileName, optional: true, reloadOnChange: false)
                .AddEnvironmentVariables()
                .Build();
            error = null;
            return new ConfigurationSources(configuration, filePath, File.Exists(filePath));
        }
        catch (Exception exception)
        {
            error = $"{FileName} could not be read: {exception.Message}";
            return null;
        }
    }

    public string? Get(string key) => _configuration[key];
}
