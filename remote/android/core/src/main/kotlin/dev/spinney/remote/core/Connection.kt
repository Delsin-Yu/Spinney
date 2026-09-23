package dev.spinney.remote.core

import java.security.SecureRandom

/**
 * §5 of `remote/PROTOCOL.md`: the logical frame. Compact JSON, exactly this key order.
 *
 * ```json
 * {"v":1,"type":"<type>","id":"<frame id>","from":"<peerId>","to":"<peerId>|*","body":{ }}
 * ```
 *
 * Everything semantic — the type, who sent it, who it is for — is **inside** this JSON and
 * therefore sealed: the transport envelope carries none of it, and could not without leaking
 * it. The frame's `id` is a caller-chosen correlation id; it is deliberately independent of
 * the transport's `fid` (a sender that makes them equal is making a choice, not following a
 * rule — `seals[0]` does, `seals[1]` and `seals[2]` do not).
 */
data class Frame(
    val v: Int,
    val type: String,
    val id: String,
    val from: String,
    val to: String,
    val body: JsonValue.Obj,
) {

    /** `to == "*"` means the whole room. */
    val isBroadcast: Boolean get() = to == "*"

    /** `mirror` and `input` wrap one verbatim host⇄webview message (§5). */
    val wrappedMessage: JsonValue.Obj? get() = body["message"] as? JsonValue.Obj

    /** The session a `mirror`/`input`/`attach`/`detach` frame is about. */
    val sessionId: String? get() = body.strOrNull("sessionId")
}

object FrameJson {

    /**
     * Builds a frame's plaintext. [bodyJson] is embedded **verbatim** rather than re-encoded:
     * a body the caller already serialised is the caller's bytes, and re-encoding it would
     * put this file's JSON writer between a `mirror` body and the publisher's exact bytes —
     * which is precisely the drift §5 exists to prevent.
     */
    fun encode(
        type: String,
        id: String,
        from: String,
        to: String,
        bodyJson: String,
        v: Int = Protocol.FRAME_VERSION,
    ): String {
        require(v >= 1) { "v must be a positive version" }
        val out = StringBuilder(bodyJson.length + 96)
        out.append("{\"v\":").append(v)
        out.append(",\"type\":").append(JsonValue.of(type).toJson())
        out.append(",\"id\":").append(JsonValue.of(id).toJson())
        out.append(",\"from\":").append(JsonValue.of(from).toJson())
        out.append(",\"to\":").append(JsonValue.of(to).toJson())
        out.append(",\"body\":").append(bodyJson)
        out.append('}')
        return out.toString()
    }

    /**
     * Parses a frame's plaintext. Tolerant about key order — the GCM tag authenticates the
     * bytes the sender chose, so a peer that emits the same six keys in another order is
     * interoperable — and strict about the key set and about `v`, because a version this
     * build does not understand must be refused rather than guessed at (§5).
     */
    fun decode(text: String): Frame {
        val root = JsonValue.parse(text) as? JsonValue.Obj
            ?: throw IllegalArgumentException("a frame must be a JSON object")
        val known = setOf("v", "type", "id", "from", "to", "body")
        val unknown = root.fields.keys - known
        require(unknown.isEmpty()) { "unknown frame key(s): ${unknown.joinToString(",")}" }
        val body = root["body"] as? JsonValue.Obj
            ?: throw IllegalArgumentException("a frame's body must be an object")
        return Frame(
            v = root.long("v").toInt(),
            type = root.str("type"),
            id = root.str("id"),
            from = root.str("from"),
            to = root.str("to"),
            body = body,
        )
    }
}

/** Why a received frame was refused. `too large`, `tampered` and `replayed` stay three outcomes (§4). */
enum class RefusalReason {
    /** A version this build does not understand — refused before it is opened, never best-effort (§5). */
    VERSION,

    /** The reassembled frame would exceed the 16 MiB cap; an error, never a truncation (§7). */
    TOO_LARGE,

    /** The GCM tag did not verify: altered bytes, or a key/AAD/nonce that does not belong to them. */
    TAMPERED,

    /** A `seq` already seen, or at or below the replay window's floor (§4). */
    REPLAYED,

    /** The slices themselves were wrong: out of order, duplicated, mixed or over the slice cap (§7). */
    REASSEMBLY,
}

/** The outcome of feeding bytes to a receiver. Never an exception on the hot path. */
sealed interface OpenOutcome {

