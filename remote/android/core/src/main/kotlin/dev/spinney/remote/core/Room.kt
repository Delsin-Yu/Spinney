package dev.spinney.remote.core

/**
 * The room tree's brain, and the reason the Android room tree can be a plain Compose list:
 * this is a pure fold over the sealed frames of §5, so what the phone shows is testable
 * without a relay, an emulator or a screen.
 *
 * ```
 * room -> device (by deviceId) -> instance (workspace folder, model, busy) -> session
 * ```
 *
 * The shape it draws is `instances` plus `hello`:
 *
 * - `hello { deviceId, deviceName, instanceId, workspace, appVersion, proto }` — sent on join,
 *   and the only place `deviceId`/`deviceName` come from. `peerId` is assigned by the relay and
 *   is **transient** (§2), so nothing here keys on it: it is an address, not an identity.
 * - `instances { instances: [ { instanceId, workspace, sessions: [ … ] } ] }` — the state the
 *   room tree draws, re-sent whenever it changes.
 * - `bye {}` — a graceful leave, so a peer disappears at once instead of at the 90 s idle
 *   eviction.
 *
 * Grouping is by `deviceId`, not by `peerId`, because two windows on one machine are two peers
 * and one device — that is exactly what §2 says the grouping is for.
 */
class RoomModel(val roomId: String) {

    /** One peer's `hello`. `peerId` is the relay's transient address. */
    data class Peer(
        val peerId: String,
        val deviceId: String,
        val deviceName: String,
        val instanceId: String,
        val workspace: String,
        val appVersion: String,
        val proto: Int,
        val greetedAtMs: Long,
        val lastFrameAtMs: Long,
    )

    /** One session as a publisher announced it. `nodes` is the node count, not the nodes. */
    data class Session(
        val id: String,
        val title: String,
        val running: Boolean,
        val lockedNodes: Int,
        val backgroundNodes: Int,
        val model: String,
        val modelName: String,
        val effort: String,
        val nodes: Int,
    ) {
        /** §5's `running` is a boolean; a locked node is the reason Send becomes Stop locally. */
        val busy: Boolean get() = running || lockedNodes > 0
    }

    /** One published window: what the instance row shows. */
    data class Instance(
        val peerId: String,
        val instanceId: String,
        val workspace: String,
        val sessions: List<Session>,
        val updatedAtMs: Long,
    ) {
        /** The models in play, for the instance row's summary. */
        val modelNames: List<String> get() = sessions.map { it.modelName }.filter { it.isNotEmpty() }.distinct()
    }

    /** The tree's top row: one machine, however many windows it runs. */
    data class Device(val deviceId: String, val deviceName: String, val instances: List<Instance>) {
        val sessionCount: Int get() = instances.sumOf { it.sessions.size }
        val busy: Boolean get() = instances.any { instance -> instance.sessions.any { it.busy } }
    }

    private val peers = LinkedHashMap<String, Peer>()
    private val instances = LinkedHashMap<String, Instance>()

    /** True when the last [apply] changed anything a screen would redraw. */
    var revision: Long = 0
        private set

    fun peerCount(): Int = peers.size

    /**
     * Fold one sealed frame into the model. Returns true when the model changed. Unknown
     * types are ignored rather than refused: the transport already decided what may cross
     * (`remote/PROTOCOL.md` §6), and the room tree only needs the three types above.
     */
    fun apply(frame: Frame, atMs: Long): Boolean = when (frame.type) {
        "hello" -> applyHello(frame, atMs)
        "bye" -> removePeer(frame.from)
        "instances" -> applyInstances(frame, atMs)
        else -> false
    }

    private fun applyHello(frame: Frame, atMs: Long): Boolean {
        val body = frame.body
        val previous = peers[frame.from]
        val peer = Peer(
            peerId = frame.from,
            deviceId = body.strOrNull("deviceId") ?: previous?.deviceId ?: frame.from,
            deviceName = body.strOrNull("deviceName") ?: previous?.deviceName ?: frame.from,
            instanceId = body.strOrNull("instanceId") ?: previous?.instanceId ?: "",
            workspace = body.strOrNull("workspace") ?: previous?.workspace ?: "",
            appVersion = body.strOrNull("appVersion") ?: previous?.appVersion ?: "",
            proto = (body["proto"] as? JsonValue.Num)?.toLong()?.toInt() ?: previous?.proto ?: 0,
            greetedAtMs = previous?.greetedAtMs ?: atMs,
            lastFrameAtMs = atMs,
        )
        peers[frame.from] = peer
        revision++
        return true
    }

