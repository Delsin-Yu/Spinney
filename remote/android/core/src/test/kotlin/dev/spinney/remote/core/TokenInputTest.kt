package dev.spinney.remote.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test

/**
 * `TokenInput` is the phone's half of a bug that was measured on a real phone: the relay's log
 * showed **four different rooms out of four spellings of one token**, because the room id is
 * derived from the token alone and a wrong token is not an error — it is an empty room. These
 * tests pin the four spellings from that report, and the two things a "helpful" normaliser must
 * never do (change case, touch an interior character).
 */
class TokenInputTest {

    /**
     * The four room ids the relay logged for one token, in the order the owner's report gives
     * them: as typed, plus a trailing space, plus a trailing newline (what a phone paste
     * produces), and with the first letter capitalised by the IME.
     *
     * The tokens themselves are a secret and are deliberately not reconstructed here; what the
     * test can — and must — prove is the *relationship* between those spellings, which is the
     * whole defect.
     */
    private val reportedRoomIds = listOf(
        "SMXWUIEVKERHFZBP2TNYACJ65A",
        "XEOTFEDTRP4Z4DEQLVKOFY5KJA",
        "RSUI2WPPHFT2ST2M2ZCETUH2UA",
        "AOBMGK7LS55I2TDRSGNQWO2I3U",
    )

    /** A stand-in for the owner's token: same shape and strength, not the secret. */
    private val typed = "a1f3c9d2e5b8a470f3a1c02b7d4e685"

    @Test
    @DisplayName("the report's four room ids really are four distinct rooms (26 base32 characters each)")
    fun reportedRoomIdsAreFourRooms() {
        assertEquals(4, reportedRoomIds.size)
        for (roomId in reportedRoomIds) {
            assertEquals(26, roomId.length, "$roomId is a room id, so 26 characters")
            assertTrue(Regex("^[A-Z2-7]{26}$").matches(roomId), "$roomId is base32 without 0/1/lowercase")
        }
        assertEquals(4, reportedRoomIds.toSet().size, "four spellings of one token landed in four rooms")
    }

    @Test
    @DisplayName("one trailing space, one trailing newline, one leading newline: the paste lands in the SAME room as the typed token")
    fun whitespaceSpellingsConvergeOnOneRoom() {
        val typedRoom = RoomKeys.derive(TokenInput.normalize(typed)).roomId
        val spellings = listOf(
            "$typed ", // the desktop trims this; the phone did not
            "$typed\n", // what a phone paste produces
            "\n$typed", // a paste that carries a newline in front
            " $typed ",
            "\r\n$typed\t",
            "\u00A0$typed\u00A0", // a non-breaking space: trimmed by JS .trim(), kept by Char.isWhitespace()
            "\uFEFF$typed\uFEFF", // a byte-order mark: same story
            "\u3000$typed\u3000", // ideographic space, which a CJK IME can append
        )
        for (spelling in spellings) {
            assertEquals(typed, TokenInput.normalize(spelling), "normalize must yield the typed token")
            assertEquals(
                typedRoom,
                RoomKeys.derive(TokenInput.normalize(spelling)).roomId,
                "a whitespace spelling of one token must route to one room",
            )
        }

        // …and the defect the fix removes, stated as a test rather than a comment: hashing the
        // untrimmed spellings really does produce different rooms. If this ever stops being true,
        // the room id has stopped depending on the token alone and this whole file needs rereading.
        for (spelling in spellings) {
            val untrimmed = RoomKeys.derive(spelling).roomId
            assertNotEquals(typedRoom, untrimmed, "without normalisation, ${spelling.length}-character input is another room")
        }
    }

    @Test
    @DisplayName("case is preserved, so the IME's capitalisation cannot be silently repaired")
    fun caseIsNeverRewritten() {
        val capitalised = typed.replaceFirstChar { it.uppercaseChar() }
        assertNotEquals(typed, capitalised, "the fixture must actually differ in case")
        assertEquals(capitalised, TokenInput.normalize(capitalised), "normalize must not lowercase anything")
        assertNotEquals(
            RoomKeys.derive(TokenInput.normalize(typed)).roomId,
            RoomKeys.derive(TokenInput.normalize(capitalised)).roomId,
            "a capitalised token is a real second room: the IME must be constrained, not the token guessed at",
        )
    }

    @Test
    @DisplayName("nothing else is touched: interior whitespace, punctuation and non-Latin scripts survive")
    fun onlyLeadingAndTrailingWhitespaceIsRemoved() {
        assertEquals("a b", TokenInput.normalize("a b"))
        assertEquals("a b", TokenInput.normalize("  a b  "))
        assertEquals("ab\ncd", TokenInput.normalize("ab\ncd"), "an interior newline is part of the secret")
        assertEquals("a\u00A0b", TokenInput.normalize("a\u00A0b"), "an interior non-breaking space too")
        assertEquals("café-ключ-密码-𝄞", TokenInput.normalize("  café-ключ-密码-𝄞  "))
        assertEquals("Secret-123!", TokenInput.normalize("Secret-123!"), "case, digits and punctuation are the secret")
        assertEquals("", TokenInput.normalize("   \t\n\r\u00A0\uFEFF "))
        assertEquals("", TokenInput.normalize(""))
        assertEquals("x", TokenInput.normalize("x"))

        // Idempotent: a normalised token is a fixed point, so "read, repair, write back" cannot
        // keep changing the stored value.
        for (raw in listOf("", " ", " $typed ", "a\tb", "\uFEFF$typed")) {
            val once = TokenInput.normalize(raw)
            assertEquals(once, TokenInput.normalize(once), "normalize is idempotent for ${raw.length} characters")
        }
    }

