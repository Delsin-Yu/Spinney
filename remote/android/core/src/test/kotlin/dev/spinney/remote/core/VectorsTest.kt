package dev.spinney.remote.core

import java.io.File
import java.util.Base64
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test

/**
 * **The point of milestone M3.** `remote/vectors/vectors.json` is the machine-checked crypto
 * contract, and this test is what proves the Kotlin implementation agrees with the TypeScript
 * one byte for byte (`remote/vectors/README.md`: "Two implementations are checked against it,
 * bit for bit — the two ends that hold a key"). Nothing here is a round trip through this
 * module's own code and back: every expected value is read out of the committed file, and the
 * only inputs are the file's own tokens, nonces and plaintexts.
 *
 * A failure here means **this implementation drifted**. Fix it; never edit the vectors.
 */
class VectorsTest {

    private val vectors: JsonValue.Obj by lazy { loadVectors() }

    private fun loadVectors(): JsonValue.Obj {
        // The path comes from a Gradle `systemProperty` (see core/build.gradle.kts), so the
        // test never depends on the JVM's working directory. The fallbacks below exist only so
        // a run from an IDE, or from the module directory by hand, still works — and the
        // resolver prints the path it used, so a wrong file is never silent.
        val candidates = buildList {
            System.getProperty("spinney.vectors")?.let { add(File(it)) }
            add(File("../vectors/vectors.json"))
            add(File("remote/vectors/vectors.json"))
            add(File("../../remote/vectors/vectors.json"))
        }
        val file = candidates.firstOrNull { it.isFile }
            ?: fail(
                "cannot find remote/vectors/vectors.json. Tried: " +
                    candidates.joinToString(", ") { it.absolutePath } +
                    ". Run `./gradlew :core:test` (it sets -Dspinney.vectors) " +
                    "or pass -Dspinney.vectors=<path>.",
            )
        println("vectors: ${file.canonicalPath} (${file.length()} bytes)")
        val parsed = JsonValue.parse(file.readText())
        return parsed as? JsonValue.Obj ?: fail("vectors.json is not a JSON object")
    }

    private fun fail(message: String): Nothing = throw AssertionError(message)

    private fun hex(bytes: ByteArray): String = Hex.encode(bytes)

    private fun unhex(text: String): ByteArray = Hex.decode(text)

    private fun base64(text: String): ByteArray = Base64.getDecoder().decode(text)

    // ---------------------------------------------------------------------------------------
    // §3 — the derivation: master, roomIdB, roomId, encKey, macKey, and the token's UTF-8.
    // ---------------------------------------------------------------------------------------

    @Test
    @DisplayName("all three derivations match the committed vectors (master, roomIdB, roomId, encKey, macKey)")
    fun derivationsMatch() {
        val derivations = vectors.arr("derivations")
        assertEquals(3, derivations.size, "the vectors commit three derivations")

        for ((index, item) in derivations.items.withIndex()) {
            val vector = item as JsonValue.Obj
            val token = vector.str("token")
            val where = "derivations[$index] (token=${token.take(12)}…)"

            // The encoding a vector assumes is explicit: the token's UTF-8 bytes.
            assertEquals(
                vector.str("tokenUtf8Hex"),
                hex(token.toUtf8()),
                "$where: tokenUtf8Hex is not the UTF-8 of the token",
            )

            val keys = RoomKeys.derive(token)
            assertEquals(vector.str("masterHex"), hex(keys.master), "$where: master mismatch")
            assertEquals(vector.str("roomIdBHex"), hex(keys.roomIdBytes), "$where: roomIdB mismatch")
            assertEquals(vector.str("encKeyHex"), hex(keys.encKey), "$where: encKey mismatch")
            assertEquals(vector.str("macKeyHex"), hex(keys.macKey), "$where: macKey mismatch")

            // roomId is base32 of roomIdB, 26 chars, uppercase, unpadded — and the relay URL's
            // path segment, so it is the routing credential.
            assertEquals(vector.str("roomId"), keys.roomId, "$where: roomId mismatch")
            assertEquals(Base32.encode(unhex(vector.str("roomIdBHex"))), vector.str("roomId"), "$where: roomId is not base32(roomIdB)")
            assertEquals(Protocol.ROOM_ID_LENGTH, keys.roomId.length, "$where: a room id is 26 characters")
            assertEquals(keys.roomId.uppercase(), keys.roomId, "$where: roomId must be uppercase")
            assertTrue(keys.roomId.none { it == '=' }, "$where: roomId must be unpadded")
        }
    }

