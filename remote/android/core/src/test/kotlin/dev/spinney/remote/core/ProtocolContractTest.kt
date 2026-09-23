package dev.spinney.remote.core

import java.util.Base64
import kotlin.random.Random
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test

/**
 * The rest of the contract, asserted without the vectors: the nonce's freshness, the three
 * distinguishable failure modes, the replay window, the frame's own JSON, the SSE parser, the
 * reconnect backoff, and the room tree's fold.
 *
 * `remote/vectors/vectors.json` pins *bytes*; these tests pin *behaviour* — the parts of
 * `remote/PROTOCOL.md` that are stated as rules rather than as values.
 */
class ProtocolContractTest {

    private val keys by lazy { RoomKeys.derive("contract-test-token") }
    private val fid = "0123456789abcdef"

    // ---------------------------------------------------------------------------------------
    // §4 — "a reused nonce is a silent cryptographic failure"; a reconnect must not reuse one.
    // ---------------------------------------------------------------------------------------

    @Test
    @DisplayName("reconnect: a fresh 32-bit salt and a new nonce sequence, never the old salt with seq back at 1")
    fun reconnectMintsAFreshSaltAndRestartsTheSequence() {
        val first = SealedConnection.fresh(keys)
        val second = SealedConnection.fresh(keys)

        // The salt is random per connection; two draws agreeing would be a 2^-32 event, and if
        // this ever fails the right conclusion is the RNG, not the assertion.
        assertNotEquals(first.connectionSalt, second.connectionSalt, "a reconnect must mint a fresh connection salt")
        assertEquals(1L, first.sequence, "seq starts at 1 per connection")
        assertEquals(1L, second.sequence, "the new connection's seq starts at 1 again — under a new salt")

        // The same (seq, salt) pair under one key produces the *same* bytes and GCM does not
        // complain: that is the silent failure, and it is why the salt is per connection.
        val plaintext = "{\"v\":1,\"type\":\"ping\",\"id\":\"$fid\",\"from\":\"9f3a1c02\",\"to\":\"*\",\"body\":{}}".toUtf8()
        val pinnedA = SealedConnection.pinned(keys, 0x5a5a5a5a)
        val pinnedB = SealedConnection.pinned(keys, 0x5a5a5a5a)
        val sliceA = pinnedA.sealAt(1, 1L, 0x5a5a5a5a, fid, plaintext).single()
        val sliceB = pinnedB.sealAt(1, 1L, 0x5a5a5a5a, fid, plaintext).single()
        assertTrue(sliceA.b == sliceB.b, "an identical (key, nonce, aad, plaintext) is an identical ciphertext")
        assertEquals("5a5a5a5a", sliceA.s, "the wire salt is the connection's, in lowercase hex")

        // A fresh salt changes the nonce's last four bytes and therefore the whole ciphertext.
        val otherSalt = 0x5a5a5a5b
        val nonceA = Nonces.of(1L, 0x5a5a5a5a)
        val nonceC = Nonces.of(1L, otherSalt)
        assertTrue(nonceA.copyOfRange(0, 8).contentEquals(nonceC.copyOfRange(0, 8)), "the seq half is unchanged")
        assertFalse(nonceA.copyOfRange(8, 12).contentEquals(nonceC.copyOfRange(8, 12)), "the salt half must differ")
        val sliceC = SealedConnection.pinned(keys, otherSalt).sealAt(1, 1L, otherSalt, fid, plaintext).single()
        assertFalse(sliceC.b == sliceA.b, "a new salt must produce different sealed bytes for the same plaintext")
        assertEquals("5a5a5a5b", sliceC.s, "…and the new salt is what travels")

        // And a reconnect carries neither the old window nor the old sequence.
        first.seal(fid, "{\"v\":1,\"type\":\"ping\",\"id\":\"$fid\",\"from\":\"9f3a1c02\",\"to\":\"*\",\"body\":{}}")
        assertEquals(2L, first.sequence, "seq is monotonic inside one connection")
        assertEquals(1L, second.sequence, "…and independent across connections")

        // The salt itself is not a secret: it is half the nonce and it travels as `s`.
        assertEquals(8, Nonces.encodeSalt(first.connectionSalt).length, "a wire salt is 8 hex characters")
    }

