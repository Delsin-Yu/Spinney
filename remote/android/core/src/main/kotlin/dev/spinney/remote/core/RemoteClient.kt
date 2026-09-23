package dev.spinney.remote.core

import java.io.IOException
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * One room connection, in **pure Kotlin/JVM**: the replica side of §7 of `remote/PROTOCOL.md`.
 *
 * WHY IT LIVES IN `:core` AND NOT IN `:app`. This class owns the protocol — the SSE down stream,
 * the POST up path, the heartbeat, the reconnect rule, the frame dispatch — and none of its
 * failure modes are Android's. Keeping it here means the same transport the phone runs can be
 * driven by a plain JVM `main` (`InteropMain`), which is the only way the Kotlin implementation
 * can ever be put on a wire against the TypeScript one (`tools/remote-interop.mjs`). It must
 * therefore never import `android.*` or an androidx type: OkHttp, `java.*` and
 * `kotlinx.coroutines.flow` are the whole of its outside world.
 *
 * - **SSE down, POST up.** The same shape the extension host has, in the only form a JVM has:
 *   OkHttp rather than `fetch` + `response.body.getReader()`.
 * - **A 20 s application `ping`, answered by `pong`.** [Protocol.CLIENT_PING_INTERVAL_MS] is a
 *   constant of the contract, not a tunable: it is what stops a quiet room from being killed by
 *   an idle-read timeout, and — together with the relay's own 15 s comment — it is how a
 *   half-open connection is detected. Anything that arrives, including a `: ping` comment,
 *   proves the stream is alive.
 * - **Exponential backoff with jitter and a cap** on every transport failure.
 * - **A fresh 32-bit connection salt and `seq` back at 1 on every reconnect**
 *   ([SealedConnection.fresh]). Reusing the old salt would reuse every nonce of the previous
 *   connection, and GCM does not complain about that: it silently leaks the XOR of the two
 *   plaintexts and the authentication key. That is the one failure this class must never make,
 *   and it is why there is no "resume the connection" path here at all.
 * - **The receiver takes the salt from the envelope.** A frame from another peer is opened under
 *   *that peer's* salt, read from the `s` its slices carried (§4/§7), never under this
 *   connection's own — see [SealedConnection.open].
 *
 * What it is not: a publisher. A replica announces itself with `hello` (§2 says every peer does),
 * attaches to sessions, renders them and submits input. It has no sessions of its own to
 * announce, so it never sends `instances`; the Android app and the interop harness are both just
 * replicas with different surfaces.
 *
 * Threading: one loop thread owns the stream and the model; one writer thread owns the send
 * order (so `seq` is monotonic and slices of a frame cannot interleave); one scheduler owns the
 * heartbeat. State reaches the caller through [StateFlow], which is thread-safe by construction.
 */
