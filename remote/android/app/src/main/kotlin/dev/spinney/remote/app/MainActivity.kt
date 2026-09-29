package dev.spinney.remote.app

import android.app.Application
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.spinney.remote.core.RemoteClient
import dev.spinney.remote.core.TokenInput
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Milestone M3: the Android remote controller.
 *
 * A phone joins the same room as a Spinney window and gets the same two surfaces the desktop
 * replica has — a foldable room tree (room → device → instance → session) and a replicated
 * session view — plus the actions of the frozen contract. The token grants full control,
 * including creating sessions; that is accepted and decided (`docs/agents/plans/remote-control.md`
 * §1), so there is deliberately no read-only tier, no approval step and no reminder here.
 *
 * The architecture in one line each:
 * - the replicated session view is the repo's **own** `media/main.js` in a WebView
 *   ([SessionWebView]), so there is one renderer, not two;
 * - the room tree is native Compose ([RoomTreeScreen]) over `:core`'s `RoomModel`, a pure fold
 *   over the sealed frames of `remote/PROTOCOL.md` §5;
 * - the crypto and the wire live in the pure Kotlin/JVM `:core` module, which is unit-tested
 *   against `remote/vectors/vectors.json` — that test is what proves the Kotlin implementation
 *   derives and seals the same bytes as the TypeScript host.
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    SpinneyRemoteApp(application)
                }
            }
        }
    }
}

/** The three screens. There is no back stack library: this app has three states. */
private sealed interface Screen {
    data object Setup : Screen
    data object Room : Screen
    data class Session(val id: String, val title: String) : Screen
}

@Composable
private fun SpinneyRemoteApp(app: Application) {
    val controller = remember { RemoteController(app) }
    val state by controller.state.collectAsState()
    val room by controller.room.collectAsState()
    var screen by remember { mutableStateOf<Screen>(Screen.Setup) }

    DisposableEffect(controller) {
        onDispose { controller.shutdown() }
    }

    // A live connection is the room screen; losing it returns to setup, which is also where the
    // failure is explained. Keyed on the state rather than on `controller.client`, so a
    // reconnect (a new peerId, a new salt) is not a screen change.
    LaunchedEffect(state, controller.client) {
        if (controller.client == null) {
            if (screen != Screen.Setup) screen = Screen.Setup
        } else if (screen == Screen.Setup) {
            screen = Screen.Room
        }
    }

    when (val current = screen) {
        Screen.Setup -> ConnectScreen(controller, state)

        Screen.Room -> RoomTreeScreen(
            room = room,
            state = state,
            l10n = controller.l10n,
            onOpenSession = { sessionId, title -> screen = Screen.Session(sessionId, title) },
            onResync = { controller.requestResync() },
            onDisconnect = { controller.disconnect() },
        )

        is Screen.Session -> {
            val client = controller.client
            if (client == null) {
                ConnectScreen(controller, state)
            } else {
                SessionScreen(
                    client = client,
                    sessionId = current.id,
                    title = current.title,
                    l10n = controller.l10n,
                    onBack = { screen = Screen.Room },
                )
            }
        }
    }
}

