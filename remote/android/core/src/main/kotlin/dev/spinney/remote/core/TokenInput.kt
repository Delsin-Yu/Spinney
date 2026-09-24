package dev.spinney.remote.core

/**
 * The one place a **typed or pasted token** is turned into the string that is actually hashed —
 * and the desktop's strength rules, ported so the phone refuses the same inputs for the same
 * reasons instead of silently landing in a different room.
 *
 * WHY THIS EXISTS AT ALL. The room id is derived from the token and nothing else (§3), so two
 * tokens that differ by one character are two *different rooms* — and a wrong token is not an
 * error, it is an **empty room** (`docs/agents/plans/remote-control.md` §11). That combination is
 * what makes whitespace a real defect rather than a cosmetic one, and it was measured on a phone:
 *
 * ```
 * SMXWUIEVKERHFZBP2TNYACJ65A   <- as typed (the desktop trims to this)
 * XEOTFEDTRP4Z4DEQLVKOFY5KJA   <- one trailing space
 * RSUI2WPPHFT2ST2M2ZCETUH2UA   <- one trailing newline (what a phone paste produces)
 * AOBMGK7LS55I2TDRSGNQWO2I3U   <- the IME capitalised the first letter
 * ```
 *
 * Four inputs, four rooms, and neither device ever saw the other. The desktop trims the token on
 * the way in and on the way out` (src/remote/roomsCommand.ts`, `src/remote/roomsStore.ts`); the
 * phone did not, so the two sides disagreed about exactly the input a paste produces.
 *
 * WHAT [normalize] DOES, AND WHAT IT DELIBERATELY DOES NOT. It removes leading and trailing
 * whitespace **and nothing else**: no lowercasing, no interior stripping, no character
 * substitution. A token is a case-sensitive shared secret, and "helpfully" rewriting it would
 * create a *third* wrong room that neither the desktop nor the user could explain.
 *
 * The whitespace set is the one `String.prototype.trim` removes — the desktop is the other end of
 * this comparison, and the two must agree character for character. Delegating to Kotlin's
 * `Char.isWhitespace()` would not: the two sets genuinely differ, in both directions.
 *
 * - a **byte-order mark** (`\uFEFF`), which a paste can carry, is trimmed by JavaScript and is
 *   *not* whitespace to Kotlin's `Char.isWhitespace()` — so a `trim()` would keep a BOM the desktop
 *   strips, and the two devices would derive different rooms from the same paste;
 * - the C0 file/group/record/unit separators (`\u001C`–`\u001F`) are whitespace to Kotlin and are
 *   *not* trimmed by JavaScript.
 *
 * The two sets agree about every space that matters (including NBSP and the Unicode space
 * separators); the two lines above are exactly why this set is written out by hand.
 *
 * The three issues below are not a strength *policy* invented here: they are
 * [`tokenIssue`](https://github.com/spinney) in `src/remote/rooms.ts` — `MIN_TOKEN_CHARS` 16 and
 * `MIN_DISTINCT_CHARS` 8 — ported verbatim, so the phone refuses a truncated paste for the same
 * reason the desktop does instead of letting it become an empty room.
 */
object TokenInput {

    /**
     * Minimum token length in **code points**, not UTF-16 units — mirrors `MIN_TOKEN_CHARS` in
     * `src/remote/rooms.ts`. A token written in a non-Latin script is measured by what the user
     * sees, not by surrogate pairs.
     */
    const val MIN_TOKEN_CHARS: Int = 16

    /**
     * Minimum number of distinct characters — mirrors `MIN_DISTINCT_CHARS`. A **typo guard, not an
     * entropy model**: it only refuses a token that is (nearly) one repeated character
     * (`aaaaaaaaaaaaaaaa`), which is what a slip on the keyboard produces.
     */
    const val MIN_DISTINCT_CHARS: Int = 8

    /**
     * The characters `String.prototype.trim` removes: WhiteSpace ∪ LineTerminator of the
     * ECMAScript grammar. Written out rather than delegated to `Char.isWhitespace()` because the
     * two sets differ exactly where a paste hurts (NBSP, BOM, the Unicode space separators).
     */
    private const val JS_TRIM_CHARS =
        "\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680" +
            "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A" +
            "\u2028\u2029\u202F\u205F\u3000\uFEFF"

    /** Why a token was refused, or null when it is usable. Mirrors `TokenIssue` in `rooms.ts`. */
    enum class Issue {
        /** Nothing left after normalisation: there is no room to derive. */
        EMPTY,

        /** Fewer than [MIN_TOKEN_CHARS] code points. */
        TOO_SHORT,

        /** Fewer than [MIN_DISTINCT_CHARS] distinct characters. */
        TOO_FEW_DISTINCT,
    }

    /**
     * The token as it must be hashed: leading and trailing ECMAScript whitespace removed, every
     * other character — case, digits, punctuation, interior spaces, non-Latin scripts — untouched.
     */
    fun normalize(raw: String): String {
        var start = 0
        var end = raw.length
        while (start < end && isJsWhitespace(raw[start])) start++
        while (end > start && isJsWhitespace(raw[end - 1])) end--
        return raw.substring(start, end)
    }

    /**
     * Judge an **already normalised** token, exactly as `tokenIssue` does. Returns null when the
     * token is usable. Call it with [normalize]'s output: `issue(" secret ")` would judge the
     * untrimmed string and report a length the hash will never see.
     */
    fun issue(token: String): Issue? {
        if (token.isEmpty()) return Issue.EMPTY
        val codePoints = token.codePoints().toArray()
        if (codePoints.size < MIN_TOKEN_CHARS) return Issue.TOO_SHORT
        if (codePoints.toSet().size < MIN_DISTINCT_CHARS) return Issue.TOO_FEW_DISTINCT
        return null
    }

    /** The whole judgement in one call: normalise, then judge what would actually be hashed. */
    fun normalizeAndIssue(raw: String): Pair<String, Issue?> {
        val token = normalize(raw)
        return token to issue(token)
    }

    /** True iff [char] is in the set `String.prototype.trim` removes. */
    fun isJsWhitespace(char: Char): Boolean = JS_TRIM_CHARS.indexOf(char) >= 0
}
