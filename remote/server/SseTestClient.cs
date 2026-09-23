using System.Text;
using System.Threading.Channels;

namespace SpinneyRelay;

internal sealed class SseTestClient : IAsyncDisposable
{
    private readonly HttpResponseMessage _response;
    private readonly Channel<string> _events = Channel.CreateUnbounded<string>();
    private readonly CancellationTokenSource _cancellation = new();
    private readonly Task _reader;
    private int _ping;
    private int _ended;

    private SseTestClient(HttpResponseMessage response)
    {
        _response = response;
        _reader = ReadAsync();
    }

    public int StatusCode => (int)_response.StatusCode;

    public string? ContentType => _response.Content.Headers.ContentType?.ToString();

    public string? CacheControl => _response.Headers.CacheControl?.ToString();

    public bool SawPing => Volatile.Read(ref _ping) != 0;

    public bool Ended => Volatile.Read(ref _ended) != 0;

    public static async Task<SseTestClient> OpenAsync(HttpClient http, string path)
    {
        var response = await http.GetAsync(path, HttpCompletionOption.ResponseHeadersRead);
        if (!response.IsSuccessStatusCode)
        {
            var status = (int)response.StatusCode;
            response.Dispose();
            throw new InvalidOperationException($"down request returned {status}");
        }

        return new SseTestClient(response);
    }

    public async Task<string?> NextDataAsync(TimeSpan timeout)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(_cancellation.Token);
        deadline.CancelAfter(timeout);
        try
        {
            return await _events.Reader.ReadAsync(deadline.Token);
        }
        catch (OperationCanceledException)
        {
            return null;
        }
        catch (ChannelClosedException)
        {
            return null;
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _cancellation.CancelAsync();
        _response.Dispose();
        try
        {
            await _reader;
        }
        catch (Exception)
        {
        }

        _cancellation.Dispose();
    }

    private async Task ReadAsync()
    {
        var buffer = new byte[8192];
        var pending = new List<byte>(8192);
        try
        {
            var stream = await _response.Content.ReadAsStreamAsync(_cancellation.Token);
            while (true)
            {
                var read = await stream.ReadAsync(buffer, _cancellation.Token);
                if (read == 0) break;
                for (var i = 0; i < read; i++) pending.Add(buffer[i]);

                while (true)
                {
                    var end = IndexOfBlankLine(pending);
                    if (end < 0) break;
                    var block = Encoding.UTF8.GetString(pending.ToArray(), 0, end);
                    pending.RemoveRange(0, end + 2);
                    Dispatch(block);
                }
            }
        }
        catch (Exception)
        {
        }
        finally
        {
            Volatile.Write(ref _ended, 1);
            _events.Writer.TryComplete();
        }
    }

    private void Dispatch(string block)
    {
        if (block.StartsWith(':'))
        {
            Volatile.Write(ref _ping, 1);
            return;
        }

        if (block.StartsWith("data: ", StringComparison.Ordinal))
        {
            _events.Writer.TryWrite(block[6..]);
        }
    }

    private static int IndexOfBlankLine(List<byte> data)
    {
        for (var i = 0; i + 1 < data.Count; i++)
        {
            if (data[i] == (byte)'\n' && data[i + 1] == (byte)'\n') return i;
        }

        return -1;
    }
}
