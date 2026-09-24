package dev.spinney.remote.app

import android.app.Application
import android.os.Build
import dev.spinney.remote.core.RemoteClient
import dev.spinney.remote.core.RoomKeys
import dev.spinney.remote.core.TokenInput
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The phone's session-side state: the configured rooms, the one live [RemoteClient], and the
 * flows the two screens read.
 *
 * It is deliberately a plain class rather than an `AndroidViewModel`: the app has exactly one
 * room connection and one activity, so a ViewModel would add a second lifecycle to reason about
 * without adding a single guarantee. The scope is created here and cancelled by [shutdown].
 *
 * Nothing in here ever prints a token: [describe] reports room names and whether a token is set,
 * which is what a bug report needs, and [devices] is the room tree's diagnostics.
 */
class RemoteController(private val app: Application) {

    private val job = SupervisorJob()
    private val scope = CoroutineScope(job + Dispatchers.Main.immediate)

    val store = SecureTokenStore(app)
    val l10n = L10n(app)

    private val _state = MutableStateFlow<RemoteClient.ConnectionState>(RemoteClient.ConnectionState.Idle)
    val state: StateFlow<RemoteClient.ConnectionState> = _state.asStateFlow()

    private val _room = MutableStateFlow(RemoteClient.RoomSnapshot("", emptyList(), 0, -1))
    val room: StateFlow<RemoteClient.RoomSnapshot> = _room.asStateFlow()

    private val _refusals = MutableStateFlow<List<RemoteClient.Refusal>>(emptyList())
    val refusals: StateFlow<List<RemoteClient.Refusal>> = _refusals.asStateFlow()

    /** The fingerprint of the token being typed, or null while there is nothing to derive. */
    private val _fingerprint = MutableStateFlow<String?>(null)
    val fingerprint: StateFlow<String?> = _fingerprint.asStateFlow()

    /** Stored room name → the fingerprint of its token, derived once per room list change. */
    private val _storedFingerprints = MutableStateFlow<Map<String, String>>(emptyMap())
    val storedFingerprints: StateFlow<Map<String, String>> = _storedFingerprints.asStateFlow()

    private var fingerprintJob: Job? = null

    /**
     * Mirrored session messages, re-emitted from the live client. A `SharedFlow` with no replay:
     * the session screen subscribes *before* it attaches (see `SessionWebView`), so the publisher's
     * first state is not dropped — and when nothing is on screen there is nothing to render.
     */
    private val _mirror = MutableSharedFlow<RemoteClient.MirrorMessage>(extraBufferCapacity = 256)
    val mirror: SharedFlow<RemoteClient.MirrorMessage> = _mirror.asSharedFlow()

    /** The live connection, if one is running. The session screen requires it, so it is only reached from a connected room. */
    var client: RemoteClient? = null
        private set

    /** Which room the client was started for, for the UI to name it. */
    var connectedRoom: String? = null
        private set

    val rooms: List<SecureTokenStore.RoomConfig> get() = store.rooms()

    /**
     * The room id a token would route to, normalised first — `null` when there is nothing to
     * derive. This is the phone's only way to *see* which room it is about to enter, which is what
     * makes a paste with a newline checkable instead of silent.
     */
    fun previewRoomId(token: String): String? {
        val normalized = TokenInput.normalize(token)
        if (normalized.isEmpty()) return null
        return runCatching { RoomKeys.derive(normalized).roomId }.getOrNull()
    }

    /** The first 8 characters of the room a token routes to: a fingerprint two devices can compare. */
    fun fingerprintOf(token: String): String? = previewRoomId(token)?.take(FINGERPRINT_CHARS)

    /**
     * `token` is normalised here as well as in the store and in the field's IME: three layers,
     * because the cost of getting it wrong is a *silent* second room (`docs/agents/plans/remote-
     * control.md` §11: a wrong token is not an error, it is an empty room). The token is hashed as
     * the desktop hashes it, or the two devices never meet.
     *
     * Returns the reason it refused, or null when the connection was started. The strength rules are
     * the desktop's ([TokenInput.MIN_TOKEN_CHARS] / [MIN_DISTINCT_CHARS], mirroring
     * `tokenIssue` in `src/remote/rooms.ts`) so a truncated paste is refused *here*, with a
     * sentence, instead of becoming an empty room on the other side.
     */
    fun connect(roomName: String, relayUrl: String, token: String): TokenInput.Issue? {
        val normalized = TokenInput.normalize(token)
        val issue = TokenInput.issue(normalized)
        if (issue != null) return issue

        disconnect()
        store.setToken(roomName, normalized)
        val room = SecureTokenStore.RoomConfig(roomName, relayUrl)
        store.saveRoom(room)

        val installationId = store.installationId
        val client = RemoteClient(
            relayUrl = relayUrl,
            token = normalized,
            // The phone's stand-in for `vscode.env.machineId`. It stays a per-install secret and
            // is hashed with the *room id* inside the client (`deviceId = sha256hex(machineId +
            // roomId)`, §2), so the same phone is one device row per room and cannot be
            // correlated between two rooms.
            machineId = installationId,
            deviceName = deviceLabel(),
            instanceId = "android-" + installationId.take(8),
            appVersion = appVersion(),
        )
        this.client = client
        connectedRoom = roomName

        scope.launch { client.state.collect { _state.value = it } }
        scope.launch { client.room.collect { _room.value = it } }
        scope.launch { client.refusals.collect { _refusals.value = it } }
        scope.launch { client.mirror.collect { _mirror.emit(it) } }
        client.start()
        refreshStoredFingerprints()
        return null
    }