    @Test
    @DisplayName("the nonce is uint64 BE seq followed by uint32 BE salt, and both halves read back")
    fun nonceLayout() {
        val nonce = Nonces.of(0x0102030405060708L, 0x11223344.toInt())
        assertEquals("010203040506070811223344", Hex.encode(nonce), "big-endian on both halves, seq first")
        assertEquals(0x0102030405060708L, Nonces.seqOf(nonce))
        assertEquals(0x11223344, Nonces.saltOf(nonce))
        assertEquals(Protocol.NONCE_BYTES, nonce.size)
    }

    @Test
    @DisplayName("too large, tampered and replayed are three different outcomes, never one string")
    fun refusalsStayDistinguishable() {
        val salt = 0x0badf00d
        val connection = SealedConnection.pinned(keys, salt)
        val json = "{\"v\":1,\"type\":\"ping\",\"id\":\"$fid\",\"from\":\"9f3a1c02\",\"to\":\"*\",\"body\":{}}"
        val slices = connection.seal(fid, json)
        val sealed = base64Of(slices.single())

        // 1. a version this build does not understand is refused before it is opened — not best-effort.
        val version = connection.openSealed(2, 1L, salt, fid, sealed) as OpenOutcome.Refused
        assertEquals(RefusalReason.VERSION, version.reason)

        // 2. the frame opens…
        val opened = connection.openSealed(Protocol.FRAME_VERSION, 1L, salt, fid, sealed)
        assertTrue(opened is OpenOutcome.Opened, "the freshly sealed frame must open: $opened")
        assertEquals("ping", (opened as OpenOutcome.Opened).frame.type)

        // 3. …and the same seq again is a replay, told apart from a tamper.
        val replayed = connection.openSealed(Protocol.FRAME_VERSION, 1L, salt, fid, sealed) as OpenOutcome.Refused
        assertEquals(RefusalReason.REPLAYED, replayed.reason)

        // 4. a single flipped byte is *tampered*, and it must not consume a sequence number:
        //    the window only advances for a frame whose tag verified.
        val next = connection.seal(fid, json)
        val nextSealed = base64Of(next.single())
        val flipped = nextSealed.copyOf().also { it[0] = (it[0].toInt() xor 0x01).toByte() }
        val tampered = connection.openSealed(Protocol.FRAME_VERSION, 2L, salt, fid, flipped) as OpenOutcome.Refused
        assertEquals(RefusalReason.TAMPERED, tampered.reason, "a flipped byte is tampered, not replayed")
        assertTrue(
            connection.openSealed(Protocol.FRAME_VERSION, 2L, salt, fid, nextSealed) is OpenOutcome.Opened,
            "a tampered frame must not burn the genuine seq that follows it",
        )

        // 5. the wrong salt is a *tamper*, not a replay: the salt is half the nonce, so a
        //    receiver that substituted its own would diagnose a transport bug as an attack.
        val wrongSalt = connection.openSealed(Protocol.FRAME_VERSION, 2L, salt xor 1, fid, nextSealed) as OpenOutcome.Refused
        assertEquals(RefusalReason.TAMPERED, wrongSalt.reason, "a frame under another salt cannot authenticate")

        // 6. over the 16 MiB cap is `too large`, checked before the tag so it cannot be a truncation.
        val huge = ByteArray(Protocol.MAX_SEALED_BYTES + 1)
        val tooLarge = connection.openSealed(Protocol.FRAME_VERSION, 3L, salt, fid, huge) as OpenOutcome.Refused
        assertEquals(RefusalReason.TOO_LARGE, tooLarge.reason)
    }

    @Test
    @DisplayName("the replay window is 64 wide: a seen seq is refused, an in-window gap is not, the floor is")
    fun replayWindow() {
        val window = ReplayWindow()
        assertTrue(window.accept(1))
        assertFalse(window.accept(1), "a repeat of the newest seq is a replay")
        assertTrue(window.accept(2))
        assertFalse(window.accept(1), "a repeat inside the window is a replay")
        assertTrue(window.accept(3))
        assertTrue(window.accept(5), "a gap is not an error — the relay may drop frames")
        assertTrue(window.accept(4), "…and the dropped frame may still arrive")
        assertFalse(window.accept(5), "…once only")
        assertEquals(5L, window.highestSeq)

        // 64 wide: highest = 100 makes 36 the floor (delta 64), 37 the oldest still usable.
        val fresh = ReplayWindow()
        assertTrue(fresh.accept(100L))
        assertFalse(fresh.accept(100L - Protocol.REPLAY_WINDOW_WIDTH), "at or below the floor is refused")
        assertTrue(fresh.accept(100L - Protocol.REPLAY_WINDOW_WIDTH + 1), "the newest end of the window is usable")
        assertFalse(fresh.accept(0L), "seq starts at 1")
        assertFalse(fresh.accept(-1L))
    }

