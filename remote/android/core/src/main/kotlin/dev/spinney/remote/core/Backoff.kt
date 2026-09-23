package dev.spinney.remote.core

import kotlin.math.pow
import kotlin.random.Random

/**
 * §7: "backoff is exponential with jitter and a cap". The contract fixes the shape and
 * leaves the numbers to the client ([Protocol.RECONNECT_BASE_MS] and friends).
 *
 * Jitter is **full-ish, symmetric and applied per attempt**: a room whose peers all reconnect
 * after the same outage must not stampede the relay in lockstep. The first attempt is
 * deliberately not zero-delay: a relay that just refused a join is not retried instantly.
 */
class Backoff(
    private val baseMs: Long = Protocol.RECONNECT_BASE_MS,
    private val capMs: Long = Protocol.RECONNECT_CAP_MS,
    private val factor: Double = 2.0,
    private val jitter: Double = Protocol.RECONNECT_JITTER,
) {

    init {
        require(baseMs > 0) { "baseMs must be positive" }
        require(capMs >= baseMs) { "the cap cannot be below the base" }
        require(jitter in 0.0..1.0) { "jitter is a fraction of the delay" }
    }

    /**
     * The delay before attempt number [attempt], 1-based (attempt 1 is the first reconnect).
     * The un-jittered value grows `base * factor^(attempt-1)` and stops at [capMs]; the
     * jitter then scales it by `1 ± jitter`, never below 1 ms.
     */
    fun delayMs(attempt: Int, random: Random = Random.Default): Long {
        require(attempt >= 1) { "attempts are 1-based" }
        val raw = baseMs.toDouble() * factor.pow((attempt - 1).toDouble())
        val capped = minOf(if (raw.isInfinite()) capMs.toDouble() else raw, capMs.toDouble())
        if (jitter == 0.0) return capped.toLong()
        val spread = capped * jitter
        val offset = (random.nextDouble() * 2.0 - 1.0) * spread
        return maxOf(1L, (capped + offset).toLong())
    }

    /** The un-jittered ceiling for an attempt — what a log line should say. */
    fun ceilingMs(attempt: Int): Long {
        require(attempt >= 1) { "attempts are 1-based" }
        val raw = baseMs.toDouble() * factor.pow((attempt - 1).toDouble())
        return minOf(if (raw.isInfinite()) capMs.toDouble() else raw, capMs.toDouble()).toLong()
    }
}
