package dev.spinney.remote.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Size
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.lifecycle.awaitInstance
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.spinney.remote.core.QrScan
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The live camera: point the phone at the desktop's screen and the room is paired.
 *
 * WHY A CAMERA FEED AND NOT ONLY THE PHOTO PICKER. Photographing the desktop with another app and
 * picking the photo out of the gallery works, but it is three applications deep for one gesture,
 * and the plainer gesture — point the phone at the code — is what people try first. This is that
 * gesture, and it is the *primary* action on the connect screen; the picker stays underneath it as
 * "or from a photo", because a denied camera permission or a code that is already a picture must
 * still have a way in.
 *
 * WHY THE CAMERA STOPS ON THE FIRST DECODE. Once a payload is in hand the frames have no reader
 * left, so continuing would keep the camera (and its privacy indicator) on behind a screen that
 * says the pairing succeeded, while the connect derives a key. The use cases are unbound *before*
 * the payload is handed over, so the camera is already off when the next screen composes.
 *
 * WHAT IS NOT HERE. The payload is not parsed and no token is judged — [pairingFromPayload] does
 * that and it is the same code the photo path runs, so a scanned code and a photographed code
 * cannot be judged two different ways. This screen's whole job is: a preview, a luma frame, the
 * shared decoder, one payload.
 */
@Composable
internal fun CameraScanScreen(
    l10n: L10n,
    onPayload: (String) -> Unit,
    onCancel: () -> Unit,
) {
    val context = LocalContext.current
    var granted by remember { mutableStateOf(context.hasCameraPermission()) }
    var asked by remember { mutableStateOf(false) }
    val requestPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok
        asked = true
    }

    // Asked for as soon as the screen opens, because the permission is the cost of the one gesture
    // this screen exists for and a button in front of it would be a second step for the same
    // decision. A refusal is a sentence and a way back rather than a dead end: the connect screen
    // still has the photo picker, which needs no permission at all (the manifest asks for `CAMERA`
    // and knows nothing else — no storage, no location).
    LaunchedEffect(Unit) {
        if (!granted) requestPermission.launch(Manifest.permission.CAMERA)
    }

    // Back leaves the scan exactly as Cancel does. Without this the system back gesture would finish
    // the activity from the middle of the pairing gesture, which the user would read as "the app
    // closed" rather than "the scan was cancelled" — and the form they had typed would be gone.
    BackHandler(enabled = true) { onCancel() }

    if (!granted) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(l10n.t("Scan the code with the camera"), style = MaterialTheme.typography.titleMedium)
            Text(
                text = if (asked) {
                    l10n.t("The camera was not allowed, so the code cannot be scanned. A photo of the code still works.")
                } else {
                    l10n.t("To scan the room code, this app needs the camera.")
                },
                style = MaterialTheme.typography.bodyMedium,
            )
            Button(onClick = { requestPermission.launch(Manifest.permission.CAMERA) }) {
                Text(l10n.t("Allow the camera"))
            }
            OutlinedButton(onClick = onCancel) { Text(l10n.t("Cancel")) }
        }
        return
    }

    CameraViewfinder(l10n, onPayload, onCancel)
}

