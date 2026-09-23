using System.Collections.Concurrent;

namespace SpinneyRelay;

internal enum JoinOutcome
{
    Ok,
    RoomFull,
    TooManyRooms,
}

internal sealed class RoomRegistry
{
    private readonly ConcurrentDictionary<string, Room> _rooms = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private readonly Limits _limits;
    private readonly ILogger _logger;

    public RoomRegistry(Limits limits, ILogger<RoomRegistry> logger)
    {
        _limits = limits;
        _logger = logger;
    }

    public long UptimeMs => Environment.TickCount64 - StartedMs;

    private long StartedMs { get; } = Environment.TickCount64;

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

    public JoinOutcome Join(string roomId, out Peer? peer)
    {
        peer = null;
        lock (_gate)
        {
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