    @Test
    @DisplayName("the derivation ignores nothing: 600000 iterations is what the vectors were made with")
    fun derivationParametersMatchTheVectors() {
        val params = vectors.obj("params")
        assertEquals(Protocol.PBKDF2_ITERATIONS, params.long("kdfIterations").toInt(), "PBKDF2 iteration count")
        assertEquals(Protocol.KDF_SALT, params.str("kdfSalt"), "PBKDF2 salt")
        assertEquals(Protocol.HKDF_SALT, params.str("hkdfSalt"), "HKDF salt")
        assertEquals("PBKDF2-HMAC-SHA256", params.str("kdf"), "the KDF")
        assertEquals("SHA-256", params.str("hkdfHash"), "the HKDF hash")
        assertEquals("AES-256-GCM", params.str("aead"), "the AEAD")
        assertEquals(Protocol.TAG_BYTES, params.long("tagLength").toInt(), "tag length")
        assertEquals(Protocol.NONCE_BYTES, params.long("nonceLength").toInt(), "nonce length")
        assertEquals(Protocol.REFERENCE_CHUNK_BYTES, params.long("sliceChunkBytes").toInt(), "reference chunking")
    }

    // ---------------------------------------------------------------------------------------
    // §4 — the nonce, the AAD, and the sealed bytes: byte-identical, then opened back.
    // ---------------------------------------------------------------------------------------