/** The preview, the analysis and the one payload — the part of the screen that needs a device. */
@Composable
private fun CameraViewfinder(l10n: L10n, onPayload: (String) -> Unit, onCancel: () -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val mainExecutor = remember(context) { ContextCompat.getMainExecutor(context) }
    // One frame at a time, and never a queue of them: a frame that arrived while the previous one
    // was still being decoded is stale by definition — the phone has moved — so decoding a backlog
    // would delay the live frames behind it and find nothing in the old ones.
    val analyzerExecutor = remember { Executors.newSingleThreadExecutor() }
    val previewView = remember { PreviewView(context) }
    // The first payload wins. Two frames can be in the analyzer's queue at any moment, and both
    // can hold the same code; without this the form would be filled twice and two connects would
    // race for one room.
    val delivered = remember { AtomicBoolean(false) }
    val provider = remember { mutableStateOf<ProcessCameraProvider?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }

    DisposableEffect(Unit) {
        onDispose {
            // Leaving the screen — cancel, back, or the connect that follows a payload — must not
            // leave a camera the user cannot see. The bind is to this lifecycle owner, so a
            // backgrounded activity stops it too; this covers the screen going away while the
            // activity stays.
            provider.value?.unbindAll()
            analyzerExecutor.shutdown()
        }
    }

    LaunchedEffect(lifecycleOwner) {
        try {
            val cameraProvider = ProcessCameraProvider.awaitInstance(context)
            provider.value = cameraProvider

            val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
            val analysis = ImageAnalysis.Builder()
                // The frame's pixel count is the ladder's allocation: at 1/1 the ARGB ints of a
                // 1280x720 frame are 3.7 MB where a phone's default 1080p analysis frame would be
                // 8.3 MB, for pixels no step of the ladder can use. 720p still leaves roughly ten
                // pixels per module when a 41-module symbol fills a third of the frame, three times
                // what a reader needs.
                .setResolutionSelector(
                    ResolutionSelector.Builder()
                        .setResolutionStrategy(
                            ResolutionStrategy(
                                Size(1280, 720),
                                ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                            ),
                        )
                        .build(),
                )
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()

            analysis.setAnalyzer(analyzerExecutor) { proxy ->
                val payload = try {
                    if (delivered.get()) {
                        // A frame that arrives after the payload is not decoded at all: this screen
                        // is about to disappear, and a second payload could only race the first into
                        // the form.
                        null
                    } else {
                        proxy.planes.firstOrNull()?.let { plane ->
                            // The luma plane is all a QR reader needs, and building one IntArray of
                            // it per frame costs far less than a Bitmap would — see
                            // `QrScan.grayPixels` for why the plane's strides are passed rather than
                            // assumed.
                            val pixels = QrScan.grayPixels(
                                plane.buffer,
                                proxy.width,
                                proxy.height,
                                plane.rowStride,
                                plane.pixelStride,
                            )
                            QrScan.decodeLadder(pixels, proxy.width, proxy.height)
                        }
                    }
                } catch (err: IllegalArgumentException) {
                    // A frame whose geometry does not match its buffer is a stream this app cannot
                    // read: one sentence (the same one the photo path says for an unreadable image),
                    // not an exception on the analyzer thread for every frame.
                    mainExecutor.execute { failure = l10n.t("That image could not be read.") }
                    null
                } finally {
                    // CameraX hands each frame over, and every path out of here must close it: a
                    // proxy left open stalls the analysis pipeline for good.
                    proxy.close()
                }

                if (payload != null && delivered.compareAndSet(false, true)) {
                    // Unbind *before* the payload becomes a room, so the camera is off when the
                    // connect screen composes. The rebind is the user's next scan, not this one.
                    mainExecutor.execute {
                        analysis.clearAnalyzer()
                        provider.value?.unbindAll()
                        onPayload(payload)
                    }
                }
            }

            // Bound after the analyzer is set, and unbound first: a second visit to this screen
            // must not find the previous bind, which `bindToLifecycle` would reject.
            cameraProvider.unbindAll()
            cameraProvider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        } catch (err: Exception) {
            // No camera, or one another app holds: the screen says so instead of showing a black
            // rectangle, and the connect screen's photo path is still the way to pair.
            failure = l10n.t("The camera could not be started.")
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
        Text(
            text = l10n.t("Point the phone at the code on the desktop's screen."),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .padding(24.dp),
        )
        failure?.let { message ->
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier
                    .align(Alignment.Center)
                    .padding(24.dp),
            )
        }
        OutlinedButton(
            onClick = onCancel,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(24.dp),
        ) {
            Text(l10n.t("Cancel"))
        }
    }
}

/** The manifest declares `CAMERA`; this is the runtime half of it. */
private fun Context.hasCameraPermission(): Boolean =
    ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
