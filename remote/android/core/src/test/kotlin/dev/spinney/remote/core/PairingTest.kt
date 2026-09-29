package dev.spinney.remote.core

import java.net.URLDecoder
import javax.imageio.ImageIO
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test

/**
 * `Pairing` and `QrScan`: the phone's half of `spinney-pair:1?…`.
 *
 * The three payload literals below are the repo's **shared vectors** — the desktop asserts the
 * same strings in `tools/check-remote.js` §9 — so this file is where the two implementations are
 * pinned to one contract instead of to each other's behaviour.
 *
 * The last test is the one this file exists for: it decodes the committed
 * `src/test/resources/pairing-fixture.png` with **zxing**, an independent decoder, and the payload
 * it reads back is vector 1. That is the proof that the desktop's *encoder* (`src/remote/qr.ts`,
 * hand-written from ISO/IEC 18004) writes a symbol a real reader accepts — a proof no round trip
 * through either implementation's own decoder could give.
 */
class PairingTest {

    /** Shared vectors 1-3: the relay, the room's local label, and the raw token. */
    private val vectors = listOf(
        Triple("https://relay.example.com:8787", "home + lab", "a b+c/d?"),
        Triple("http://120.79.122.240:8787", "home", "spinney-emulator-token-01"),
        Triple("https://relay.example.com", "房间", "口令 a"),
    )

    /** The same three as the exact strings `src/remote/pairing.ts` emits and the desktop asserts. */
    private val payloads = listOf(
        "spinney-pair:1?relay=https%3A%2F%2Frelay.example.com%3A8787&room=home%20%2B%20lab&token=a%20b%2Bc%2Fd%3F",
        "spinney-pair:1?relay=http%3A%2F%2F120.79.122.240%3A8787&room=home&token=spinney-emulator-token-01",
        "spinney-pair:1?relay=https%3A%2F%2Frelay.example.com&room=%E6%88%BF%E9%97%B4&token=%E5%8F%A3%E4%BB%A4%20a",
    )

    @Test
    @DisplayName("the three shared vectors parse verbatim — the same literals the desktop's own check asserts")
    fun theSharedVectorsParseVerbatim() {
        assertEquals(vectors.size, payloads.size)
        for ((index, payload) in payloads.withIndex()) {
            val (relay, room, token) = vectors[index]
            val parsed = Pairing.parse(payload)
            assertTrue(parsed is Pairing.Outcome.Ok, "vector ${index + 1} must parse: $parsed")
            parsed as Pairing.Outcome.Ok
            assertEquals(relay, parsed.relay, "vector ${index + 1} relay")
            assertEquals(room, parsed.room, "vector ${index + 1} room")
            assertEquals(token, parsed.token, "vector ${index + 1} token")
        }
        // Vector 3 is the UTF-8 case: those bytes are never ASCII, so a decoder that read the
        // escapes one byte at a time as characters would not have produced the two strings above.
        assertTrue(payloads[2].contains("%E6%88%BF%E9%97%B4"), "the room label travels as UTF-8 bytes")
        assertEquals(6, "%E6%88%BF%E9%97%B4".length / 3, "房间 is two characters, six UTF-8 bytes, six escapes")
    }

    @Test
    @DisplayName("the parity trap: %20 is a space, a bare + stays a literal + (URLDecoder would have joined a different room)")
    fun aSpaceDecodesToASpaceAndABarePlusStaysLiteral() {
        val base = "spinney-pair:1?relay=https%3A%2F%2Frelay.example.com&room=home&token="

        // The two spellings are *different values*, and the payload says which is which.
        val spaced = Pairing.parse(base + "a%20b") as Pairing.Outcome.Ok
        assertEquals("a b", spaced.token, "%20 is a space, per RFC 3986")
        val plus = Pairing.parse(base + "a+b") as Pairing.Outcome.Ok
        assertEquals("a+b", plus.token, "a bare + is a literal +, not the form spelling of a space")
        assertNotEquals(spaced.token, plus.token, "the trap in one line: two different tokens, two different rooms")

        // The measured fact behind the ban on `URLDecoder`, asserted rather than described: a form
        // decoder reads that second token as a space. A token is one character away from another
        // room, so this is the defect the strict decoder exists to prevent.
        assertEquals("a b", URLDecoder.decode("a+b", Charsets.UTF_8))
        assertEquals("a+b", Pairing.parse(base + "a+b").let { (it as Pairing.Outcome.Ok).token })

        // …and the same in vector 1, where the token carries a space, a plus and a slash at once.
        val vectorOne = Pairing.parse(payloads[0]) as Pairing.Outcome.Ok
        assertEquals("a b+c/d?", vectorOne.token)
        assertEquals("home + lab", vectorOne.room, "the room label's own + is %2B in the payload and stays one here")

        // A relay with an escaped colon and port: nothing here is form-decoded either.
        assertEquals("https://relay.example.com:8787", vectorOne.relay)
    }

