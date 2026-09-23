package dev.spinney.remote.core

import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * §3 of `remote/PROTOCOL.md`: the token is the single trust root, and everything the room
 * needs is derived from it. The token is never sent to the relay, and the relay cannot
 * derive it.
 *
 * ```
 * master  = PBKDF2-HMAC-SHA256(password = token, salt = "spinney-room-v1",
 *                              iterations = 600000, dkLen = 32)
 * roomIdB = HKDF-SHA256(ikm = master, salt = "spinney-hkdf-v1", info = "room", len = 16)
 * encKey  = HKDF-SHA256(ikm = master, salt = "spinney-hkdf-v1", info = "enc",  len = 32)
 * macKey  = HKDF-SHA256(ikm = master, salt = "spinney-hkdf-v1", info = "mac",  len = 32)
 * roomId  = base32(RFC 4648, uppercase, no padding) of roomIdB -> 26 chars
 * ```
 *
 * `PBKDF2WithHmacSHA256` is a `javax.crypto` algorithm added in **API 26**, which is why the
 * Android app's `minSdk` is 26: on an older platform this call would throw at runtime, and a
 * missing algorithm is not something a `catch` should paper over on a key-derivation path.
 *
 * 600000 iterations is paid once per room per connection, synchronously. It is the reason
 * [derive] must never be called on a hot path — hold the [RoomKeys] for the process, as the
 * extension host does.
 */
class RoomKeys internal constructor(
    /** `master`, 32 bytes. Never logged, never sent. */
    val master: ByteArray,
    /** `roomIdB`, the 16 bytes the room id is the base32 of. */
    val roomIdBytes: ByteArray,
    /** The AEAD key, 32 bytes. */
    val encKey: ByteArray,
    /** The MAC key, 32 bytes — derived because §3 pins it; this implementation seals with the AEAD only. */
    val macKey: ByteArray,
) {

    /** The relay URL path segment: the routing credential, 26 base32 characters. */
    val roomId: String = Base32.encode(roomIdBytes)

    /** True when this object still holds a token-derived secret worth keeping out of a log. */
    val isSecret: Boolean get() = true

    /** Never print the keys. A `RoomKeys` that reaches a transcript is a leaked room. */
    override fun toString(): String = "RoomKeys(roomId=$roomId, master=<redacted>)"

    companion object {

        /**
         * Derive the room's keys from one token. UTF-8 of the token is the PBKDF2 password,
         * so a non-ASCII token — and one with a supplementary-plane character — behaves the
         * same here as it does in the TypeScript host (`derivations[1]` in the vectors).
         */
        fun derive(token: String): RoomKeys {
            require(token.isNotEmpty()) { "the token is the trust root; an empty one is a caller error" }
            val master = pbkdf2(token)
            return RoomKeys(
                master = master,
                roomIdBytes = Hkdf.derive(master, Protocol.HKDF_INFO_ROOM, Protocol.ROOM_ID_BYTES),
                encKey = Hkdf.derive(master, Protocol.HKDF_INFO_ENC, Protocol.KEY_BYTES),
                macKey = Hkdf.derive(master, Protocol.HKDF_INFO_MAC, Protocol.KEY_BYTES),
            )
        }

        private fun pbkdf2(token: String): ByteArray {
            val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
            val spec = PBEKeySpec(
                token.toCharArray(),
                Protocol.KDF_SALT.toUtf8(),
                Protocol.PBKDF2_ITERATIONS,
                Protocol.MASTER_BYTES * 8,
            )
            return try {
                factory.generateSecret(spec).encoded
            } finally {
                spec.clearPassword()
            }
        }
    }
}

/**
 * RFC 5869 HKDF over HMAC-SHA256, in its extract-then-expand shape, with the contract's
 * fixed salt. Only the outputs §3 names are ever requested.
 */
object Hkdf {

    private const val HASH_BYTES = 32

    fun extract(salt: ByteArray, ikm: ByteArray): ByteArray = hmac(salt, ikm)

    fun expand(prk: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length > 0 && length <= 255 * HASH_BYTES) { "invalid HKDF length $length" }
        val out = ByteArray(length)
        var previous = ByteArray(0)
        var counter = 1
        var written = 0
        while (written < length) {
            previous = hmac(prk, concat(previous, info, byteArrayOf(counter.toByte())))
            val take = minOf(previous.size, length - written)
            System.arraycopy(previous, 0, out, written, take)
            written += take
            counter++
        }
        return out
    }

    /** `HKDF-SHA256(ikm, salt = "spinney-hkdf-v1", info, len)` — the contract's one call shape. */
    fun derive(ikm: ByteArray, info: String, length: Int): ByteArray =
        expand(extract(Protocol.HKDF_SALT.toUtf8(), ikm), info.toUtf8(), length)

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }
}

/** SHA-256, used for `deviceId` (§2) and for nothing on the sealed path. */
object Sha256 {

    fun hex(text: String): String = Hex.encode(digest(text.toUtf8()))

    fun digest(bytes: ByteArray): ByteArray =
        java.security.MessageDigest.getInstance("SHA-256").digest(bytes)
}

/**
 * §2: `deviceId = sha256hex(utf8(machineId + roomId))` — stable per machine per room, and
 * deliberately different across rooms so a peer cannot correlate a device between two rooms.
 *
 * The extension host feeds `vscode.env.machineId` in; the Android app has no such value, so
 * it feeds its own installation id (`SecureTokenStore.installationId`), which is a
 * per-install secret kept in the same encrypted store as the token. It is an input to a
 * hash, not an identity, so it never travels in the clear either way.
 */
object DeviceIdentity {

    fun deviceId(machineId: String, roomId: String): String = Sha256.hex(machineId + roomId)
}
