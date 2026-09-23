package dev.spinney.remote.app

import android.app.Application
import android.os.Build
import dev.spinney.remote.core.RoomKeys
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import dev.spinney.remote.core.RemoteClient

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

    fun connect(roomName: String, relayUrl: String, token: String) {
        disconnect()
        store.setToken(roomName, token)
        val room = SecureTokenStore.RoomConfig(roomName, relayUrl)
        store.saveRoom(room)

        val installationId = store.installationId
        val client = RemoteClient(
            relayUrl = relayUrl,
            token = token,
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

    fun forgetRoom(name: String) {
        if (connectedRoom == name) disconnect()
        store.removeRoom(name)
    }

    fun shutdown() {
        disconnect()
        job.cancel()
    }

    /** The room id a token would route to, for the connect screen's confirmation line. */
    fun previewRoomId(token: String): String? = runCatching { RoomKeys.derive(token).roomId }.getOrNull()

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
}
