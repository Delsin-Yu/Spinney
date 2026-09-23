package dev.spinney.remote.app

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dev.spinney.remote.core.Hex
import java.security.SecureRandom

/**
 * Where the room token lives on the phone.
 *
 * The token is the single trust root (`remote/PROTOCOL.md` §9): whoever holds it has full
 * control of every publisher in the room, including creating sessions. On the host it lives in
 * VS Code `SecretStorage` and never in a log; the Android equivalent is
 * `EncryptedSharedPreferences` — an AES-256-GCM keyset in the Android Keystore — and never
 * plain `SharedPreferences`, never a file, never an export.
 *
 * Two rules this class enforces by existing:
 *
 * 1. **the token is never printed.** There is no `toString` that reaches a token, [describe]
 *    reports names and counts only, and nothing here writes a token to logcat. A token that
 *    reaches a logcat buffer is a leaked room, and logcat is readable by other tooling.
 * 2. **the token is written once per room and read on demand** — it is not held in a field, so
 *    it cannot be captured in a crash dump or a heap snapshot of a long-lived object.
 *
 * The room's *name* and *relay URL* are not secrets (`docs/agents/plans/remote-control.md`
 * §11: a name is a local label) but they live in the same store, because a second preference
 * file would be a second thing to get wrong.
 */
class SecureTokenStore(context: Context) {

    /** One configured room. `relayUrl` is where it meets the others; `name` never travels. */
    data class RoomConfig(val name: String, val relayUrl: String, val autoConnect: Boolean = true)

    private val prefs: SharedPreferences = createEncrypted(context)

    /**
     * A per-install random id, the phone's stand-in for `vscode.env.machineId` as an input to
     * `deviceId = sha256hex(installationId + roomId)` (§2). It is a hash input, never an
     * identity, and it is stable for the installation so the same phone is one device row.
     */
    val installationId: String
        get() = prefs.getString(KEY_INSTALLATION, null) ?: newRandomHex(32).also {
            prefs.edit().putString(KEY_INSTALLATION, it).apply()
        }

    fun rooms(): List<RoomConfig> {
        val raw = prefs.getString(KEY_ROOMS, null) ?: return emptyList()
        return raw.split('\n').mapNotNull { line ->
            val parts = line.split('\t')
            if (parts.size < 2 || parts[0].isEmpty()) null
            else RoomConfig(parts[0], parts[1], parts.getOrNull(2) != "0")
        }
    }

    fun saveRoom(room: RoomConfig) {
        val next = rooms().filterNot { it.name == room.name } + room
        writeRooms(next)
    }

    /** Removing a room removes its token too — a token left behind is a room left behind. */
    fun removeRoom(name: String) {
        writeRooms(rooms().filterNot { it.name == name })
        prefs.edit().remove(tokenKey(name)).apply()
    }

    fun token(roomName: String): String? = prefs.getString(tokenKey(roomName), null)?.takeIf { it.isNotEmpty() }

    fun setToken(roomName: String, token: String) {
        require(token.isNotEmpty()) { "an empty token is an empty room, not a configuration" }
        prefs.edit().putString(tokenKey(roomName), token).apply()
    }

    fun clearToken(roomName: String) {
        prefs.edit().remove(tokenKey(roomName)).apply()
    }

    /**
     * Diagnostics that may be printed. Deliberately says which rooms exist and whether each has
     * a token — never the token, not even a prefix, not even a length.
     */
    fun describe(): String {
        val names = rooms().map { "${it.name}@${it.relayUrl}${if (token(it.name) != null) " (token set)" else " (no token)"}" }
        return "rooms=${names.size}${if (names.isEmpty()) "" else ": " + names.joinToString(", ")}"
    }

    private fun writeRooms(rooms: List<RoomConfig>) {
        val text = rooms.joinToString("\n") { "${it.name}\t${it.relayUrl}\t${if (it.autoConnect) "1" else "0"}" }
        prefs.edit().putString(KEY_ROOMS, text).apply()
    }

    private fun tokenKey(roomName: String) = "$PREFIX_TOKEN$roomName"

    private fun newRandomHex(bytes: Int): String {
        val buffer = ByteArray(bytes)
        SecureRandom().nextBytes(buffer)
        return Hex.encode(buffer)
    }

    companion object {
        private const val FILE = "spinney-remote"
        private const val KEY_ROOMS = "rooms"
        private const val KEY_INSTALLATION = "installationId"
        private const val PREFIX_TOKEN = "token."

        /**
         * EncryptedSharedPreferences over an AES-256-GCM master key in the Android Keystore.
         * Key names are AES-256-SIV-encrypted too, so not even a room *name* is readable from
         * the file: the store leaks nothing about which rooms a phone is in.
         */
        private fun createEncrypted(context: Context): SharedPreferences {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            return EncryptedSharedPreferences.create(
                context,
                FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }
    }
}
