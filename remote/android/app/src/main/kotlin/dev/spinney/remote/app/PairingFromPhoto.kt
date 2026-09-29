package dev.spinney.remote.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import dev.spinney.remote.core.Pairing
import dev.spinney.remote.core.QrScan
import dev.spinney.remote.core.TokenInput

/**
 * Pairing from a picture: the desktop's QR code, read with the photo picker the app already uses
 * for attachments.
 *
 * WHY THIS IS STILL HERE NOW THAT THERE IS A CAMERA. The camera is the gesture the feature is for
 * ([CameraScanScreen]) and it is the primary action on the connect screen, but it is the one part
 * of pairing that can be *unavailable* or refused: a phone whose camera permission was denied, a
 * device with no camera at all, a code that already exists as a picture (a screenshot of the
 * desktop, a code sent through a chat). The picker needs no permission at all — the system photo
 * picker hands back one URI without granting access to the gallery — so the same payload stays
 * reachable when the camera is not, and the user is never left with a keyboard as the only way in.
 *
 * THE FOUR STEPS, EACH WITH ONE SENTENCE WHEN IT FAILS: decode a QR code out of the pixels
 * ([QrScan], zxing), parse it ([Pairing], strict), judge the token ([TokenInput], the desktop's own
 * rules and its own sentences), and hand the three strings back to the caller to fill the form and
 * connect. Nothing here touches a socket or the store: the connect path is the same one the
 * "Connect" button uses, so a paired room is saved, normalised and derived exactly like a typed one.
 *
 * Only the first step is photo-specific — everything from [pairingFromPayload] on is shared with the
 * camera, which is why that function is not private to this file and why the one interface below is
 * the outcome both ways in produce.
 */
sealed interface PhotoPairing {

    /** The three fields to fill. `token` is [TokenInput.normalize]'d, which is what gets hashed. */
    data class Paired(val relay: String, val room: String, val token: String) : PhotoPairing

    /** One sentence, already localised, to show in place of the form's own error line. */
    data class Failed(val message: String) : PhotoPairing
}

/**
 * Read a pairing payload out of the image at [uri]. Blocking, so it belongs on a background
 * dispatcher — a gallery-sized bitmap is decoded here.
 */
fun pairFromPhoto(context: Context, uri: Uri, l10n: L10n): PhotoPairing {
    val bitmap = decodeSampledBitmap(context, uri)
        ?: return PhotoPairing.Failed(l10n.t("That image could not be read."))
    val width = bitmap.width
    val height = bitmap.height
    if (width <= 0 || height <= 0) {
        bitmap.recycle()
        return PhotoPairing.Failed(l10n.t("That image could not be read."))
    }
    // ARGB_8888 packed ints, row-major, which is exactly what `RGBLuminanceSource` reads — the same
    // array a live camera frame produces, so both ways in run through one decoder and one ladder.
    val pixels = IntArray(width * height)
    bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
    bitmap.recycle()

    val payload = QrScan.decodeLadder(pixels, width, height)
        ?: return PhotoPairing.Failed(l10n.t("That photo has no Spinney room code in it."))
    return pairingFromPayload(payload, l10n)
}

/**
 * The payload → the three fields, or one sentence: the half of the flow the camera shares.
 *
 * It is the *whole* judgement of a decoded string — strict parse, then the token rules — so a
 * payload from a camera frame and a payload from a photograph cannot be judged two different ways.
 */
internal fun pairingFromPayload(payload: String, l10n: L10n): PhotoPairing =
    when (val parsed = Pairing.parse(payload)) {
        is Pairing.Outcome.Refused -> PhotoPairing.Failed(pairingRefusalSentence(parsed.reason, l10n))
        is Pairing.Outcome.Ok -> {
            val (token, issue) = TokenInput.normalizeAndIssue(parsed.token)
            if (issue != null) PhotoPairing.Failed(tokenIssueSentence(issue, l10n))
            else PhotoPairing.Paired(parsed.relay, parsed.room, token)
        }
    }