    private fun applyInstances(frame: Frame, atMs: Long): Boolean {
        val announced = frame.body["instances"] as? JsonValue.Arr
            ?: return false
        val seen = HashSet<String>()
        var changed = false
        for (entry in announced.items) {
            val obj = entry as? JsonValue.Obj ?: continue
            val instanceId = obj.strOrNull("instanceId") ?: continue
            val key = frame.from + "/" + instanceId
            seen.add(key)
            val sessions = (obj["sessions"] as? JsonValue.Arr)?.items.orEmpty().mapNotNull { item ->
                val s = item as? JsonValue.Obj ?: return@mapNotNull null
                Session(
                    id = s.strOrNull("id") ?: return@mapNotNull null,
                    title = s.strOrNull("title") ?: "",
                    running = (s["running"] as? JsonValue.Bool)?.value ?: false,
                    lockedNodes = (s["lockedNodes"] as? JsonValue.Num)?.toLong()?.toInt() ?: 0,
                    backgroundNodes = (s["backgroundNodes"] as? JsonValue.Num)?.toLong()?.toInt() ?: 0,
                    model = s.strOrNull("model") ?: "",
                    modelName = s.strOrNull("modelName") ?: "",
                    effort = s.strOrNull("effort") ?: "",
                    nodes = (s["nodes"] as? JsonValue.Num)?.toLong()?.toInt() ?: 0,
                )
            }
            val instance = Instance(
                peerId = frame.from,
                instanceId = instanceId,
                workspace = obj.strOrNull("workspace") ?: "",
                sessions = sessions,
                updatedAtMs = atMs,
            )
            if (instances[key] != instance) {
                instances[key] = instance
                changed = true
            }
        }
        // An `instances` frame is the peer's whole truth: an instance it no longer lists is
        // gone. Without this, a closed window would keep a stale row forever.
        val stale = instances.keys.filter { it.startsWith("${frame.from}/") && it !in seen }
        for (key in stale) {
            instances.remove(key)
            changed = true
        }
        peers[frame.from]?.let { peers[frame.from] = it.copy(lastFrameAtMs = atMs) }
        if (changed) revision++
        return changed
    }

    /** A peer left, or stopped answering: its instances go with it. */
    fun removePeer(peerId: String): Boolean {
        val removed = peers.remove(peerId) != null
        val stale = instances.keys.filter { it.startsWith("$peerId/") }
        for (key in stale) instances.remove(key)
        if (removed || stale.isNotEmpty()) revision++
        return removed || stale.isNotEmpty()
    }

    /** The room tree, folded and sorted by device name then workspace so it does not jump. */
    fun devices(): List<Device> {
        val byDevice = LinkedHashMap<String, MutableList<Instance>>()
        val names = LinkedHashMap<String, String>()
        for ((key, instance) in instances) {
            val peer = peers[instance.peerId]
            // No `hello` yet: the instance is not drawable, because a device row has no name.
            val deviceId = peer?.deviceId ?: continue
            names[deviceId] = peer.deviceName
            byDevice.getOrPut(deviceId) { ArrayList() }.add(instance)
            if (key.isEmpty()) continue // unreachable; keeps the key explicit for readers
        }
        return byDevice.entries
            .map { (deviceId, list) ->
                Device(
                    deviceId = deviceId,
                    deviceName = names[deviceId] ?: deviceId.take(8),
                    instances = list.sortedBy { it.workspace.lowercase() },
                )
            }
            .sortedWith(compareBy({ it.deviceName.lowercase() }, { it.deviceId }))
    }

    /** Where a session lives, so a tap can `attach` to the right publisher. */
    data class SessionRef(val peerId: String, val instanceId: String, val session: Session)

    fun sessionRef(sessionId: String): SessionRef? {
        for (instance in instances.values) {
            val session = instance.sessions.firstOrNull { it.id == sessionId } ?: continue
            return SessionRef(instance.peerId, instance.instanceId, session)
        }
        return null
    }

    /** Peers that have gone quiet past the relay's eviction window are dropped locally too. */
    fun evictSilent(nowMs: Long, timeoutMs: Long = Protocol.PEER_IDLE_EVICT_MS): Boolean {
        val dead = peers.values.filter { nowMs - it.lastFrameAtMs > timeoutMs }.map { it.peerId }
        var changed = false
        for (peerId in dead) changed = removePeer(peerId) || changed
        return changed
    }

    fun describe(): String = buildString {
        append("room ").append(roomId).append(": ")
        val devices = devices()
        append(devices.size).append(" device(s), ")
        append(devices.sumOf { it.instances.size }).append(" instance(s), ")
        append(devices.sumOf { it.sessionCount }).append(" session(s)")
    }
}
