package dev.spinney.remote.core

/**
 * §7: `GET /v1/room/{roomId}/down?peer=` is `text/event-stream`; "one `data:` line per frame
 * from another peer, plus a `: ping` comment every 15 s".
 *
 * This is the *parser*, not the reader: it takes text as it arrives from the socket and
 * yields the payloads, so the whole thing is testable without a network — which matters for
 * a milestone whose point is that the bytes are right. The reader itself lives in the Android
 * module on OkHttp.
 *
 * Rules kept deliberately narrow, because the relay "never parses this" either: a comment
 * line (`:` at the start) is a heartbeat and is surfaced as such rather than dropped, so the
 * client can use the relay's 15 s comment as a half-open-detector too; a blank line ends an
 * event; anything else is ignored rather than treated as a payload, so a stray line can never
 * be handed to the frame parser.
 */
class SseParser {

    private val data = StringBuilder()
    private val text = StringBuilder()

    /** One complete SSE event, or the relay's heartbeat comment. */
    sealed interface Event {
        /** The payload of one `data:` line sequence, exactly as it arrived. */
        data class Data(val payload: String) : Event

        /** A `: comment` — the relay's 15 s `: ping`. */
        data class Comment(val text: String) : Event
    }

    /**
     * Feed a chunk of the response body. Returns every event that chunk completed —
     * a chunk may complete several, and a partial line is buffered until it is not.
     */
    fun feed(chunk: String): List<Event> {
        val events = ArrayList<Event>(1)
        text.append(chunk)
        while (true) {
            val newline = indexOfNewline()
            if (newline.first < 0) break
            val line = text.substring(0, newline.first)
            text.delete(0, newline.second)
            lineEvent(line)?.let { events.add(it) }
        }
        return events
    }

    /** Flush whatever is buffered with no trailing newline — a stream that ended mid-line. */
    fun end(): List<Event> {
        val events = ArrayList<Event>(1)
        if (text.isNotEmpty()) {
            val line = text.toString()
            text.setLength(0)
            lineEvent(line)?.let { events.add(it) }
        }
        if (data.isNotEmpty()) {
            events.add(Event.Data(data.toString()))
            data.setLength(0)
        }
        return events
    }

    private fun indexOfNewline(): Pair<Int, Int> {
        for (i in text.indices) {
            when (text[i]) {
                '\n' -> return i to i + 1
                '\r' -> // CRLF, or a lone CR
                    return i to if (i + 1 < text.length && text[i + 1] == '\n') i + 2 else i + 1
            }
        }
        return -1 to -1
    }

    private fun lineEvent(line: String): Event? {
        if (line.isEmpty()) {
            if (data.isEmpty()) return null
            val payload = data.toString()
            data.setLength(0)
            return Event.Data(payload)
        }
        if (line.startsWith(":")) {
            return Event.Comment(line.substring(1).trim())
        }
        if (line.startsWith("data:")) {
            // A single `data:` line per frame is what the relay sends; a multi-line event
            // joins with "\n" per the SSE spec, which a JSON payload never needs.
            if (data.isNotEmpty()) data.append('\n')
            var value = line.substring(5)
            if (value.startsWith(" ")) value = value.substring(1)
            data.append(value)
            return null
        }
        // `event:`, `id:`, `retry:` and anything unknown: not part of this contract.
        return null
    }
}

/**
 * §7's two POST/GET targets, built in one place so a URL is never assembled by string
 * concatenation at a call site. The room id is a path segment and therefore a routing
 * credential; it is not escaped because it is base32 by construction (§3).
 */
object RelayRoutes {

    fun join(relayBaseUrl: String, roomId: String): String = "${base(relayBaseUrl)}/v1/room/$roomId/join"

    fun down(relayBaseUrl: String, roomId: String, peerId: String): String =
        "${base(relayBaseUrl)}/v1/room/$roomId/down?peer=$peerId"

    fun up(relayBaseUrl: String, roomId: String, peerId: String): String =
        "${base(relayBaseUrl)}/v1/room/$roomId/up?peer=$peerId"

    fun healthz(relayBaseUrl: String): String = "${base(relayBaseUrl)}/healthz"

    /** A trailing slash in a setting is a typo, not a different host. */
    private fun base(relayBaseUrl: String): String = relayBaseUrl.trimEnd('/')
}
