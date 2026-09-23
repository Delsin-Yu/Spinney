package dev.spinney.remote.core

import java.io.ByteArrayOutputStream
import java.util.Base64

/**
 * §7 of `remote/PROTOCOL.md`: transport, SSE down and POST up.
 *
 * A frame payload on the wire is one SSE-shaped line carrying **only what a receiver needs
 * before it can decrypt** — the version, the sequence number and the connection salt (which
 * together are the nonce, so neither can be secret), the framing id, the slice position and the
 * bytes:
 *
 * ```json
 * {"v":1,"seq":7,"s":"1a2b3c4d","fid":"0011223344556677","idx":0,"last":true,"b":"<base64>"}
 * ```
 *
 * Note what is *absent*: the frame's type, its sender and its target are all inside the
 * sealed plaintext, so the relay learns the shape of the traffic but never what any of it
 * means. That is also why this class can validate everything it needs to and still know
 * nothing about the frame.
 *
 * `s` is the connection salt, 8 lowercase hex, in position 3 — §7's key order is
 * `v,seq,s,fid,idx,last,b`. It is on the wire **because the nonce is built before a frame can be
 * opened**, and the salt is half of that nonce ([Nonces.fromWire]). It is validated strictly by
 * [Nonces.decodeSalt]: a wrong length, a non-hex character or an uppercase letter is a refusal,
 * never a coercion.
 */
data class TransportEnvelope(
    val v: Int,
    val seq: Long,
    /** The connection salt as it travels: 8 lowercase hex (`remote/PROTOCOL.md` §7). */
    val s: String,
    val fid: String,
    val idx: Int,
    val last: Boolean,
    /** base64 (standard, padded) of one slice of the *sealed* frame. */
    val b: String,
) {

    init {
        require(v >= 1) { "v must be a positive version" }
        require(seq >= 1) { "seq starts at 1 per connection" }
        Nonces.decodeSalt(s) // strict: wrong length, non-hex or uppercase is a refusal
        require(FID_PATTERN.matches(fid)) { "fid must be ${Protocol.FRAMING_ID_LENGTH} hex chars" }
        require(idx >= 0) { "idx is 0-based" }
        require(BASE64_PATTERN.matches(b)) { "b must be base64" }
    }

    /**
     * The wire form, key order fixed. `v`, `seq` and `fid` are the AAD of the frame these
     * bytes belong to ([Aad]); `s` is the other half of the nonce. None of them is re-labelled
     * on the way out.
     */
    fun toJson(): String = buildString(72 + b.length) {
        append("{\"v\":").append(v)
        append(",\"seq\":").append(seq)
        append(",\"s\":\"").append(s)
        append("\",\"fid\":\"").append(fid)
        append("\",\"idx\":").append(idx)
        append(",\"last\":").append(last)
        append(",\"b\":\"").append(b)
        append("\"}")
    }

    companion object {

        private val FID_PATTERN = Regex("^[0-9a-fA-F]{${Protocol.FRAMING_ID_LENGTH}}$")
        private val BASE64_PATTERN = Regex("^[A-Za-z0-9+/]*={0,2}$")

        /** The seven keys of §7, in the wire's order, and no others. */
        val KEYS: Set<String> = linkedSetOf("v", "seq", "s", "fid", "idx", "last", "b")

        /**
         * Parse one SSE `data:` payload. Tolerant about key order (the envelope is not hashed
         * — only `v`, `seq`, `fid` are bound, and they are bound as *values*), strict about
         * the key set: an unknown key means a version of the transport this build does not
         * understand, and guessing at it is how a garbled render is born. A missing or sloppy
         * `s` is refused for a sharper reason: it is half the nonce, and a receiver that
         * guessed it would report a transport bug as tampering.
         */
        fun parse(text: String): TransportEnvelope {
            val root = JsonValue.parse(text) as? JsonValue.Obj
                ?: throw IllegalArgumentException("a transport envelope must be a JSON object")
            val unknown = root.fields.keys - KEYS
            require(unknown.isEmpty()) { "unknown transport envelope key(s): ${unknown.joinToString(",")}" }
            val missing = KEYS - root.fields.keys
            require(missing.isEmpty()) { "missing transport envelope key(s): ${missing.joinToString(",")}" }
            return TransportEnvelope(
                v = root.long("v").toInt(),
                seq = root.long("seq"),
                s = root.str("s"),
                fid = root.str("fid"),
                idx = root.long("idx").toInt(),
                last = root.bool("last"),
                b = root.str("b"),
            )
        }
    }
}

