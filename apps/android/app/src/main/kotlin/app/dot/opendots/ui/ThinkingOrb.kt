package app.dot.opendots.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.dot.design.Dot
import app.dot.design.rememberReducedMotion
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * What an AI request is really doing, as one small animated orb of dots on a sphere. A native Compose port of the idea
 * of Thinking Orbs (MIT, Jakub Antalík, https://github.com/Jakubantalik/thinking-orbs): same states, drawn on a
 * Canvas, ink from the theme, depth shading, static under reduced motion. Never more than one per request.
 */
enum class OrbState { Working, Searching, Solving, Connecting, Composing, Breathing }

@Composable
fun ThinkingOrb(state: OrbState, size: Dp = 20.dp, label: String, modifier: Modifier = Modifier) {
    val ink = Dot.colors.textPrimary
    val reduced = rememberReducedMotion()
    val time by rememberInfiniteTransition(label = "orb").animateFloat(0f, 1000f, infiniteRepeatable(tween(1_000_000, easing = LinearEasing), RepeatMode.Restart), label = "orb-time")
    val t = if (reduced) 0f else time
    val points = remember(state, size) { orbPoints(state, if (size >= 48.dp) 1f else 0.55f) }
    Canvas(modifier.size(size).semantics { contentDescription = label }.testTag("orb-${state.name.lowercase()}")) {
        val r = this.size.minDimension / 2f * 0.86f
        val center = Offset(this.size.width / 2f, this.size.height / 2f)
        val dot = (this.size.minDimension / if (size >= 48.dp) 52f else 16f).coerceAtLeast(0.8f)
        drawOrb(state, points, t, center, r, dot, ink)
    }
}

/** Unit-sphere layout of each state, built once. */
private fun orbPoints(state: OrbState, density: Float): List<FloatArray> {
    fun n(base: Int) = (base * density).toInt().coerceAtLeast(10)
    return when (state) {
        // Three tilted orbits.
        OrbState.Working -> (0 until 3).flatMap { o -> (0 until n(22)).map { i -> floatArrayOf(o.toFloat(), i * 2f * PI.toFloat() / n(22)) } }
        // A dotted globe: latitude rings.
        OrbState.Searching -> (1 until 8).flatMap { ring -> val lat = -PI.toFloat() / 2 + ring * PI.toFloat() / 8; val count = (n(26) * cos(lat)).toInt().coerceAtLeast(4); (0 until count).map { i -> floatArrayOf(lat, i * 2f * PI.toFloat() / count) } }
        // Bands that turn by quarter turns.
        OrbState.Solving -> (0 until 5).flatMap { band -> val lat = -0.9f + band * 0.45f; (0 until n(20)).map { i -> floatArrayOf(band.toFloat(), lat, i * 2f * PI.toFloat() / n(20)) } }
        // A constellation: nodes spread on the sphere (golden spiral).
        OrbState.Connecting -> (0 until 12).map { i -> val y = 1 - 2f * (i + 0.5f) / 12; val rr = sqrt(1 - y * y); val a = i * 2.39996f; floatArrayOf(rr * cos(a), y, rr * sin(a)) }
        // An undulating sash around the equator.
        OrbState.Composing -> (0 until 3).flatMap { line -> (0 until n(40)).map { i -> floatArrayOf(line.toFloat(), i * 2f * PI.toFloat() / n(40)) } }
        // A face-on ring.
        OrbState.Breathing -> (0 until n(48)).map { i -> floatArrayOf(i * 2f * PI.toFloat() / n(48)) }
    }
}

private fun DrawScope.drawOrb(state: OrbState, points: List<FloatArray>, t: Float, c: Offset, r: Float, dot: Float, ink: androidx.compose.ui.graphics.Color) {
    val spin = t * 0.9f
    // Rotates a point about the vertical axis then tilts it, and draws it shaded by depth.
    fun plot(x0: Float, y0: Float, z0: Float, size: Float = dot, boost: Float = 1f) {
        val x1 = x0 * cos(spin) + z0 * sin(spin); val z1 = -x0 * sin(spin) + z0 * cos(spin)
        val tilt = 0.35f
        val y2 = y0 * cos(tilt) - z1 * sin(tilt); val z2 = y0 * sin(tilt) + z1 * cos(tilt)
        val depth = (z2 + 1f) / 2f
        drawCircle(ink.copy(alpha = ((0.18f + 0.82f * depth) * boost).coerceIn(0f, 1f)), size * (0.65f + 0.5f * depth), Offset(c.x + x1 * r, c.y - y2 * r))
    }
    when (state) {
        OrbState.Working -> points.forEach { (o, a) ->
            val tiltO = 0.5f + o * 1.05f; val speed = 1.4f + o * 0.35f; val ang = a + t * speed
            plot(cos(ang), sin(ang) * sin(tiltO), sin(ang) * cos(tiltO))
        }
        OrbState.Searching -> {
            val sweep = (t * 1.6f) % (2f * PI.toFloat())
            points.forEach { (lat, lon) ->
                val lit = 1f - (abs(((lon - sweep + 3f * PI.toFloat()) % (2f * PI.toFloat())) - PI.toFloat()) / 0.5f).coerceIn(0f, 1f)
                plot(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon), dot * (1f + lit * 0.6f), 0.55f + lit)
            }
        }
        OrbState.Solving -> points.forEach { (band, lat, lon) ->
            // Each band turns a quarter, pauses, then the next one goes: a scramble that clicks back.
            val phase = t * 0.8f + band * 0.37f; val step = floor(phase); val frac = (phase - step).coerceAtMost(0.5f) * 2f
            val turn = (step + frac * frac * (3 - 2 * frac)) * (PI.toFloat() / 2) * if (band.toInt() % 2 == 0) 1f else -1f
            val a = lon + turn
            plot(cos(lat) * cos(a), sin(lat), cos(lat) * sin(a))
        }
        OrbState.Connecting -> {
            val nodes = points
            for (i in nodes.indices) for (j in i + 1 until nodes.size) {
                val (ax, ay, az) = nodes[i]; val (bx, by, bz) = nodes[j]
                val d = (ax - bx) * (ax - bx) + (ay - by) * (ay - by) + (az - bz) * (az - bz)
                if (d < 0.9f) {
                    // A packet travels each edge.
                    val p = ((t * 0.7f + i * 0.13f + j * 0.07f) % 1f)
                    for (k in 0..4) { val q = k / 4f; plot(ax + (bx - ax) * q, ay + (by - ay) * q, az + (bz - az) * q, dot * 0.45f, 0.35f) }
                    plot(ax + (bx - ax) * p, ay + (by - ay) * p, az + (bz - az) * p, dot * 0.8f, 1.2f)
                }
            }
            nodes.forEach { (x, y, z) -> plot(x, y, z, dot * 1.25f) }
        }
        OrbState.Composing -> points.forEach { (line, a) ->
            val y = 0.32f * sin(a * 3f + t * 2.2f + line * 0.6f) + (line - 1f) * 0.14f
            val rr = sqrt((1f - y * y).coerceAtLeast(0f))
            plot(rr * cos(a), y, rr * sin(a))
        }
        OrbState.Breathing -> {
            val breath = 0.78f + 0.12f * sin(t * 1.3f)
            points.forEach { (a) ->
                val wobble = 1f + 0.06f * sin(a * 3f + t * 0.9f)
                drawCircle(ink.copy(alpha = 0.75f), dot, Offset(c.x + cos(a) * r * breath * wobble, c.y + sin(a) * r * breath * wobble))
            }
        }
    }
}