    /**
     * An opened frame, with the material it was opened *from*: the salt the slices carried (the
     * half of the nonce a receiver has to read, §4/§7), the framing id, the sequence number and
     * the reassembled sealed bytes. A caller that only renders the frame uses [frame]/[plaintext];
     * the interop harness uses the rest to compare bytes across implementations.
     */
    data class Opened(
        val frame: Frame,
        val plaintext: String,
        val v: Int,
        val seq: Long,
        /** The salt the wire carried — never a salt this connection chose. */
        val salt: Int,
        val fid: String,
        val sealed: ByteArray,
    ) : OpenOutcome {
        override fun equals(other: Any?): Boolean =
            other is Opened && frame == other.frame && plaintext == other.plaintext && v == other.v &&
                seq == other.seq && salt == other.salt && fid == other.fid && sealed.contentEquals(other.sealed)

        override fun hashCode(): Int =
            (((((frame.hashCode() * 31 + plaintext.hashCode()) * 31 + v) * 31 + seq.hashCode()) * 31 + salt) * 31 +
                fid.hashCode()) * 31 + sealed.contentHashCode()
    }

    data class Refused(val reason: RefusalReason, val detail: String) : OpenOutcome
}

/**
 * One connection's sealing state: a fresh random 32-bit salt, a `seq` sequence that starts at
 * 1 and is monotonic, a 64-wide replay window, and the reassembly of inbound frames.
 *
 * **A reconnect is a new instance.** §7: "on any transport failure, drop everything, re-derive
 * (the derivation is cached per process), `join` again for a new `peerId` and a new connection
 * salt, `hello`, re-`attach` the sessions that were attached, and ask for `resync`." Restarting
 * `seq` at 1 under the *old* salt would reuse every nonce of the previous connection — GCM
 * would keep producing output and would leak the XOR of the two plaintexts and the
 * authentication key. That failure is silent, which is why [fresh] is the only supported way
 * to build the next connection and why the unit test asserts it.
 */
