package dev.spinney.remote.core

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * §4 of `remote/PROTOCOL.md`: sealing, the nonce, and the AAD.
 *
 * - AES-256-GCM, key `encKey`, 16-byte tag **appended** (`ciphertext || tag`) — the layout
 *   WebCrypto, .NET `AesGcm` and Java `AES/GCM/NoPadding` all produce, which is what makes
 *   three implementations agree byte for byte.
 * - Nonce (12 bytes) = `uint64 big-endian frame seq` followed by `uint32 big-endian
 *   connection salt`.
 * - AAD = UTF-8 of `v|seq|fid`, decimals unpadded — the three facts a receiver already has
 *   before it decrypts, and nothing else.
 */
object Aead {

    /**
     * Seals [plaintext] and returns `ciphertext || tag`.
     *
     * [nonce] must be exactly [Protocol.NONCE_BYTES] and must never repeat under one key:
     * a reused (key, nonce) pair is a silent cryptographic failure, not a loud one — GCM
     * keeps working and leaks the XOR of the two plaintexts and the authentication key.
     * That is exactly why a reconnect mints a fresh connection salt (§4, [Nonces.freshSalt])
     * instead of restarting `seq`.
     */
    fun seal(key: ByteArray, nonce: ByteArray, aad: ByteArray, plaintext: ByteArray): ByteArray {
        require(key.size == Protocol.KEY_BYTES) { "encKey must be ${Protocol.KEY_BYTES} bytes" }
        require(nonce.size == Protocol.NONCE_BYTES) { "nonce must be ${Protocol.NONCE_BYTES} bytes" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(Protocol.TAG_BYTES * 8, nonce),
        )
        cipher.updateAAD(aad)
        return cipher.doFinal(plaintext)
    }

    /**
     * Opens `ciphertext || tag`. A tag failure is [TamperFailure] and nothing else — the
     * caller must not turn *tampered* into *replayed* or *too large*, which are three
     * different outcomes on the wire (§4).
     */
    fun open(key: ByteArray, nonce: ByteArray, aad: ByteArray, sealed: ByteArray): ByteArray {
        require(sealed.size >= Protocol.TAG_BYTES + 1) { "a sealed frame cannot be shorter than its tag" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(Protocol.TAG_BYTES * 8, nonce),
        )
        cipher.updateAAD(aad)
        return try {
            cipher.doFinal(sealed)
        } catch (err: javax.crypto.AEADBadTagException) {
            throw TamperFailure("the GCM tag did not verify", err)
        } catch (err: java.security.GeneralSecurityException) {
            throw TamperFailure("the GCM tag did not verify (${err.javaClass.simpleName})", err)
        }
    }
}

/** The frame's bytes were altered, or the key/AAD/nonce does not belong to them. */
class TamperFailure(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * The nonce construction of §4, the connection salt that makes a reconnect safe, and the wire
 * form of that salt (`s`, §7).
 *
 * The salt is **not secret and not derived**: it is random per connection and it travels in the
 * transport envelope, because a receiver has to build the nonce *before* it can open a frame and
 * the nonce is `be64(seq) || be32(salt)`. The bytes that reach the wire are
 * [encodeSalt]'s — 8 lowercase hex — and the bytes a receiver uses are [decodeSalt]'s. Nothing
 * may infer the salt from anywhere else: an earlier draft of the contract left it implicit
 * inside `fid`, and two implementations promptly invented two incompatible conventions for it.
 */
object Nonces {

    private val SALT_PATTERN = Regex("^[0-9a-f]{${Protocol.SALT_CHARS}}$")

    fun of(seq: Long, connectionSalt: Int): ByteArray {
        require(seq >= 1) { "seq starts at 1 per connection" }
        val out = ByteArray(Protocol.NONCE_BYTES)
        for (i in 0 until 8) {
            out[i] = ((seq ushr (8 * (7 - i))) and 0xff).toByte()
        }
        for (i in 0 until 4) {
            out[8 + i] = ((connectionSalt ushr (8 * (3 - i))) and 0xff).toByte()
        }
        return out
    }

    /**
     * The nonce **as a receiver must build it**: from the two fields the transport envelope
     * carries, `seq` and the wire salt `s` (§7). This is the only legitimate source of the salt
     * on the receiving side — an implementation that keeps the salt somewhere it can only guess
     * is incompatible with every other one by construction.
     */
    fun fromWire(seq: Long, wireSalt: String): ByteArray = of(seq, decodeSalt(wireSalt))

    /** The `uint32 big-endian connection salt` half of a nonce, read back — for tests and diagnostics. */
    fun saltOf(nonce: ByteArray): Int {
        require(nonce.size == Protocol.NONCE_BYTES) { "a nonce is ${Protocol.NONCE_BYTES} bytes" }
        var salt = 0
        for (i in 0 until 4) {
            salt = (salt shl 8) or (nonce[8 + i].toInt() and 0xff)
        }
        return salt
    }

    /** The `uint64 big-endian seq` half of a nonce, read back. */
    fun seqOf(nonce: ByteArray): Long {
        require(nonce.size == Protocol.NONCE_BYTES) { "a nonce is ${Protocol.NONCE_BYTES} bytes" }
        var seq = 0L
        for (i in 0 until 8) {
            seq = (seq shl 8) or (nonce[i].toLong() and 0xff)
        }
        return seq
    }

    /** The salt as it travels: 8 lowercase hex, big-endian uint32. */
    fun encodeSalt(salt: Int): String = Hex.encode(
        byteArrayOf(
            (salt ushr 24).toByte(),
            (salt ushr 16).toByte(),
            (salt ushr 8).toByte(),
            salt.toByte(),
        ),
    )

    /**
     * Parse a wire salt back into the uint32 the nonce needs. **Strict on purpose**: a wrong
     * length, a non-hex character or an uppercase letter is an [IllegalArgumentException], not a
     * coercion. Reading `1A2B3C4D` or `1a2b3c4` as a number would build a different nonce than
     * the sender used and surface the mismatch as "tampered", which is the wrong diagnosis for
     * what is really a transport-format bug.
     */
    fun decodeSalt(hex: String): Int {
        if (!SALT_PATTERN.matches(hex)) {
            throw IllegalArgumentException(
                "a wire salt must be ${Protocol.SALT_CHARS} lowercase hex characters, got \"$hex\"",
            )
        }
        return hex.toLong(16).toInt()
    }

    /**
     * A fresh 32-bit connection salt: "random per connection, which is what makes a
     * reconnect unable to reuse a nonce". [SecureRandom] rather than `Random` — a predictable
     * salt puts two connections under one key on a colliding nonce, and a repeated
     * (key, nonce) pair in GCM is not a wrong frame, it is the key.
     */
    fun freshSalt(random: SecureRandom = SecureRandom()): Int = random.nextInt()
}

/** The AAD of §4: `v|seq|fid`, field order fixed, decimals unpadded. */
object Aad {

    fun canonical(version: Int, seq: Long, fid: String): String = "$version|$seq|$fid"

    fun bytes(version: Int, seq: Long, fid: String): ByteArray = canonical(version, seq, fid).toUtf8()
}