    @Test
    @DisplayName("reassembly is refused for out-of-order, duplicate, mixed and over-cap input, and reports which")
    fun reassemblyRefusals() {
        val sealed = ByteArray(40) { it.toByte() }
        val parts = Slicing.slice(sealed, 1, 9L, 0x0a0b0c0d, fid, chunkBytes = 10)
        assertEquals(4, parts.size)

        // Nothing is delivered until the last slice: a partial frame is never a frame.
        val reassembler = Reassembler()
        assertTrue(parts.dropLast(1).all { reassembler.accept(it) == null }, "no partial frame is ever returned")
        assertEquals(1, reassembler.inFlight, "three slices of one frame are one frame in flight")
        val done = reassembler.accept(parts.last())
        assertTrue(done!!.sealed.contentEquals(sealed))

        val outOfOrder = assertThrowsReassembly { Reassembler().accept(parts[1]) }
        assertEquals(ReassemblyReason.OUT_OF_ORDER, outOfOrder)

        val duplicate = assertThrowsReassembly {
            Reassembler().also { it.accept(parts[0]); it.accept(parts[1]) }.accept(parts[1])
        }
        assertEquals(ReassemblyReason.DUPLICATE, duplicate)

        val mixed = assertThrowsReassembly {
            Reassembler().also { it.accept(parts[0]) }.accept(parts[1].copy(fid = "ffffffffffffffff"))
        }
        assertEquals(ReassemblyReason.OUT_OF_ORDER, mixed, "a different fid starts a frame whose first slice must be idx 0")

        val mixedSeq = assertThrowsReassembly {
            Reassembler().also { it.accept(parts[0]) }.accept(parts[1].copy(seq = 10L))
        }
        assertEquals(ReassemblyReason.MIXED_FRAME, mixedSeq)

        val tooLarge = assertThrowsReassembly {
            val small = Reassembler(capBytes = 25)
            for (part in parts) small.accept(part)
        }
        assertEquals(ReassemblyReason.TOO_LARGE, tooLarge)

        val tooMany = assertThrowsReassembly {
            val narrow = Reassembler(maxSlices = 2)
            for (part in parts) narrow.accept(part)
        }
        assertEquals(ReassemblyReason.TOO_MANY_SLICES, tooMany)

        // A slice that is too big for the transport cap is refused at the sender, not on the wire.
        assertThrows(IllegalArgumentException::class.java) {
            Slicing.slice(sealed, 1, 9L, 0x0a0b0c0d, fid, chunkBytes = Protocol.MAX_SLICE_BASE64_CHARS)
        }
    }

    private fun assertThrowsReassembly(block: () -> Unit): ReassemblyReason {
        val failure = try {
            block()
            throw AssertionError("expected a ReassemblyFailure")
        } catch (err: ReassemblyFailure) {
            return err.reason
        }
    }

    // ---------------------------------------------------------------------------------------
    // §5 — the frame's JSON, and that a client only echoes back what it received.
    // ---------------------------------------------------------------------------------------

