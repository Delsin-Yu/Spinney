package dev.spinney.remote.core

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.ReaderException
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.nio.ByteBuffer

/**
 * `QrScan` — read the pairing payload out of an image of the desktop's code.
 *
 * WHY ZXING, AND WHY IT IS A DEPENDENCY OF THIS MODULE. A decoder is the one thing a phone cannot
 * do without here, and hand-rolling one would be a second, *untested* implementation of ISO/IEC
 * 18004 next to the encoder the desktop already has. zxing-core is pure Java — no Google Play
 * Services, no native library, no AAR — which is a hard requirement and not a preference: the test
 * phone is a Huawei device without Play Services, and `:core` is a plain Kotlin/JVM module that a
 * desktop JVM test runs. It also buys the property this file exists for: zxing is an *independent*
 * decoder, so `PairingTest` decoding the committed fixture is evidence that the desktop's own
 * encoder is correct rather than evidence that one implementation reads itself.
 *
 * NOTHING HERE MAY IMPORT `java.awt` OR `javax.imageio` — they do not exist on Android, and this is
 * the main source set of a module the app links against. The pixels arrive as an `IntArray` because
 * that is what `Bitmap.getPixels` hands over, and a camera frame is turned into the same array by
 * [grayPixels] below; the *test* may use `ImageIO` to load the committed PNG into that same array,
 * and that is the only place image decoding is allowed.
 *
 * WHY THESE THREE PIECES. `HybridBinarizer` is zxing's own recommendation for camera images: it
 * thresholds in local blocks, so a photograph whose screen is unevenly lit or has a bright window
 * on it still binarizes, where the global histogram binarizer gives up on one half of the frame.
 * `TRY_HARDER` is for the same reason — a photograph is skewed, softly focused and off-axis, and
 * the fast path's stricter grid assumptions would return "not found" for a code a person can see.
 *
 * WHY THE LADDER LIVES HERE. Both ways of pairing — the photo picker and the live camera — read the
 * same kind of image with the same decoder, so [decodeLadder] is the one place the scales are
 * decided. On an image *of a screen*, the kind of downscale decides whether the code reads at all;
 * the measurement behind the ladder is written out where the ladder is.
 */
object QrScan {

    /**
     * The payload in [pixels], or null when the photograph holds no QR code this decoder can read.
     *
     * [pixels] is one ARGB_8888 pixel per element, row-major, [width] × [height] of them — exactly
     * `Bitmap.getPixels(…)`'s layout, which is what `RGBLuminanceSource` expects. A shorter array
     * is a caller error and surfaces as zxing's own `IllegalArgumentException` rather than a silent
     * null: it means the caller guessed the geometry instead of reading it off the bitmap.
     *
     * The reader is built per call because `MultiFormatReader` is not thread-safe and holds state
     * between `decode` calls; the allocation is trivial next to one photograph.
     */
    fun decode(pixels: IntArray, width: Int, height: Int): String? {
        // A blank bitmap is not a "no code found" case: zxing would throw on the geometry, and the
        // caller is better served by the same answer it gives for a photo with no code in it.
        if (width <= 0 || height <= 0) return null
        val reader = MultiFormatReader()
        val hints = mapOf<DecodeHintType, Any>(
            // QR only, never the whole 1D/2D catalogue: the payload is a `spinney-pair:` string and
            // a barcode that happened to be in the photo must not be reported as an unknown prefix.
            DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
            DecodeHintType.TRY_HARDER to true,
        )
        return try {
            reader.decode(BinaryBitmap(HybridBinarizer(RGBLuminanceSource(width, height, pixels))), hints).text
        } catch (err: ReaderException) {
            // NotFound, Checksum or Format: one answer for all three, because every one of them
            // means "photograph the code again" and none of them means "this payload is damaged".
            null
        } finally {
            reader.reset()
        }
    }

    /**
     * The payload in [pixels], trying a ladder of scales — the single decode path the photo picker
     * and the live camera share.
     *
     * WHY A LADDER, AND WHY THE DOWNSCALES AVERAGE. Measured on the very photograph that asked for
     * this code (3072x4096, a monitor shot with the phone's camera, read with this zxing): an
     * **unfiltered** (nearest-neighbour) downsample finds the code at 1/4 and nowhere else, while an
     * **area-averaging** one finds it at 1/2, 1/4 and 1/8. The subject is why — a photograph of a
     * *screen* carries the screen's own pixel grid, and a nearest-neighbour read keeps that texture
     * at a size the binarizer reads as noise, where an average over a 2x2 box of pixels removes it.
     * Android's `inSampleSize` does not filter and `Bitmap.createScaledBitmap(…, filter = true)`
     * does, which is why this ladder averages the ARGB ints itself rather than asking a platform to
     * scale anything: `:core` is a plain JVM module, and a camera frame has no Bitmap in it anyway.
     *
     * 1/1 is tried first because a screenshot, or a code the frame is full of, decodes exactly as it
     * is; the ladder then halves twice, which is where the measurement says a photographed screen
     * lives. A step whose *smaller* side has fallen below [MIN_LADDER_SIDE] ends the ladder: there a
     * 41-module symbol cannot survive, so the later steps could only return the same null.
     */
    fun decodeLadder(pixels: IntArray, width: Int, height: Int): String? {
        if (width <= 0 || height <= 0) return null
        require(pixels.size >= width * height) {
            "pixels must hold width * height ARGB values: ${pixels.size} for ${width}x$height"
        }
        var level = pixels
        var w = width
        var h = height
        for (step in LADDER_STEPS.indices) {
            if (step > 0) {
                val halved = halveArea(level, w, h)
                level = halved.pixels
                w = halved.width
                h = halved.height
            }
            if (w < MIN_LADDER_SIDE || h < MIN_LADDER_SIDE) return null
            decode(level, w, h)?.let { return it }
        }
        return null
    }

