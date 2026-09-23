package dev.spinney.remote.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Base64
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import dev.spinney.remote.core.RemoteClient

/**
 * One replicated session: a thin chrome bar over [SessionWebView], which is the shipped renderer.
 *
 * Everything the host half must do for a remote session lives here, and each branch is a
 * consequence of the 1:1 rule (`docs/agents/plans/remote-control.md` §3) rather than a choice:
 *
 * - `openExternal` — a link opens **where it was clicked**, so the phone opens it.
 * - `copyNodeId` — the clipboard belongs to the surface you are operating; the phone's.
 * - `pickImage` — the picker opens on the surface you are operating. The chosen bytes become a
 *   `dataUrl` and go back into the webview as `imagePicked`, which is exactly the local path the
 *   desktop uses (§4); the attachment then travels to the publisher inside `userMessage`.
 * - `openModelTree` — the model-card editor edits local settings and local secrets. A phone has
 *   no such settings, so it says so instead of opening something that does not exist.
 * - `setNodeSize`, `perfDiag`, `layoutDiagnostic` — card geometry and this surface's own
 *   diagnostics stay here, and are quietly ignored: they are already local.
 */
@Composable
fun SessionScreen(
    client: RemoteClient,
    sessionId: String,
    title: String,
    l10n: L10n,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val host = remember(sessionId) { SessionWebHost(context.applicationContext, l10n) }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val picked = withContext(Dispatchers.IO) { readAsDataUrl(context, uri) }
            if (picked == null) {
                toast(context, l10n.t("That image could not be read."))
            } else {
                val (dataUrl, name) = picked
                // `imagePicked` is a host→webview message, and the webview's own composer turns
                // it into an attachment on the next send — the same path a local send uses.
                host.deliver(
                    JSONObject()
                        .put("type", "imagePicked")
                        .put("dataUrl", dataUrl)
                        .put("name", name)
                        .toString(),
                )
            }
        }
    }

    Column(modifier = modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            TextButton(onClick = onBack) { Text("‹ " + l10n.t("Room")) }
            Spacer(Modifier.width(4.dp))
            Text(
                text = title.ifEmpty { sessionId },
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
        }

        SessionWebView(
            sessionId = sessionId,
            client = client,
            l10n = l10n,
            host = host,
            modifier = Modifier.fillMaxWidth().weight(1f),
            onNotice = { message -> toast(context, message) },
            onLocal = { type, message ->
                when (type) {
                    "openExternal" -> openExternal(context, message.optString("url"), l10n)
                    "copyNodeId" -> {
                        val id = message.optString("id")
                        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                        clipboard?.setPrimaryClip(ClipData.newPlainText("Spinney node", id))
                        toast(context, l10n.t("Node id copied"))
                    }
                    "pickImage" -> picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    "openModelTree" -> toast(
                        context,
                        l10n.t("The model-card editor edits the machine's local settings; this phone has none."),
                    )
                    // Local by definition: the camera, card geometry and this surface's own
                    // diagnostics are already where they belong and nothing else has to happen.
                    "setNodeSize", "perfDiag", "layoutDiagnostic" -> Unit
                    else -> toast(context, l10n.t("'{0}' is handled on this phone.", type))
                }
            },
        )
    }
}

private fun toast(context: Context, message: String) {
    Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
}

private fun openExternal(context: Context, url: String, l10n: L10n) {
    if (url.isEmpty()) return
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (err: android.content.ActivityNotFoundException) {
        Toast.makeText(context, l10n.t("No app on this phone can open that link."), Toast.LENGTH_SHORT).show()
    }
}

/**
 * `data:<mime>;base64,<bytes>` — the `UserAttachment.dataUrl` shape of `src/chat/tree.ts`, which
 * is what the publisher injects through the same local path the desktop picker uses (§4). The
 * whole image is read into memory once: an 8 MB photo becomes ~10.7 MB of base64, which §8 sizes
 * the wire for ("a phone photo is the sizing case that matters").
 */
private fun readAsDataUrl(context: Context, uri: Uri): Pair<String, String>? = runCatching {
    val mime = context.contentResolver.getType(uri) ?: "image/jpeg"
    val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@runCatching null
    val extension = when (mime) {
        "image/png" -> "png"
        "image/webp" -> "webp"
        "image/gif" -> "gif"
        else -> "jpg"
    }
    val dataUrl = "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    dataUrl to "photo.$extension"
}.getOrNull()
