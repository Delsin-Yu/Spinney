namespace SpinneyRelay;

internal sealed class PeerOutbox
{
    private readonly object _gate = new();
    private readonly Queue<byte[]> _segments = new();
    private readonly SemaphoreSlim _signal = new(0);
    private readonly long _maxBytes;
    private long _bytes;
    private bool _closed;

    public PeerOutbox(long maxBytes) => _maxBytes = maxBytes;

    public long PendingBytes
    {
        get
        {
            lock (_gate) return _bytes;
        }
    }

    public bool TryEnqueue(byte[] segment)
    {
        lock (_gate)
        {
            if (_closed) return false;
            if (_bytes + segment.Length > _maxBytes) return false;
            _segments.Enqueue(segment);
            _bytes += segment.Length;
        }

        _signal.Release();
        return true;
    }

    public async ValueTask<byte[]?> DequeueAsync(CancellationToken cancellationToken)
    {
        await _signal.WaitAsync(cancellationToken);
        lock (_gate)
        {
            if (_segments.Count == 0) return null;
            var segment = _segments.Dequeue();
            _bytes -= segment.Length;
            return segment;
        }
    }

    public void Close()
    {
        lock (_gate)
        {
            if (_closed) return;
            _closed = true;
            _segments.Clear();
            _bytes = 0;
        }

        _signal.Release();
    }
}