    @Test
    @DisplayName("a decoded value keeps a character the desktop never escaped, and refuses bytes it could not have written")
    fun theDecoderIsByteExact() {
        // A raw (un-escaped) non-ASCII value: `encodeURIComponent` would have escaped it, but a
        // hand-built payload that carries the bytes directly must read the same, because the
        // decoder works on bytes and only then on UTF-8.
        val raw = Pairing.parse("spinney-pair:1?relay=https%3A%2F%2Frelay.example.com&room=房间&token=abcdefgh") as Pairing.Outcome.Ok
        assertEquals("房间", raw.room)
        assertEquals("房间", Pairing.parse(payloads[2]).let { (it as Pairing.Outcome.Ok).room })

        // Bytes that are not UTF-8 at all, and a lone surrogate: refused, never repaired into
        // U+FFFD — a replaced character is a different token, which is a different room.
        assertEquals(Pairing.Refusal.MALFORMED_ESCAPE, refusalOf("spinney-pair:1?relay=https%3A%2F%2Frelay.example.com&room=home&token=%FF"))
        assertEquals(Pairing.Refusal.MALFORMED_ESCAPE, refusalOf("spinney-pair:1?relay=https%3A%2F%2Frelay.example.com&room=home&token=%ED%A0%80"))
        assertEquals(Pairing.Refusal.MALFORMED_ESCAPE, refusalOf("spinney-pair:1?relay=https%3A%2F%2Frelay.example.com&room=home&token=\uD800"))
    }

