package dev.spinney.remote.core

/**
 * A tiny, order-preserving JSON reader/writer.
 *
 * Why hand-rolled instead of a library: this module is the *pure Kotlin/JVM* half of the
 * Android app (no Android dependency, so it runs in a plain JVM unit test), and the
 * obvious alternatives are all wrong here — `org.json` is part of the Android framework
 * and adding the JVM artifact to the core module would ship a duplicate class into the
 * APK, and kotlinx-serialization/Gson are a dependency plus a plugin for what is, on this
 * wire, a handful of small objects.
 *
 * The one thing it must get exactly right is [JsonValue.Str] escaping, because a frame's
 * plaintext is `JSON.stringify` output on the TypeScript side (`remote/PROTOCOL.md` §5) and
 * a divergence in escaping would be a divergence in the sealed bytes. So the writer mimics
 * `JSON.stringify`: `"` and `\` are escaped, the five control characters with short forms,
 * every other control character as `\u00XX`, and everything else — including non-ASCII —
 * is emitted raw, because the bytes are UTF-8.
 */
sealed class JsonValue {

    object Null : JsonValue()

    data class Bool(val value: Boolean) : JsonValue()

    /** Numbers keep their source text, so `1` never round-trips into `1.0`. */
    data class Num(val text: String) : JsonValue() {
        fun toLong(): Long = text.toLong()
    }

    data class Str(val value: String) : JsonValue()

    data class Arr(val items: List<JsonValue>) : JsonValue() {
        val size: Int get() = items.size
        operator fun get(index: Int): JsonValue = items[index]
        fun strings(): List<String> = items.map { (it as? Str)?.value ?: error("not a string: $it") }
    }

    /** Insertion-ordered, which is what makes the fixed key order of §5 and §7 reachable. */
    data class Obj(val fields: Map<String, JsonValue>) : JsonValue() {
        constructor(vararg pairs: Pair<String, JsonValue>) : this(linkedMapOf(*pairs))

        operator fun get(key: String): JsonValue? = fields[key]

        fun str(key: String): String = (fields[key] as? Str)?.value ?: error("missing string field '$key'")

        fun strOrNull(key: String): String? = (fields[key] as? Str)?.value

        fun long(key: String): Long = (fields[key] as? Num)?.toLong() ?: error("missing number field '$key'")

        fun bool(key: String): Boolean = (fields[key] as? Bool)?.value ?: error("missing boolean field '$key'")

        fun obj(key: String): Obj = fields[key] as? Obj ?: error("missing object field '$key'")

        fun arr(key: String): Arr = fields[key] as? Arr ?: error("missing array field '$key'")

        fun has(key: String): Boolean = fields.containsKey(key)
    }

    fun write(out: StringBuilder) {
        when (this) {
            is Null -> out.append("null")
            is Bool -> out.append(if (value) "true" else "false")
            is Num -> out.append(text)
            is Str -> writeString(out, value)
            is Arr -> {
                out.append('[')
                items.forEachIndexed { i, item ->
                    if (i > 0) out.append(',')
                    item.write(out)
                }
                out.append(']')
            }
            is Obj -> {
                out.append('{')
                var first = true
                for ((key, value) in fields) {
                    if (!first) out.append(',')
                    first = false
                    writeString(out, key)
                    out.append(':')
                    value.write(out)
                }
                out.append('}')
            }
        }
    }

    fun toJson(): String = StringBuilder().also { write(it) }.toString()

    override fun toString(): String = toJson()

    companion object {

        fun of(value: String?): JsonValue = if (value == null) Null else Str(value)

        fun of(value: Long): JsonValue = Num(value.toString())

        fun of(value: Int): JsonValue = Num(value.toString())

        fun of(value: Boolean): JsonValue = Bool(value)

        fun parse(text: String): JsonValue = Parser(text).parseDocument()

        /** `JSON.stringify`-compatible string escaping — see the class comment. */
        private fun writeString(out: StringBuilder, text: String) {
            out.append('"')
            var i = 0
            while (i < text.length) {
                val c = text[i]
                when {
                    c == '"' -> out.append("\\\"")
                    c == '\\' -> out.append("\\\\")
                    c == '\b' -> out.append("\\b")
                    c == '\u000c' -> out.append("\\f")
                    c == '\n' -> out.append("\\n")
                    c == '\r' -> out.append("\\r")
                    c == '\t' -> out.append("\\t")
                    c < ' ' -> {
                        val hex = Hex.encode(byteArrayOf((c.code ushr 8).toByte(), c.code.toByte()))
                        out.append("\\u").append(hex)
                    }
                    else -> out.append(c)
                }
                i++
            }
            out.append('"')
        }
    }