    @Test
    @DisplayName("all four seals reproduce sealedHex byte for byte and open back to plaintextUtf8")
    fun sealsMatch() {
        val seals = vectors.arr("seals")
        assertEquals(4, seals.size, "the vectors commit four seals")

        for ((index, item) in seals.items.withIndex()) {
            val vector = item as JsonValue.Obj
            val where = "seals[$index]"
            val envelope = vector.obj("envelope")
            val v = envelope.long("v").toInt()
            val seq = envelope.long("seq")
            val fid = envelope.str("fid")
            val plaintext = vector.str("plaintextUtf8").toUtf8()
            val keys = RoomKeys.derive(vector.str("token"))

            // §7's key order, `s` in position 3 — the envelope the vectors record is the shape
            // this build parses and emits, seven keys and no others.
            assertEquals(
                "{\"v\",\"seq\",\"s\",\"fid\",\"idx\",\"last\"}",
                envelope.fields.keys.joinToString(",", "{", "}") { "\"$it\"" },
                "$where: §7 envelope key order",
            )

            // `s` is the connection salt on the wire, and the recorded one is the recorded
            // `connSaltHex`: the two must be the same string, not merely the same number.
            val wireSalt = envelope.str("s")
            assertEquals(vector.str("connSaltHex"), wireSalt, "$where: envelope.s is not the recorded connection salt")
            assertEquals(8, wireSalt.length, "$where: a wire salt is 8 characters")
            assertEquals(wireSalt.lowercase(), wireSalt, "$where: a wire salt is lowercase hex")
            val salt = Nonces.decodeSalt(wireSalt)
            assertEquals(intOfHex(vector.str("connSaltHex")), salt, "$where: decodeSalt(hex) is the uint32")

            // The AAD is `v|seq|fid` — built from the envelope, because those are the three
            // facts the receiver has *before* it decrypts. The vector's `aad` field is the
            // recorded truth, and both must agree.
            val aad = Aad.canonical(v, seq, fid)
            assertEquals(vector.str("aad"), aad, "$where: the canonical AAD is not v|seq|fid")

            // The nonce is `uint64 BE seq || uint32 BE connection salt`, **built from the wire
            // salt** — the receiver's only legitimate source for it — and the vectors pin the
            // layout, not just the fact that it is random.
            val nonce = Nonces.fromWire(seq, wireSalt)
            assertEquals(vector.str("nonceHex"), hex(nonce), "$where: nonce layout mismatch")
            assertEquals(Protocol.NONCE_BYTES, nonce.size, "$where: a nonce is 12 bytes")
            assertEquals(seq, Nonces.seqOf(nonce), "$where: the first 8 nonce bytes are the big-endian seq")
            assertEquals(salt, Nonces.saltOf(nonce), "$where: the last 4 nonce bytes are the big-endian salt")
            assertTrue(
                hex(nonce).endsWith(wireSalt),
                "$where: the nonce's last 4 bytes are `s`, verbatim: ${hex(nonce)} vs $wireSalt",
            )
            assertTrue(nonce.contentEquals(Nonces.of(seq, salt)), "$where: fromWire(seq, s) == of(seq, decodeSalt(s))")

            val sealed = Aead.seal(keys.encKey, nonce, aad.toUtf8(), plaintext)
            assertEquals(vector.str("sealedHex"), hex(sealed), "$where: the sealed bytes are not byte-identical")
            assertEquals(
                plaintext.size + Protocol.TAG_BYTES,
                sealed.size,
                "$where: the layout is ciphertext||tag, 16 bytes of tag appended",
            )

            // …and the recorded bytes open when the nonce is rebuilt **from `s`**, which is the
            // whole point of `s` existing.
            val opened = Aead.open(
                keys.encKey,
                Nonces.fromWire(seq, envelope.str("s")),
                aad.toUtf8(),
                unhex(vector.str("sealedHex")),
            )
            assertEquals(vector.str("plaintextUtf8"), opened.asUtf8(), "$where: opening did not return plaintextUtf8")
            assertTrue(opened.contentEquals(plaintext), "$where: opening did not return the plaintext bytes")

            // A *guessed* salt — any other one — must not open these bytes. If it did, `s` would
            // be decoration and the two-implementations disagreement could come back.
            val wrongSalt = salt xor 0x00000001
            assertThrows(TamperFailure::class.java) {
                Aead.open(keys.encKey, Nonces.of(seq, wrongSalt), aad.toUtf8(), unhex(vector.str("sealedHex")))
            }

            // The plaintext is a logical frame with exactly the §5 key order.
            val frame = FrameJson.decode(vector.str("plaintextUtf8"))
            assertEquals(v, frame.v, "$where: frame version")
            assertEquals(vector.str("peer"), frame.from, "$where: the envelope's peer is the frame's from")
            assertEquals("{\"v\",\"type\",\"id\",\"from\",\"to\",\"body\"}", keyOrder(vector.str("plaintextUtf8")), "$where: §5 key order")
            assertNotNull(frame.body, "$where: a frame always carries a body object")

            // The whole receiver path, from the wire line to the frame: the salt is taken from
            // `s`, and the frame opens. (The vectors' `envelope` carries no `b` — it is the
            // frame's envelope, and a part in `slices[].parts` is that object plus its bytes —
            // so the round trip below is proved on the slice sets, in `envelopeWireFormMatches`.)
            val connection = SealedConnection.pinned(keys, 0x11111111)
            val outcome = connection.openSealed(v, seq, Nonces.decodeSalt(envelope.str("s")), fid, unhex(vector.str("sealedHex")))
            assertTrue(outcome is OpenOutcome.Opened, "$where: the receiver path did not open the frame: $outcome")
            assertEquals(vector.str("plaintextUtf8"), (outcome as OpenOutcome.Opened).plaintext, "$where: receiver path plaintext")
        }

        // The vectors deliberately separate `id` (correlation, inside the plaintext) from `fid`
        // (one frame's transport framing): equal in seals[0], different afterwards.
        val first = FrameJson.decode((seals.items[0] as JsonValue.Obj).str("plaintextUtf8"))
        assertEquals(
            first.id,
            (seals.items[0] as JsonValue.Obj).obj("envelope").str("fid"),
            "seals[0] makes id == fid because a sender may",
        )
        for (index in 1..3) {
            val vector = seals.items[index] as JsonValue.Obj
            val frame = FrameJson.decode(vector.str("plaintextUtf8"))
            assertNotEquals(frame.id, vector.obj("envelope").str("fid"), "seals[$index] keeps id and fid apart")
        }
    }

