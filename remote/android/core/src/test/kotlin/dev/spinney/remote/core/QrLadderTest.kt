package dev.spinney.remote.core

import java.awt.image.BufferedImage
import java.nio.ByteBuffer
import javax.imageio.ImageIO
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test

/**
 * `QrScan.decodeLadder` and `QrScan.grayPixels`: the two pieces the photo picker and the live camera
 * share, tested where they cannot be tested on a device.
 *
 * The first test is the regression this file exists for, and it is a **measurement rather than an
 * illustration**: a synthetic photograph of a screen — the committed fixture scaled up
 * nearest-neighbour, then covered with the screen's own pixel grid — on which a nearest-neighbour
 * downsample cannot find the code while `decodeLadder`'s area-averaging one can. That asymmetry is
 * what the real photograph showed (see the ladder's comment for the numbers), and the test fails if
 * the ladder ever loses its averaging, or gains an unfiltered step.
 *
 * The other two cover the camera's other new piece of arithmetic: a `YUV_420_888` luma plane is
 * padded and spaced, and reading it as a tightly packed byte array shears the picture by the padding
 * — a defect no preview can show and no emulator in this repo can catch.
 */
class QrLadderTest {

    /** Shared vector 1's payload literal — the same string `tools/check-remote.js` §9 asserts. */
    private val payload =
        "spinney-pair:1?relay=https%3A%2F%2Frelay.example.com%3A8787&room=home%20%2B%20lab&token=a%20b%2Bc%2Fd%3F"

    /**
     * THE REGRESSION. Measured on the real photograph that asked for the ladder: an unfiltered
     * downscale of a screen decodes the code at one scale and nowhere else, while an area-averaging
     * one decodes it at every scale it tried. The reason is the subject — a photograph of a screen
     * carries the screen's pixel grid, and a nearest-neighbour read keeps that grid at a size the
     * binarizer reads as noise — and it is a bug the code had: a single unfiltered scale is a coin
     * flip on this kind of image. `decodeLadder` averages, and this test is what stops that from
     * being undone by a later "simplification".
     */
    @Test
    @DisplayName("a photographed screen: an unfiltered downscale finds nothing, the averaging ladder finds the code")
    fun theAveragingIsWhatReadsAPhotographedScreen() {
        val photo = screenPhotograph(fixture(), scale = 4, gridPeriod = 3, gridDepth = 30)

        // The controls, and they are the bug: nearest-neighbour sampling keeps the screen's grid, so
        // the symbol is not in the pixels to be found. All three reads are asserted — the full-size
        // one and both halvings, because the real photograph has the code unreadable in an unfiltered
        // read wherever it looked, and because the full-size read is the ladder's *own* first step:
        // with it null, the success below can only have come from the averaging underneath it.
        for (divisor in intArrayOf(1, 2, 4)) {
            val nearest = nearestNeighbour(photo.pixels, photo.width, photo.height, divisor)
            val found = QrScan.decode(nearest, photo.width / divisor, photo.height / divisor)
            assertNull(
                found,
                "an unfiltered 1/$divisor read of a photographed screen must not decode — that is the measured bug, and finding " +
                    "\"$found\" here means this synthetic photograph no longer reproduces it",
            )
        }

        // The remedy. On this image the ladder's 1/1 and 1/2 steps find nothing either (the grid is
        // finer than a module there); the 1/4 step is where the averaging has smoothed the grid away
        // and the symbol is readable — the same scale relationship the real photograph showed.
        assertEquals(
            payload,
            QrScan.decodeLadder(photo.pixels, photo.width, photo.height),
            "the averaging ladder must read what no unfiltered downscale can",
        )
    }

    @Test
    @DisplayName("a luma plane is read with its row padding and its pixel spacing, never as tightly packed bytes")
    fun theLumaPlaneGeometryIsHonoured() {
        // A 2x2 frame: two bytes per pixel (pixelStride 2), rows of five bytes (rowStride 5), with
        // sentinel values in every byte that is *not* a pixel. Read as a packed array this frame is
        // 10 greys wide and every "pixel" after the first row's first one is off by the padding.
        val plane = ByteBuffer.wrap(byteArrayOf(10, 99, 20, 99, 55, 30, 99, 40, 99, 77))

        val pixels = QrScan.grayPixels(plane, width = 2, height = 2, rowStride = 5, pixelStride = 2)

        assertEquals(listOf(10, 20, 30, 40), pixels.map { it and 0xFF }, "the four luma samples, and none of the sentinels")
        // Opaque, and the same value in all three channels: zxing's luminance source reads the
        // packed ARGB int, and a camera's one-channel grey has to arrive as one.
        assertEquals(0xFF000000.toInt() or (10 shl 16) or (10 shl 8) or 10, pixels[0])
    }

