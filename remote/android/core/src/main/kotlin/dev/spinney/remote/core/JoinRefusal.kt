package dev.spinney.remote.core

/**
 * Why a `/v2` join was refused, as the machine-readable fact a UI can put a sentence to.
 *
 * This is §3's axiom retired. At `/v1` a phone holding a wrong token was handed a live empty
 * room — indistinguishable, byte for byte, from a room nobody was publishing in yet — so "the
 * token is wrong" had no symptom of its own. `/v2`'s `join` mode separates them, and the
 * separation is worth naming in code because two of these answers **cannot change**: the room id
 * is derived from the token alone (§3), so a retry derives the same id and gets the same answer
 * forever. Those two are [ROOM_UNKNOWN] and [RELAY_TOO_OLD]; every other answer is left to the
 * caller's own retry handling, and is not named here.
 */
enum class JoinRefusal(val token: String) {

    /**
     * `404 {"error":"room_unknown"}`: this relay has no room with that id. Either the token is
     * wrong — a different token is a different room — or nobody has created the room *yet*, which
     * is why the sentence that goes with this one says to compare the token with the other device.
     */
    ROOM_UNKNOWN("room_unknown"),

    /**
     * A 404 that carries no `error` field: this relay has no `/v2` join route at all, i.e. it is
     * older than this build. §5 puts a changed transport contract in a new route version, so a
     * missing route can only mean the older side, and no retry makes the route appear.
     */
    RELAY_TOO_OLD("relay_too_old"),

    /** `404 {"error":"invalid_room_id"}`: the path segment is not a room id (§3 makes it 26 base32 characters). */
    INVALID_ROOM_ID("invalid_room_id"),

    /** `400 {"error":"bad_mode"}`: this build's own request was refused, so it and that relay disagree about the contract. */
    BAD_MODE("bad_mode"),

    /** A terminal refusal whose token this build does not know — not a status the backoff loop owns. */
    REFUSED("refused"),
    ;

    companion object {

        /** The refusal a relay error token names, or null for a token this build does not know. */
        fun of(token: String?): JoinRefusal? = entries.firstOrNull { it.token == token }
    }
}

/**
 * The refusal a `/v2` join answer names, or **null when it names none**: a `2xx`, a `429`, a `5xx`
 * or any status this function does not know is left to the caller's transport handling, where the
 * reconnect loop's backoff already owns it.
 *
 * The 404s are deliberately not merged. A relay that answers the *route miss* — an empty body, or
 * the framework's own 404 document, and in neither case an `error` field — knows nothing about
 * `/v2`; `{"error":"room_unknown"}` is a relay that does. One of those sentences is "update the
 * relay", the other is "check the token", and they are not interchangeable.
 */
fun joinRefusalOf(status: Int, body: String): JoinRefusal? = when {
    status == 404 ->
        errorTokenOf(body)?.let { JoinRefusal.of(it) ?: JoinRefusal.REFUSED } ?: JoinRefusal.RELAY_TOO_OLD
    status == 429 || status >= 500 -> null
    status in 400..499 -> errorTokenOf(body)?.let { JoinRefusal.of(it) } ?: JoinRefusal.REFUSED
    else -> null
}

/**
 * The `error` token of a relay error body, or null when it carries none.
 *
 * Read defensively on purpose: this body is a third party's, and the 404 of a relay built before
 * `/v2` is often not JSON at all. "Not JSON" is a value here — it is the older-relay case — so it
 * must never be an exception on the connect path.
 */
private fun errorTokenOf(body: String): String? {
    val obj = try {
        JsonValue.parse(body) as? JsonValue.Obj
    } catch (err: IllegalArgumentException) {
        null
    }
    return obj?.strOrNull("error")?.takeIf { it.isNotEmpty() }
}