    private class Parser(private val text: String) {
        private var at = 0

        fun parseDocument(): JsonValue {
            skipWhitespace()
            val value = parseValue()
            skipWhitespace()
            require(at == text.length) { "trailing content at offset $at" }
            return value
        }

        private fun parseValue(): JsonValue {
            skipWhitespace()
            require(at < text.length) { "unexpected end of JSON at offset $at" }
            return when (text[at]) {
                '{' -> parseObject()
                '[' -> parseArray()
                '"' -> Str(parseString())
                't' -> literal("true", Bool(true))
                'f' -> literal("false", Bool(false))
                'n' -> literal("null", Null)
                else -> parseNumber()
            }
        }

        private fun literal(word: String, value: JsonValue): JsonValue {
            require(text.startsWith(word, at)) { "expected '$word' at offset $at" }
            at += word.length
            return value
        }

        private fun parseObject(): JsonValue {
            at++ // '{'
            val fields = LinkedHashMap<String, JsonValue>()
            skipWhitespace()
            if (at < text.length && text[at] == '}') {
                at++
                return Obj(fields)
            }
            while (true) {
                skipWhitespace()
                require(at < text.length && text[at] == '"') { "expected a quoted key at offset $at" }
                val key = parseString()
                skipWhitespace()
                require(at < text.length && text[at] == ':') { "expected ':' at offset $at" }
                at++
                fields[key] = parseValue()
                skipWhitespace()
                require(at < text.length) { "unterminated object" }
                when (text[at]) {
                    ',' -> at++
                    '}' -> {
                        at++
                        return Obj(fields)
                    }
                    else -> error("expected ',' or '}' at offset $at")
                }
            }
        }

        private fun parseArray(): JsonValue {
            at++ // '['
            val items = ArrayList<JsonValue>()
            skipWhitespace()
            if (at < text.length && text[at] == ']') {
                at++
                return Arr(items)
            }
            while (true) {
                items.add(parseValue())
                skipWhitespace()
                require(at < text.length) { "unterminated array" }
                when (text[at]) {
                    ',' -> at++
                    ']' -> {
                        at++
                        return Arr(items)
                    }
                    else -> error("expected ',' or ']' at offset $at")
                }
            }
        }

        private fun parseString(): String {
            at++ // opening quote
            val out = StringBuilder()
            while (true) {
                require(at < text.length) { "unterminated string" }
                val c = text[at++]
                when {
                    c == '"' -> return out.toString()
                    c != '\\' -> out.append(c)
                    else -> {
                        require(at < text.length) { "unterminated escape" }
                        when (val esc = text[at++]) {
                            '"' -> out.append('"')
                            '\\' -> out.append('\\')
                            '/' -> out.append('/')
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000c')
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'u' -> {
                                require(at + 4 <= text.length) { "truncated \\u escape" }
                                val code = text.substring(at, at + 4).toInt(16)
                                at += 4
                                out.append(code.toChar())
                            }
                            else -> error("bad escape '\\$esc' at offset ${at - 1}")
                        }
                    }
                }
            }
        }

        private fun parseNumber(): JsonValue {
            val start = at
            if (at < text.length && (text[at] == '-' || text[at] == '+')) at++
            while (at < text.length && (text[at].isDigit() || text[at] == '.' ||
                        text[at] == 'e' || text[at] == 'E' || text[at] == '-' || text[at] == '+')
            ) {
                at++
            }
            require(at > start) { "expected a JSON value at offset $start" }
            return Num(text.substring(start, at))
        }

        private fun skipWhitespace() {
            while (at < text.length && (text[at] == ' ' || text[at] == '\n' || text[at] == '\r' || text[at] == '\t')) at++
        }
    }
}