/**
 * §7: "a sealed frame is sealed **once** (one nonce) and then split into slices of at most
 * 48000 base64 characters each. `fid` is shared by the slices of one frame, `idx` is 0-based,
 * `last` marks the final slice, and every slice of one frame carries the same `v`, `seq`, `s`
 * and `fid` (a mismatch is an error — and the `s` check is the one that would otherwise let two
 * connections' slices be spliced into one frame)."
 *
 * The salt is stamped here rather than left to the caller, for the same reason `seq` is: a slice
 * set whose parts disagree about `s` describes two connections at once, and a receiver must never
 * have to decide which of its own slices to believe.
 *
 * Slice boundaries are the sender's choice and are deliberately not part of the contract, so
 * this implementation uses the vectors' reference chunking and a receiver never inspects
 * where a slice ends.
 */
object Slicing {

    fun slice(
        sealed: ByteArray,
        v: Int,
        seq: Long,
        salt: Int,
        fid: String,
        chunkBytes: Int = Protocol.REFERENCE_CHUNK_BYTES,
    ): List<TransportEnvelope> {
        require(sealed.isNotEmpty()) { "a sealed frame is never empty" }
        require(chunkBytes > 0) { "chunkBytes must be positive" }
        val base64PerChunk = 4 * ((chunkBytes + 2) / 3)
        require(base64PerChunk <= Protocol.MAX_SLICE_BASE64_CHARS) {
            "a ${chunkBytes}-byte chunk is $base64PerChunk base64 chars, over the " +
                "${Protocol.MAX_SLICE_BASE64_CHARS} cap"
        }
        val wireSalt = Nonces.encodeSalt(salt)
        val slices = ArrayList<TransportEnvelope>((sealed.size / chunkBytes) + 1)
        var at = 0
        while (at < sealed.size) {
            val end = minOf(at + chunkBytes, sealed.size)
            val chunk = sealed.copyOfRange(at, end)
            slices.add(
                TransportEnvelope(
                    v = v,
                    seq = seq,
                    s = wireSalt,
                    fid = fid,
                    idx = slices.size,
                    last = end == sealed.size,
                    b = Base64.getEncoder().encodeToString(chunk),
                ),
            )
            at = end
        }
        require(slices.size <= Protocol.SLICE_COUNT_MAX) {
            "a ${sealed.size}-byte frame needs ${slices.size} slices, over the ${Protocol.SLICE_COUNT_MAX} cap"
        }
        return slices
    }
}

/** Why reassembly refused a slice. Three of the four are the contract's explicit errors. */
enum class ReassemblyReason {
    /** An `idx` above the next expected one — slices of one frame may interleave, but must not reorder. */
    OUT_OF_ORDER,

    /** An `idx` already consumed for this frame. */
    DUPLICATE,

    /**
     * A slice of `fid` disagreed with an earlier slice about `v`, `seq` or `s`.
     *
     * The `s` case is the one that matters most: the salt is half the nonce, so two slices under
     * one `fid` carrying different salts describe two *connections*, and a receiver that accepted
     * them would be reassembling a frame whose nonce it can only guess. `fid` is only a label a
     * hostile relay can reuse; `seq` + `s` are what make a frame's nonce and AAD unique.
     */
    MIXED_FRAME,

    /** The reassembled frame would exceed [Protocol.MAX_SEALED_BYTES]: "an error, never a truncation". */
    TOO_LARGE,

    /** More slices than a maximally packed frame could need — a sender bug or an attack. */
    TOO_MANY_SLICES,
}

class ReassemblyFailure(val reason: ReassemblyReason, message: String) : Exception(message)

/**
 * A frame whose slices have all arrived, still sealed, **and the salt its slices carried**.
 *
 * The salt is carried out of the reassembler because it is the receiver's only legitimate source
 * for the second half of the nonce (§4/§7): it came off the wire with the slices, it was checked
 * to be the same on every one of them, and it is what [SealedConnection.open] must use. A
 * `ReassembledFrame` therefore cannot be opened without it.
 */
data class ReassembledFrame(
    val v: Int,
    val seq: Long,
    /** The connection salt of the *sender*'s connection, as the slices carried it. */
    val salt: Int,
    val fid: String,
    /** `ciphertext || tag`, exactly as it was sealed. */
    val sealed: ByteArray,
) {
    /** The salt as it travelled, for a log line or a diagnostic. */
    val saltHex: String get() = Nonces.encodeSalt(salt)

    override fun equals(other: Any?): Boolean =
        other is ReassembledFrame && v == other.v && seq == other.seq && salt == other.salt &&
            fid == other.fid && sealed.contentEquals(other.sealed)

    override fun hashCode(): Int =
        ((((v * 31 + seq.hashCode()) * 31 + salt) * 31 + fid.hashCode()) * 31) + sealed.contentHashCode()
}

