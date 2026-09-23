package dev.spinney.remote.app

import android.app.Application
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.input.PasswordVisualTransformation
import dev.spinney.remote.core.RemoteClient

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
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text(l10n.t("Token")) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )

        Button(
            onClick = {
                // The derivation is the 600000-iteration PBKDF2 of §3 and it runs on the
                // connection's own thread, so this call returns immediately.
                controller.connect(name.trim(), relayUrl.trim(), token)
                rooms = controller.rooms
            },
            enabled = name.isNotBlank() && relayUrl.isNotBlank() && token.isNotEmpty(),
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
                    }
                    TextButton(onClick = {
                        name = room.name
                        relayUrl = room.relayUrl
                        token = controller.store.token(room.name) ?: ""
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
private fun StatusLine(state: RemoteClient.ConnectionState, l10n: L10n) {
    val text = when (state) {
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
