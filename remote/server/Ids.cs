using System.Security.Cryptography;

namespace SpinneyRelay;

internal static class Ids
{
    // 4 bytes -> 8 lowercase hex characters. Ample because the peer id is an opaque, transient
    // in-room lookup key that carries no authority: every member of the room already holds the
    // token, and `from` inside the sealed payload is what a peer reports about itself. It is not
    // a security parameter, so 32 bits of collision-resistant naming is plenty.
    public const int PeerIdBytes = 4;

    public static string NewPeer() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(PeerIdBytes));
}
