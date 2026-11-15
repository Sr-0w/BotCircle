package app.dot.design.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.dot.design.Dot
import app.dot.design.DotSpacing
import app.dot.design.rememberDotHaptics
import app.dot.design.rememberReducedMotion

/** Outer height of [DotFloatingDock]; pages leave this much room (plus its margin) at the end of their lists. */
val DockHeight: Dp = 56.dp

/** Gap between the dock and the system navigation area. */
val DockMargin: Dp = 12.dp

/**
 * Floating navigation of the top-level pages: a short capsule of the same glass as the conversation's top buttons,
 * blurring the page that scrolls underneath ([backdrop] must be that page's source). Only the active destination
 * shows its label, inside a lighter inner capsule; the others are icons with spoken labels. A dot marks something
 * waiting. Never shown over a conversation or a full-screen page.
 */
@Composable
fun DotFloatingDock(items: List<DotBottomBarItem>, selected: Int, onSelect: (Int) -> Unit, backdrop: QuietBackdrop?, modifier: Modifier = Modifier) {
    val c = Dot.colors
    val haptics = rememberDotHaptics()
    val reduced = rememberReducedMotion()
    val duration = if (reduced) 0 else 220
    Row(
        modifier
            .heightIn(min = DockHeight)
            .shadow(3.dp, CircleShape, ambientColor = Color(0x26000000), spotColor = Color(0x33000000))
            .clip(CircleShape)
            .glassSurface(backdrop, pressed = false)
            .border(DotSpacing.hairline * 2, frostedBorderBrush(), CircleShape)
            .padding(4.dp)
            .selectableGroup(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        items.forEachIndexed { index, item ->
            val active = index == selected
            val fill by animateColorAsState(if (active) c.textPrimary.copy(alpha = if (c.isDark) 0.12f else 0.08f) else Color.Transparent, tween(duration), label = "dock-fill")
            val tint by animateColorAsState(if (active) c.textPrimary else c.textSecondary, tween(duration), label = "dock-tint")
            Row(
                Modifier
                    .heightIn(min = 48.dp)
                    .clip(CircleShape)
                    .background(fill)
                    .selectable(active, interactionSource = remember { MutableInteractionSource() }, indication = ripple(bounded = true, color = c.textPrimary), role = Role.Tab) {
                        if (!active) { haptics.tick(); onSelect(index) }
                    }
                    .semantics(mergeDescendants = true) { contentDescription = item.label }
                    .padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box {
                    Icon(item.icon, null, Modifier.size(22.dp), tint = tint)
                    if (item.badge) UnreadDot(Modifier.align(Alignment.TopEnd).padding(start = 18.dp), size = 7.dp)
                }
                AnimatedVisibility(active, enter = fadeIn(tween(duration)) + expandHorizontally(tween(duration)), exit = fadeOut(tween(duration / 2)) + shrinkHorizontally(tween(duration))) {
                    Text(item.label, style = Dot.type.label, color = c.textPrimary, maxLines = 1, modifier = Modifier.padding(start = DotSpacing.s))
                }
            }
        }
    }
}