    @Test
    @DisplayName("seals[3] pins the fresh connection salt: same token, same seq, a different s, a different frame")
    fun freshSaltIsPinnedByTheVectors() {
        val seals = vectors.arr("seals").items.map { it as JsonValue.Obj }
        val first = seals[0]
        val secondConnection = seals[3]

        // One token, two connections. Same `seq` 1, different `s` — so different nonces, and
        // different sealed bytes. That pair is what makes the fresh salt, and not the sequence
        // number, the replay defence (§4).
        assertEquals(first.str("token"), secondConnection.str("token"), "seals[3] is a second connection of seals[0]'s token")
        assertEquals(first.obj("envelope").long("seq"), secondConnection.obj("envelope").long("seq"), "…with the same seq")
        assertNotEquals(first.str("connSaltHex"), secondConnection.str("connSaltHex"), "…and a different salt")
        assertNotEquals(first.str("nonceHex"), secondConnection.str("nonceHex"), "…so a different nonce")
        assertNotEquals(first.str("sealedHex"), secondConnection.str("sealedHex"), "…and different sealed bytes")

        // Both open, each under its own `s`. A receiver that substituted its own salt — or a
        // convention like "the first 4 bytes of fid" — would fail one of these.
        val keys = RoomKeys.derive(first.str("token"))
        for (vector in listOf(first, secondConnection)) {
            val envelope = vector.obj("envelope")
            val nonce = Nonces.fromWire(envelope.long("seq"), envelope.str("s"))
            val aad = Aad.bytes(envelope.long("v").toInt(), envelope.long("seq"), envelope.str("fid"))
            val plaintext = Aead.open(keys.encKey, nonce, aad, unhex(vector.str("sealedHex")))
            assertEquals(vector.str("plaintextUtf8"), plaintext.asUtf8(), "each connection's frame opens under its own s")
        }
    }

    private fun keyOrder(json: String): String {
        val obj = JsonValue.parse(json) as JsonValue.Obj
        return obj.fields.keys.joinToString(",", "{", "}") { "\"$it\"" }
    }

    // ---------------------------------------------------------------------------------------
    // §7 — the transport slices: reassembly is byte-identical, and the error cases are errors.
    // ---------------------------------------------------------------------------------------