    @Test
    @DisplayName("a frame is compact JSON in the §5 key order, and its body is embedded verbatim")
    fun frameEncoding() {
        val encoded = FrameJson.encode("mirror", "0f1e2d3c4b5a6978", "9f3a1c02", "7b2f9d10", "{\"sessionId\":\"s\"}")
        assertEquals(
            "{\"v\":1,\"type\":\"mirror\",\"id\":\"0f1e2d3c4b5a6978\",\"from\":\"9f3a1c02\",\"to\":\"7b2f9d10\",\"body\":{\"sessionId\":\"s\"}}",
            encoded,
        )
        val frame = FrameJson.decode(encoded)
        assertEquals("mirror", frame.type)
        assertEquals("s", frame.sessionId)
        assertFalse(frame.isBroadcast)

        // A body the caller already serialised is never re-encoded: the publisher's exact
        // bytes are the point of the mirror, and a re-encode would be a second renderer.
        val composed = JsonValue.Obj("err" to JsonValue.Str("<a href=\"x\">&</a>"), "n" to JsonValue.of(1))
        val verbatim = FrameJson.encode("error", fid, "9f3a1c02", "*", composed.toJson())
        assertTrue(verbatim.contains("{\"err\":\"<a href=\\\"x\\\">&</a>\",\"n\":1}"), verbatim)
        assertTrue(FrameJson.decode(verbatim).isBroadcast, "'*' is the whole room")

        // A version this build does not understand is a value it can see without opening… 
        assertEquals(2, FrameJson.decode(FrameJson.encode("error", fid, "a", "*", "{}", v = 2)).v)
        // …and an unknown key or a non-object body is a caller error, not a silent guess.
        assertEquals(
            "a frame's body must be an object",
            try {
                FrameJson.decode("{\"v\":1,\"type\":\"ping\",\"id\":\"$fid\",\"from\":\"a\",\"to\":\"*\",\"body\":1}")
                "no failure"
            } catch (err: IllegalArgumentException) {
                err.message
            },
        )
    }

    // ---------------------------------------------------------------------------------------
    // §7 — the SSE shape, the routes, and the backoff.
    // ---------------------------------------------------------------------------------------

    @Test
    @DisplayName("SSE: one data line per frame, `:` comments are the relay's heartbeat, CRLF included")
    fun sseParsing() {
        val parser = SseParser()
        val payload = "{\"v\":1,\"seq\":7,\"fid\":\"0011223344556677\",\"idx\":0,\"last\":true,\"b\":\"AA==\"}"

        // A chunk may split a line; a line is only an event once its newline arrived.
        assertTrue(parser.feed("data: $payload").isEmpty())
        val events = parser.feed("\n\n: ping\n")
        assertEquals(2, events.size)
        assertEquals(SseParser.Event.Data(payload), events[0])
        assertEquals(SseParser.Event.Comment("ping"), events[1])

        // CRLF, a lone CR, and two events in one chunk.
        val crlf = parser.feed(": keep-alive\r\ndata: a\r\ndata: b\r\n\r\n")
        assertEquals(
            listOf(SseParser.Event.Comment("keep-alive"), SseParser.Event.Data("a\nb")),
            crlf,
        )

        // An unknown field is ignored, so a stray line can never reach the frame parser.
        assertTrue(parser.feed("event: message\ndata: x\n\n").single() is SseParser.Event.Data)
        assertEquals(emptyList<SseParser.Event>(), parser.feed("retry: 1000\n\n"))

        // A stream that ended mid-line still yields what it had.
        val truncated = SseParser()
        truncated.feed(": bye")
        assertEquals(SseParser.Event.Comment("bye"), truncated.end().single())
    }

    @Test
    @DisplayName("the relay routes are built in one place and a trailing slash is a typo, not a host")
    fun routes() {
        assertEquals("https://relay.example/v1/room/ABC/join", RelayRoutes.join("https://relay.example/", "ABC"))
        assertEquals("https://relay.example/v1/room/ABC/down?peer=9f3a1c02", RelayRoutes.down("https://relay.example", "ABC", "9f3a1c02"))
        assertEquals("https://relay.example/v1/room/ABC/up?peer=9f3a1c02", RelayRoutes.up("https://relay.example", "ABC", "9f3a1c02"))
        assertEquals("https://relay.example/healthz", RelayRoutes.healthz("https://relay.example"))
    }

