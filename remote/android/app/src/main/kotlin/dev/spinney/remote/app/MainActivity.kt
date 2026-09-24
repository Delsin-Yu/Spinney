package dev.spinney.remote.app

import android.app.Application
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
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
        controller.previewToken(typed)
    }

    val normalizedToken = TokenInput.normalize(token)
    val liveIssue = TokenInput.issue(normalizedToken)
    // An untouched empty field is not an error worth shouting about; a weak one is.
    val shownIssue = refusedIssue ?: liveIssue?.takeIf { it != TokenInput.Issue.EMPTY }

    LaunchedEffect(Unit) { controller.refreshStoredFingerprints() }

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
            onValueChange = { name = it },
            label = { Text(l10n.t("Room name (a local label, never sent)")) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = relayUrl,
            onValueChange = { relayUrl = it },
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

/**
 * One sentence per refusal, in the desktop's own words.
 *
 * The three English literals below are **not new strings**: they are the exact literals the
 * extension already ships (`l10n/bundle.l10n.zh-Hans.json` carries translations for all three,
 * because the desktop's connect dialog says them too). Reusing them means a Chinese phone reads the
 * same sentence the desktop shows, and it keeps this fix from adding a catalog entry — which the
 * l10n guard would then treat as stale, because its English literal appears nowhere in `src/` or
 * `media/`. Only the fingerprint line and the reveal toggle's label are new, and they live in
 * Kotlin, where [L10n] falls back to the English literal.
 */
@Composable
private fun tokenIssueSentence(issue: TokenInput.Issue, l10n: L10n): String = when (issue) {
    TokenInput.Issue.EMPTY -> l10n.t("A room token is required.")
    TokenInput.Issue.TOO_SHORT ->
        l10n.t("The token is too short — use at least {0} characters.", TokenInput.MIN_TOKEN_CHARS.toString())
    TokenInput.Issue.TOO_FEW_DISTINCT ->
        l10n.t("The token is too easy to guess — use at least {0} different characters.", TokenInput.MIN_DISTINCT_CHARS.toString())
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
