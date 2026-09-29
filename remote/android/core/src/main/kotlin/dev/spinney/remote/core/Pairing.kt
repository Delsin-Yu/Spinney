package dev.spinney.remote.core

import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.URISyntaxException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * `Pairing` — the phone's half of the one string that pairs it:
 * `spinney-pair:1?relay=<r>&room=<n>&token=<t>`.
 *
 * WHY THIS STRING EXISTS. The token *is* the room (`remote/PROTOCOL.md` §3: the room id is derived
 * from the token and nothing else) and the relay never learns it, so the only channel between the
 * two devices is the one in front of the user. The desktop holds the token and draws this payload
 * as a QR code (`src/remote/pairing.ts` + `src/remote/qr.ts`); the phone photographs that screen
 * and reads the string back. Typing the token was the step that failed *silently*
 * (`docs/agents/plans/remote-control.md` §11: a mistyped token is a different room, and a different
 * room looked exactly like an idle one), so the token now travels device to device and never
 * through a keyboard.
 *
 * THE FORMAT, AS THE DESKTOP WRITES IT — the other half of this contract, and the same three
 * shared vectors are asserted on both sides: the prefix `spinney-pair`, a **version integer**
 * (`1`), then `?` and exactly three parameters — `relay` (the relay base URL), `room` (the room's
 * local label, which never travels over the wire but travels here so the phone can name the room
 * the way its user does) and `token` (the raw token).
 *
 * THE TRAP, AND THE WHOLE REASON THIS FILE IS NOT THREE LINES LONG. A literal `+` in a query value
 * is a *web form* convention, not RFC 3986: Java's `URLEncoder` writes a space as `+` and its
 * `URLDecoder` reads `+` back as a space, while the desktop uses JS `encodeURIComponent`, which
 * writes a space as `%20` and treats `+` literally. So **`URLDecoder` is banned here** — a token
 * containing `+` would arrive with a space in it, which is a *different room*, and an empty one,
 * which is the exact silent failure the QR code was introduced to remove. [percentDecode] is the
 * matching strict decoder instead: `%XX` over the UTF-8 bytes, `%20` to a space, a bare `+` kept
 * as a literal `+`, and a malformed escape refused rather than repaired.
 *
 * STRICT — AND PURITY IS PART OF THAT. It refuses an unknown prefix or version, a parameter that is
 * missing or empty, **any parameter it does not know** (a version-1 parser that skipped a future
 * field would silently mis-read a version-2 payload, so a new field means a new version), a
 * malformed `%XX` escape or non-UTF-8 bytes, and a relay that is not an `http`/`https` URL. What it
 * deliberately does **not** do is judge the token: it returns the three strings, and the flow then
 * runs [TokenInput.normalize] + [TokenInput.issue], which is the single definition of a usable
 * token and the single place its refusal sentences live. There is no encoder here either — the
 * desktop owns encoding, and a second one would only be a second thing to drift.
 */
object Pairing {

    /** The scheme prefix, before the version integer. A wire literal, shared with `pairing.ts`. */
    const val PREFIX: String = "spinney-pair"

    /** The payload version this build reads. An unknown version is refused, never read best-effort. */
    const val VERSION: Int = 1

    /** The three parameter names — and no others: a fourth name means a new [VERSION]. */
    val PARAMS: List<String> = listOf("relay", "room", "token")

    /**
     * Why a payload was refused. One value per clause of the format above, because the phone has to
     * be able to name the failure (and a test has to be able to assert *which* one fired) instead
     * of reporting "a bad code" for a payload that was merely made by a newer app.
     */
    enum class Refusal {
        /** The text does not start with `spinney-pair:` at all — a QR code that is something else. */
        UNKNOWN_PREFIX,

        /** A numeric version this build does not know: the payload was made by a newer Spinney. */
        UNKNOWN_VERSION,

        /** The payload's own shape is broken: no `?`, no version, a part with no `=`, a repeat. */
        MALFORMED,

        /** One of the three names never appeared. */
        MISSING_PARAMETER,

        /** A name appeared with nothing after `=` — the desktop refuses to emit one for this reason. */
        EMPTY_PARAMETER,

        /** A name that is not one of the three: refusing it is what makes a new field a new version. */
        UNKNOWN_PARAMETER,

        /** A `%` not followed by two hex digits, or bytes that are not UTF-8. */
        MALFORMED_ESCAPE,

        /** The relay is not an addressable `http`/`https` URL, so a paired phone could not connect. */
        BAD_RELAY,
    }

    /** Either the three strings, or the one reason they were refused. */
    sealed interface Outcome {
        data class Ok(val relay: String, val room: String, val token: String) : Outcome
        data class Refused(val reason: Refusal) : Outcome
    }