    @Test
    @DisplayName("a camera-shaped luma plane of the fixture decodes to shared vector 1, through the same ladder")
    fun aCameraShapedPlaneDecodesTheSamePayload() {
        val image = fixture()
        // The whole camera path minus the device: a plane with padding and a pixel stride, the ints
        // the analyzer would hand over, and the ladder both ways in share. Both oddities are load
        // bearing — a packed read of this plane decodes nothing, because it shears the symbol.
        val rowStride = image.width * 2 + 7
        val plane = ByteBuffer.allocate(rowStride * image.height)
        for (y in 0 until image.height) {
            for (x in 0 until image.width) {
                // The green channel, because the fixture is pure black and white — a real frame's Y
                // plane carries the luminance itself, and this test is about the geometry, not the
                // colour maths.
                plane.put(y * rowStride + x * 2, ((image.pixels[y * image.width + x] shr 8) and 0xFF).toByte())
            }
        }

        val pixels = QrScan.grayPixels(plane, image.width, image.height, rowStride, 2)

        assertEquals(payload, QrScan.decodeLadder(pixels, image.width, image.height))
    }

    /**
     * The committed fixture, decoded with `ImageIO` — allowed in a test and nowhere else (`java.awt`
     * does not exist on Android, which is why the module's own source set may not touch it).
     */
    private fun fixture(): Picture {
        val image: BufferedImage = javaClass.getResourceAsStream("/pairing-fixture.png")?.use { ImageIO.read(it) }
            ?: throw AssertionError("pairing-fixture.png must be on the test classpath as a readable PNG")
        val pixels = IntArray(image.width * image.height)
        image.getRGB(0, 0, image.width, image.height, pixels, 0, image.width)
        return Picture(pixels, image.width, image.height)
    }

    /**
     * A photograph of a screen, built from [source]: [scale]-fold nearest-neighbour enlargement, then
     * a grid over it — every [gridPeriod]-th column and row made [gridDepth] darker.
     *
     * The grid is the subject of this file. A photograph of a screen is not a picture of a code: it
     * is a picture of a code *and* of the screen's own pixel grid, and what a downscale does to that
     * grid decides whether the code exists in the result at all.
     *
     * The parameters are measured, not chosen. With period 3 and depth 30 the two unfiltered reads
     * find nothing and the ladder finds the code at its 1/4 step, with room either side (at depth 20
     * the ladder reads it at 1/2, at 40 at 1/4, at 10 the unfiltered reads succeed, at 60 nothing
     * reads it) — the same shape of curve the real photograph produced, from depth 10 to 60. A grid
     * whose period divides the read's stride — the obvious "alternate the rows and columns" of period
     * 2 — does *not* reproduce it: every sampled pixel then has the same phase and the grid cancels
     * itself, which is why a synthetic image has to be measured before it is asserted on.
     */
    private fun screenPhotograph(source: Picture, scale: Int, gridPeriod: Int, gridDepth: Int): Picture {
        val width = source.width * scale
        val height = source.height * scale
        val pixels = IntArray(width * height)
        for (y in 0 until height) {
            for (x in 0 until width) {
                val argb = source.pixels[(y / scale) * source.width + (x / scale)]
                val shift = if (x % gridPeriod == 0) -gridDepth else 0
                val shiftRows = if (y % gridPeriod == 0) -gridDepth else 0
                val darken = shift + shiftRows
                if (darken == 0) {
                    pixels[y * width + x] = argb
                } else {
                    val r = clamp(((argb shr 16) and 0xFF) + darken)
                    val g = clamp(((argb shr 8) and 0xFF) + darken)
                    val b = clamp((argb and 0xFF) + darken)
                    pixels[y * width + x] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
                }
            }
        }
        return Picture(pixels, width, height)
    }

    /**
     * The read the measurement is about: one sampled pixel per [divisor]-wide block and no averaging
     * of any kind — what Android's `inSampleSize` does to a bitmap, and what a caller who reaches for
     * "just scale it down" gets.
     */
    private fun nearestNeighbour(pixels: IntArray, width: Int, height: Int, divisor: Int): IntArray {
        val w = maxOf(1, width / divisor)
        val h = maxOf(1, height / divisor)
        val out = IntArray(w * h)
        for (y in 0 until h) {
            for (x in 0 until w) {
                out[y * w + x] = pixels[minOf(height - 1, y * divisor) * width + minOf(width - 1, x * divisor)]
            }
        }
        return out
    }

    private fun clamp(value: Int): Int = value.coerceIn(0, 255)

    /** Pixels and the geometry they are laid out in — what both paths hand to `QrScan`. */
    private class Picture(val pixels: IntArray, val width: Int, val height: Int)
}
