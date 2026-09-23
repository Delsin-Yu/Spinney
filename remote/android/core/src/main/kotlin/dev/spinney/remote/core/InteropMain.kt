package dev.spinney.remote.core

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

/**
 * **A test harness, and nothing else.** This `main` exists so that `tools/remote-interop.mjs` can
 * put the Kotlin transport on a real wire against the TypeScript one, through the real relay:
 * every layer of this implementation is unit-tested and the two implementations agree on a vector
 * file, but until a frame crosses between them nothing has proved they interoperate at all.
 *
 * What it is NOT: a CLI, a product surface, or a second client. It has no Android dependency, no
 * configuration, and no features beyond "join, print what happens, optionally send one frame, then
 * leave". If it ever grows a purpose, that purpose belongs in the app or in the harness.
 *
 * The output contract with the harness is one JSON object per line, on stdout, and it is
 * deliberately trivial to parse from Node — no nesting, no arrays, no multi-line values:
 *
 * ```
 * {"event":"room","roomId":"…","saltBytes":4}
 * {"event":"online","peer":"1a2b3c4d","salt":"5e6f7a8b"}
 * {"event":"frame","type":"interop","from":"…","bytes":123,"plaintext":"…","salt":"…",
 *  "fidSalt":"…","fidSaltWouldOpen":false,"path":"envelope"}
 * {"event":"refused","reason":"REPLAYED","detail":"…"}
 * {"event":"sent","fid":"…","bytes":123,"plaintext":"…"}
 * {"event":"replayed","fid":"…","slices":4}
 * {"event":"saltedNudge","fid":"…","slices":4,"salt":"…"}
 * {"event":"exit"}
 * ```
 *
 * `path` says where the salt used to open a frame came from: `"envelope"` for the `s` field the
 * slices carried, which is the only legitimate source (§4/§7). There is no other value: this
 * implementation has no hidden convention to fall back to, and `fidSaltWouldOpen` is printed to
 * *prove* that — it is the salt the old "the first four bytes of `fid`" convention would have
 * inferred, and the frame must not open under it.
 *
 * Flags (all optional except the first three):
 * ```
 *   --relay <url>            e.g. http://127.0.0.1:8787
 *   --token <token>          the room token; one token is one room
 *   --name <label>           the device name to announce in `hello`
 *   --send-file <path>       body JSON to send as one frame of type `interop`, verbatim; the file
 *                            may be arbitrarily large (that is how a multi-slice frame is made)
 *   --send-after-ms <n>      wait this long after coming online before sending (default 300)
 *   --replay-after-ms <n>    re-post the last frame's slices verbatim, after this long
 *   --nudge-salt-after-ms <n> re-post the last frame's slices with `s` replaced by `s xor 1`
 *   --exit-after-ms <n>      stop and leave, this long after start (default: never)
 *   --exit-on-stdin          stop and leave when stdin reaches EOF, which is how the harness says
 *                            "I have finished asserting" without guessing at a duration
 * ```
 *
 * Exit code 0 when it left cleanly, 1 when a flag was wrong, 2 when it never came online.
 */
object InteropMain {

    private val out = java.io.PrintStream(java.io.FileOutputStream(java.io.FileDescriptor.out), true, "UTF-8")
    private val counter = AtomicInteger(0)

    /** One JSON object per line, from any thread, with no interleaving. */
    private fun emit(vararg fields: Pair<String, String>) {
        val line = StringBuilder(64)
        line.append('{')
        fields.forEachIndexed { index, (key, raw) ->
            if (index > 0) line.append(',')
            line.append(JsonValue.of(key).toJson()).append(':').append(raw)
        }
        line.append('}')
        synchronized(out) { out.println(line) }
    }

    private fun emitRaw(vararg fields: Pair<String, Any?>) {
        emit(*fields.map { (key, value) ->
            key to when (value) {
                null -> "null"
                is String -> JsonValue.of(value).toJson()
                is Boolean -> value.toString()
                is Number -> value.toString()
                else -> JsonValue.of(value.toString()).toJson()
            }
        }.toTypedArray())
    }

    private fun flag(args: Array<String>, name: String): String? {
        val index = args.indexOf(name)
        if (index < 0) return null
        require(index + 1 < args.size) { "$name needs a value" }
        return args[index + 1]
    }