/**
 * Reassembles by `fid`, and only then is a frame opened. Slices of one frame may arrive
 * interleaved with other frames, so several `fid`s may be in flight at once.
 *
 * Every slice of one frame must agree about `v`, `seq` **and the connection salt `s`**: the salt
 * comes off the wire, is remembered here with the partial frame, and is handed to the caller in
 * the [ReassembledFrame]. A disagreement is a refusal, because it is exactly what splicing two
 * connections' slices under one `fid` would look like (§7).
 *
 * A `fid` whose frame has just completed is deliberately *not* remembered here: a duplicate
 * of the whole frame repeats its `seq`, and the replay window behind this class is what
 * refuses it — one mechanism, one place.
 */
class Reassembler(
    private val capBytes: Int = Protocol.MAX_SEALED_BYTES,
    private val maxSlices: Int = Protocol.SLICE_COUNT_MAX,
) {

    private class Partial(val v: Int, val seq: Long, val s: String, val fid: String) {
        val buffer = ByteArrayOutputStream()
        var nextIdx = 0
    }

    private val partials = LinkedHashMap<String, Partial>()

    val inFlight: Int get() = partials.size

    /**
     * Feed one slice. Returns the frame when the slice marked `last` completes it, and null
     * while it is still incomplete. Throws [ReassemblyFailure] — never returns a partial or a
     * truncated frame — for anything the contract calls an error.
     */
    fun accept(envelope: TransportEnvelope): ReassembledFrame? {
        val partial = partials[envelope.fid]
        if (partial == null) {
            if (envelope.idx != 0) {
                throw ReassemblyFailure(
                    ReassemblyReason.OUT_OF_ORDER,
                    "the first slice of ${envelope.fid} has idx=${envelope.idx}, not 0",
                )
            }
            partials[envelope.fid] = Partial(envelope.v, envelope.seq, envelope.s, envelope.fid).also {
                it.nextIdx = 1
                appendRaw(it, envelope)
            }
        } else {
            when {
                partial.v != envelope.v || partial.seq != envelope.seq || partial.s != envelope.s -> {
                    // Abandoned: two connections cannot be one frame, and keeping the halves
                    // would only invite a third slice into a frame that never existed.
                    partials.remove(envelope.fid)
                    throw ReassemblyFailure(
                        ReassemblyReason.MIXED_FRAME,
                        "slice ${envelope.idx} of ${envelope.fid} says v=${envelope.v} seq=${envelope.seq} " +
                            "s=${envelope.s}, but the frame was opened as v=${partial.v} seq=${partial.seq} " +
                            "s=${partial.s} — one frame is one seq and one connection salt",
                    )
                }
                envelope.idx < partial.nextIdx ->
                    throw ReassemblyFailure(
                        ReassemblyReason.DUPLICATE,
                        "slice ${envelope.idx} of ${envelope.fid} arrived again (next expected ${partial.nextIdx})",
                    )
                envelope.idx > partial.nextIdx ->
                    throw ReassemblyFailure(
                        ReassemblyReason.OUT_OF_ORDER,
                        "slice ${envelope.idx} of ${envelope.fid} arrived out of order (next expected ${partial.nextIdx})",
                    )
                else -> {
                    partial.nextIdx++
                    appendRaw(partial, envelope)
                }
            }
            if (partial.nextIdx > maxSlices) {
                partials.remove(envelope.fid)
                throw ReassemblyFailure(
                    ReassemblyReason.TOO_MANY_SLICES,
                    "${envelope.fid} carried more than $maxSlices slices",
                )
            }
        }

        if (!envelope.last) return null
        val done = partials.remove(envelope.fid) ?: throw ReassemblyFailure(
            ReassemblyReason.OUT_OF_ORDER,
            "${envelope.fid} completed without a first slice",
        )
        // The salt is decoded from the wire field the slices carried, and it is what the caller
        // must build the nonce from — never a salt of its own (see [SealedConnection.open]).
        return ReassembledFrame(done.v, done.seq, Nonces.decodeSalt(done.s), done.fid, done.buffer.toByteArray())
    }

    /** Drop everything in flight — a reconnect invalidates every partial frame. */
    fun clear() = partials.clear()

    private fun appendRaw(partial: Partial, envelope: TransportEnvelope) {
        val chunk = try {
            Base64.getDecoder().decode(envelope.b)
        } catch (err: IllegalArgumentException) {
            partials.remove(envelope.fid)
            throw ReassemblyFailure(ReassemblyReason.MIXED_FRAME, "slice ${envelope.idx} of ${envelope.fid} is not base64: ${err.message}")
        }
        if (partial.buffer.size() + chunk.size > capBytes) {
            partials.remove(envelope.fid)
            throw ReassemblyFailure(
                ReassemblyReason.TOO_LARGE,
                "${envelope.fid} would reassemble beyond the $capBytes-byte cap",
            )
        }
        partial.buffer.write(chunk)
    }
}