    @Test
    @DisplayName("backoff grows exponentially, stops at the cap, and jitters without ever reaching zero")
    fun backoff() {
        val backoff = Backoff(jitter = 0.0)
        assertEquals(500L, backoff.delayMs(1))
        assertEquals(1_000L, backoff.delayMs(2))
        assertEquals(2_000L, backoff.delayMs(3))
        assertEquals(Protocol.RECONNECT_CAP_MS, backoff.delayMs(20), "the cap holds")
        assertEquals(Protocol.RECONNECT_CAP_MS, backoff.ceilingMs(100))

        val jittered = Backoff()
        val random = Random(1234)
        for (attempt in 1..12) {
            val delay = jittered.delayMs(attempt, random)
            val ceiling = jittered.ceilingMs(attempt)
            assertTrue(delay in 1..(ceiling * 2), "attempt $attempt stayed near its ceiling: $delay vs $ceiling")
            assertTrue(delay >= 1, "a delay is never zero")
        }
        // Jitter is per attempt, so peers do not stampede in lockstep.
        val a = Backoff().delayMs(5, Random(1))
        val b = Backoff().delayMs(5, Random(2))
        assertNotEquals(a, b, "the same attempt must not compute the same delay for every peer")
    }

    // ---------------------------------------------------------------------------------------
    // §2/§5 — the room tree's fold, which is what the Compose screen renders.
    // ---------------------------------------------------------------------------------------

    @Test
    @DisplayName("the room tree folds hello + instances + bye into room -> device -> instance -> session")
    fun roomModel() {
        val model = RoomModel("GVBI45FYHJGT6N574KLJYYSR3U")
        val peerA = "9f3a1c02"
        val peerB = "7b2f9d10"

        model.apply(helloFrame(peerA, "device-1", "desk-1", "pid-100", "C:/work"), atMs = 1_000)
        model.apply(helloFrame(peerB, "device-1", "desk-1", "pid-200", "D:/other"), atMs = 1_000)
        model.apply(helloFrame("c0ffee11", "device-2", "laptop", "pid-300", "E:/third"), atMs = 1_000)
        assertEquals(3, model.peerCount())

        model.apply(
            instancesFrame(
                peerA,
                """{"instances":[{"instanceId":"pid-100","workspace":"C:/work","sessions":[
                   {"id":"s1","title":"First","running":true,"lockedNodes":0,"backgroundNodes":0,
                    "model":"deepseek-flash","modelName":"DeepSeek Flash","effort":"medium","nodes":12},
                   {"id":"s2","title":"Second","running":false,"lockedNodes":1,"backgroundNodes":0,
                    "model":"deepseek-flash","modelName":"DeepSeek Flash","effort":"low","nodes":3}]}]}""",
            ),
            atMs = 2_000,
        )
        model.apply(
            instancesFrame(
                peerB,
                """{"instances":[{"instanceId":"pid-200","workspace":"D:/other","sessions":[]}]}""",
            ),
            atMs = 2_000,
        )
        model.apply(
            instancesFrame(
                "c0ffee11",
                """{"instances":[{"instanceId":"pid-300","workspace":"E:/third","sessions":[
                   {"id":"s3","title":"Third","running":false,"lockedNodes":0,"backgroundNodes":2,
                    "model":"deepseek-flash","modelName":"DeepSeek Flash","effort":"high","nodes":7}]}]}""",
            ),
            atMs = 2_000,
        )

        val devices = model.devices()
        assertEquals(2, devices.size, "two devices, grouped by deviceId and not by peerId")
        val desk = devices.first { it.deviceName == "desk-1" }
        assertEquals("device-1", desk.deviceId)
        assertEquals(2, desk.instances.size, "two windows on one machine are one device with two instances")
        assertEquals(2, desk.sessionCount)
        assertTrue(desk.busy, "a running session makes the device row busy")

        val laptops = devices.first { it.deviceName == "laptop" }
        assertEquals(1, laptops.instances.size)
        assertEquals(1, laptops.sessionCount)
        assertFalse(laptops.busy, "a background terminal does not lock the node, so it is not 'busy'")

        val ref = model.sessionRef("s2")!!
        assertEquals(peerA, ref.peerId, "a session is addressed to the peer that publishes it")
        assertEquals("pid-100", ref.instanceId)
        assertTrue(ref.session.busy, "a locked node is busy even when nothing is streaming")
        assertNull(model.sessionRef("nope"), "an unknown session has no publisher")

        // An `instances` frame is the peer's whole truth: what it stops listing is gone.
        model.apply(instancesFrame(peerA, """{"instances":[]}"""), atMs = 3_000)
        val deskAfter = model.devices().first { it.deviceName == "desk-1" }
        assertEquals(1, deskAfter.instances.size, "only the other window's instance is left")
        assertEquals(0, deskAfter.sessionCount)
        assertEquals(2, model.devices().size, "two machines are still two rows")

        model.apply(instancesFrame(peerB, """{"instances":[]}"""), atMs = 3_500)
        assertEquals(1, model.devices().size, "the desk announced nothing, so its device row is gone too")

        // A peer that stops answering is evicted locally too — the relay's own window.
        model.apply(helloFrame(peerA, "device-1", "desk-1", "pid-100", "C:/work"), atMs = 10_000)
        assertFalse(model.evictSilent(nowMs = 20_000, timeoutMs = 60_000), "a peer inside the window stays")
        assertTrue(model.evictSilent(nowMs = 80_000, timeoutMs = 60_000), "a peer past the window goes")
        assertEquals(0, model.peerCount())
        assertEquals(0, model.devices().size)

        // `bye` removes a peer and its instances at once, instead of at the 90 s eviction.
        model.apply(helloFrame("c0ffee11", "device-2", "laptop", "pid-300", "E:/third"), atMs = 90_000)
        assertTrue(model.removePeer("c0ffee11"))
        assertEquals(0, model.peerCount())
        assertEquals("room GVBI45FYHJGT6N574KLJYYSR3U: 0 device(s), 0 instance(s), 0 session(s)", model.describe())
    }

