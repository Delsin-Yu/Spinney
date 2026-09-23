using System.Collections.Concurrent;

namespace SpinneyRelay;

internal sealed class Room
{
    private readonly ConcurrentDictionary<string, Peer> _peers = new(StringComparer.Ordinal);
    private int _count;

    public Room(string id) => Id = id;

    public string Id { get; }

    public int Count => Volatile.Read(ref _count);

    public ICollection<Peer> Peers => _peers.Values;

    public bool TryAdd(Peer peer, int maxPeers)
    {
        while (true)
        {
            var count = Volatile.Read(ref _count);
            if (count >= maxPeers) return false;
            if (Interlocked.CompareExchange(ref _count, count + 1, count) != count) continue;
            _peers[peer.Id] = peer;
            return true;
        }
    }

    public bool Remove(Peer peer)
    {
        if (!_peers.TryRemove(peer.Id, out _)) return false;
        Interlocked.Decrement(ref _count);
        return true;
    }

    public Peer? Find(string peerId) => _peers.TryGetValue(peerId, out var peer) ? peer : null;
}