    @Test
    @DisplayName("every refusal is its own reason: prefix, version, shape, missing, empty, unknown, escape, relay")
    fun refusalsAreDistinguishable() {
        val relay = "relay=https%3A%2F%2Frelay.example.com"

        assertEquals(Pairing.Refusal.UNKNOWN_PREFIX, refusalOf("hello world"))
        assertEquals(Pairing.Refusal.UNKNOWN_PREFIX, refusalOf(""))
        assertEquals(Pairing.Refusal.UNKNOWN_PREFIX, refusalOf("spinney-pair/1?$relay&room=home&token=abcdefgh"))
        assertEquals(Pairing.Refusal.UNKNOWN_PREFIX, refusalOf("spinney-pair"))
        // A QR code whose *reader* is this one, but whose payload is an ordinary URL: the common
        // case of photographing the wrong screen.
        assertEquals(Pairing.Refusal.UNKNOWN_PREFIX, refusalOf("https://relay.example.com/v2/room/X/join"))

        assertEquals(Pairing.Refusal.UNKNOWN_VERSION, refusalOf("spinney-pair:2?$relay&room=home&token=abcdefgh"))
        assertEquals(Pairing.Refusal.UNKNOWN_VERSION, refusalOf("spinney-pair:999?$relay&room=home&token=abcdefgh"))
        // A version is the integer itself, not its spelling: `007` is a version this build does not
        // know, and it is *not* read as `7` or padded into `1`.
        assertEquals(Pairing.Refusal.UNKNOWN_VERSION, refusalOf("spinney-pair:007?$relay&room=home&token=abcdefgh"))
        assertEquals(Pairing.Refusal.MALFORMED, refusalOf("spinney-pair:x?$relay&room=home&token=abcdefgh"))

        assertEquals(Pairing.Refusal.MALFORMED, refusalOf("spinney-pair:1"))
        assertEquals(Pairing.Refusal.MALFORMED, refusalOf("spinney-pair:1?$relay&room&token=abcdefgh"))
        assertEquals(Pairing.Refusal.MALFORMED, refusalOf("spinney-pair:1?$relay&room=home&token=abcdefgh&$relay"))
        assertEquals(Pairing.Refusal.MALFORMED, refusalOf("spinney-pair:1?$relay&room=home&token=abcdefgh&"))

        assertEquals(Pairing.Refusal.MISSING_PARAMETER, refusalOf("spinney-pair:1?$relay&room=home"))
        assertEquals(Pairing.Refusal.MISSING_PARAMETER, refusalOf("spinney-pair:1?room=home&token=abcdefgh"))
        assertEquals(Pairing.Refusal.MISSING_PARAMETER, refusalOf("spinney-pair:1?"))

        assertEquals(Pairing.Refusal.EMPTY_PARAMETER, refusalOf("spinney-pair:1?$relay&room=&token=abcdefgh"))
        assertEquals(Pairing.Refusal.EMPTY_PARAMETER, refusalOf("spinney-pair:1?$relay&room=home&token="))

        // A field this build does not know means a *newer* version — never a field to skip.
        assertEquals(Pairing.Refusal.UNKNOWN_PARAMETER, refusalOf("spinney-pair:1?$relay&room=home&token=abcdefgh&extra=1"))
        assertEquals(Pairing.Refusal.UNKNOWN_PARAMETER, refusalOf("spinney-pair:1?$relay&room=home&token=abcdefgh&Token=abcdefgh"))

        assertEquals(Pairing.Refusal.MALFORMED_ESCAPE, refusalOf("spinney-pair:1?$relay&room=home&token=a%2"))
        assertEquals(Pairing.Refusal.MALFORMED_ESCAPE, refusalOf("spinney-pair:1?$relay&room=home&token=a%zzb"))
        assertEquals(Pairing.Refusal.MALFORMED_ESCAPE, refusalOf("spinney-pair:1?$relay&room=home&token=a%2&b=c"))
        // Lowercase hex is still hex; only a non-hex character is a broken escape.
        assertEquals("a\u0002b", (Pairing.parse("spinney-pair:1?$relay&room=home&token=a%02b") as Pairing.Outcome.Ok).token)

        assertEquals(Pairing.Refusal.BAD_RELAY, refusalOf("spinney-pair:1?relay=ftp%3A%2F%2Frelay.example.com&room=home&token=abcdefgh"))
        assertEquals(Pairing.Refusal.BAD_RELAY, refusalOf("spinney-pair:1?relay=http%3A%2F%2F&room=home&token=abcdefgh"))
        assertEquals(Pairing.Refusal.BAD_RELAY, refusalOf("spinney-pair:1?relay=http%3A%2F%2F%2Froom&room=home&token=abcdefgh"))
        assertEquals(Pairing.Refusal.BAD_RELAY, refusalOf("spinney-pair:1?relay=relay.example.com&room=home&token=abcdefgh"))
        assertEquals(Pairing.Refusal.BAD_RELAY, refusalOf("spinney-pair:1?relay=ws%3A%2F%2Frelay.example.com&room=home&token=abcdefgh"))
        // An http relay with no port, and one whose scheme the user capitalised: both are usable.
        assertEquals("http://relay.example.com", (Pairing.parse("spinney-pair:1?relay=http%3A%2F%2Frelay.example.com&room=home&token=abcdefgh") as Pairing.Outcome.Ok).relay)
        assertEquals("HTTP://relay.example.com", (Pairing.parse("spinney-pair:1?relay=HTTP%3A%2F%2Frelay.example.com&room=home&token=abcdefgh") as Pairing.Outcome.Ok).relay)
    }