/**
 * The picked image's pixels, downsampled to something a phone can hold.
 *
 * The bounds are read first (`inJustDecodeBounds`) because `BitmapFactory` allocates the whole
 * bitmap before it hands one back: a 108 MP photograph would be a 432 MB allocation and an OOM
 * crash, not a decode. The cap is the *longest side* of the decoded bitmap, and it is measured, not
 * guessed: the committed fixture's symbol is version 6 — **41 modules across** — so a code taking
 * up a tenth of a 2560 px frame still leaves ~6 px per module, where a reader needs about three.
 *
 * WHAT THIS CAP IS NOT. It is **not** the ladder's downscale. `inSampleSize` is nearest-neighbour,
 * and on a photograph of a screen that is the read the ladder's measurement says fails at some
 * scales — so this only bounds the allocation, and [QrScan.decodeLadder] then does the averaging
 * that decides whether the code is legible.
 *
 * EXIF orientation is deliberately not applied. A QR code has no up: its finder patterns make
 * every one of the four rotations readable, so a JPEG that decodes sideways is a photo the decoder
 * handles, and re-encoding the bitmap would cost memory to fix nothing.
 */
private fun decodeSampledBitmap(context: Context, uri: Uri): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_DECODE_SIDE) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    // The input stream is opened a second time rather than buffered: a content URI is a fresh
    // stream per `openInputStream` call, and holding an 8 MB photo in a byte array to avoid one
    // `open` would cost more than it saves.
    return context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
}

/** The longest side of the bitmap handed to zxing. See [decodeSampledBitmap] for the arithmetic. */
private const val MAX_DECODE_SIDE = 2560

/**
 * One sentence per refusal, in the app's own words through [L10n.t].
 *
 * The unknown version and the bad relay are their own sentences because each has its own remedy
 * (update the app; fix the room's relay URL). Every other refusal — an unknown prefix, a damaged
 * segment, a missing, empty or unknown parameter, a broken `%XX` escape — is one sentence, because
 * to the person holding the phone they are one fact with one action: this is not a code this app
 * can read, so photograph the desktop's code again. The distinct reasons stay in `:core`, where a
 * test asserts *which* one fires.
 */
internal fun pairingRefusalSentence(refusal: Pairing.Refusal, l10n: L10n): String = when (refusal) {
    Pairing.Refusal.UNKNOWN_VERSION ->
        l10n.t("That code was made by a newer version of Spinney, so this app cannot read it.")
    Pairing.Refusal.BAD_RELAY ->
        l10n.t("The relay address in that code is not an http:// or https:// URL.")
    Pairing.Refusal.UNKNOWN_PREFIX,
    Pairing.Refusal.MALFORMED,
    Pairing.Refusal.MISSING_PARAMETER,
    Pairing.Refusal.EMPTY_PARAMETER,
    Pairing.Refusal.UNKNOWN_PARAMETER,
    Pairing.Refusal.MALFORMED_ESCAPE,
    -> l10n.t("That is not a Spinney pairing code this app can read.")
}

/**
 * One sentence per token issue, in the **desktop's** own words.
 *
 * The three English literals below are not new strings: they are the exact literals the extension
 * already ships (`l10n/bundle.l10n.zh-Hans.json` carries translations for all three, because the
 * desktop's connect dialog says them too). Reusing them means a Chinese phone reads the same
 * sentence the desktop shows, whether the token was typed, photographed or scanned — and the
 * pairing code does not get to invent a second vocabulary for "this token is too short".
 */
internal fun tokenIssueSentence(issue: TokenInput.Issue, l10n: L10n): String = when (issue) {
    TokenInput.Issue.EMPTY -> l10n.t("A room token is required.")
    TokenInput.Issue.TOO_SHORT ->
        l10n.t("The token is too short — use at least {0} characters.", TokenInput.MIN_TOKEN_CHARS.toString())
    TokenInput.Issue.TOO_FEW_DISTINCT ->
        l10n.t("The token is too easy to guess — use at least {0} different characters.", TokenInput.MIN_DISTINCT_CHARS.toString())
}