    private fun helloFrame(peerId: String, deviceId: String, deviceName: String, instanceId: String, workspace: String): Frame =
        FrameJson.decode(
            FrameJson.encode(
                "hello",
                fid,
                peerId,
                "*",
                """{"deviceId":"$deviceId","deviceName":"$deviceName","instanceId":"$instanceId",""" +
                    """"workspace":"$workspace","appVersion":"0.1.0","proto":1}""",
            ),
        )

    private fun instancesFrame(peerId: String, bodyJson: String): Frame =
        FrameJson.decode(FrameJson.encode("instances", fid, peerId, "*", bodyJson))

    @Test
    @DisplayName("the replay window is per sender salt: two peers both start at seq 1 and neither is a replay of the other")
    fun replayWindowIsPerSalt() {
        val windows = ReplayWindows()
        val peerA = 0x11111111
        val peerB = 0x22222222

        // Two publishers, each with its own salt and its own seq 1. A single window keyed on
        // `seq` alone would refuse the second one — a room that renders one publisher and looks
        // healthy, which is why the key is the pair the nonce already is.
        assertTrue(windows.accept(peerA, 1L))
        assertTrue(windows.accept(peerB, 1L), "another salt's seq 1 is not a replay of this one's")
        assertTrue(windows.accept(peerA, 2L))
        assertTrue(windows.accept(peerB, 2L))
        assertEquals(2, windows.trackedSalts)

        // Within one salt the check is exactly as strict as before: a repeat is a replay, and so
        // is anything at or below that salt's floor.
        assertFalse(windows.accept(peerA, 1L), "a repeat under the same salt is a replay")
        assertFalse(windows.accept(peerB, 1L))
        assertTrue(windows.accept(peerA, 100L))
        assertFalse(windows.accept(peerA, 100L - Protocol.REPLAY_WINDOW_WIDTH), "at or below this salt's floor")
        assertTrue(windows.accept(peerA, 100L - Protocol.REPLAY_WINDOW_WIDTH + 1), "…but the window's edge is usable")
        assertTrue(windows.accept(peerB, 3L), "one salt's floor is not another's")
        assertEquals(100L, windows.highestSeq(peerA))
        assertEquals(3L, windows.highestSeq(peerB))

        // A frame replayed under its original salt still meets its own window — the widenings
        // above buy nothing for a replay.
        assertFalse(windows.accept(peerA, 100L))
        assertFalse(windows.accept(peerB, 2L))

        // The map is bounded at the room's peer cap, and only an authenticated salt gets a window
        // at all (the relay holds no key, so it cannot mint one).
        val narrow = ReplayWindows(maxSalts = 2)
        assertTrue(narrow.accept(1, 1L))
        assertTrue(narrow.accept(2, 1L))
        assertTrue(narrow.accept(3, 1L))
        assertEquals(2, narrow.trackedSalts, "the bound holds")
        assertTrue(narrow.accept(1, 1L), "the least recently used window was the one evicted")

        narrow.clear()
        assertEquals(0, narrow.trackedSalts, "one window set per connection, cleared with it")
    }

