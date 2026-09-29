package dev.spinney.remote.core

/**
 * §7's relay routes, built in one place so a URL is never assembled by string concatenation at a
 * call site. The room id is a path segment and therefore a routing credential; it is not escaped
 * because it is base32 by construction (§3).
 */
object RelayRoutes {

    /**
     * What the caller asks `/v2`'s join to do with the room, as the route's `mode`.
     *
     * §3: "a wrong token produces a different room, so a wrong token is not an error: it is an
     * empty room." `/v1` therefore answered a token that named nothing with a live empty room, and
     * that room renders exactly like one nobody is publishing in yet. `/v2` separates the two:
     * [JOIN] is refused with `404 room_unknown` when this relay has no such room, while [CREATE]
     * records it.
     *
     * **This client asks for [JOIN] and never for [CREATE]**: a phone is a replica, and a replica
     * must not be able to bring a room into being — which is exactly what makes a token that names
     * nothing fail loudly instead of quietly producing a room where two devices will never meet. It
     * is a client-mode declaration, not a privilege: the relay cannot tell a phone from a desktop,
     * and whoever holds the token *is* the room. What it buys is legibility, not security.
     */
    enum class JoinMode(val wire: String) {

        /** The publisher's mode: record the room if this relay has never seen that id. */
        CREATE("create"),

        /** The replica's mode: enter a room that exists, or be told that none does. */
        JOIN("join"),
    }

    /**
     * One join: the URL **and** the body its mode travels in — they are built together because the
     * mode is not part of the path, so a caller assembling the body itself could send a request
     * whose route says `/v2` and whose body says something else.
     */
    data class JoinRequest(val url: String, val body: String)

    /**
     * `POST /v2/room/{roomId}/join`. There is deliberately **no default mode** — the relay's own
     * rule, and the reason the route exists: a default would be the old silent behaviour wearing a
     * new route's name, so a caller that forgot the argument would keep failing invisibly.
     */
    fun join(relayBaseUrl: String, roomId: String, mode: JoinMode): JoinRequest = JoinRequest(
        url = "${base(relayBaseUrl)}/v2/room/$roomId/join",
        body = "{\"mode\":${JsonValue.of(mode.wire).toJson()}}",
    )

    fun down(relayBaseUrl: String, roomId: String, peerId: String): String =
        "${base(relayBaseUrl)}/v1/room/$roomId/down?peer=$peerId"

    fun up(relayBaseUrl: String, roomId: String, peerId: String): String =
        "${base(relayBaseUrl)}/v1/room/$roomId/up?peer=$peerId"

    fun healthz(relayBaseUrl: String): String = "${base(relayBaseUrl)}/healthz"

    /** A trailing slash in a setting is a typo, not a different host. */
    private fun base(relayBaseUrl: String): String = relayBaseUrl.trimEnd('/')
}
