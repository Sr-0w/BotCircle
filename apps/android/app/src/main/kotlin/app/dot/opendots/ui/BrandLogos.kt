package app.dot.opendots.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.dot.design.Dot

/**
 * The official OpenCode logo (https://opencode.ai/brand), unchanged: the light version on light themes, the dark one
 * on dark themes. Its proportions are fixed at 4:5; it is drawn at 16×20, 20×25, 24×30 or 32×40.
 */
@Composable
fun OpencodeLogo(modifier: Modifier = Modifier, width: Dp = 20.dp, contentDescription: String? = null) {
    val dark = Dot.colors.isDark
    val logo = remember(dark) { opencodeLogo(dark) }
    Image(logo, contentDescription, modifier.size(width, width * 5 / 4))
}

private fun opencodeLogo(dark: Boolean): ImageVector = ImageVector.Builder(
    name = if (dark) "opencode-dark" else "opencode-light", defaultWidth = 240.dp, defaultHeight = 300.dp, viewportWidth = 240f, viewportHeight = 300f,
).apply {
    addPath(PathParser().parsePathString("M180 240H60V120H180V240Z").toNodes(), fill = SolidColor(Color(if (dark) 0xFF4B4B4B else 0xFFD2D2D2)))
    addPath(PathParser().parsePathString("M180 60H60V240H180V60ZM240 300H0V0H240V300Z").toNodes(), fill = SolidColor(Color(if (dark) 0xFFEEEEEE else 0xFF1F1F1F)))
}.build()