    @Test
    @DisplayName("a room's second publisher is readable: a connection opens a frame salted by another peer")
    fun aFrameFromAnotherSaltOpens() {
        // The publisher's connection and the receiver's are different connections of the same
        // room: different salts, each with its own seq 1. The receiver must build the nonce from
        // the salt the slices carried, or every frame but its own fails to open.
        val publisher = SealedConnection.fresh(keys)
        val receiver = SealedConnection.fresh(keys)
        assertNotEquals(publisher.connectionSalt, receiver.connectionSalt)

        val json = "{\"v\":1,\"type\":\"ping\",\"id\":\"$fid\",\"from\":\"9f3a1c02\",\"to\":\"*\",\"body\":{}}"
        val slices = publisher.seal(fid, json)
        val outcome = receiver.accept(slices.single())
        assertTrue(outcome is OpenOutcome.Opened, "the receiver must open a frame salted by its peer: $outcome")

        // A second publisher, also starting at seq 1, is not a replay of the first.
        val second = SealedConnection.fresh(keys)
        val otherFid = "fedcba9876543210"
        val otherSlices = second.seal(otherFid, json)
        val otherOutcome = receiver.accept(otherSlices.single())
        assertTrue(otherOutcome is OpenOutcome.Opened, "…nor is a second peer's seq 1: $otherOutcome")

        // …and a repeat of either one is. (The same slices again, not freshly sealed ones: a
        // second `seal` is a second frame, which is the point of `seq` being monotonic.)
        assertEquals(RefusalReason.REPLAYED, (receiver.accept(slices.single()) as OpenOutcome.Refused).reason)
        assertEquals(RefusalReason.REPLAYED, (receiver.accept(otherSlices.single()) as OpenOutcome.Refused).reason)
    }

    // ---------------------------------------------------------------------------------------
    // The catalogs a phone's locale has to be mapped onto — the reason the alias files are not
    // needed on Android at all.
    // ---------------------------------------------------------------------------------------

    @Test
    @DisplayName("a reported language tag is canonicalised the way languageTags.ts does, before any catalog is looked up")
    fun languageTags() {
        // The pair the repo authors, and the pair VS Code reports for them.
        assertEquals("zh-Hans", LanguageTags.canonicalTagFor("zh-cn"))
        assertEquals("zh-Hant", LanguageTags.canonicalTagFor("zh-tw"))
        assertEquals("zh-cn", LanguageTags.CANONICAL_TO_REPORTED["zh-Hans"])
        assertEquals("zh-tw", LanguageTags.CANONICAL_TO_REPORTED["zh-Hant"])
        assertEquals(
            LanguageTags.REPORTED_TO_CANONICAL.keys,
            LanguageTags.CANONICAL_TO_REPORTED.values.toSet(),
            "the two tables are one pair from both sides",
        )

        // What a phone actually reports: a region id, a script subtag, or both.
        assertEquals("zh-Hans", LanguageTags.catalogTagFor("zh-cn"))
        assertEquals("zh-Hans", LanguageTags.catalogTagFor("zh-CN"))
        assertEquals("zh-Hant", LanguageTags.catalogTagFor("zh-tw"))
        assertEquals("zh-Hant", LanguageTags.catalogTagFor("zh-TW"))
        assertEquals("zh-Hans", LanguageTags.catalogTagFor("zh-Hans"))
        assertEquals("zh-Hant", LanguageTags.catalogTagFor("zh-Hant"))
        assertEquals("zh-Hans", LanguageTags.catalogTagFor("zh-Hans-CN"))
        assertEquals("zh-Hant", LanguageTags.catalogTagFor("zh-Hant-TW"))
        assertEquals("zh-Hant", LanguageTags.catalogTagFor("zh-HK"), "a Hong Kong phone is Traditional")
        assertEquals("zh-Hant", LanguageTags.catalogTagFor("zh-MO"))
        assertEquals("zh-Hans", LanguageTags.catalogTagFor("zh"))
        assertEquals("zh-Hans", LanguageTags.catalogTagFor("zh_CN"), "an underscore separator is a tag too")

        // English is the source language and has no catalog: null is "an English phone", not
        // "a missing translation", and the shell then injects an empty dictionary.
        for (english in listOf("en", "en-US", "en-GB", "", "fr", "ja-JP", "de")) {
            assertEquals(null, LanguageTags.catalogTagFor(english), "'$english' is not a catalog language")
        }

        // A canned alias tag is never what the app looks up: it canonicalises first, which is why
        // `l10n/bundle.l10n.zh-cn.json` (a vsce artifact) is neither shipped nor needed.
        assertEquals("zh-Hans", LanguageTags.catalogTagFor(LanguageTags.CANONICAL_TO_REPORTED.getValue("zh-Hans")))
    }