    @Test
    @DisplayName("every slices entry reassembles byte-identically and refuses out-of-order, duplicate and over-cap input")
    fun slicesMatch() {
        val seals = vectors.arr("seals").items.map { it as JsonValue.Obj }
        val slices = vectors.arr("slices")
        assertEquals(2, slices.size, "the vectors commit two slice sets")

        for ((index, item) in slices.items.withIndex()) {
            val entry = item as JsonValue.Obj
            val where = "slices[$index]"
            val fid = entry.str("fid")
            val expected = unhex(entry.str("sealedHex"))
            val parts = entry.arr("parts").items.map { envelopeOf(it as JsonValue.Obj) }

            // Shape: one shared (v, seq, s, fid), idx 0-based and dense, `last` only on the end.
            assertEquals(parts.size, parts.map { it.idx }.distinct().size, "$where: indices must be unique")
            assertEquals((0 until parts.size).toList(), parts.map { it.idx }, "$where: idx is 0-based and dense")
            assertEquals(List(parts.size - 1) { false }, parts.dropLast(1).map { it.last }, "$where: only the final slice is last")
            assertTrue(parts.last().last, "$where: the final slice must be last")
            assertEquals(1, parts.map { it.fid }.distinct().size, "$where: every slice shares the fid")
            assertEquals(1, parts.map { it.seq }.distinct().size, "$where: every slice shares the seq")
            assertEquals(1, parts.map { it.v }.distinct().size, "$where: every slice shares the version")
            assertEquals(1, parts.map { it.s }.distinct().size, "$where: every slice of one frame shares the connection salt")
            assertEquals(fid, parts.first().fid, "$where: the parts carry the entry's fid")
            assertEquals(8, parts.first().s.length, "$where: s is 8 hex characters")
            assertEquals(parts.first().s.lowercase(), parts.first().s, "$where: s is lowercase")
            for (part in parts) {
                assertTrue(
                    part.b.length <= Protocol.MAX_SLICE_BASE64_CHARS,
                    "$where: a slice must stay under the ${Protocol.MAX_SLICE_BASE64_CHARS}-base64-char cap",
                )
                // The wire line of every slice has §7's key order, with `s` in position 3.
                assertEquals(
                    "{\"v\",\"seq\",\"s\",\"fid\",\"idx\",\"last\",\"b\"}",
                    (JsonValue.parse(part.toJson()) as JsonValue.Obj).fields.keys.joinToString(",", "{", "}") { "\"$it\"" },
                    "$where: §7 key order on the wire",
                )
            }

            // Reassembly: concatenating the slice bytes must reproduce the sealed frame exactly.
            val concatenated = parts.map { base64(it.b) }.reduce { a, b -> a + b }
            assertTrue(concatenated.contentEquals(expected), "$where: concatenated slice bytes != sealedHex")

            val reassembler = Reassembler()
            var done: ReassembledFrame? = null
            for (part in parts) done = reassembler.accept(part) ?: done
            assertNotNull(done, "$where: the reassembler never completed the frame")
            assertEquals(expected.size, done!!.sealed.size, "$where: reassembled length")
            assertTrue(done!!.sealed.contentEquals(expected), "$where: reassembly is not byte-identical")
            assertEquals(0, reassembler.inFlight, "$where: nothing may stay in flight after the last slice")

            // The reassembler hands the salt out with the frame: it is where the nonce's second
            // half comes from, and it is the one the slices carried.
            assertEquals(Nonces.decodeSalt(parts.first().s), done!!.salt, "$where: the reassembled frame's salt is the wire salt")
            assertEquals(parts.first().s, done!!.saltHex, "$where: …and it round-trips to the same hex")

            // The reassembled frame is the matching seal, so the whole chain — slices, salt,
            // AAD, nonce, key — is proved end to end and not just in pieces. The salt comes from
            // the slices, **not** from the seal's recorded `connSaltHex`: the wire is the source.
            val seal = seals.firstOrNull { it.str("sealedHex") == entry.str("sealedHex") }
                ?: fail("$where: no seal in the vectors has this sealedHex")
            val keys = RoomKeys.derive(seal.str("token"))
            val opened = Aead.open(
                keys.encKey,
                Nonces.of(done!!.seq, done!!.salt),
                Aad.bytes(done!!.v, done!!.seq, done!!.fid),
                done!!.sealed,
            )
            assertEquals(seal.str("plaintextUtf8"), opened.asUtf8(), "$where: the reassembled frame did not open to its seal's plaintext")
            assertEquals(seal.str("connSaltHex"), done!!.saltHex, "$where: the slices' s is the seal's own connection salt")

            // …and through the connection, which must build the nonce from the wire salt too.
            val connection = SealedConnection.pinned(keys, 0x22222222)
            var viaConnection: OpenOutcome? = null
            for (part in parts) viaConnection = connection.accept(part) ?: viaConnection
            assertTrue(viaConnection is OpenOutcome.Opened, "$where: the connection did not open its own slices: $viaConnection")
            assertEquals(seal.str("plaintextUtf8"), (viaConnection as OpenOutcome.Opened).plaintext, "$where: connection plaintext")

            // Refusals. These are the contract's own words: "an out-of-order or duplicated
            // `idx` is an error", and "exceeding the cap is an error, never a truncation".
            if (parts.size > 1) {
                val fresh = Reassembler()
                val outOfOrder = assertThrows(ReassemblyFailure::class.java) { fresh.accept(parts[1]) }
                assertEquals(ReassemblyReason.OUT_OF_ORDER, outOfOrder.reason, "$where: idx 1 before idx 0 is out of order")

                val dup = Reassembler()
                dup.accept(parts[0])
                val duplicate = assertThrows(ReassemblyFailure::class.java) { dup.accept(parts[0]) }
                assertEquals(ReassemblyReason.DUPLICATE, duplicate.reason, "$where: a repeated idx is a duplicate")

                val mixed = Reassembler()
                mixed.accept(parts[0])
                val mixedFailure = assertThrows(ReassemblyFailure::class.java) {
                    mixed.accept(parts[1].copy(seq = parts[1].seq + 1))
                }
                assertEquals(ReassemblyReason.MIXED_FRAME, mixedFailure.reason, "$where: slices must agree about seq")

                // The salt check: the same fid carrying a different `s` is two *connections*
                // spliced into one frame, and §7 makes it an error. This is the case that matters
                // most — a receiver that accepted it would be reassembling a frame whose nonce it
                // can only guess.
                val spliced = Reassembler()
                spliced.accept(parts[0])
                val otherSalt = Nonces.encodeSalt(Nonces.decodeSalt(parts[1].s) xor 0x01020304)
                val spliceFailure = assertThrows(ReassemblyFailure::class.java) {
                    spliced.accept(parts[1].copy(s = otherSalt))
                }
                assertEquals(
                    ReassemblyReason.MIXED_FRAME,
                    spliceFailure.reason,
                    "$where: slices must agree about the connection salt",
                )
                assertTrue(
                    spliceFailure.message?.contains("one connection salt") == true,
                    "$where: the splice refusal must say what it is: ${spliceFailure.message}",
                )
                assertEquals(0, spliced.inFlight, "$where: a mixed frame is abandoned, not kept")

                val capped = Reassembler(capBytes = 1024)
                val tooLarge = assertThrows(ReassemblyFailure::class.java) {
                    for (part in parts) capped.accept(part)
                }
                assertEquals(ReassemblyReason.TOO_LARGE, tooLarge.reason, "$where: over the cap is an error, never a truncation")

                val narrow = Reassembler(maxSlices = 1)
                val tooMany = assertThrows(ReassemblyFailure::class.java) {
                    for (part in parts) narrow.accept(part)
                }
                assertEquals(ReassemblyReason.TOO_MANY_SLICES, tooMany.reason, "$where: more slices than a frame may need")
            }
        }

        // Slices of one frame may arrive interleaved with another frame's: both must still
        // reassemble, byte for byte. That is the whole reason the reassembler keys on `fid`.
        val small = vectors.arr("slices").items[0] as JsonValue.Obj
        val large = vectors.arr("slices").items[1] as JsonValue.Obj
        val smallParts = small.arr("parts").items.map { envelopeOf(it as JsonValue.Obj) }
        val largeParts = large.arr("parts").items.map { envelopeOf(it as JsonValue.Obj) }
        val interleaved = Reassembler()
        var smallDone: ReassembledFrame? = null
        var largeDone: ReassembledFrame? = null
        val maxSteps = maxOf(smallParts.size, largeParts.size)
        for (step in 0 until maxSteps) {
            largeParts.getOrNull(step)?.let { largeDone = interleaved.accept(it) ?: largeDone }
            smallParts.getOrNull(step)?.let { smallDone = interleaved.accept(it) ?: smallDone }
        }
        assertTrue(smallDone!!.sealed.contentEquals(unhex(small.str("sealedHex"))), "the interleaved small frame")
        assertTrue(largeDone!!.sealed.contentEquals(unhex(large.str("sealedHex"))), "the interleaved large frame")

        // Slice boundaries are the sender's choice; only seal/open and the AAD must agree.
        // Re-chunking a vector frame into different-sized slices must still interoperate with
        // the vectors' own reassembly truth — and it must restamp the same `s`, because a slice
        // set that disagreed about its salt would describe two connections.
        val rechunked = Slicing.slice(
            unhex(small.str("sealedHex")),
            1,
            smallParts[0].seq,
            Nonces.decodeSalt(smallParts[0].s),
            small.str("fid"),
            chunkBytes = 17,
        )
        assertTrue(rechunked.size > smallParts.size, "a 17-byte chunking makes more slices")
        assertEquals(smallParts[0].s, rechunked.first().s, "re-chunking keeps the connection's salt")
        val rechunkedReassembly = Reassembler()
        var rechunkedDone: ReassembledFrame? = null
        for (part in rechunked) rechunkedDone = rechunkedReassembly.accept(part) ?: rechunkedDone
        assertTrue(rechunkedDone!!.sealed.contentEquals(unhex(small.str("sealedHex"))), "re-chunking is the sender's choice")
    }

