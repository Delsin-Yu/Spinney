namespace SpinneyRelay;

internal sealed class TokenBucket
{
    private readonly object _gate = new();
    private readonly double _ratePerSecond;
    private readonly double _burst;
    private double _tokens;
    private long _lastMs;

    public TokenBucket(double ratePerSecond, double burst)
    {
        _ratePerSecond = ratePerSecond;
        _burst = burst;
        _tokens = burst;
        _lastMs = Environment.TickCount64;
    }

    public bool TryTake()
    {
        lock (_gate)
        {
            var now = Environment.TickCount64;
            var elapsedSeconds = (now - _lastMs) / 1000.0;
            if (elapsedSeconds > 0)
            {
                _tokens = Math.Min(_burst, _tokens + elapsedSeconds * _ratePerSecond);
                _lastMs = now;
            }

            if (_tokens < 1) return false;
            _tokens -= 1;
            return true;
        }
    }
}
