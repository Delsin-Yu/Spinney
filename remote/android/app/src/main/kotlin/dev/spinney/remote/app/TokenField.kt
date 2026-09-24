package dev.spinney.remote.app

import android.content.Context
import android.text.InputType
import android.text.method.PasswordTransformationMethod
import android.util.TypedValue
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import androidx.core.widget.doAfterTextChanged

/**
 * The token field: a **platform `EditText`**, wrapped in an `AndroidView`, because the two flags
 * that actually stop an IME from "helping" have no Compose `KeyboardOptions` parameter.
 *
 * WHAT WAS MEASURED (API 28 emulator, `adb shell dumpsys input_method`, the Compose field focused):
 *
 * ```
 * inputType  = 0x81       = TYPE_CLASS_TEXT | TYPE_TEXT_VARIATION_PASSWORD
 * imeOptions = 0x2000006  = IME_FLAG_NO_FULLSCREEN | IME_ACTION_DONE
 * ```
 *
 * So Compose's `KeyboardOptions(keyboardType = Password, autoCorrect = false, …)` does work —
 * and it is still not enough. `TYPE_TEXT_VARIATION_PASSWORD` is a *hint*, and the IMEs that ignore
 * it are exactly the ones a phone owner meets (third-party Chinese IMEs among them); they are
 * looking for `TYPE_TEXT_FLAG_NO_SUGGESTIONS`. And nothing Compose can set asks an IME not to
 * *learn* the text it is typing, which for a shared secret is the difference between a token and a
 * token in someone's prediction dictionary.
 *
 * WHAT THIS SETS, EXPLICITLY:
 *
 * ```
 * inputType  = 0x80081     = TYPE_CLASS_TEXT | TYPE_TEXT_VARIATION_PASSWORD | TYPE_TEXT_FLAG_NO_SUGGESTIONS
 * imeOptions = 0x11000006  = IME_ACTION_DONE | IME_FLAG_NO_PERSONALIZED_LEARNING | IME_FLAG_NO_EXTRACT_UI
 * ```
 *
 * (The arithmetic, so it can be checked against `dumpsys`: `0x01 | 0x80 | 0x80000`, and
 * `0x6 | 0x1000000 | 0x10000000`.) `IME_FLAG_NO_FULLSCREEN`, which Compose used to add, is
 * deliberately not here: `IME_FLAG_NO_EXTRACT_UI` covers the same landscape-extract case.
 *
 * WHY THE FLAGS DON'T MOVE. An IME re-applies its own `EditorInfo` when a field regains focus, so
 * the flags are stamped at creation **and** on every focus gain ([applyImeFlags]) rather than once.
 * And because `TextView.setInputType` re-derives its own transformation method from the type, the
 * masking is applied *after* the flags every time — otherwise the "reveal" toggle would silently
 * stop working the next time the field was focused.
 *
 * Masking is `PasswordTransformationMethod` (which is also what makes `uiautomator` report
 * `password="true"`); revealing sets it to `null`.
 *
 * Why not a `TextInputLayout` or an AppCompat field: this app's manifest theme is a platform
 * `Theme.Material.Light.NoActionBar` with no AppCompat, so the platform widget is the one that
 * looks right next to the Compose fields once the container and colours are supplied by Compose.
 */
class TokenField(context: Context, textColor: Int) {

    /** Every user-visible change, on the main thread — including a paste. */
    var onText: (String) -> Unit = {}

    private var revealed = false

    val view: EditText = EditText(context).apply {
        // A token is one line, and it scrolls sideways rather than wrapping when it is long.
        // (`setHorizontallyScrolling` is the public spelling of what the brief calls
        // `isHorizontallyScrollable`: that property has no setter in the android-35 stubs, so
        // assigning it does not compile. `setHorizontallyScrolling(true)` is the same call the
        // platform's own `setSingleLine` makes internally.)
        setSingleLine(true)
        setHorizontallyScrolling(true)
        // The border is drawn by the Compose container around this view, so the platform widget
        // brings no background of its own; the padding is the container's job too.
        background = null
        setPadding(0, 0, 0, 0)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        setTextColor(textColor)
        // A password field is not something a password manager should offer to fill from, or to
        // remember: the token lives in EncryptedSharedPreferences and nowhere else.
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO

        doAfterTextChanged { editable -> onText(editable?.toString().orEmpty()) }

        // Pitfall 3: focus is when an IME gets to speak, so focus is when the flags are re-stamped.
        setOnFocusChangeListener { _, hasFocus -> if (hasFocus) applyImeFlags() }
    }

    init {
        // After `view` exists: `applyImeFlags` writes through it, so it cannot run from inside the
        // initializer above.
        applyImeFlags()
    }

    /**
     * Re-stamp the input type, the IME options and the masking.
     *
     * Safe to call while the field is focused (the platform restarts the input connection, which is
     * the point) and deliberately **not** called on every recomposition: re-stamping `inputType`
     * while somebody types would restart the IME per keystroke and can drop composing text.
     */
    fun applyImeFlags() {
        view.inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_VARIATION_PASSWORD or
            InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        view.imeOptions = EditorInfo.IME_ACTION_DONE or
            EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING or
            EditorInfo.IME_FLAG_NO_EXTRACT_UI
        // `setInputType` re-derives a transformation method from the type, so the reveal state has
        // to be restored *after* it — otherwise a revealed field would mask itself on the next focus.
        applyTransformation()
    }

    /** Show or mask the value. Idempotent, so recomposition cannot churn the input connection. */
    fun setRevealed(next: Boolean) {
        if (revealed == next) return
        revealed = next
        applyTransformation()
    }

    /**
     * Pitfall 1: Compose state can change from *outside* the field (a saved room's `Use` button),
     * and the view has to follow. The comparison is what keeps this from fighting the user: while
     * typing, the state and the view already agree, so nothing is written and the cursor stays put.
     * When something *does* change, the caret goes to the end, which is where a person who just
     * loaded a saved token expects to be.
     */
    fun setTextIfDifferent(value: String) {
        if (view.text.toString() == value) return
        view.setText(value)
        view.setSelection(view.text.length)
    }

    private fun applyTransformation() {
        view.transformationMethod = if (revealed) null else PasswordTransformationMethod.getInstance()
    }
}