    @Test
    @DisplayName("the trimmed set is the one String.prototype.trim removes — which is wider than Char.isWhitespace()")
    fun trimSetMatchesJavaScript() {
        // Where the two sets agree: every ECMAScript space, including the non-breaking ones.
        for (char in listOf('\u0009', '\u000A', '\u000B', '\u000C', '\u000D', ' ', '\u00A0', '\u2007', '\u202F', '\u3000', '\u2000', '\u2028', '\u2029')) {
            assertTrue(TokenInput.isJsWhitespace(char), "\\u${char.code.toString(16)} is trimmed by String.prototype.trim()")
            assertTrue(char.isWhitespace(), "…and Kotlin agrees about \\u${char.code.toString(16)}")
        }

        // The first real disagreement, and the one a phone meets: a paste can carry a byte-order
        // mark, JavaScript's `trim` removes it, and Kotlin's `Char.isWhitespace()` does not — so an
        // implementation that "just called trim()" would keep a BOM the desktop strips, and the two
        // devices would derive different rooms from the same paste. This is why the set is written
        // out by hand instead of delegated.
        assertTrue(TokenInput.isJsWhitespace('\uFEFF'), "a BOM is trimmed by String.prototype.trim()")
        assertFalse('\uFEFF'.isWhitespace(), "…but Kotlin's Char.isWhitespace() says no, so trim() would keep it")

        // The other direction: the C0 file/group/record/unit separators are whitespace to Java and
        // Kotlin and NOT to JavaScript. Over-trimming cannot change a room on its own, but a
        // normaliser that disagreed with the desktop about the set would be a divergence of exactly
        // the kind that produced this bug.
        for (char in listOf('\u001C', '\u001D', '\u001E', '\u001F')) {
            assertFalse(TokenInput.isJsWhitespace(char), "\\u${char.code.toString(16)} is not trimmed by String.prototype.trim()")
            assertTrue(char.isWhitespace(), "…even though Kotlin's Char.isWhitespace() says it is")
        }

        // And the ordinary characters of a token are whitespace to nobody.
        for (char in listOf('a', 'Z', '0', '-', '!', '密')) {
            assertFalse(TokenInput.isJsWhitespace(char), "'$char' is part of a token")
        }
    }

    @Test
    @DisplayName("the strength rules are the desktop's: 16 code points, 8 distinct, three issues and no policy of our own")
    fun strengthRulesMirrorRoomsTs() {
        // The constants are pinned by value, mirroring `MIN_TOKEN_CHARS` / `MIN_DISTINCT_CHARS` in
        // `src/remote/rooms.ts`. No test can read that file at run time; a change there has to show
        // up as a change here.
        assertEquals(16, TokenInput.MIN_TOKEN_CHARS)
        assertEquals(8, TokenInput.MIN_DISTINCT_CHARS)

        assertEquals(TokenInput.Issue.EMPTY, TokenInput.issue(""))
        assertEquals(TokenInput.Issue.EMPTY, TokenInput.issue(TokenInput.normalize("   \n")))
        assertEquals(TokenInput.Issue.TOO_SHORT, TokenInput.issue("short"), "5 characters")
        assertEquals(TokenInput.Issue.TOO_SHORT, TokenInput.issue("0123456789abcde"), "15 characters")
        assertNull(TokenInput.issue("0123456789abcdef"), "16 characters and 16 distinct: usable")
        assertEquals(TokenInput.Issue.TOO_FEW_DISTINCT, TokenInput.issue("aaaaaaaaaaaaaaaa"), "the keyboard slip")
        assertEquals(TokenInput.Issue.TOO_FEW_DISTINCT, TokenInput.issue("abcdefgabcdefgab"), "16 characters, 7 distinct")
        assertNull(TokenInput.issue("abcdefghabcdefgh"), "16 characters, 8 distinct: usable")

        // Code points, not UTF-16 units — `Array.from` counts the same way, so a token in a
        // non-Latin script is judged by what the user sees, not by surrogate pairs.
        val emoji = "\uD834\uDD1E" // 𝄞, one code point, two UTF-16 units
        val eightEmoji = emoji.repeat(8)
        assertEquals(16, eightEmoji.length, "fixture: 16 UTF-16 units, 8 code points, 8 distinct")
        assertEquals(
            TokenInput.Issue.TOO_SHORT,
            TokenInput.issue(eightEmoji),
            "8 code points is too short — a UTF-16 length check would have called it 16 characters and passed it",
        )
        assertNull(TokenInput.issue(emoji.repeat(8) + "abcdefgh"), "16 code points and 16 distinct: usable")
        assertEquals(
            TokenInput.Issue.TOO_FEW_DISTINCT,
            TokenInput.issue(emoji.repeat(16)),
            "16 code points of one character: the slip this rule exists for",
        )
        val mixed = emoji.repeat(7) + "abcdefg"
        assertEquals(14, mixed.codePoints().count().toInt(), "fixture: 7 + 7 code points")
        assertEquals(TokenInput.Issue.TOO_SHORT, TokenInput.issue(mixed), "14 code points")

        // The order the desktop checks in: length first, then distinctness.
        assertEquals(TokenInput.Issue.TOO_SHORT, TokenInput.issue("aaaaaaaaa"), "too short AND too few distinct → too short")

        // `normalizeAndIssue` is the whole judgement in one call, and it judges what would actually
        // be hashed — not the raw string a paste produced.
        val (normalized, issue) = TokenInput.normalizeAndIssue("  $typed\n")
        assertEquals(typed, normalized)
        assertNull(issue, "the trimmed paste is a usable token even though its untrimmed length was 34")
        val (shortNormalized, shortIssue) = TokenInput.normalizeAndIssue("  short  ")
        assertEquals("short", shortNormalized)
        assertEquals(TokenInput.Issue.TOO_SHORT, shortIssue)
    }
}