    // ---------------------------------------------------------------------------------------
    // §6 — the mirror's two deny-by-default tables, as the phone holds them.
    // ---------------------------------------------------------------------------------------

    @Test
    @DisplayName("the mirror tables are deny-by-default in both directions, and the surface's own actions stay local")
    fun mirrorPolicy() {
        // Every type the shipped protocol posts is either mirrorable or refused — nothing is
        // accepted by accident, in either direction.
        for (type in MirrorPolicy.MIRROR_TO_PEER) {
            assertEquals(MirrorPolicy.Route.MIRROR_IN, MirrorPolicy.routeHostMessage(type))
            assertFalse(MirrorPolicy.mayAcceptFromPeer(type), "$type is a host→webview type")
        }
        for (type in MirrorPolicy.ACCEPT_FROM_PEER) {
            assertEquals(MirrorPolicy.Route.INPUT_UP, MirrorPolicy.routeWebviewMessage(type))
            assertFalse(MirrorPolicy.mayMirrorToPeer(type), "$type is a webview→host type")
        }
        for (type in MirrorPolicy.HANDLED_LOCALLY) {
            assertEquals(MirrorPolicy.Route.LOCAL, MirrorPolicy.routeWebviewMessage(type), "$type acts on this phone")
        }

        // The refusal table is not decoration: every one of its entries is refused, and none of
        // them is in a mirror table.
        for (type in MirrorPolicy.MIRROR_REFUSED.keys) {
            assertEquals(MirrorPolicy.Route.REFUSED, MirrorPolicy.routeHostMessage(type))
            assertFalse(MirrorPolicy.mayMirrorToPeer(type))
        }

        // Deny by default: an unknown type, a null and an empty string all go nowhere.
        assertEquals(MirrorPolicy.Route.REFUSED, MirrorPolicy.routeHostMessage("brandNewThing"))
        assertEquals(MirrorPolicy.Route.REFUSED, MirrorPolicy.routeWebviewMessage("brandNewThing"))
        assertEquals(MirrorPolicy.Route.REFUSED, MirrorPolicy.routeWebviewMessage(null))
        assertFalse(MirrorPolicy.mayMirrorToPeer(null))
        assertFalse(MirrorPolicy.mayAcceptFromPeer(""))

        // The 1:1 rule in one assertion: the four actions that belong to the surface you are
        // operating are handled here and are refused at the publisher.
        for (type in listOf("openExternal", "pickImage", "copyNodeId", "setNodeSize")) {
            assertFalse(MirrorPolicy.mayAcceptFromPeer(type), "$type must never be submitted to the publisher")
            assertTrue(MirrorPolicy.isHandledLocally(type), "$type is the phone's own action")
        }

        // And the control surface really is the control surface: send, fork, stop, checkout…
        for (type in listOf("userMessage", "forkTurn", "stop", "continueTurn", "rolloverTurn", "checkout")) {
            assertTrue(MirrorPolicy.mayAcceptFromPeer(type), "$type is the token's full control")
        }

        // The two tables must not overlap: a type is one direction or the other, never both.
        assertTrue(
            MirrorPolicy.MIRROR_TO_PEER.intersect(MirrorPolicy.ACCEPT_FROM_PEER).isEmpty(),
            "a type cannot be mirrored in and submitted up",
        )
    }

    // ---------------------------------------------------------------------------------------

    private fun base64Of(envelope: TransportEnvelope): ByteArray = Base64.getDecoder().decode(envelope.b)
}