    /**
     * [width] × [height] ARGB_8888 pixels out of a camera frame's luma (`Y`) plane.
     *
     * WHY THIS IS HERE AND NOT IN THE CAMERA SCREEN. Two facts about a `YUV_420_888` frame are easy
     * to get wrong and impossible to notice by looking at a preview: the rows are **padded**
     * (`rowStride` is a whole row and usually more than `width`), and a row's pixels can be spaced
     * (`pixelStride`, 1 for the luma plane on every device seen, 2 on a few). Reading such a plane
     * as tightly packed pixels shears the picture by the padding — a correct decode of a picture no
     * lens produced. Both facts are pure arithmetic over a byte buffer, so they live on this side of
     * the Android line where a JVM test can pin them, and the camera screen keeps only the part that
     * needs a device.
     *
     * [luma] is read at **absolute** index 0, which leaves its position untouched: an `ImageProxy`
     * plane is a view, and one more copy of a multi-megabyte plane per frame buys nothing. The three
     * channels get the same value because a QR reader's first act is to turn colour into luminance.
     */
    fun grayPixels(luma: ByteBuffer, width: Int, height: Int, rowStride: Int, pixelStride: Int): IntArray {
        require(width > 0 && height > 0) { "a frame is at least one pixel: ${width}x$height" }
        require(pixelStride >= 1 && rowStride >= width * pixelStride) {
            "a row holds at least width * pixelStride bytes: rowStride=$rowStride for ${width}x$height, pixelStride=$pixelStride"
        }
        val last = (height - 1) * rowStride + (width - 1) * pixelStride
        require(luma.limit() > last) {
            "the plane holds ${luma.limit()} bytes; a ${width}x$height frame with rowStride=$rowStride needs ${last + 1}"
        }
        val pixels = IntArray(width * height)
        var row = 0
        var index = 0
        for (y in 0 until height) {
            for (x in 0 until width) {
                val gray = luma.get(row + x * pixelStride).toInt() and 0xFF
                pixels[index++] = (0xFF shl 24) or (gray shl 16) or (gray shl 8) or gray
            }
            row += rowStride
        }
        return pixels
    }

    /** The scales of [decodeLadder], as divisors of the frame: 1/1, 1/2, 1/4. */
    private val LADDER_STEPS = intArrayOf(1, 2, 4)

    /**
     * The side below which a ladder step is not worth asking about: a version-6 symbol is 41 modules
     * across, so 128 px leaves about three pixels per module — the floor a reader needs, measured on
     * the fixture rather than guessed.
     */
    private const val MIN_LADDER_SIDE = 128

    /** One scale of the ladder: the pixels, and the geometry they are laid out in. */
    private class Level(val pixels: IntArray, val width: Int, val height: Int)

    /**
     * One 2x2 area average — the step every scale above 1/1 is built from.
     *
     * Averaged **per channel**, which is what `Bitmap.createScaledBitmap(filter = true)` does: the
     * decodes the ladder's measurement came from were with that filter, so this has to be the same
     * operation and not a luminance-weighted approximation of it. An odd side averages the last row
     * or column against itself, so a frame of any size halves without losing its edge pixels.
     */
    private fun halveArea(pixels: IntArray, width: Int, height: Int): Level {
        val w = maxOf(1, width / 2)
        val h = maxOf(1, height / 2)
        val out = IntArray(w * h)
        for (y in 0 until h) {
            val top = y * 2 * width
            val bottom = minOf(y * 2 + 1, height - 1) * width
            val outRow = y * w
            for (x in 0 until w) {
                val left = minOf(x * 2, width - 1)
                val right = minOf(x * 2 + 1, width - 1)
                val tl = pixels[top + left]
                val tr = pixels[top + right]
                val bl = pixels[bottom + left]
                val br = pixels[bottom + right]
                val r = (((tl shr 16) and 0xFF) + ((tr shr 16) and 0xFF) + ((bl shr 16) and 0xFF) + ((br shr 16) and 0xFF)) / 4
                val g = (((tl shr 8) and 0xFF) + ((tr shr 8) and 0xFF) + ((bl shr 8) and 0xFF) + ((br shr 8) and 0xFF)) / 4
                val b = ((tl and 0xFF) + (tr and 0xFF) + (bl and 0xFF) + (br and 0xFF)) / 4
                out[outRow + x] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
            }
        }
        return Level(out, w, h)
    }
}
