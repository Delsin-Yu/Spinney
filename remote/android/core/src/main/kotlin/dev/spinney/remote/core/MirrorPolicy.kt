package dev.spinney.remote.core

/**
 * §6 of `remote/PROTOCOL.md`: the mirror is denied by default **in both directions**, and the
 * tables are the guarded artifact, not a denylist.
 *
 * The authority is the TypeScript host's `src/remote/allowlist.ts`, because the publisher is
 * the side that enforces it: it decides which `mirror` frames leave and which `input` frames
 * are accepted. This is the phone's own copy of both tables, for one reason — a replica must
 * not even *send* a message that acts on its own device. `openExternal` opens the link where
 * it was clicked, so the click's surface handles it; `pickImage` opens the picker on the
 * surface you are operating; `copyNodeId` writes this phone's clipboard. Sending any of those
 * up would ask the publisher to act on the owner's machine, which the 1:1 rule forbids and
 * which §6 refuses at the far end — a round trip that can only end in `error{code:"denied"}`.
 *
 * **Agreement with `allowlist.ts` is a review obligation, not a machine-checked one.** The
 * vectors cover bytes, not tables, and no test can read the TypeScript at runtime. Two things
 * keep it honest: this class refuses anything not listed (so a type added on the host side is
 * refused here until somebody adds it, which is the deny-by-default property the host relies
 * on), and the Kotlin unit test pins the two lists by value so a silent edit shows up in a
 * diff.
 */
object MirrorPolicy {

    /** Host→webview types a replica can receive and render. Mirrors `MIRROR_TO_PEER`. */
    val MIRROR_TO_PEER: Set<String> = linkedSetOf(
        // Session structure and view focus.
        "state", "tree", "path", "nodeUpdate", "agentItems", "reset",
        // One running turn.
        "delta", "thinkingDelta", "toolCallDelta", "toolStart", "toolEnd", "usage", "done",
        "interrupted", "error", "agentStart", "agentDone",
        // Transcript echoes.
        "user", "notice", "harnessNote", "backgroundNotice",
        // Chrome.
        "context", "sessionStats", "status", "backgrounds",
        // Configuration and the owner's account readout.
        "config", "balance",
    )

    /** Webview→host types a replica may submit. Mirrors `ACCEPT_FROM_PEER`. */
    val ACCEPT_FROM_PEER: Set<String> = linkedSetOf(
        "userMessage", "forkTurn", "stop", "continueTurn", "rolloverTurn", "checkout",
        "killAgent", "killBackground", "deleteBranch", "loadAgentItems", "setModel",
        "setThinkingEffort",
    )

    /**
     * Host→webview types a replica must never receive, with the reason. Mirrors
     * `MIRROR_REFUSED`; the phone drops one of these if a publisher ever sends it, because
     * `probe`/`nudge` would make this surface answer somebody else's diagnostics.
     */
    val MIRROR_REFUSED: Map<String, String> = linkedMapOf(
        "probe" to "the owner's stall watch",
        "nudge" to "a diagnostic repaint belonging to the surface that asked",
        "imagePicked" to "the local picker's result; the attachment travels inside userMessage",
        "composerClear" to "the composer box belongs to the surface you are typing on",
        "panTo" to "the camera is per surface, like card geometry",
        "background" to "the retired pre-P2 background list",
    )

    /**
     * Webview→host types the phone handles **itself**, because they act on the phone: the
     * clipboard, opening a link, the image picker, card geometry, the camera, and the local
     * diagnostics. They never enter the room.
     */
    val HANDLED_LOCALLY: Set<String> = linkedSetOf(
        "openExternal", "copyNodeId", "pickImage", "setNodeSize", "perfDiag",
        "layoutDiagnostic", "openModelTree", "ready", "clear",
    )

    /** May a host→webview type be rendered here? Deny by default. */
    fun mayMirrorToPeer(type: String?): Boolean = type != null && MIRROR_TO_PEER.contains(type)

    /** May a webview→host type be submitted to the publisher? Deny by default. */
    fun mayAcceptFromPeer(type: String?): Boolean = type != null && ACCEPT_FROM_PEER.contains(type)

    /** Does this type act on this phone, so it is handled here and never sent up? */
    fun isHandledLocally(type: String?): Boolean = type != null && HANDLED_LOCALLY.contains(type)

    /** One classification, for the dispatcher that has to decide in one place. */
    enum class Route { MIRROR_IN, INPUT_UP, LOCAL, REFUSED }

    fun routeWebviewMessage(type: String?): Route = when {
        isHandledLocally(type) -> Route.LOCAL
        mayAcceptFromPeer(type) -> Route.INPUT_UP
        else -> Route.REFUSED
    }

    fun routeHostMessage(type: String?): Route = when {
        mayMirrorToPeer(type) -> Route.MIRROR_IN
        else -> Route.REFUSED
    }
}
