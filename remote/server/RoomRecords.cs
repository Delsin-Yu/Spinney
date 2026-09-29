using System.Text.Json;

namespace SpinneyRelay;

internal enum RoomRecordOutcome
{
    /// <summary>The room had no record and now has one: this is the room's first member.</summary>
    Created,

    /// <summary>The room already existed — this token has been used on this relay before.</summary>
    Existing,

    /// <summary>The ledger is at <see cref="Limits.MaxRoomRecords"/> and this room is not in it.</summary>
    Full,
}

/// <summary>
/// Which rooms exist, as far as this relay is concerned.
///
/// Before this class the relay had no such notion: <see cref="RoomRegistry"/> created a room the
/// moment anybody joined any well-formed id and deleted it when the last peer left, so *every*
/// token "worked", and a wrong one produced a live, silent, empty room. `remote/PROTOCOL.md` §3
/// said so as an axiom — "a wrong token is not an error, it is an empty room" — and the cost was
/// that two devices sitting in two different rooms could not tell that situation apart from a
/// room nobody had published in yet: not from the phone, not from the desktop, not from the UI.
/// It took the relay's aggregate counts to see it at all.
///
/// A record is that missing fact, and nothing else: **the room id — an id the relay already sees,
/// as the join path — and when it was last used.** No token (the relay has never seen one), no
/// content, no peer, no room name. It is what lets a join naming a room this relay has never
/// heard of be *refused*, instead of answered with a fresh empty room.
///
/// Two consequences, stated here because they are choices and not accidents:
///
/// * a record outlives its last peer, so a phone can still join a room whose desktop is asleep —
///   which means the relay remembers, across restarts, that a room existed. The file is
///   <see cref="Limits.RoomRecordsFile"/>, written atomically.
/// * a record expires after <see cref="Limits.RoomRecordTtlDays"/> without a join, so the
///   metadata decays instead of accumulating; the next desktop connect re-creates it.
///
/// This is **not** an authentication mechanism. Anyone may send `mode=create`, because in this
/// design the token is the whole of the authority and whoever holds it *is* the room
/// (`PROTOCOL.md` §3). The record buys a legible failure, not a closed door.
/// </summary>
internal sealed class RoomRecords
{
    /// <summary>How long a mutation may wait before it is written out. A join is a rare event and
    /// the file is small; the throttle only keeps a burst of joins from doing one write each.</summary>
    private const int SaveThrottleMs = 5000;

    private readonly Dictionary<string, long> _records = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private readonly Limits _limits;
    private readonly ILogger _logger;
    private bool _dirty;
    private long _lastSavedMs;

    public RoomRecords(Limits limits, ILogger<RoomRecords> logger)
    {
        _limits = limits;
        _logger = logger;
        FilePath = Path.IsPathRooted(limits.RoomRecordsFile)
            ? limits.RoomRecordsFile
            : Path.Combine(AppContext.BaseDirectory, limits.RoomRecordsFile);
    }

    /// <summary>Where the ledger lives — for the startup line, and for the tests.</summary>
    public string FilePath { get; }

    /// <summary>Rooms on record. Logged, never served: a count is not an id.</summary>
    public int Count
    {
        get
        {
            lock (_gate) return _records.Count;
        }
    }

    /// <summary>
    /// Read the file once, at startup. A missing file is the normal first run. A file that cannot
    /// be read or parsed is *loud* — it is the one failure that would silently turn every room
    /// into an unknown one — and the ledger starts empty rather than guessing.
    /// </summary>
    public void Load()
    {
        if (!File.Exists(FilePath))
        {
            RelayLog.RoomRecordsLoaded(_logger, 0, FilePath);
            return;
        }

        try
        {
            using var stream = File.OpenRead(FilePath);
            var file = JsonSerializer.Deserialize(stream, RelayJsonContext.Default.RoomRecordsFile);
            int count;
            lock (_gate)
            {
                _records.Clear();
                foreach (var (roomId, lastUsed) in file?.Rooms ?? new Dictionary<string, long>())
                {
                    if (RoomId.IsValid(roomId)) _records[roomId] = lastUsed;
                }

                var expired = PruneExpiredLocked(NowSeconds());
                if (expired > 0) _dirty = true;
                count = _records.Count;
            }

            RelayLog.RoomRecordsLoaded(_logger, count, FilePath);
        }
        catch (Exception exception)
        {
            RelayLog.RoomRecordsUnreadable(_logger, exception.Message, FilePath);
        }
    }

