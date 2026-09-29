namespace SpinneyRelay;

/// <summary>
/// A per-source-address brake on the join routes.
///
/// The relay now answers "this room does not exist" (`room_unknown`), and that answer is exactly
/// the thing a candidate token can be tested against: derive a room id, ask, and the status code
/// says whether anybody has ever used it. The derivation itself costs the asker 600000 PBKDF2
/// iterations (`PROTOCOL.md` §3) — hundreds of milliseconds of their CPU per guess — and this
/// bucket is the other half of that: a guesser who wants to walk a dictionary needs both the CPU
/// *and* the patience, while a device that joins once when it opens does not notice it.
///
/// Keyed by source address, because a peer id does not exist yet at join time. The table is
/// bounded: an attacker cycling addresses must not be able to grow it, so once it is full the
/// oldest entries are dropped — a dropped bucket only means a fresh burst for whoever held it,
/// which is the graceful half of a brake that has run out of room.
/// </summary>
internal sealed class JoinLimiter
{
    private const int MaxTracked = 2048;
    private const int IdleDropMs = 10 * 60 * 1000;

    private readonly Dictionary<string, Entry> _buckets = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private readonly Limits _limits;

    public JoinLimiter(Limits limits) => _limits = limits;

    /// <summary>May this source join now? <c>false</c> is answered with 429 <c>rate_limited</c>.</summary>
    public bool TryTake(string? source)
    {
        var key = string.IsNullOrEmpty(source) ? "unknown" : source;
        lock (_gate)
        {
            var now = Environment.TickCount64;
            if (!_buckets.TryGetValue(key, out var entry))
            {
                if (_buckets.Count >= MaxTracked) EvictOldestLocked(MaxTracked / 4);
                entry = new Entry(new TokenBucket(_limits.JoinRatePerSecond, _limits.JoinRateBurst));
                _buckets[key] = entry;
            }

            entry.LastMs = now;
            return entry.Bucket.TryTake();
        }
    }

    /// <summary>Forget sources that have not knocked in a while. Called by the sweeper.</summary>
    public void Sweep()
    {
        lock (_gate)
        {
            var now = Environment.TickCount64;
            var stale = new List<string>();
            foreach (var (key, entry) in _buckets)
            {
                if (now - entry.LastMs > IdleDropMs) stale.Add(key);
            }

            foreach (var key in stale) _buckets.Remove(key);
        }
    }

    private void EvictOldestLocked(int howMany)
    {
        foreach (var key in _buckets.OrderBy(entry => entry.Value.LastMs).Take(howMany).Select(entry => entry.Key).ToList())
        {
            _buckets.Remove(key);
        }
    }

    private sealed class Entry(TokenBucket bucket)
    {
        public TokenBucket Bucket { get; } = bucket;

        public long LastMs { get; set; }
    }
}