    @Test
    @DisplayName("the parser is pure: it returns the token, and TokenInput — not this file — judges it")
    fun theParserDoesNotJudgeTheToken() {
        val short = "spinney-pair:1?relay=https%3A%2F%2Frelay.example.com&room=home&token=abc"

        // Vector 1 already shows it: `a b+c/d?` is seven code points and would be refused as a
        // *token*, yet the parser hands it back untouched — the strength rule has one definition
        // ([TokenInput.issue], the desktop's own) and this file must not grow a second one.
        val parsed = Pairing.parse(payloads[0]) as Pairing.Outcome.Ok
        assertEquals("a b+c/d?", parsed.token)
        assertNotNull(TokenInput.issue(parsed.token), "the shared vector's token is deliberately too short to use")

        val parsedShort = Pairing.parse(short) as Pairing.Outcome.Ok
        assertEquals("abc", parsedShort.token)
        assertEquals(TokenInput.Issue.TOO_SHORT, TokenInput.issue(parsedShort.token))

        // And raw is what the flow then normalises, in that order: the parser never trims, because
        // trimming is [TokenInput.normalize]'s set (the one `String.prototype.trim` removes) and
        // two normalisers would be two answers.
        val padded = Pairing.parse("spinney-pair:1?relay=https%3A%2F%2Frelay.example.com&room=home&token=%20abcdefgh%20") as Pairing.Outcome.Ok
        assertEquals(" abcdefgh ", padded.token)
        assertEquals("abcdefgh", TokenInput.normalize(padded.token))
    }

    @Test
    @DisplayName("a payload can be read from a photograph's pixels, not only from a string")
    fun pixelsAreReadFromArgbPixels() {
        // The geometry contract `Bitmap.getPixels` and `RGBLuminanceSource` share — one ARGB_8888
        // int per pixel, row-major — checked on the case the app actually hits: a photo with no
        // code in it is null, not an exception, because "photograph the code again" is the answer
        // and a thrown NotFoundException would be a crash instead of a sentence.
        val size = 41
        assertNull(QrScan.decode(IntArray(size * size) { 0xFFFFFFFF.toInt() }, size, size), "a blank image holds no code")
        assertNull(QrScan.decode(IntArray(0), 0, 0), "a degenerate geometry is the same answer, not a crash")
    }

    /**
     * THE REASON THIS FILE EXISTS. `pairing-fixture.png` is shared vector 1's payload as a QR code,
     * drawn by the desktop's own encoder (`tools/gen-qr-fixture.mjs`) and committed like the crypto
     * vectors are. Decoding it with zxing — a third-party reader, not the desktop's encoder and not
     * a Kotlin one — is the only evidence in this repository that the desktop emits a symbol a real
     * phone can read: it fails if the encoder's block interleaving, mask, format bits or padding
     * ever drift, none of which a round trip through the same implementation would notice.
     */
    @Test
    @DisplayName("the committed fixture decodes with zxing to shared vector 1, field for field")
    fun theCommittedFixtureDecodesToVectorOne() {
        // ImageIO is allowed *here* and nowhere else: it is a JDK class with no Android
        // counterpart, and this test is the one place the pixels come from a file instead of a
        // `BitmapFactory`.
        val image = javaClass.getResourceAsStream("/pairing-fixture.png")?.use { ImageIO.read(it) }
            ?: throw AssertionError("pairing-fixture.png must be on the test classpath as a readable PNG")
        assertTrue(image.width > 32 && image.height > 32, "a QR symbol with its quiet zone, not a thumbnail")

        val pixels = IntArray(image.width * image.height)
        image.getRGB(0, 0, image.width, image.height, pixels, 0, image.width)
        val payload = QrScan.decode(pixels, image.width, image.height)

        assertEquals(payloads[0], payload, "the fixture must decode to the shared vector's payload literal")
        val parsed = Pairing.parse(payload!!) as Pairing.Outcome.Ok
        assertEquals("https://relay.example.com:8787", parsed.relay)
        assertEquals("home + lab", parsed.room)
        assertEquals("a b+c/d?", parsed.token)
    }

    private fun refusalOf(payload: String): Pairing.Refusal =
        when (val outcome = Pairing.parse(payload)) {
            is Pairing.Outcome.Refused -> outcome.reason
            is Pairing.Outcome.Ok -> throw AssertionError("expected a refusal, got $outcome")
        }
}