    /**
     * Parse one payload. Pure: no I/O, no clock, and **no judgement of the token** — the three
     * strings come back exactly as the desktop wrote them, and a caller that needs a *usable* token
     * asks [TokenInput] (which is where the desktop's own sentences live).
     */
    fun parse(text: String): Outcome {
        if (!text.startsWith("$PREFIX:")) return Outcome.Refused(Refusal.UNKNOWN_PREFIX)
        val rest = text.substring(PREFIX.length + 1)
        val mark = rest.indexOf('?')
        if (mark < 0) return Outcome.Refused(Refusal.MALFORMED)
        val version = rest.substring(0, mark)
        if (version != VERSION.toString()) {
            // A *numeric* version this build does not know is its own reason — "made by a newer
            // Spinney" is actionable, "this code is damaged" is not. A version field that is not an
            // integer at all (empty, `1x`) is a damaged payload instead. The text is compared, never
            // parsed as a number, so a long run of digits cannot overflow anything.
            val numeric = version.isNotEmpty() && version.all { it in '0'..'9' }
            return Outcome.Refused(if (numeric) Refusal.UNKNOWN_VERSION else Refusal.MALFORMED)
        }

        val query = rest.substring(mark + 1)
        if (query.isEmpty()) return Outcome.Refused(Refusal.MISSING_PARAMETER)

        val values = mutableMapOf<String, String>()
        for (part in query.split('&')) {
            // The `=` is found first, so a value may legally contain one; the desktop escapes it
            // anyway (`%3D`), which is why an empty name or a part with no `=` is damage.
            val cut = part.indexOf('=')
            if (cut <= 0) return Outcome.Refused(Refusal.MALFORMED)
            val name = part.substring(0, cut)
            if (name !in PARAMS) return Outcome.Refused(Refusal.UNKNOWN_PARAMETER)
            if (values.containsKey(name)) return Outcome.Refused(Refusal.MALFORMED)
            val value = percentDecode(part.substring(cut + 1)) ?: return Outcome.Refused(Refusal.MALFORMED_ESCAPE)
            if (value.isEmpty()) return Outcome.Refused(Refusal.EMPTY_PARAMETER)
            values[name] = value
        }
        if (values.size != PARAMS.size) return Outcome.Refused(Refusal.MISSING_PARAMETER)

        // The names are the contract, the *order* is the encoder's: `pairing.ts` emits relay, room,
        // token, and a reader that refused a reordered payload would refuse nothing it cannot read.
        val relay = values.getValue("relay")
        if (!isRelayUrl(relay)) return Outcome.Refused(Refusal.BAD_RELAY)
        return Outcome.Ok(relay, values.getValue("room"), values.getValue("token"))
    }

    /**
     * The matching half of the trap above: percent-decode into **bytes** and only then read them as
     * UTF-8, so `%E6%88%BF` and a raw `房` both work and neither is ever a form decode. `+` is a
     * literal `+` (it is not the form spelling of a space) and `%20` is a space. Returns null on
     * anything a strict decoder must not guess at: a truncated or non-hex escape, a lone UTF-16
     * surrogate (it has no UTF-8 bytes), or bytes that are not valid UTF-8.
     */
    private fun percentDecode(value: String): String? {
        val bytes = ByteArrayOutputStream(value.length)
        var index = 0
        while (index < value.length) {
            val char = value[index]
            if (char == '%') {
                if (index + 2 >= value.length) return null
                val high = hexDigit(value[index + 1])
                val low = hexDigit(value[index + 2])
                if (high < 0 || low < 0) return null
                bytes.write((high shl 4) or low)
                index += 3
            } else {
                val codePoint = value.codePointAt(index)
                // A lone surrogate cannot be encoded; the desktop refuses to *emit* one for the same
                // reason (`pairing.ts`: it would reach the phone as U+FFFD, a different token, a
                // different room).
                if (codePoint in 0xD800..0xDFFF) return null
                bytes.write(String(Character.toChars(codePoint)).toByteArray(Charsets.UTF_8))
                index += Character.charCount(codePoint)
            }
        }
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        return try {
            decoder.decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
        } catch (err: CharacterCodingException) {
            null
        }
    }

    /** `0`-`9`/`a`-`f`/`A`-`F`, or -1. Both cases, because a `%XX` escape is hex and not a literal. */
    private fun hexDigit(char: Char): Int = when (char) {
        in '0'..'9' -> char - '0'
        in 'a'..'f' -> char - 'a' + 10
        in 'A'..'F' -> char - 'A' + 10
        else -> -1
    }

    /**
     * What the rest of the app needs from `relay`: an `http`/`https` URL with an **authority**, so
     * `RelayRoutes` can hang `/v2/room/…` off it. `ftp://…`, `file:///…`, `http:relay.example.com`
     * and a bare `http://` are all refused here rather than at the first request, because a room
     * saved with an unreachable relay is a room the user cannot get out of without noticing.
     *
     * The authority is checked rather than `URI.host` on purpose: `java.net.URI` does not convert an
     * internationalized hostname, so a relay named in a non-Latin script would have a `null` host
     * yet a perfectly usable authority, and refusing it here would refuse a URL the user typed.
     */
    private fun isRelayUrl(relay: String): Boolean {
        val uri = try {
            URI(relay)
        } catch (err: URISyntaxException) {
            return false
        }
        val scheme = uri.scheme ?: return false
        if (!scheme.equals("http", ignoreCase = true) && !scheme.equals("https", ignoreCase = true)) return false
        return !uri.authority.isNullOrEmpty()
    }
}