@Composable
private fun ConnectScreen(controller: RemoteController, state: RemoteClient.ConnectionState) {
    val l10n = controller.l10n
    var rooms by remember { mutableStateOf(controller.rooms) }
    var name by remember { mutableStateOf(rooms.firstOrNull()?.name ?: "home") }
    var relayUrl by remember { mutableStateOf(rooms.firstOrNull()?.relayUrl ?: "http://") }
    var token by remember { mutableStateOf("") }

    // A masked field plus no fingerprint is how a token that routes somewhere else stayed silent
    // (`docs/agents/plans/remote-control.md` §11: a wrong token is an empty room, not an error), so
    // the token can be revealed, and the room it would route to is shown underneath.
    var revealed by remember { mutableStateOf(false) }
    val fingerprint by controller.fingerprint.collectAsState()
    val storedFingerprints by controller.storedFingerprints.collectAsState()
    var refusedIssue by remember { mutableStateOf<TokenInput.Issue?>(null) }
    // One sentence about the last code — scanned or photographed — shown where the form's own errors
    // are and cleared the moment the user edits anything: a pairing that failed must not sit under a
    // form that now reads like a paired one.
    var pairingError by remember { mutableStateOf<String?>(null) }
    // The camera screen replaces the form while it is open: it is a full-screen preview, and the
    // form behind it has nothing to show until the scan ends.
    var scanning by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    // The platform field lives outside composition, so it is remembered once and told about the
    // state on every pass (see the `update` below). Its `onText` is re-pointed each time so it
    // always writes into the current state.
    val context = LocalContext.current
    val fieldTextColor = MaterialTheme.colorScheme.onSurface.toArgb()
    // The Activity context, not the application one: a widget that lives in this window's hierarchy
    // should resolve its theme against the window it is in (the manifest's application theme is what
    // it inherits today, and this keeps that true if a screen theme is ever added).
    val tokenField = remember(context) { TokenField(context, fieldTextColor) }
    tokenField.onText = { typed ->
        token = typed
        refusedIssue = null
        pairingError = null
        controller.previewToken(typed)
    }

    // One payload, two ways in, and one place where it becomes a room: the camera hands over the
    // string zxing read out of a live frame, the picker hands over a photo the same decoder reads,
    // and from here both fill the three fields and take the ordinary `connect` — so a paired room is
    // normalised, stored and derived exactly like a typed one, and there is no second way in.
    fun applyPairing(pairing: PhotoPairing) {
        when (pairing) {
            is PhotoPairing.Failed -> pairingError = pairing.message
            is PhotoPairing.Paired -> {
                pairingError = null
                // The values are used exactly as the payload carried them (only the token is
                // normalised, and that is `TokenInput`'s rule): the room name is the desktop's own
                // label for the room, and trimming it here would name the room something the other
                // device does not. A relay with whitespace in it never gets this far — `Pairing`
                // refuses a URL that is not one.
                name = pairing.room
                relayUrl = pairing.relay
                token = pairing.token
                controller.previewToken(pairing.token)
                val issue = controller.connect(pairing.room, pairing.relay, pairing.token)
                refusedIssue = issue
                rooms = controller.rooms
                if (issue == null) controller.refreshStoredFingerprints()
            }
        }
    }

    // Pairing from a photo: the desktop's code photographed with the phone's own camera app and
    // handed back by the picker. It is the same contract `SessionScreen`'s `pickImage` uses, so no
    // permission is involved at all — the picture comes from outside the app.
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        // Decoding a gallery-sized bitmap and reading a QR out of it is main-thread death.
        scope.launch { applyPairing(withContext(Dispatchers.IO) { pairFromPhoto(context, uri, l10n) }) }
    }

    val normalizedToken = TokenInput.normalize(token)
    val liveIssue = TokenInput.issue(normalizedToken)
    // An untouched empty field is not an error worth shouting about; a weak one is.
    val shownIssue = refusedIssue ?: liveIssue?.takeIf { it != TokenInput.Issue.EMPTY }

    LaunchedEffect(Unit) { controller.refreshStoredFingerprints() }

    // The camera is a screen, not a dialog: the preview *is* the gesture, and the form, the room
    // list and the status line have nothing to show while it is open. The screen stops the camera
    // itself as soon as a frame decodes, and hands back the one payload.
    if (scanning) {
        CameraScanScreen(
            l10n = l10n,
            onPayload = { payload -> scanning = false; applyPairing(pairingFromPayload(payload, l10n)) },
            onCancel = { scanning = false },
        )
        return
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(l10n.t("Spinney Remote"), style = MaterialTheme.typography.headlineSmall)
        Text(
            text = l10n.t(
                "One token is one room. The token grants full control of every window in the room, " +
                    "including creating sessions — the same trust the desktop replica has.",
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        OutlinedTextField(
            value = name,
            onValueChange = {
                name = it
                pairingError = null
            },
            label = { Text(l10n.t("Room name (a local label, never sent)")) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = relayUrl,
            onValueChange = {
                relayUrl = it
                pairingError = null
            },
            label = { Text(l10n.t("Relay URL")) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        // The token field is a platform `EditText` in an `AndroidView`, not a Compose field: the two
        // flags that actually stop an IME from "helping" — TYPE_TEXT_FLAG_NO_SUGGESTIONS and
        // IME_FLAG_NO_PERSONALIZED_LEARNING — have no Compose KeyboardOptions parameter, and the
        // measured Compose field (inputType=0x81, imeOptions=0x2000006) left both unset. The label,
        // the border, the eye and the fingerprint line below are the same as before; only the widget
        // underneath changed. See `TokenField` for what exactly is set and why.
        Text(
            text = l10n.t("Token"),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(4.dp))
                .padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AndroidView(
                factory = { tokenField.view },
                modifier = Modifier.weight(1f),
                // Pitfalls 1 and 2 in one place: the view follows the state, and the state follows
                // the view. Neither can loop, because each side only writes when it differs.
                update = { _ ->
                    tokenField.setTextIfDifferent(token)
                    tokenField.setRevealed(revealed)
                },
            )
            IconButton(
                onClick = { revealed = !revealed },
                modifier = Modifier.semantics { contentDescription = l10n.t("Show or hide the token") },
            ) {
                Text(if (revealed) "🙈" else "👁")
            }
        }

        // The signal that was missing: which room this exact input routes to, as a fingerprint two
        // devices can compare *before* saving anything. The full id is shown in the room screen.
        fingerprint?.let { prefix ->
            Text(
                text = l10n.t("Room · {0}…", prefix),
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        shownIssue?.let { issue ->
            Text(
                text = tokenIssueSentence(issue, l10n),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        // A failed pairing reads exactly where a refused token does: both are one sentence about
        // why the form above is not connected, and both are cleared as soon as the user edits it.
        pairingError?.let { message ->
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        Button(
            onClick = {
                // The derivation is the 600000-iteration PBKDF2 of §3 and it runs on the
                // connection's own thread, so this call returns immediately.
                val issue = controller.connect(name.trim(), relayUrl.trim(), token)
                refusedIssue = issue
                rooms = controller.rooms
                if (issue == null) controller.refreshStoredFingerprints()
            },
            // A weak token is refused *here*, with a sentence, rather than becoming an empty room on
            // the other side of the world: the rules are the desktop's own.
            enabled = name.isNotBlank() && relayUrl.isNotBlank() && liveIssue == null,
        ) {
            Text(l10n.t("Connect"))
        }

        // The first way in, and the one that removes the failure this feature exists for: the desktop
        // shows the room's code, the phone is pointed at that screen, and the payload fills the three
        // fields above and connects — a mistyped token is a different room, and nothing is mistyped
        // here. This is the primary action because it is the plain gesture; the picker below stays
        // for the camera a phone will not give us (see `PairingFromPhoto.kt`).
        Button(onClick = { scanning = true }) {
            Text(l10n.t("Scan the code with the camera"))
        }

        // The second way in, and the one that cannot be refused: the same code, photographed with
        // the phone's own camera app and picked through the system photo picker the app already
        // opens for attachments. No permission is involved — the picture comes from outside the app.
        OutlinedButton(
            onClick = {
                photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            },
        ) {
            Text(l10n.t("or from a photo"))
        }

        StatusLine(state, l10n)

        if (rooms.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            Text(l10n.t("Rooms on this phone"), style = MaterialTheme.typography.titleSmall)
            for (room in rooms) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(room.name, style = MaterialTheme.typography.bodyMedium)
                        Text(
                            room.relayUrl,
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        // The same fingerprint as the field above, so a room that was saved earlier
                        // can be checked against the desktop at any time.
                        storedFingerprints[room.name]?.let { prefix ->
                            Text(
                                text = l10n.t("Room · {0}…", prefix),
                                style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    TextButton(onClick = {
                        name = room.name
                        relayUrl = room.relayUrl
                        token = controller.store.token(room.name) ?: ""
                        refusedIssue = null
                        controller.previewToken(token)
                    }) { Text(l10n.t("Use")) }
                    TextButton(onClick = {
                        controller.forgetRoom(room.name)
                        rooms = controller.rooms
                    }) { Text(l10n.t("Forget")) }
                }
            }
        }

        Spacer(Modifier.height(8.dp))
        Text(
            text = l10n.t(
                "The token is stored in EncryptedSharedPreferences (an AES-256-GCM key in the " +
                    "Android Keystore) and is never written to a log.",
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = controller.describe(),
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.width(4.dp))
    }
}

@Composable
private fun StatusLine(state: RemoteClient.ConnectionState, l10n: L10n) {    val text = when (state) {
        is RemoteClient.ConnectionState.Idle -> null
        is RemoteClient.ConnectionState.Connecting -> l10n.t("Connecting to room {0}…", state.roomId)
        is RemoteClient.ConnectionState.Connected ->
            l10n.t("Connected as {0} · {1} peer(s)", state.peerId, state.peers.toString())
        is RemoteClient.ConnectionState.Reconnecting ->
            l10n.t("Reconnecting in {0} s ({1})", "%.1f".format(state.delayMs / 1000.0), state.reason)
        is RemoteClient.ConnectionState.Failed -> l10n.t("Failed: {0}", state.reason)
    } ?: return
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
}
