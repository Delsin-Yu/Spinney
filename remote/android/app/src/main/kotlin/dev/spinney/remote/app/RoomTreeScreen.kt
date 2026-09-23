package dev.spinney.remote.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.spinney.remote.core.RoomModel
import dev.spinney.remote.core.RemoteClient

/**
 * The room tree: **native Compose, not a WebView.**
 *
 * Why native, in one line: the tree here is a small list — room → device → instance → session —
 * and the desktop's own room tree (`media/remote.js`, view type `spinney.remoteTree`) is an M2
 * artifact that does not exist yet and is not this milestone's to copy. The **session view** is
 * the part that must be the shipped renderer (§5: one renderer, three places), and it is one:
 * `SessionWebView` loads the copied `media/main.js`. A second native list would be a second
 * renderer for a list that has no pixels in common with the chat tree; a second native *chat*
 * view would have been the mistake.
 *
 * The model is `RoomModel` from `:core` — a pure fold over the sealed frames of §5 — so what is
 * drawn here is unit-tested against synthetic `hello`/`instances` frames without an emulator.
 */
@Composable
fun RoomTreeScreen(
    room: RemoteClient.RoomSnapshot,
    state: RemoteClient.ConnectionState,
    l10n: L10n,
    onOpenSession: (sessionId: String, title: String) -> Unit,
    onResync: () -> Unit,
    onDisconnect: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        ConnectionHeader(room, state, l10n, onResync, onDisconnect)

        if (room.devices.isEmpty()) {
            Column(Modifier.padding(24.dp)) {
                Text(
                    text = l10n.t("No window in this room has published a session yet."),
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    text = l10n.t("A room is empty when a token is wrong: a wrong token is not an error, it is an empty room."),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            return@Column
        }

        LazyColumn(Modifier.fillMaxWidth()) {
            items(room.devices, key = { it.deviceId }) { device ->
                DeviceRow(device, l10n, onOpenSession)
            }
        }
    }
}

@Composable
private fun ConnectionHeader(
    room: RemoteClient.RoomSnapshot,
    state: RemoteClient.ConnectionState,
    l10n: L10n,
    onResync: () -> Unit,
    onDisconnect: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusDot(busy = state is RemoteClient.ConnectionState.Connected)
            Spacer(Modifier.width(8.dp))
            Text(
                text = when (state) {
                    is RemoteClient.ConnectionState.Connected ->
                        l10n.t("Connected as {0} · {1} peer(s) in the room", state.peerId, state.peers.toString())
                    is RemoteClient.ConnectionState.Connecting -> l10n.t("Connecting…")
                    is RemoteClient.ConnectionState.Reconnecting ->
                        l10n.t("Reconnecting in {0} s ({1})", "%.1f".format(state.delayMs / 1000.0), state.reason)
                    is RemoteClient.ConnectionState.Failed -> l10n.t("Failed: {0}", state.reason)
                    RemoteClient.ConnectionState.Idle -> l10n.t("Not connected")
                },
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
        }
        Spacer(Modifier.height(4.dp))
        Text(
            text = l10n.t("Room {0}", room.roomId.ifEmpty { "—" }),
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onResync) { Text(l10n.t("Resync")) }
            OutlinedButton(onClick = onDisconnect) { Text(l10n.t("Disconnect")) }
        }
    }
}

@Composable
private fun StatusDot(busy: Boolean) {
    Spacer(
        Modifier
            .size(10.dp)
            .background(if (busy) Color(0xFF2E7D32) else Color(0xFF9E9E9E), CircleShape),
    )
}

@Composable
private fun DeviceRow(
    device: RoomModel.Device,
    l10n: L10n,
    onOpenSession: (String, String) -> Unit,
) {
    var expanded by remember(device.deviceId) { mutableStateOf(true) }
    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = !expanded }
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(if (expanded) "▾" else "▸", style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.width(8.dp))
            StatusDot(busy = device.busy)
            Spacer(Modifier.width(8.dp))
            Text(device.deviceName, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.width(8.dp))
            Text(
                l10n.t("{0} instance(s) · {1} session(s)", device.instances.size.toString(), device.sessionCount.toString()),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        if (!expanded) return@Column

        for (instance in device.instances) {
            Column(Modifier.fillMaxWidth().padding(start = 32.dp, end = 16.dp, bottom = 6.dp)) {
                Text(
                    text = instance.workspace.ifEmpty { l10n.t("(no folder open)") },
                    style = MaterialTheme.typography.bodyMedium,
                    fontFamily = FontFamily.Monospace,
                )
                Text(
                    text = l10n.t("{0} · {1}", instance.instanceId, instance.modelNames.joinToString(", ").ifEmpty { "—" }),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                for (session in instance.sessions) {
                    SessionRow(session, l10n) { onOpenSession(session.id, session.title) }
                }
            }
        }
    }
}

@Composable
private fun SessionRow(
    session: RoomModel.Session,
    l10n: L10n,
    onOpen: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onOpen)
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusDot(busy = session.busy)
        Spacer(Modifier.width(8.dp))
        Column(Modifier.fillMaxWidth()) {
            Text(
                text = session.title.ifEmpty { session.id },
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text = buildList {
                    add(l10n.t("{0} node(s)", session.nodes.toString()))
                    if (session.modelName.isNotEmpty()) add(session.modelName)
                    if (session.effort.isNotEmpty()) add(l10n.t("effort {0}", session.effort))
                    if (session.lockedNodes > 0) add(l10n.t("{0} locked", session.lockedNodes.toString()))
                    if (session.backgroundNodes > 0) add(l10n.t("{0} background", session.backgroundNodes.toString()))
                    if (session.running) add(l10n.t("running"))
                }.joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    Spacer(Modifier.height(4.dp))
}