class RemoteClient(
    private val relayUrl: String,
    private val token: String,
    private val machineId: String,
    private val deviceName: String,
    private val instanceId: String,
    private val appVersion: String,
) {

    /** What the room screen shows about the phone's own connection. */
    sealed interface ConnectionState {
        data object Idle : ConnectionState

        data class Connecting(val roomId: String) : ConnectionState

        data class Connected(
            val roomId: String,
            val peerId: String,
            val peers: Int,
            /**
             * This connection's own random salt (§4), the half of the nonce the receiver of *our*
             * frames reads from the envelope. A reconnect mints a new one, which is why it is
             * worth showing: "connected, salt 1a2b3c4d" is the state a stuck room needs to see.
             */
            val connectionSalt: Int,
        ) : ConnectionState

        data class Reconnecting(val attempt: Int, val delayMs: Long, val reason: String) : ConnectionState

        /** A failure a retry cannot fix (a malformed room id, a relay that refuses this peer). */
        data class Failed(val reason: String) : ConnectionState
    }

    /** A snapshot of the room tree: immutable, so Compose can compare it and redraw. */
    data class RoomSnapshot(
        val roomId: String,
        val devices: List<RoomModel.Device>,
        val peers: Int,
        val revision: Long,
    ) {
        val isReady: Boolean get() = roomId.isNotEmpty()

        fun sessionCount(): Int = devices.sumOf { it.sessionCount }
    }

    /**
     * One mirrored host→webview message, verbatim (§5). [messageJson] is the publisher's exact
     * bytes and is handed to the WebView unchanged — re-encoding it would put a second renderer
     * between the two surfaces.
     */
    data class MirrorMessage(val sessionId: String, val messageJson: String, val type: String)

    /**
     * Every logical frame this connection opened, with the material it was opened from.
     *
     * The app renders from [MirrorMessage] and never needs this; it exists for the interop
     * harness (`InteropMain`), which has to compare its own bytes with the other implementation's
     * — including the salt the wire carried, so "the receiver read `s`" is measured rather than
     * asserted in prose.
     */
    data class ReceivedFrame(
        val frame: Frame,
        val plaintext: String,
        val v: Int,
        val seq: Long,
        val salt: Int,
        val fid: String,
        val sealed: ByteArray,
    )

    /** A frame this phone refused, or a note the room sent. Surfaced, never swallowed. */
    data class Refusal(val reason: String, val detail: String, val at: Long)

    private val keys: Lazy<RoomKeys> = lazy { RoomKeys.derive(token) }

    /** The relay URL path segment: the room id is the routing credential, 26 base32 chars. */
    val roomId: String get() = keys.value.roomId

    /**
     * The room tree's fold (§2/§5). Written by the stream thread, read by the writer thread and
     * by [StateFlow] snapshots; the derivation that gives it its room id runs on the loop thread,
     * so the id arrives with the first connect.
     */
    @Volatile
    private var model = RoomModel("")

    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Idle)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    private val _room = MutableStateFlow(RoomSnapshot("", emptyList(), 0, -1))
    val room: StateFlow<RoomSnapshot> = _room.asStateFlow()

    /** Mirrored messages, one per publisher message. Dropped-oldest rather than unbounded. */
    private val _mirror = MutableSharedFlow<MirrorMessage>(extraBufferCapacity = 256)
    val mirror: SharedFlow<MirrorMessage> = _mirror.asSharedFlow()

    /**
     * Every opened logical frame, in arrival order — the interop harness's view of the room. No
     * replay and a bounded buffer: a caller that is not collecting has not asked for them, and the
     * room itself is not a log.
     */
    private val _frames = MutableSharedFlow<ReceivedFrame>(extraBufferCapacity = 64)
    val frames: SharedFlow<ReceivedFrame> = _frames.asSharedFlow()

    /**
     * Suspends until something is collecting [mirror].
     *
     * A mirror frame emitted with no collector is **dropped** (the flow has no replay, on
     * purpose: a replicated session is not a queue to replay from, it is the publisher's current
     * state). The publisher answers an `attach` immediately, so an `attach` that outran its own
     * subscription would lose the session's first state — which is the state a freshly opened
     * webview needs. Subscribing first and waiting for it is how that is impossible.
     */
    suspend fun awaitMirrorCollector() {
        _mirror.subscriptionCount.first { it > 0 }
    }

    private val _refusals = MutableStateFlow<List<Refusal>>(emptyList())
    val refusals: StateFlow<List<Refusal>> = _refusals.asStateFlow()

    private val started = AtomicBoolean(false)
    private val attached = LinkedHashSet<String>()

    /** sessionId -> the publisher peerId an `attach` was actually sent to. */
    private val attachedAtPeer = HashMap<String, String>()

    @Volatile
    private var peerId: String? = null

    @Volatile
    private var connection: SealedConnection? = null

    @Volatile
    private var streamCall: Call? = null

    @Volatile
    private var lastInboundAt: Long = 0

    private var loop: Thread? = null
    private var pingFuture: ScheduledFuture<*>? = null
    private var watchdogFuture: ScheduledFuture<*>? = null

    private val backoff = Backoff()
    private val random = SecureRandom()

    private val writer = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "spinney-remote-send").apply { isDaemon = true }
    }

    private val scheduler = Executors.newScheduledThreadPool(2) { runnable ->
        Thread(runnable, "spinney-remote-heartbeat").apply { isDaemon = true }
    }

    /**
     * The stream client reads with **no read timeout**: a quiet room is the normal state, and a
     * read timeout would kill exactly the connection the 20 s `ping` exists to keep alive. The
     * relay's own comments and the pings are the liveness signal, checked by the watchdog.
     */
    private val streamClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(false)
        .build()

    /** POSTs get a deadline: a relay that accepts a frame and never answers must not hang the writer. */
    private val postClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build()

    // ---------------------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------------------

    fun start() {
        if (!started.compareAndSet(false, true)) return
        loop = Thread({ runLoop() }, "spinney-remote-loop").apply {
            isDaemon = true
            start()
        }
    }

    /**
     * Drop everything. There is no graceful `leave` route in the contract (§7 records that as a
     * known limitation), so the peer keeps its room slot until the relay's 90 s idle eviction —
     * which is what the slot cap is sized for.
     */
    fun stop() {
        started.set(false)
        stopHeartbeat()
        streamCall?.cancel()
        loop?.interrupt()
        writer.shutdownNow()
        scheduler.shutdownNow()
        connection = null
        peerId = null
        _state.value = ConnectionState.Idle
    }

    // ---------------------------------------------------------------------------------------
    // The reconnect loop
    // ---------------------------------------------------------------------------------------

    private fun runLoop() {
        var attempt = 0
        while (started.get()) {
            var reason: String? = null
            try {
                connectAndStream()
                if (!started.get()) return
                // A stream that ended without an error is still a dropped connection.
                reason = "the stream ended"
            } catch (fatal: FatalRelayException) {
                _state.value = ConnectionState.Failed(fatal.message ?: "the relay refused this peer")
                return
            } catch (err: InterruptedException) {
                return
            } catch (err: Throwable) {
                if (!started.get()) return
                reason = err.message ?: err.javaClass.simpleName
            }
            if (!started.get()) return
            attempt++
            val delay = backoff.delayMs(attempt)
            _state.value = ConnectionState.Reconnecting(attempt, delay, reason ?: "reconnecting")
            try {
                Thread.sleep(delay)
            } catch (err: InterruptedException) {
                return
            }
        }
    }

    private fun connectAndStream() {
        val keys = keys.value
        _state.value = ConnectionState.Connecting(keys.roomId)
        // The model's room id is the routing credential, so it can only exist once the
        // derivation has run (600000 PBKDF2 iterations, once per process).
        if (model.roomId.isEmpty()) model = RoomModel(keys.roomId)

        // A NEW connection: a fresh 32-bit salt and seq back at 1. Never the old salt.
        val conn = SealedConnection.fresh(keys)
        val peer = join(keys)
        connection = conn
        peerId = peer
        lastInboundAt = System.currentTimeMillis()
        _state.value = ConnectionState.Connected(keys.roomId, peer, model.peerCount(), conn.connectionSalt)
        publishRoom()

        beginHeartbeat()
        try {
            // §2: every window announces itself. The phone has no sessions to publish, so this is
            // all it announces — and it is what makes it appear in the room's peer count.
            sendFrame("hello", "*", helloBody())
            // §7's reconnect procedure, in order: re-attach what was attached, then ask for the
            // state a freshly opened webview would have received.
            for (sessionId in attached.toList()) {
                model.sessionRef(sessionId)?.let { ref ->
                    attachedAtPeer[sessionId] = ref.peerId
                    sendFrame("attach", ref.peerId, sessionBody(sessionId))
                }
            }
            sendFrame("resync", "*", "{}")
            stream(keys, peer, conn)
        } finally {
            stopHeartbeat()
            connection = null
            conn.clearInFlight()
        }
    }

    private fun join(keys: RoomKeys): String {
        val request = Request.Builder()
            .url(RelayRoutes.join(relayUrl, keys.roomId))
            .post(ByteArray(0).toRequestBody(null))
            .build()
        postClient.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (response.code == 404) {
                throw FatalRelayException("the relay does not recognise this room id (404 invalid_room_id)")
            }
            if (response.code == 429) {
                throw IOException("the room is full or the relay is at its room cap (429 $text)")
            }
            if (!response.isSuccessful) {
                throw FatalRelayException("join refused: HTTP ${response.code} $text")
            }
            val obj = try {
                JsonValue.parse(text) as? JsonValue.Obj
            } catch (err: IllegalArgumentException) {
                null
            } ?: throw IOException("the relay's join answer is not JSON: $text")
            return obj.strOrNull("peer") ?: throw IOException("the relay's join answer has no peer id")
        }
    }

    private fun stream(keys: RoomKeys, peer: String, conn: SealedConnection) {
        val request = Request.Builder()
            .url(RelayRoutes.down(relayUrl, keys.roomId, peer))
            .header("Accept", "text/event-stream")
            .build()
        val call = streamClient.newCall(request)
        streamCall = call
        try {
            call.execute().use { response ->
                if (!response.isSuccessful) {
                    throw IOException("down refused: HTTP ${response.code}")
                }
                val source = response.body?.source() ?: throw IOException("the relay sent no body")
                val parser = SseParser()
                while (started.get()) {
                    val line = source.readUtf8Line() ?: break
                    lastInboundAt = System.currentTimeMillis()
                    for (event in parser.feed(line + "\n")) {
                        when (event) {
                            is SseParser.Event.Comment -> lastInboundAt = System.currentTimeMillis()
                            is SseParser.Event.Data -> onPayload(event.payload, conn)
                        }
                    }
                }
            }
        } finally {
            streamCall = null
        }
    }

    // ---------------------------------------------------------------------------------------
    // Inbound
    // ---------------------------------------------------------------------------------------

    private fun onPayload(payload: String, conn: SealedConnection) {
        val envelope = try {
            TransportEnvelope.parse(payload)
        } catch (err: IllegalArgumentException) {
            // The relay forwards verbatim and never validates; a malformed line is refused, not
            // guessed at. §7's shape is the only shape this receiver understands.
            refuse("envelope", err.message ?: "the relay sent a malformed envelope")
            return
        }
        when (val outcome = conn.accept(envelope)) {
            null -> Unit // more slices of this frame are still on their way
            is OpenOutcome.Opened -> {
                _frames.tryEmit(
                    ReceivedFrame(
                        frame = outcome.frame,
                        plaintext = outcome.plaintext,
                        v = outcome.v,
                        seq = outcome.seq,
                        salt = outcome.salt,
                        fid = outcome.fid,
                        sealed = outcome.sealed,
                    ),
                )
                onFrame(outcome.frame)
            }
            is OpenOutcome.Refused -> refuse(outcome.reason.name, outcome.detail)
        }
    }

    private fun onFrame(frame: Frame) {
        // The relay forwards to every *other* peer, so a frame "from" us is a lie or a loop.
        if (frame.from == peerId) return

        when (frame.type) {
            "instances", "hello", "bye" -> {
                if (model.apply(frame, System.currentTimeMillis())) {
                    // A new publisher may be the one an attached session lives on.
                    resendMissingAttaches()
                    publishRoom()
                    (state.value as? ConnectionState.Connected)?.let {
                        _state.value = it.copy(peers = model.peerCount())
                    }
                }
            }

            "mirror" -> {
                val sessionId = frame.sessionId
                val message = frame.wrappedMessage
                if (sessionId == null || message == null) {
                    refuse("mirror", "a mirror frame without a sessionId and a message is refused")
                    return
                }
                val type = message.strOrNull("type")
                if (MirrorPolicy.routeHostMessage(type) != MirrorPolicy.Route.MIRROR_IN) {
                    // Defense in depth: the publisher's allow-list is the authority, and a type
                    // that is not on it is dropped here rather than rendered.
                    refuse("mirror", "refused a mirrored message of type '${type ?: "?"}'")
                    return
                }
                _mirror.tryEmit(MirrorMessage(sessionId, message.toJson(), type ?: ""))
            }

            "ping" -> sendFrame("pong", frame.from, "{}")
            "pong" -> lastInboundAt = System.currentTimeMillis()

            "resync" -> Unit // a replica publishes nothing, so there is nothing to re-send

            "attach", "detach", "input" -> sendFrame(
                "error",
                frame.from,
                "{\"code\":\"unsupported\",\"message\":\"this peer is a phone: it renders and submits, it publishes no session\",\"ref\":${JsonValue.of(frame.id).toJson()}}",
            )

            "error" -> {
                val code = frame.body.strOrNull("code") ?: "error"
                val message = frame.body.strOrNull("message") ?: ""
                refuse("relay:$code", message)
            }

            else -> refuse("unknown-type", "the room sent '${frame.type}', which this build does not know")
        }
    }

    private fun refuse(reason: String, detail: String) {
        val next = _refusals.value + Refusal(reason, detail, System.currentTimeMillis())
        _refusals.value = if (next.size > MAX_REFUSALS) next.takeLast(MAX_REFUSALS) else next
    }

    private fun publishRoom() {
        _room.value = RoomSnapshot(
            roomId = model.roomId,
            devices = model.devices(),
            peers = model.peerCount(),
            revision = model.revision,
        )
    }

    // ---------------------------------------------------------------------------------------
    // Outbound
    // ---------------------------------------------------------------------------------------

    /**
     * Attach to a session so its publisher starts mirroring it. Recorded even when the session is
     * not in the room tree yet: the attach is sent as soon as the publisher becomes known, which
     * is what makes tapping a session that arrived in a racing `instances` frame work.
     */
    fun attach(sessionId: String) {
        val isNew = attached.add(sessionId)
        val ref = model.sessionRef(sessionId)
        if (ref == null) return
        if (!isNew && attachedAtPeer[sessionId] == ref.peerId) return
        attachedAtPeer[sessionId] = ref.peerId
        sendFrame("attach", ref.peerId, sessionBody(sessionId))
    }

    fun detach(sessionId: String) {
        attached.remove(sessionId)
        val peer = attachedAtPeer.remove(sessionId) ?: return
        sendFrame("detach", peer, sessionBody(sessionId))
    }

    /**
     * Submit one webview→host message to the publisher, verbatim (`input`, §5).
     *
     * The type is checked against §6 here as well as at the publisher, because the four messages
     * that act on **this** device (`openExternal`, `pickImage`, `copyNodeId`, `setNodeSize`) must
     * never be asked of the owner's machine — see [MirrorPolicy].
     */
    fun submit(sessionId: String, messageJson: String): Boolean {
        val type = runCatching {
            ((JsonValue.parse(messageJson) as? JsonValue.Obj)?.strOrNull("type"))
        }.getOrNull()
        return when (MirrorPolicy.routeWebviewMessage(type)) {
            MirrorPolicy.Route.INPUT_UP -> {
                val peer = model.sessionRef(sessionId)?.peerId
                if (peer == null) {
                    refuse("input", "no publisher is known for session $sessionId")
                    false
                } else {
                    sendFrame("input", peer, "{\"sessionId\":${JsonValue.of(sessionId).toJson()},\"message\":$messageJson}")
                    true
                }
            }
            MirrorPolicy.Route.LOCAL -> {
                // Handled by the WebView host (the clipboard, a link, the picker). Reaching here
                // means the host forgot to handle it; saying so beats a silent no-op.
                refuse("local", "'${type ?: "?"}' acts on this phone and was not handled locally")
                false
            }
            MirrorPolicy.Route.REFUSED, MirrorPolicy.Route.MIRROR_IN -> {
                refuse("denied", "'${type ?: "?"}' is not on §6's accept-from-peer table")
                false
            }
        }
    }

    /** Ask for fresh state — the same request the client makes after a reconnect (§7). */
    fun requestResync(sessionId: String? = null) {
        if (sessionId == null) sendFrame("resync", "*", "{}")
        else sendFrame("resync", model.sessionRef(sessionId)?.peerId ?: return, sessionBody(sessionId))
    }

    private fun resendMissingAttaches() {
        for (sessionId in attached.toList()) {
            val ref = model.sessionRef(sessionId) ?: continue
            if (attachedAtPeer[sessionId] == ref.peerId) continue
            attachedAtPeer[sessionId] = ref.peerId
            sendFrame("attach", ref.peerId, sessionBody(sessionId))
        }
    }

    /**
     * Seal one logical frame and queue its slices, in order. The writer thread is what makes
     * `seq` monotonic and keeps two frames' slices from interleaving on the wire; each slice is
     * one POST.
     */
    private fun sendFrame(type: String, to: String, bodyJson: String) {
        val from = peerId ?: return
        writer.execute {
            val conn = connection ?: return@execute
            try {
                val frameJson = FrameJson.encode(type, newId(), from, to, bodyJson)
                for (slice in conn.seal(newId(), frameJson)) {
                    postUp(slice)
                }
            } catch (err: Throwable) {
                // A send that cannot complete means the transport is gone: drop the stream so the
                // loop reconnects with a fresh salt, rather than retrying frames under the old one.
                refuse("send", "${err.javaClass.simpleName}: ${err.message}")
                streamCall?.cancel()
            }
        }
    }

    /**
     * Send a logical frame whose JSON the **caller** built, and hand the envelope lines back to
     * it. Exists for the interop harness (`InteropMain`), which has to be able to (a) know the
     * exact plaintext it put on the wire so the other implementation's copy of it can be compared
     * byte for byte, and (b) replay its own slices verbatim, or re-stamp their salt, to prove the
     * receiving side reads `s` and refuses a repeat. A normal caller uses [submit]/[attach].
     *
     * [deliver] runs on the writer thread, after the slices have been sealed and before/while
     * they are posted. Returns false when the connection is not online (nothing was queued).
     */
    fun interopSendFrameJson(fid: String, frameJson: String, deliver: (List<TransportEnvelope>) -> Unit = {}): Boolean {
        if (peerId == null || connection == null) return false
        writer.execute {
            val conn = connection ?: return@execute
            try {
                val slices = conn.seal(fid, frameJson)
                deliver(slices)
                for (slice in slices) postUp(slice)
            } catch (err: Throwable) {
                refuse("send", "${err.javaClass.simpleName}: ${err.message}")
                streamCall?.cancel()
            }
        }
        return true
    }

    /**
     * Seal a frame and hand its slices back **without posting them** — the interop harness's
     * neighbouring-salt case. It has to seal with the connection's real salt and then stamp the
     * *envelope* with a different one, so that the receiving implementation builds a nonce the
     * frame was not sealed under: the only way to show that a receiver uses `s` and nothing else.
     *
     * Blocking, because the caller needs the result and there is nothing else to do meanwhile.
     * Returns null when the connection is not online.
     */
    fun interopSealOnly(fid: String, frameJson: String): List<TransportEnvelope>? {
        if (peerId == null || connection == null) return null
        var slices: List<TransportEnvelope>? = null
        val latch = java.util.concurrent.CountDownLatch(1)
        writer.execute {
            try {
                slices = connection?.seal(fid, frameJson)
            } catch (err: Throwable) {
                refuse("seal", "${err.javaClass.simpleName}: ${err.message}")
            } finally {
                latch.countDown()
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        return slices
    }

    /**
     * Post these envelope lines **verbatim**, without sealing anything. Only the interop harness
     * uses it, for the two cases a client must never do itself: re-posting a frame it already
     * sent (a replay the peer has to refuse), and posting a frame whose `s` was altered (which the
     * AEAD must reject — the salt is half the nonce).
     */
    fun interopPostSlices(slices: List<TransportEnvelope>) {
        writer.execute {
            for (slice in slices) {
                try {
                    postUp(slice)
                } catch (err: Throwable) {
                    refuse("send", "${err.javaClass.simpleName}: ${err.message}")
                    streamCall?.cancel()
                    return@execute
                }
            }
        }
    }

    /** This connection's own salt, or null while offline — the interop harness announces it. */
    fun interopConnectionSalt(): Int? = connection?.connectionSalt

    private fun postUp(slice: TransportEnvelope) {
        val peer = peerId ?: return
        val request = Request.Builder()
            .url(RelayRoutes.up(relayUrl, roomId, peer))
            .post(slice.toJson().toRequestBody(PLAIN_TEXT))
            .build()
        postClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val detail = runCatching { response.body?.string()?.take(200) }.getOrNull().orEmpty()
                throw IOException("up refused: HTTP ${response.code} $detail")
            }
        }
    }

    private fun helloBody(): String = "{" +
        // §2: deviceId is sha256hex(utf8(machineId + roomId)) — stable per machine per room, and
        // deliberately different across rooms so a peer cannot correlate a device between two.
        "\"deviceId\":${JsonValue.of(DeviceIdentity.deviceId(machineId, roomId)).toJson()}," +
        "\"deviceName\":${JsonValue.of(deviceName).toJson()}," +
        "\"instanceId\":${JsonValue.of(instanceId).toJson()}," +
        "\"workspace\":\"\"," +
        "\"appVersion\":${JsonValue.of(appVersion).toJson()}," +
        "\"proto\":${Protocol.FRAME_VERSION}" +
        "}"

    private fun sessionBody(sessionId: String): String = "{\"sessionId\":${JsonValue.of(sessionId).toJson()}}"

    private fun newId(): String {
        val buffer = ByteArray(Protocol.FRAMING_ID_LENGTH / 2)
        random.nextBytes(buffer)
        return Hex.encode(buffer)
    }

    // ---------------------------------------------------------------------------------------
    // Liveness
    // ---------------------------------------------------------------------------------------

    private fun beginHeartbeat() {
        pingFuture = scheduler.scheduleAtFixedRate(
            { if (started.get()) sendFrame("ping", "*", "{}") },
            Protocol.CLIENT_PING_INTERVAL_MS,
            Protocol.CLIENT_PING_INTERVAL_MS,
            TimeUnit.MILLISECONDS,
        )
        watchdogFuture = scheduler.scheduleAtFixedRate(
            { checkLiveness() },
            WATCHDOG_INTERVAL_MS,
            WATCHDOG_INTERVAL_MS,
            TimeUnit.MILLISECONDS,
        )
    }

    private fun stopHeartbeat() {
        pingFuture?.cancel(false)
        watchdogFuture?.cancel(false)
        pingFuture = null
        watchdogFuture = null
    }

    /**
     * The half-open detector. The relay writes a `: ping` comment every 15 s and peers answer a
     * `ping` with `pong`, so on a live connection *something* arrives well inside [SILENCE_LIMIT].
     * Silence past it means the socket is a ghost: cancel the call so the loop rebuilds the
     * connection — with a new salt — instead of waiting forever on a dead stream. The loop, not
     * this watchdog, reports the reconnect (and its backoff delay), so there is one place that
     * decides how long to wait.
     */
    private fun checkLiveness() {
        if (!started.get() || streamCall == null) return
        val silentFor = System.currentTimeMillis() - lastInboundAt
        if (silentFor > SILENCE_LIMIT_MS) {
            refuse("liveness", "no traffic for ${silentFor / 1000}s; rebuilding the connection")
            streamCall?.cancel()
        }
    }

    companion object {
        private val PLAIN_TEXT = "text/plain; charset=utf-8".toMediaType()
        private const val WATCHDOG_INTERVAL_MS = 10_000L

        /** 2.5 x the relay's 15 s comment interval, so a lost comment is not a lost connection. */
        private const val SILENCE_LIMIT_MS = 40_000L
        private const val MAX_REFUSALS = 50
    }
}

/** A failure no retry can fix: a malformed room id, or a relay that refuses this peer outright. */
class FatalRelayException(message: String) : IOException(message)