    @Test
    @DisplayName("a wire salt is 8 lowercase hex or nothing: the sloppy forms a coercion would have accepted are refusals")
    fun wireSaltIsStrict() {
        for (bad in listOf("", "1a2b3c4", "1a2b3c4d0", "1A2B3C4D", "1a2b3c4g", "1a2b3c d", "1a2b3c4d\n")) {
            val failure = assertThrows(IllegalArgumentException::class.java) {
                Nonces.decodeSalt(bad)
            }
            assertTrue(
                failure.message?.contains("8 lowercase hex characters") == true,
                "a sloppy salt must be refused with the rule, not coerced: \"$bad\" gave ${failure.message}",
            )
            // …and the same strictness is what the envelope's own constructor applies, so a
            // slice cannot carry one either.
            assertThrows(IllegalArgumentException::class.java) {
                TransportEnvelope(v = 1, seq = 1, s = bad, fid = "0011223344556677", idx = 0, last = true, b = "AA==")
            }
            assertThrows(IllegalArgumentException::class.java) {
                TransportEnvelope.parse(
                    "{\"v\":1,\"seq\":1,\"s\":${JsonValue.of(bad).toJson()},\"fid\":\"0011223344556677\",\"idx\":0,\"last\":true,\"b\":\"AA==\"}",
                )
            }
        }

        // Uppercase is refused rather than lowercased, precisely because it would otherwise
        // build a *different* nonce than the sender and be reported as tampering.
        assertEquals(0x1a2b3c4d, Nonces.decodeSalt("1a2b3c4d"))
        assertEquals("1a2b3c4d", Nonces.encodeSalt(0x1a2b3c4d))
        assertEquals("00000000", Nonces.encodeSalt(0))
        assertEquals("ffffffff", Nonces.encodeSalt(-1))
        assertEquals(-1, Nonces.decodeSalt("ffffffff"))
        for (salt in listOf(0, 1, 0x7fffffff, -1, -2147483648, 0x00ff00ff)) {
            assertEquals(salt, Nonces.decodeSalt(Nonces.encodeSalt(salt)), "salt round trip for $salt")
        }

        // A missing `s` is refused even though everything else is well formed.
        val missing = assertThrows(IllegalArgumentException::class.java) {
            TransportEnvelope.parse("{\"v\":1,\"seq\":1,\"fid\":\"0011223344556677\",\"idx\":0,\"last\":true,\"b\":\"AA==\"}")
        }
        assertTrue(missing.message?.contains("s") == true, "a missing s must be named: ${missing.message}")
    }

