package dev.spinney.remote.core

/**
 * Every number `remote/PROTOCOL.md` pins, in one place, so an implementation cannot
 * quietly drift from the contract by writing a literal somewhere else — and so a unit test
 * can assert them against `remote/vectors/vectors.json`'s `params` instead of trusting a
 * comment. Where a value is a *client* choice rather than a contract (§7's reconnect
 * backoff), it is named as one.
 */
object Protocol {

    /** §5: the only logical-frame version this implementation understands. */
    const val FRAME_VERSION = 1

    /** §3: the token → key derivation. Slow on purpose; do not lower it for a test. */
    const val PBKDF2_ITERATIONS = 600_000
    const val KDF_SALT = "spinney-room-v1"
    const val HKDF_SALT = "spinney-hkdf-v1"
    const val HKDF_INFO_ROOM = "room"
    const val HKDF_INFO_ENC = "enc"
    const val HKDF_INFO_MAC = "mac"
    const val MASTER_BYTES = 32
    const val ROOM_ID_BYTES = 16
    const val ROOM_ID_LENGTH = 26
    const val KEY_BYTES = 32

    /** §4: AES-256-GCM with the tag appended. */
    const val TAG_BYTES = 16
    const val NONCE_BYTES = 12
    const val CONNECTION_SALT_BYTES = 4

    /**
     * §7: the salt travels in the transport envelope as `s`, 8 **lowercase hex** characters.
     * The width is a contract, not a convention: a receiver builds the nonce before it can
     * decrypt, so a sloppy `s` (wrong length, uppercase, non-hex) is a refusal rather than
     * something to coerce — coercing it would build a different nonce than the sender and
     * report a transport bug as tampering.
     */
    const val SALT_CHARS = 8
    const val REPLAY_WINDOW_WIDTH = 64

    /** §7/§8: the transport envelope and its slices. */
    const val MAX_SLICE_BASE64_CHARS = 48_000
    const val RELAY_MAX_BODY_BYTES = 65_536
    const val MAX_SEALED_BYTES = 16_777_216
    const val SLICE_COUNT_MAX = 467
    const val SLICE_COUNT_MAX_REFERENCE = 560
    const val REFERENCE_CHUNK_BYTES = 30_000

    /** §7/§8: liveness and the relay's own limits. */
    const val CLIENT_PING_INTERVAL_MS = 20_000L
    const val RELAY_HEARTBEAT_INTERVAL_MS = 15_000L
    const val PEER_QUEUE_DROP_BYTES = 4_194_304
    const val PEERS_PER_ROOM = 16
    const val ROOMS = 64
    const val PEER_IDLE_EVICT_MS = 90_000L
    const val PEER_RATE_PER_SECOND = 60
    const val PEER_RATE_BURST = 120

    /** §2: `peerId` is 8 hex chars, minted by the relay and transient. */
    const val PEER_ID_LENGTH = 8

    /** §5: `id` is a caller-chosen 16-hex-char correlation id; `fid` is 16 hex chars too. */
    const val CORRELATION_ID_LENGTH = 16
    const val FRAMING_ID_LENGTH = 16

    /**
     * §7: the reconnect backoff is a client choice — "exponential with jitter and a cap" is
     * the contract, these numbers are this client's. They live here anyway so the transport
     * has one place to read them from, and so the shape (grow, cap, jitter) is testable.
     */
    const val RECONNECT_BASE_MS = 500L
    const val RECONNECT_CAP_MS = 30_000L
    const val RECONNECT_JITTER = 0.3
}