    // ---------------------------------------------------------------------------------------
    // Fingerprints: the derivation is deliberately slow, so it never runs on a keystroke
    // ---------------------------------------------------------------------------------------

    /**
     * The fingerprint of the token currently being typed, updated **after the typing stops**.
     *
     * `RoomKeys.derive` is 600000 PBKDF2 iterations — hundreds of milliseconds, by design (§3: "do
     * not lower it to make a test faster"). Deriving per keystroke, or on every recomposition,
     * would make the field unusable and jank the UI thread; so the work is debounced and pushed to
     * a background dispatcher, and the UI only ever reads a `String?`.
     */
    fun previewToken(raw: String) {
        fingerprintJob?.cancel()
        val normalized = TokenInput.normalize(raw)
        if (normalized.isEmpty()) {
            _fingerprint.value = null
            return
        }
        fingerprintJob = scope.launch {
            delay(FINGERPRINT_DEBOUNCE_MS)
            val roomId = withContext(Dispatchers.Default) {
                runCatching { RoomKeys.derive(normalized).roomId }.getOrNull()
            }
            _fingerprint.value = roomId?.take(FINGERPRINT_CHARS)
        }
    }

    /** Re-derive the fingerprint of every stored room, once, off the main thread. */
    fun refreshStoredFingerprints() {
        scope.launch {
            val rooms = store.rooms()
            val fingerprints = withContext(Dispatchers.Default) {
                rooms.mapNotNull { room ->
                    val token = store.token(room.name) ?: return@mapNotNull null
                    runCatching { room.name to RoomKeys.derive(token).roomId.take(FINGERPRINT_CHARS) }.getOrNull()
                }.toMap()
            }
            _storedFingerprints.value = fingerprints
        }
    }

    fun forgetRoom(name: String) {
        if (connectedRoom == name) disconnect()
        store.removeRoom(name)
        refreshStoredFingerprints()
    }

    fun disconnect() {
        client?.stop()
        client = null
        connectedRoom = null
        _state.value = RemoteClient.ConnectionState.Idle
        _room.value = RemoteClient.RoomSnapshot("", emptyList(), 0, -1)
    }

    fun attach(sessionId: String) = client?.attach(sessionId)

    fun submit(sessionId: String, messageJson: String): Boolean = client?.submit(sessionId, messageJson) ?: false

    fun requestResync() {
        client?.requestResync()
    }

    fun shutdown() {
        disconnect()
        job.cancel()
    }

    /** Printable diagnostics: never a token, never a key. */
    fun describe(): String = "app=${appVersion()} device=${deviceLabel()} · ${store.describe()} · " +
        "state=${_state.value} · room=${_room.value.roomId.ifEmpty { "none" }} peers=${_room.value.peers}"

    private fun deviceLabel(): String {
        val manufacturer = Build.MANUFACTURER?.takeIf { it.isNotEmpty() && it != "unknown" }
        val model = Build.MODEL ?: "android"
        return if (manufacturer == null || model.startsWith(manufacturer, ignoreCase = true)) model else "$manufacturer $model"
    }

    private fun appVersion(): String = runCatching {
        app.packageManager.getPackageInfo(app.packageName, 0).versionName ?: "0"
    }.getOrDefault("0")

    private companion object {
        /** How much of a room id a phone shows: enough to compare two devices by eye. */
        const val FINGERPRINT_CHARS = 8

        /**
         * Long enough that a typist stops before the derivation starts, short enough that a paste
         * shows its fingerprint immediately. 600000 PBKDF2 iterations is ~300 ms on a phone; eight
         * of those per second of typing would be felt.
         */
        const val FINGERPRINT_DEBOUNCE_MS = 250L
    }
}
