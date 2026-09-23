namespace SpinneyRelay;

internal sealed class SilentDown : IAsyncDisposable
{
    private readonly HttpResponseMessage _response;

    private SilentDown(HttpResponseMessage response) => _response = response;

    public int StatusCode => (int)_response.StatusCode;

    public static async Task<SilentDown> OpenAsync(HttpClient http, string path)
    {
        var response = await http.GetAsync(path, HttpCompletionOption.ResponseHeadersRead);
        return new SilentDown(response);
    }

    public async Task<bool> EndedAsync(TimeSpan timeout)
    {
        using var deadline = new CancellationTokenSource(timeout);
        try
        {
            var stream = await _response.Content.ReadAsStreamAsync(deadline.Token);
            var buffer = new byte[65536];
            while (true)
            {
                var read = await stream.ReadAsync(buffer, deadline.Token);
                if (read == 0) return true;
            }
        }
        catch (OperationCanceledException)
        {
            return false;
        }
        catch (Exception)
        {
            return true;
        }
    }

    public ValueTask DisposeAsync()
    {
        _response.Dispose();
        return ValueTask.CompletedTask;
    }
}