    private fun flagMs(args: Array<String>, name: String): Long? = flag(args, name)?.toLong()

    @JvmStatic
    fun main(args: Array<String>) {
        val relay = flag(args, "--relay")
        val token = flag(args, "--token")
        val name = flag(args, "--name")
        if (relay == null || token == null || name == null) {
            System.err.println("InteropMain --relay <url> --token <token> --name <label> [more flags]")
            System.err.println("  this is the interop harness's entry point, not a client: see tools/remote-interop.mjs")
            kotlin.system.exitProcess(1)
        }

        val sendFile = flag(args, "--send-file")
        val sendAfterMs = flagMs(args, "--send-after-ms") ?: 300L
        val replayAfterMs = flagMs(args, "--replay-after-ms")
        val nudgeAfterMs = flagMs(args, "--nudge-salt-after-ms")
        val exitAfterMs = flagMs(args, "--exit-after-ms")
        val exitOnStdin = args.contains("--exit-on-stdin")

        val keys = RoomKeys.derive(token!!)
        emitRaw("event" to "room", "roomId" to keys.roomId, "proto" to Protocol.FRAME_VERSION)

        val client = RemoteClient(
            relayUrl = relay!!,
            token = token,
            machineId = "interop-kotlin-${ProcessHandle.current().pid()}",
            deviceName = name!!,
            instanceId = "interop-${ProcessHandle.current().pid()}",
            appVersion = "0.3.0-interop",
        )

        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val online = CountDownLatch(1)
        val sent = CountDownLatch(1)
        var lastSlices: List<TransportEnvelope>? = null
        var lastFid: String? = null
        var lastSalt: Int = 0

        // Every received frame, with the salt the envelope carried and the control that proves the
        // old hidden convention would have failed here.
        scope.launch {
            client.mirror.collect { }
        }
        scope.launch {
            client.state.collect { state ->
                when (state) {
                    is RemoteClient.ConnectionState.Connected -> {
                        emitRaw("event" to "online", "peer" to state.peerId, "salt" to Nonces.encodeSalt(state.connectionSalt))
                        online.countDown()
                    }
                    is RemoteClient.ConnectionState.Reconnecting ->
                        emitRaw("event" to "reconnecting", "attempt" to state.attempt, "delayMs" to state.delayMs, "reason" to state.reason)
                    is RemoteClient.ConnectionState.Failed -> emitRaw("event" to "failed", "reason" to state.reason)
                    else -> Unit
                }
            }
        }
        var lastPrintedAt = 0L
        scope.launch {
            client.refusals.collect { list ->
                for (refusal in list) {
                    if (refusal.at <= lastPrintedAt) continue
                    lastPrintedAt = refusal.at
                    emitRaw("event" to "refused", "reason" to refusal.reason, "detail" to refusal.detail)
                }
            }
        }
        // The frames themselves arrive through the room model only as trees; the interop run wants
        // the raw ones, so it listens on the same flow the app would render from.
        scope.launch {
            client.frames.collect { received ->
                val oldSalt = oldConventionSalt(received.fid)
                val wouldOpenUnderOldConvention = try {
                    Aead.open(keys.encKey, Nonces.of(received.seq, oldSalt), Aad.bytes(received.v, received.seq, received.fid), received.sealed)
                    true
                } catch (err: TamperFailure) {
                    false
                }
                emitRaw(
                    "event" to "frame",
                    "type" to received.frame.type,
                    "id" to received.frame.id,
                    "from" to received.frame.from,
                    "to" to received.frame.to,
                    "bytes" to received.plaintext.length,
                    "sha256" to Sha256.hex(received.plaintext),
                    "salt" to Nonces.encodeSalt(received.salt),
                    "fidSalt" to Nonces.encodeSalt(oldSalt),
                    "fidSaltWouldOpen" to wouldOpenUnderOldConvention,
                    "path" to "envelope",
                    "plaintext" to received.plaintext,
                )
            }
        }

        client.start()

        val sender = Thread({
            if (!online.await(20, TimeUnit.SECONDS)) {
                emitRaw("event" to "timeout", "phase" to "online")
                kotlin.system.exitProcess(2)
            }
            if (sendFile != null) {
                Thread.sleep(sendAfterMs)
                val bodyJson = File(sendFile).readText()
                val fid = newFid()
                val from = client.state.value.let { (it as? RemoteClient.ConnectionState.Connected)?.peerId } ?: return@Thread
                val frameId = newFid()
                val plaintext = FrameJson.encode("interop", frameId, from, "*", bodyJson)
                lastFid = fid
                val ok = client.interopSendFrameJson(fid, plaintext) { slices ->
                    lastSlices = slices
                    lastSalt = Nonces.decodeSalt(slices.first().s)
                    emitRaw(
                        "event" to "sent",
                        "fid" to fid,
                        "id" to frameId,
                        "slices" to slices.size,
                        "bytes" to plaintext.length,
                        "salt" to slices.first().s,
                        "plaintext" to plaintext,
                    )
                    sent.countDown()
                }
                if (!ok) emitRaw("event" to "sendFailed", "fid" to fid)
            }
            if (replayAfterMs != null) {
                sent.await(10, TimeUnit.SECONDS)
                Thread.sleep(replayAfterMs)
                val slices = lastSlices
                if (slices != null) {
                    emitRaw("event" to "replayed", "fid" to lastFid, "slices" to slices.size)
                    client.interopPostSlices(slices)
                }
            }
            if (nudgeAfterMs != null) {
                sent.await(10, TimeUnit.SECONDS)
                Thread.sleep(nudgeAfterMs)
                // A **fresh** frame (new fid, the next seq) sealed under this connection's real
                // salt, whose envelopes are then stamped with a neighbouring one. Fresh matters:
                // a repeat of an already-seen `seq` is refused as a replay before anybody looks at
                // the tag, and then the run would have proved nothing about the salt.
                val from = client.state.value.let { (it as? RemoteClient.ConnectionState.Connected)?.peerId } ?: return@Thread
                val fid = newFid()
                val plaintext = FrameJson.encode("interop", newFid(), from, "*", "{\"payload\":\"KOTLIN-SALT-NUDGE\"}")
                val honest = client.interopSealOnly(fid, plaintext)
                if (honest != null) {
                    val nudged = honest.map { it.copy(s = Nonces.encodeSalt(Nonces.decodeSalt(it.s) xor 1)) }
                    emitRaw(
                        "event" to "saltedNudge",
                        "fid" to fid,
                        "slices" to nudged.size,
                        "salt" to nudged.first().s,
                        "was" to honest.first().s,
                        "plaintext" to plaintext,
                    )
                    client.interopPostSlices(nudged)
                } else {
                    emitRaw("event" to "saltedNudge", "fid" to fid, "skipped" to true)
                }
            }
        }, "interop-sender").apply { isDaemon = true; start() }

        if (exitOnStdin) {
            // The harness closes this process's stdin when it has finished asserting, so the run
            // lasts exactly as long as the assertions and not a millisecond of a guessed duration.
            Thread({
                try {
                    while (System.`in`.read() >= 0) {
                        // ignore anything the harness sends; EOF is the signal
                    }
                } catch (err: java.io.IOException) {
                    // a closed stream is EOF too
                }
                emitRaw("event" to "exit", "reason" to "stdin")
                client.stop()
                scope.cancel()
                out.flush()
                kotlin.system.exitProcess(0)
            }, "interop-stdin").apply { isDaemon = true; start() }
        }

        if (exitAfterMs != null) {
            Thread.sleep(exitAfterMs)
            emitRaw("event" to "exit", "reason" to "timer")
            client.stop()
            scope.cancel()
            out.flush()
            // `exitProcess` rather than a bare return: every thread this main starts is a daemon,
            // but a lingering non-daemon thread would keep the harness waiting on a dead peer.
            kotlin.system.exitProcess(0)
        }
    }

    /**
     * The salt the pre-`s` convention would have inferred: the first four bytes of `fid` as a
     * big-endian uint32. Printed with every frame so the harness can assert that the frame does
     * **not** open under it — which is what makes "the receiver read `s`" a measured fact rather
     * than a reading of the source.
     */
    private fun oldConventionSalt(fid: String): Int =
        (Hex.decode(fid.substring(0, 8)).fold(0) { acc, b -> (acc shl 8) or (b.toInt() and 0xff) })

    private fun newFid(): String {
        val buffer = ByteArray(Protocol.FRAMING_ID_LENGTH / 2)
        java.security.SecureRandom().nextBytes(buffer)
        return Hex.encode(buffer)
    }
}