    /// <summary>Is this a room the relay has on record, and not expired? Never mutates.</summary>
    public bool Exists(string roomId)
    {
        lock (_gate)
        {
            return _records.TryGetValue(roomId, out var lastUsed) && !Expired(lastUsed, NowSeconds());
        }
    }

    /// <summary>
    /// `mode=create`: the caller says "this room is mine; make it exist". Idempotent — a second
    /// window of the same desktop gets <see cref="RoomRecordOutcome.Existing"/>, which is what
    /// tells it that this token has been used on this relay before.
    /// </summary>
    public RoomRecordOutcome Ensure(string roomId)
    {
        RoomRecordOutcome outcome;
        int count;
        lock (_gate)
        {
            var now = NowSeconds();
            if (_records.TryGetValue(roomId, out var lastUsed) && !Expired(lastUsed, now))
            {
                _records[roomId] = now;
                outcome = RoomRecordOutcome.Existing;
            }
            else if (_records.Count >= _limits.MaxRoomRecords)
            {
                count = _records.Count;
                RelayLog.RoomRecordsFull(_logger, count, RelayLog.Tag(roomId));
                return RoomRecordOutcome.Full;
            }
            else
            {
                _records[roomId] = now;
                outcome = RoomRecordOutcome.Created;
            }

            _dirty = true;
            count = _records.Count;
        }

        RelayLog.RoomRecordSaved(_logger, outcome == RoomRecordOutcome.Created, RelayLog.Tag(roomId), count, _limits.RoomRecordTtlDays);
        return outcome;
    }

    /// <summary>Refresh a record that a join just proved is in use.</summary>
    public void Touch(string roomId)
    {
        lock (_gate)
        {
            if (!_records.ContainsKey(roomId)) return;
            _records[roomId] = NowSeconds();
            _dirty = true;
        }
    }

    /// <summary>
    /// Drop what aged out, keep the ledger inside its cap, and write it out if anything changed.
    ///
    /// This is the ledger's only flush point, and it is deliberately a *sweep* rather than a write
    /// on every mutation: a join must not do disk I/O, and it must certainly not do it while the
    /// registry's lock is held. The sweeper runs every second and <see cref="Save"/> throttles
    /// itself, so a joined room reaches the file within a few seconds, and a crash in between
    /// loses a refresh (the record's expiry moves) but never a room.
    /// </summary>
    public void Prune()
    {
        int removed;
        int count;
        lock (_gate)
        {
            removed = PruneExpiredLocked(NowSeconds());
            var overflow = _records.Count - _limits.MaxRoomRecords;
            if (overflow > 0)
            {
                foreach (var roomId in _records.OrderBy(entry => entry.Value).Take(overflow).Select(entry => entry.Key).ToList())
                {
                    _records.Remove(roomId);
                }

                removed += overflow;
            }

            if (removed > 0) _dirty = true;
            count = _records.Count;
        }

        if (removed > 0) RelayLog.RoomRecordsPruned(_logger, removed, count, _limits.RoomRecordTtlDays);
        Save(force: false);
    }

    /// <summary>Write the ledger out — atomically (temp file + move), throttled unless <paramref name="force"/>.</summary>
    public void Save(bool force)
    {
        string json;
        lock (_gate)
        {
            if (!_dirty) return;
            var now = Environment.TickCount64;
            if (!force && now - _lastSavedMs < SaveThrottleMs) return;

            var file = new RoomRecordsFile
            {
                Version = 1,
                Rooms = new Dictionary<string, long>(_records, StringComparer.Ordinal),
            };
            json = JsonSerializer.Serialize(file, RelayJsonContext.Default.RoomRecordsFile);
            _dirty = false;
            _lastSavedMs = now;
        }

        try
        {
            var temporary = FilePath + ".tmp";
            File.WriteAllText(temporary, json);
            File.Move(temporary, FilePath, overwrite: true);
        }
        catch (Exception exception)
        {
            RelayLog.RoomRecordsUnwritable(_logger, exception.Message, FilePath);
        }
    }

    private int PruneExpiredLocked(long now)
    {
        var expired = new List<string>();
        foreach (var (roomId, lastUsed) in _records)
        {
            if (Expired(lastUsed, now)) expired.Add(roomId);
        }

        foreach (var roomId in expired) _records.Remove(roomId);
        return expired.Count;
    }

    private bool Expired(long lastUsed, long now) => now - lastUsed > _limits.RoomRecordTtlDays * 86400L;

    private static long NowSeconds() => DateTimeOffset.UtcNow.ToUnixTimeSeconds();
}