class SealedConnection private constructor(
    private val keys: RoomKeys,
    val connectionSalt: Int,
    firstSeq: Long,
) {

    private var nextSeq: Long = firstSeq

    /**
     * One window per *sender* salt (§4: "a 64-wide sliding window per connection salt"). Note
     * that the salts here are not all this connection's: every peer in the room seals under its
     * own random salt, so a receiving connection meets as many salts as it has peers. See
     * [ReplayWindows] for why one window keyed on `seq` alone would refuse the second publisher's
     * first frame.
     */
    private val replay = ReplayWindows()
    private val reassembler = Reassembler()

    /** The `seq` the next [seal] will use. */
    val sequence: Long get() = nextSeq

    /** Frames sealed so far on this connection. */
    var sealedFrames: Long = 0
        private set

    /** Frames this connection accepted and opened. */
    var openedFrames: Long = 0
        private set

    /**
     * Seal one logical frame and split it. One nonce, one `seq`, many slices — the slice
     * count is the sender's choice and never changes what was sealed.
     */
    fun seal(fid: String, frameJson: String, chunkBytes: Int = Protocol.REFERENCE_CHUNK_BYTES): List<TransportEnvelope> {
        val slices = sealAt(Protocol.FRAME_VERSION, nextSeq, connectionSalt, fid, frameJson.toUtf8(), chunkBytes)
        nextSeq++
        sealedFrames++
        return slices
    }

    /**
     * Seal an explicit `(v, seq, salt, fid)` — the shape the vectors are written in, and what
     * [seal] calls with this connection's own salt. The salt is stamped onto every slice of the
     * result, because that is where a receiver has to read it from.
     */
    fun sealAt(
        v: Int,
        seq: Long,
        salt: Int,
        fid: String,
        plaintext: ByteArray,
        chunkBytes: Int = Protocol.REFERENCE_CHUNK_BYTES,
    ): List<TransportEnvelope> {
        val nonce = Nonces.of(seq, salt)
        val sealed = Aead.seal(keys.encKey, nonce, Aad.bytes(v, seq, fid), plaintext)
        return Slicing.slice(sealed, v, seq, salt, fid, chunkBytes)
    }

    /**
     * Feed one transport envelope. Returns null while a frame is still incomplete, an
     * [OpenOutcome.Opened] when the last slice completed one, and an
     * [OpenOutcome.Refused] for anything the contract calls an error — reassembly never
     * throws out of here.
     */
    fun accept(envelope: TransportEnvelope): OpenOutcome? {
        val reassembled = try {
            reassembler.accept(envelope)
        } catch (failure: ReassemblyFailure) {
            return OpenOutcome.Refused(RefusalReason.REASSEMBLY, failure.message ?: failure.reason.name)
        } ?: return null
        return open(reassembled)
    }

    /**
     * Open an already reassembled frame: version, tag, then replay.
     *
     * The nonce is built from **the salt the slices carried**, never from this connection's own
     * ([connectionSalt]): a frame from another peer was sealed under *that* peer's salt, and
     * substituting our own would fail the tag on every frame in a room with more than one
     * publisher. Taking it from the wire is the entire point of `s` existing (§4/§7).
     */
    fun open(frame: ReassembledFrame): OpenOutcome {
        if (frame.v != Protocol.FRAME_VERSION) {
            return OpenOutcome.Refused(
                RefusalReason.VERSION,
                "frame version ${frame.v} is not ${Protocol.FRAME_VERSION}",
            )
        }
        if (frame.sealed.size < Protocol.TAG_BYTES + 1) {
            return OpenOutcome.Refused(RefusalReason.TAMPERED, "a sealed frame cannot be shorter than its tag")
        }
        return openSealed(frame.v, frame.seq, frame.salt, frame.fid, frame.sealed)
    }

    /**
     * Open raw sealed bytes. Split out so the vector test can drive it with a recorded
     * `(v, seq, s, fid)` without inventing a slice — and so the **salt's source** is a parameter
     * a reader cannot miss: it comes from the wire (`s`), not from this connection.
     *
     * The order here is deliberate: **verify the tag, then advance the replay window.** A
     * replay window advanced by an unauthenticated frame would let the relay burn a
     * sequence number with a single tampered byte, and the genuine frame that follows would
     * then be refused as a replay. Unverified input must not move state.
     */
    fun openSealed(v: Int, seq: Long, salt: Int, fid: String, sealed: ByteArray): OpenOutcome {
        if (v != Protocol.FRAME_VERSION) {
            return OpenOutcome.Refused(RefusalReason.VERSION, "frame version $v is not ${Protocol.FRAME_VERSION}")
        }
        if (sealed.size > Protocol.MAX_SEALED_BYTES) {
            return OpenOutcome.Refused(
                RefusalReason.TOO_LARGE,
                "${sealed.size} bytes reassembled, over the ${Protocol.MAX_SEALED_BYTES} cap",
            )
        }
        val plaintext = try {
            Aead.open(keys.encKey, Nonces.of(seq, salt), Aad.bytes(v, seq, fid), sealed)
        } catch (err: TamperFailure) {
            return OpenOutcome.Refused(RefusalReason.TAMPERED, err.message ?: "the GCM tag did not verify")
        }
        if (!replay.accept(salt, seq)) {
            val floor = replay.highestSeq(salt)?.minus(Protocol.REPLAY_WINDOW_WIDTH - 1) ?: 1L
            return OpenOutcome.Refused(
                RefusalReason.REPLAYED,
                "seq $seq under salt ${Nonces.encodeSalt(salt)} is a replay (window floor ${maxOf(1L, floor)})",
            )
        }
        openedFrames++
        val text = plaintext.asUtf8()
        return try {
            OpenOutcome.Opened(FrameJson.decode(text), text, v, seq, salt, fid, sealed)
        } catch (err: IllegalArgumentException) {
            OpenOutcome.Refused(RefusalReason.VERSION, "the sealed plaintext is not a frame: ${err.message}")
        }
    }

    /** Drop every partial frame — a reconnect or a `resync` invalidates them all. */
    fun clearInFlight() = reassembler.clear()

    override fun toString(): String =
        "SealedConnection(salt=${Nonces.encodeSalt(connectionSalt)}, seq=$nextSeq, " +
            "sealed=$sealedFrames, opened=$openedFrames, inFlight=${reassembler.inFlight}, replay=$replay)"

    companion object {

        /**
         * A new connection for [keys] with a **fresh** 32-bit salt and `seq` back at 1. This
         * is the only constructor a transport should use: it is what makes a reconnect unable
         * to reuse a nonce.
         */
        fun fresh(keys: RoomKeys, random: SecureRandom = SecureRandom()): SealedConnection =
            SealedConnection(keys, Nonces.freshSalt(random), 1L)

        /**
         * A connection pinned to a known salt and first `seq`. Exists for the vector test and
         * for a resumed session reconstructed from persisted state — never for a reconnect.
         */
        fun pinned(keys: RoomKeys, connectionSalt: Int, firstSeq: Long = 1L): SealedConnection =
            SealedConnection(keys, connectionSalt, firstSeq)
    }
}
