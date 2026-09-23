package dev.spinney.remote.core

/**
 * Byte-level helpers the wire contract needs, and nothing else.
 *
 * The contract itself is `remote/PROTOCOL.md`; where this file and that page disagree,
 * that page wins and this file is wrong. Everything here is deliberately dependency-free
 * and pure JVM so the module can be unit-tested against `remote/vectors/vectors.json`.
 */

private const val HEX_LOWER = "0123456789abcdef"
private const val HEX_UPPER = "0123456789ABCDEF"

/** RFC 4648 base32, uppercase, no padding — the alphabet of the 26-character room id. */
private const val BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

object Hex {

    fun encode(bytes: ByteArray): String = encode(bytes, HEX_LOWER)

    fun encodeUpper(bytes: ByteArray): String = encode(bytes, HEX_UPPER)

    private fun encode(bytes: ByteArray, alphabet: String): String {
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            out.append(alphabet[v ushr 4]).append(alphabet[v and 0x0f])
        }
        return out.toString()
    }

    /** Strict: an odd length or a non-hex character is a caller error, never a silent zero. */
    fun decode(text: String): ByteArray {
        require(text.length % 2 == 0) { "hex text must have an even length, got ${text.length}" }
        val out = ByteArray(text.length / 2)
        for (i in out.indices) {
            val hi = digit(text[2 * i], 2 * i)
            val lo = digit(text[2 * i + 1], 2 * i + 1)
            out[i] = ((hi shl 4) or lo).toByte()
        }
        return out
    }

    private fun digit(c: Char, at: Int): Int {
        return when (c) {
            in '0'..'9' -> c - '0'
            in 'a'..'f' -> c - 'a' + 10
            in 'A'..'F' -> c - 'A' + 10
            else -> throw IllegalArgumentException("not a hex digit at $at: '$c'")
        }
    }
}

object Base32 {

    /** `base32(RFC 4648, uppercase, no padding)` — §3, the room id in the relay URL. */
    fun encode(bytes: ByteArray): String {
        if (bytes.isEmpty()) return ""
        val out = StringBuilder((bytes.size * 8 + 4) / 5)
        var buffer = 0
        var bits = 0
        for (b in bytes) {
            buffer = (buffer shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                out.append(BASE32_ALPHABET[(buffer ushr (bits - 5)) and 0x1f])
                bits -= 5
            }
        }
        if (bits > 0) {
            out.append(BASE32_ALPHABET[(buffer shl (5 - bits)) and 0x1f])
        }
        return out.toString()
    }
}

/** Inputs are UTF-8 unless stated (`remote/PROTOCOL.md` §3). */
fun String.toUtf8(): ByteArray = toByteArray(Charsets.UTF_8)

fun ByteArray.asUtf8(): String = toString(Charsets.UTF_8)

/** Concatenation, used by HKDF's `T(i)` chain and by nothing else. */
internal fun concat(vararg parts: ByteArray): ByteArray {
    var size = 0
    for (p in parts) size += p.size
    val out = ByteArray(size)
    var at = 0
    for (p in parts) {
        System.arraycopy(p, 0, out, at, p.size)
        at += p.size
    }
    return out
}