    private fun envelopeOf(obj: JsonValue.Obj): TransportEnvelope = TransportEnvelope(
        v = obj.long("v").toInt(),
        seq = obj.long("seq"),
        s = obj.str("s"),
        fid = obj.str("fid"),
        idx = obj.long("idx").toInt(),
        last = obj.bool("last"),
        b = obj.str("b"),
    )

    /** Round-trips the wire form of the envelope the vectors store, key order included. */
    @Test
    @DisplayName("the transport envelope's wire form matches the vectors' key order and round-trips")
    fun envelopeWireFormMatches() {
        for (item in vectors.arr("slices").items) {
            val entry = item as JsonValue.Obj
            val parts = entry.arr("parts").items.map { it as JsonValue.Obj }
            for (part in parts) {
                val envelope = envelopeOf(part)
                assertEquals(part.toJson(), envelope.toJson(), "the wire form must keep the fixed key order")
                assertEquals(envelope, TransportEnvelope.parse(part.toJson()), "parse(toJson(x)) == x")
            }
        }
    }

    @Test
    @DisplayName("FrameJson.encode reproduces the vectors' plaintext bytes exactly (the body embedded verbatim)")
    fun frameEncodingMatchesTheVectorsPlaintext() {
        for ((index, item) in vectors.arr("seals").items.withIndex()) {
            val plaintext = (item as JsonValue.Obj).str("plaintextUtf8")
            val marker = "\"body\":"
            val at = plaintext.indexOf(marker)
            assertTrue(at > 0, "seals[$index]: no body marker")
            val body = plaintext.substring(at + marker.length).removeSuffix("}")
            val envelope = item.obj("envelope")

            // Rebuilding the frame from its parts must give back the identical bytes: the key
            // order and the escaping of the §5 line are proved against the vectors, not against
            // this module's own encoder.
            val rebuilt = FrameJson.encode(
                type = FrameJson.decode(plaintext).type,
                id = FrameJson.decode(plaintext).id,
                from = FrameJson.decode(plaintext).from,
                to = FrameJson.decode(plaintext).to,
                bodyJson = body,
                v = envelope.long("v").toInt(),
            )
            assertEquals(plaintext, rebuilt, "seals[$index]: the re-encoded frame is not byte-identical")
        }
    }

    private fun intOfHex(text: String): Int = Hex.decode(text).fold(0) { acc, b -> (acc shl 8) or (b.toInt() and 0xff) }
}
