package app.dot.opendots

import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.dot.design.DotTheme
import app.dot.design.ThemeMode
import app.dot.opendots.data.BgTask
import app.dot.opendots.data.TaskExternal
import app.dot.opendots.ui.CodeActivityCapsule
import app.dot.opendots.ui.canonicalCodeTasks
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class, qualifiers = "en-w360dp-h760dp")
class CodeActivityTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val first = BgTask(
        id = "task-first", title = "First project", status = "running", provider = "opencode",
        conversationId = "chat-a", createdAt = "2026-11-01T00:00:00Z",
        external = TaskExternal(instanceId = "machine", sessionId = "first", instanceName = "Dev PC"),
    )
    private val sibling = first.copy(id = "task-next", title = "Second project", external = first.external?.copy(sessionId = "second"))

    @Test fun aggregatesCanonicalSessionsAndOpensExactTask() {
        var opened: String? = null
        val duplicate = first.copy(id = "old-link", createdAt = "2026-10-01T00:00:00Z")
        val unrelated = sibling.copy(id = "other-task", conversationId = "chat-b", external = first.external?.copy(sessionId = "unrelated"))
        val tasks = listOf(first, duplicate, sibling, unrelated)
        assertEquals(setOf(first.id, sibling.id, unrelated.id), canonicalCodeTasks(tasks).map { it.id }.toSet())
        compose.setContent {
            DotTheme(ThemeMode.DARK) {
                CodeActivityCapsule("chat-a", tasks, emptyList(), true, true, null) { opened = it }
            }
        }
        compose.onAllNodesWithTag("code-activity-capsule").assertCountEquals(1)
        compose.onNodeWithText("2 running").assertIsDisplayed()
        compose.onNodeWithTag("code-motion-on", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("2 running").performClick()
        compose.onNodeWithText("Second project").assertIsDisplayed()
        compose.onAllNodesWithText("View in Code").assertCountEquals(2)
        compose.onNode(hasText("View in Code") and hasAnyAncestor(hasTestTag("code-activity-task:" + sibling.id))).performClick()
        assertEquals(sibling.id, opened)
    }

    @Test fun reducedMotionReconnectAndFinalState() {
        Settings.Global.putFloat(compose.activity.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        val tasks = mutableStateOf(listOf(first))
        val synchronized = mutableStateOf(true)
        compose.setContent {
            DotTheme(ThemeMode.LIGHT) {
                CodeActivityCapsule("chat-a", tasks.value, emptyList(), synchronized.value, true, null) {}
            }
        }
        compose.onNodeWithText("Running").assertIsDisplayed()
        compose.onNodeWithTag("code-motion-off", useUnmergedTree = true).assertIsDisplayed()
        compose.runOnIdle { synchronized.value = false }
        compose.onNodeWithText("Disconnected").assertIsDisplayed()
        compose.runOnIdle {
            synchronized.value = true
            tasks.value = listOf(first.copy(status = "waiting_for_user"))
        }
        compose.onNodeWithText("Permission needed").assertIsDisplayed()
        compose.runOnIdle { tasks.value = listOf(first.copy(status = "failed", error = "Session removed")) }
        compose.onNodeWithText("Failed").assertIsDisplayed()
        compose.onNodeWithTag("code-motion-off", useUnmergedTree = true).assertIsDisplayed()
        compose.mainClock.advanceTimeBy(3500)
        compose.onNodeWithTag("code-activity-capsule").assertDoesNotExist()
    }
}
