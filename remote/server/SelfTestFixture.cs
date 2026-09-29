using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Logging.Console;

namespace SpinneyRelay;

internal sealed class SelfTestFixture : IAsyncDisposable
{
    private static readonly char[] Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".ToCharArray();

    private readonly WebApplication _app;
    private readonly RecordingLoggerProvider _recorder;
    private readonly List<string> _roomIds = new();
    private readonly List<string> _peerIds = new();

    private SelfTestFixture(WebApplication app, RecordingLoggerProvider recorder, string baseAddress, Limits limits)
    {
        _app = app;
        _recorder = recorder;
        Limits = limits;
        BaseAddress = baseAddress;
        Http = new HttpClient { BaseAddress = new Uri(baseAddress), Timeout = TimeSpan.FromSeconds(60) };
    }

    public Limits Limits { get; }

    public HttpClient Http { get; }

    public string BaseAddress { get; }

    public IReadOnlyList<string> RoomIds => _roomIds;

    public IReadOnlyList<string> PeerIds => _peerIds;

    /// <summary>
    /// Start a relay in process. <paramref name="limits"/> defaults to the shared self-test
    /// limits; a case that needs a different shape (a tight join brake, a tiny ledger) starts its
    /// own relay rather than making every other case live with that shape.
    /// </summary>
    public static async Task<SelfTestFixture> StartAsync(Limits? limits = null)
    {
        var effective = limits ?? Limits.SelfTest;
        var recorder = new RecordingLoggerProvider();
        var app = RelayApp.Build(effective, effective.Urls, configureLogging: logging =>
        {
            logging.SetMinimumLevel(LogLevel.Debug);
            logging.AddFilter<ConsoleLoggerProvider>(null, LogLevel.Warning);
            logging.AddProvider(recorder);
        });

        await app.StartAsync();

        var addresses = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>();
        var baseAddress = addresses?.Addresses.FirstOrDefault() ?? app.Urls.First();
        return new SelfTestFixture(app, recorder, baseAddress, effective);
    }

    public string NewRoomId()
    {
        var characters = new char[RoomId.Length];
        for (var i = 0; i < characters.Length; i++) characters[i] = Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)];
        var roomId = new string(characters);
        _roomIds.Add(roomId);
        return roomId;
    }

    public async Task<(int Status, string? PeerId)> JoinAsync(string roomId)
    {
        using var response = await Http.PostAsync($"/v1/room/{roomId}/join", null);
        var body = await response.Content.ReadAsStringAsync();
        string? peerId = null;
        if (response.IsSuccessStatusCode)
        {
            using var document = JsonDocument.Parse(body);
            peerId = document.RootElement.GetProperty("peer").GetString();
            if (peerId is not null) _peerIds.Add(peerId);
        }

        return ((int)response.StatusCode, peerId);
    }

    /// <summary>
    /// `POST /v2/room/{roomId}/join` with a mode. Returns the whole answer, because the mode cases
    /// care about all of it: the status, the peer, whether the room was *created*, and the error.
    /// </summary>
    public async Task<(int Status, string? PeerId, bool Created, string? Error)> JoinV2Async(string roomId, string mode)
    {
        var content = new StringContent($"{{\"mode\":\"{mode}\"}}", Encoding.UTF8, "application/json");
        using var response = await Http.PostAsync($"/v2/room/{roomId}/join", content);
        return await ReadJoinV2Async(response);
    }

    /// <summary>A raw v2 join body, for the cases that send something other than a mode.</summary>
    public async Task<(int Status, string? PeerId, bool Created, string? Error)> PostJoinV2RawAsync(string roomId, byte[] body, bool omitContentType = false)
    {
        var content = new ByteArrayContent(body);
        if (!omitContentType) content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        using var response = await Http.PostAsync($"/v2/room/{roomId}/join", content);
        return await ReadJoinV2Async(response);
    }

    private async Task<(int Status, string? PeerId, bool Created, string? Error)> ReadJoinV2Async(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        string? peerId = null;
        var created = false;
        string? error = null;
        using (var document = JsonDocument.Parse(body))
        {
            if (response.IsSuccessStatusCode)
            {
                peerId = document.RootElement.GetProperty("peer").GetString();
                created = document.RootElement.GetProperty("created").GetBoolean();
                if (peerId is not null) _peerIds.Add(peerId);
            }
            else
            {
                error = document.RootElement.GetProperty("error").GetString();
            }
        }

        return ((int)response.StatusCode, peerId, created, error);
    }

    public async Task<int> PostUpAsync(string roomId, string peerId, byte[] body)
    {
        using var response = await PostUpRawAsync(roomId, peerId, body);
        return (int)response.StatusCode;
    }

    public Task<HttpResponseMessage> PostUpRawAsync(string roomId, string peerId, byte[] body)
    {
        var content = new ByteArrayContent(body);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        return Http.PostAsync($"/v1/room/{roomId}/up?peer={peerId}", content);
    }

    public async Task<SseTestClient> OpenDownAsync(string roomId, string peerId) =>
        await SseTestClient.OpenAsync(Http, $"/v1/room/{roomId}/down?peer={peerId}");

    public async Task<int> DownStatusAsync(string roomId, string peerId)
    {
        using var response = await Http.GetAsync($"/v1/room/{roomId}/down?peer={peerId}", HttpCompletionOption.ResponseHeadersRead);
        return (int)response.StatusCode;
    }

    public async Task<Health> HealthAsync()
    {
        using var response = await Http.GetAsync("/healthz");
        var body = await response.Content.ReadAsStringAsync();
        return new Health((int)response.StatusCode, body, response.Content.Headers.ContentType?.MediaType);
    }

    public IReadOnlyList<string> LogSnapshot() => _recorder.Snapshot();

    public async Task<bool> WaitUntilAsync(Func<Task<bool>> condition, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (await condition()) return true;
            await Task.Delay(100);
        }

        return await condition();
    }

    public async ValueTask DisposeAsync()
    {
        Http.Dispose();
        await _app.StopAsync();
        await _app.DisposeAsync();

        // The ledger is a file the relay writes; a test process must not leave one behind (and must
        // not inherit the next run's). Only the temp paths the self-test presets use are removed —
        // a fixture pointed at a real path keeps its hands off it.
        var ledger = Path.IsPathRooted(Limits.RoomRecordsFile)
            ? Limits.RoomRecordsFile
            : Path.Combine(AppContext.BaseDirectory, Limits.RoomRecordsFile);
        if (!ledger.Contains("spinney-selftest-", StringComparison.Ordinal)) return;

        foreach (var path in new[] { ledger, ledger + ".tmp" })
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch (IOException)
            {
            }
        }
    }
}

internal sealed class Health : IDisposable
{
    private readonly JsonDocument _document;

    public Health(int status, string raw, string? contentType)
    {
        Status = status;
        Raw = raw;
        ContentType = contentType;
        _document = JsonDocument.Parse(raw);
    }

    public int Status { get; }

    public string Raw { get; }

    public string? ContentType { get; }

    public JsonElement Root => _document.RootElement;

    public bool Ok => Root.GetProperty("ok").GetBoolean();

    public int Rooms => Root.GetProperty("rooms").GetInt32();

    public int Peers => Root.GetProperty("peers").GetInt32();

    public long UptimeMs => Root.GetProperty("uptimeMs").GetInt64();

    public string KeyList => string.Join(",", Root.EnumerateObject().Select(property => property.Name));

    public bool IsIntegral(string name) =>
        Root.GetProperty(name).ValueKind == JsonValueKind.Number && Root.GetProperty(name).TryGetInt64(out _);

    public void Dispose() => _document.Dispose();
}
