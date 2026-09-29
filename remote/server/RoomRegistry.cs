using System.Collections.Concurrent;

namespace SpinneyRelay;

internal enum JoinOutcome
{
    Ok,
    RoomFull,
    TooManyRooms,

    /// <summary>
    /// `/v2` only, `mode=join`: this relay has no record of that room and no peer is in it. It is
    /// the answer that used to be impossible — see <see cref="RoomRecords"/> — and it is what turns
    /// "wrong token" from an empty room into a sentence.
    /// </summary>
    RoomUnknown,
}

/// <summary>What a join is allowed to do to the room it names.</summary>
internal enum JoinMode
{
    /// <summary>`create`: the caller is a publisher — the room is recorded if it is new. This is
    /// what the `/v1` route does implicitly, and what the desktop asks for explicitly.</summary>
    Create,

    /// <summary>`join`: the caller may only enter a room that exists. This is the phone's mode:
    /// a phone cannot bring a room into being, so a token that names nothing fails loudly.</summary>
    Join,
}

internal sealed class RoomRegistry
{
    private readonly ConcurrentDictionary<string, Room> _rooms = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private readonly Limits _limits;
    private readonly RoomRecords _records;
    private readonly ILogger _logger;

    public RoomRegistry(Limits limits, RoomRecords records, ILogger<RoomRegistry> logger)
    {
        _limits = limits;
        _records = records;
        _logger = logger;
    }

    public long UptimeMs => Environment.TickCount64 - StartedMs;

    private long StartedMs { get; } = Environment.TickCount64;

    /// <summary>Rooms on record. Logged, never served.</summary>
    public int RecordedRooms => _records.Count;

    public (int Rooms, int Peers) Counts()
    {
        var rooms = 0;
        var peers = 0;
        foreach (var room in _rooms.Values)
        {
            rooms++;
            peers += room.Count;
        }

        return (rooms, peers);
    }

    /// <summary>
    /// Enter a room. <paramref name="mode"/> is what decides whether this call may *make* the room
    /// exist, and <paramref name="created"/> answers the desktop's "had anybody used this token
    /// here before?".
    /// </summary>
    public JoinOutcome Join(string roomId, JoinMode mode, out Peer? peer, out bool created)
    {
        peer = null;
        created = false;
        lock (_gate)
        {
            if (mode == JoinMode.Create)
            {
                switch (_records.Ensure(roomId))
                {
                    case RoomRecordOutcome.Full:
                        RelayLog.RoomRecordsFull(_logger, _records.Count, RelayLog.Tag(roomId));
                        return JoinOutcome.TooManyRooms;
                    case RoomRecordOutcome.Created:
                        created = true;
                        break;
                }
            }
            else if (!_records.Exists(roomId) && !_rooms.ContainsKey(roomId))
            {
                // Neither on record nor alive. A room that is live but unrecorded is a room an
                // older client created (the v1 route does not announce itself), and refusing its
                // peers would turn this fix into an outage — so "exists" is record **or** alive.
                RelayLog.JoinRefusedUnknownRoom(_logger, RelayLog.Tag(roomId));
                return JoinOutcome.RoomUnknown;
            }

            if (!_rooms.TryGetValue(roomId, out var room))
            {
                if (_rooms.Count >= _limits.MaxRooms) return JoinOutcome.TooManyRooms;
                room = new Room(roomId);
                _rooms[roomId] = room;
                RelayLog.RoomCreated(_logger, RelayLog.Tag(roomId), _rooms.Count);
            }

            var candidate = new Peer(Ids.NewPeer(), room, _limits);
            if (!room.TryAdd(candidate, _limits.MaxPeersPerRoom)) return JoinOutcome.RoomFull;

            peer = candidate;
            // A successful join proves the room is real, so it goes on record even when the caller
            // only asked to join: that is how a room created by an older client becomes known, and
            // it keeps the record honest — only rooms somebody actually entered are ever recorded.
            _records.Ensure(roomId);
            RelayLog.PeerJoined(_logger, RelayLog.Tag(roomId), room.Count, _rooms.Count);
            return JoinOutcome.Ok;
        }
    }

    public Peer? FindPeer(string roomId, string peerId)
    {
        if (!_rooms.TryGetValue(roomId, out var room)) return null;
        var peer = room.Find(peerId);
        return peer is null || peer.Evicted ? null : peer;
    }

    public void DropPeer(Peer peer)
    {
        if (!peer.MarkEvicted()) return;
        peer.Outbox.Close();
        peer.CancelDown();
        RemovePeer(peer, dropped: true);
    }

    public void Sweep()
    {
        var now = Environment.TickCount64;
        foreach (var room in _rooms.Values)
        {
            foreach (var peer in room.Peers)
            {
                if (!peer.IsIdle(now, _limits.IdleTimeoutSeconds)) continue;
                if (!peer.MarkEvicted()) continue;
                peer.Outbox.Close();
                peer.CancelDown();
                RemovePeer(peer, dropped: false);
            }
        }

        // The ledger ages and flushes here too: it is the one periodic moment this process has,
        // and a room that nobody joins for the record's lifetime should stop existing on its own.
        _records.Prune();
    }

    private void RemovePeer(Peer peer, bool dropped)
    {
        lock (_gate)
        {
            if (!_rooms.TryGetValue(peer.Room.Id, out var room)) return;
            if (!room.Remove(peer)) return;

            if (dropped) RelayLog.PeerDropped(_logger, RelayLog.Tag(room.Id), _limits.PeerQueueBytes, room.Count);
            else RelayLog.PeerLeft(_logger, RelayLog.Tag(room.Id), _limits.IdleTimeoutSeconds, room.Count);

            if (room.Count == 0 && _rooms.TryRemove(room.Id, out _))
            {
                RelayLog.RoomDestroyed(_logger, RelayLog.Tag(room.Id), _rooms.Count);
            }
        }
    }
}
