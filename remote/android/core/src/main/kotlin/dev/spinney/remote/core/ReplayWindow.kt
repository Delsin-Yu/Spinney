package dev.spinney.remote.core

/**
 * §4: "a 64-wide sliding window per connection salt. A `seq` already seen, or at or below
 * the window floor, is rejected as a replay."
 *
 * The window is per *connection*, not per process: a reconnect mints a new salt and starts
 * `seq` at 1 again, so carrying a window across a reconnect would reject every frame of the
 * new connection. [SealedConnection] creates one per connection for exactly that reason.
 *
 * The sequence number is half the nonce, so it is public and travels in the clear; this
 * window is what stops a relay from replaying a frame it saw earlier.
 */
class ReplayWindow(private val width: Int = Protocol.REPLAY_WINDOW_WIDTH) {

    init {
        require(width in 1..64) { "a bitmap-backed window holds at most 64 seqs" }
    }

    private var highest: Long = 0

    /** Bit `i` means `highest - i` has been seen. */
    private var seen: Long = 0

    /** The highest accepted `seq`, or 0 before the first frame. */
    val highestSeq: Long get() = highest

    /**
     * Accepts or refuses one `seq`. Returns false for a replay (inside the window and
     * already seen) and for a seq at or below the floor (too old to distinguish).
     */
    fun accept(seq: Long): Boolean {
        if (seq < 1) return false
        if (seq > highest) {
            val shift = seq - highest
            seen = if (shift >= width) 0L else (seen shl shift.toInt())
            seen = seen or 1L
            highest = seq
            return true
        }
        val delta = highest - seq
        if (delta >= width) return false
        val bit = 1L shl delta.toInt()
        if (seen and bit != 0L) return false
        seen = seen or bit
        return true
    }

    /** True iff [seq] would be refused — used by tests and by a diagnostic, never by the hot path. */
    fun wouldRefuse(seq: Long): Boolean {
        if (seq < 1) return true
        if (seq > highest) return false
        val delta = highest - seq
        if (delta >= width) return true
        return seen and (1L shl delta.toInt()) != 0L
    }

    override fun toString(): String = "ReplayWindow(width=$width, highest=$highest)"
}

/**
 * §4: "a 64-wide sliding window **per connection salt**" — and the salt is per *sender*, because
 * every peer in a room seals under its own random salt and starts its own `seq` at 1. One window
 * keyed on `seq` alone would therefore refuse the second publisher's very first frame as a replay
 * of the first publisher's `seq` 1: a room would look healthy and only ever render one publisher.
 *
 * So the key is the pair the nonce already is — (salt, seq) — held as one [ReplayWindow] per salt.
 * Nothing about that is a weaker check: a frame replayed with its original `s` meets its own
 * window exactly as before, and a frame whose `s` was altered fails the GCM tag before the window
 * is ever consulted (`s` is half the nonce, and the tag covers the plaintext the nonce protects).
 *
 * The map cannot be grown by the relay: a salt only gets a window once a frame under it
 * authenticated, which needs `encKey` — the token. It is still bounded, at the room's peer cap,
 * so a bug or a future route cannot make it grow without bound. Eviction is least-recently-used;
 * with 16 peers per room there is nothing to evict.
 */
class ReplayWindows(
    private val width: Int = Protocol.REPLAY_WINDOW_WIDTH,
    private val maxSalts: Int = Protocol.PEERS_PER_ROOM,
) {

    private val windows = object : LinkedHashMap<Int, ReplayWindow>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Int, ReplayWindow>?): Boolean =
            size > maxSalts
    }

    /** How many salts are being tracked — a diagnostic, and what the bound is tested against. */
    val trackedSalts: Int get() = windows.size

    /** Accepts or refuses one (salt, seq) pair. False means: a replay, or at or below the floor. */
    fun accept(salt: Int, seq: Long): Boolean {
        val window = windows[salt] ?: ReplayWindow(width).also { windows[salt] = it }
        return window.accept(seq)
    }

    /** The highest `seq` accepted for [salt], or null if that salt has not been seen. */
    fun highestSeq(salt: Int): Long? = windows[salt]?.highestSeq

    /** Forget every salt's window. One per connection, so a reconnect starts clean. */
    fun clear() = windows.clear()

    override fun toString(): String = "ReplayWindows(salts=${windows.size}, width=$width)"
}
