package app.dot.opendots

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import coil3.imageDecoderEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTextInput
import app.dot.design.DotTheme
import app.dot.design.ThemeMode
import app.dot.design.catalog.QuietCatalogScreen
import app.dot.opendots.data.MemorySessionStore
import app.dot.opendots.data.OpenDotsClient
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.hasTestTag
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Drives the real app (AppState, OpenDotsClient, every screen) against a fake BotCircle engine that speaks the real HTTP
 * API, and writes a PNG of each screen to app/build/shots for a visual check. Blur itself needs a device (RenderEffect
 * is not rendered here); everything else - layout, themes, protocol - is exercised for real.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(application = android.app.Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
class ScreensTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val server = MockWebServer()
    private val posts = CopyOnWriteArrayList<Pair<String, String>>()
    private val gets = CopyOnWriteArrayList<Pair<String, String>>()
    /** A real 640x400 PNG standing for a desktop capture. */
    private val desktopPng: ByteArray by lazy {
        val bitmap = Bitmap.createBitmap(640, 400, Bitmap.Config.ARGB_8888)
        Canvas(bitmap).apply { drawColor(0xFF2E5AAC.toInt()); drawRect(40f, 40f, 400f, 260f, android.graphics.Paint().apply { color = 0xFFEDEDEF.toInt() }) }
        java.io.ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }
    private val out = File("build/shots").apply { mkdirs() }
    private var onboarded = true
    private var signedIn = true
    private var paired = false
    private var codeModel = """{"providerID":"openai","id":"gpt-5","variant":null,"name":"GPT-5","input":["text","image"]}"""

    private val agents = """[
      {"id":"a1","name":"Ari","named":true,"color":"#7C6CF2","description":"Concise and a bit playful.","effectiveModel":{"provider":"openrouter","model":"anthropic/claude-sonnet-5.5"},"state":"available","lastMessagePreview":"12,418 lines across 163 files.","unread":0,"mainConversationId":"c1"},
      {"id":"a2","name":"Venty","named":true,"color":"#E9A23B","description":"Handles job search emails.","effectiveModel":{"provider":"openrouter","model":"openai/gpt-5"},"state":"working","stateDetail":"Reads an email","unread":2,"mainConversationId":"c2"},
      {"id":"a3","name":"Dev","named":true,"color":"#35B58A","effectiveModel":{"provider":"openrouter","model":"openai/gpt-5"},"state":"error","unread":0,"mainConversationId":"c3"}]"""
    private val history = """{"conversationId":"c1","cursor":null,"active":false,"messages":[
      {"id":"m1","role":"user","metadata":{"kind":"chat"},"parts":[{"type":"text","text":"Every Friday at 5pm, send me a recap of what we did this week."}]},
      {"id":"m2","role":"assistant","metadata":{"agentId":"a1","workedMs":3200},"parts":[
        {"type":"tool-activity_create","toolCallId":"t1","state":"output-available","input":{"title":"Weekly recap","kind":"schedule"},"output":{"ok":true}},
        {"type":"text","text":"Done. You'll get it **every Friday at 5pm**. You can pause or edit it under *Scheduled tasks*."}]},
      {"id":"m3","role":"assistant","metadata":{"kind":"event","event":{"type":"schedule","title":"Weekly recap"},"createdAt":"2026-11-06T17:00:00Z"},"parts":[{"type":"text","text":"Scheduled run."}]},
      {"id":"m4","role":"user","metadata":{"kind":"chat","reactions":[{"emoji":"👍","actor":"a1"}]},"parts":[{"type":"text","text":"Count the TypeScript lines in the shared workspace, and reply to Claire that Thursday works."}]},
      {"id":"m5","role":"assistant","metadata":{"agentId":"a1","workedMs":12400,"reactions":[{"emoji":"👀","actor":"user"}]},"parts":[
        {"type":"reasoning","text":"Two tasks: count lines with find and wc, then draft the reply."},
        {"type":"tool-shell_exec","toolCallId":"t2","state":"output-available","input":{"command":"find . -name '*.ts' | xargs wc -l | tail -1"},"output":{"ok":true,"exit_code":0,"stdout":"12418 total"}},
        {"type":"tool-mail_search","toolCallId":"t3","state":"output-available","input":{"from":"Claire"},"output":{"ok":true}},
        {"type":"text","text":"**12,418 lines** across `163` files.\n\n| Package | Lines |\n|---|---|\n| server | 7,902 |\n| web | 4,516 |\n\n```bash\nfind . -name '*.ts' | xargs wc -l\n```\n\nI drafted the reply to Claire:"},
        {"type":"tool-mail_send","toolCallId":"t4","state":"output-available","input":{},"output":{"ok":true,"status":"pending_approval","approvalId":"ap1","summary":"Send an email to claire@example.com"}}]}
    ]}"""
    private val approvals = """[{"id":"ap1","agentId":"a1","conversationId":"c1","action":"mail.send","summary":"GitHub — robin@example.com · Pousser (git push) une branche depuis l'ordinateur du compagnon · commit 100f9b4271509a9a826ac4de535d182960079cd2 · {\"repo\":\"Sr-0w/BotCircle\",\"branch\":\"fix/team-tools\",\"set_upstream\":true}","status":"pending","createdAt":"2026-11-13T09:00:00Z"},
      {"id":"ap2","agentId":"a2","conversationId":"c2","action":"shell.exec","service":"terminal","summary":"Terminal · rm -rf build · {\"cwd\":\"/home/dev/app\"}","status":"pending","createdAt":"2026-11-13T09:00:00Z"},
      {"id":"ap3","agentId":"a2","conversationId":"c2","action":"integration.call","service":"gmail","summary":"Gmail · Send the report","status":"pending","createdAt":"2026-11-13T09:00:00Z"}]"""
    private val activities = """[
      {"id":"act1","agentId":"a1","title":"Weekly recap","kind":"schedule","schedule":{"type":"cron","expr":"0 17 * * 5"},"enabled":true,"nextRunAt":"2026-11-13T17:00:00Z"},
      {"id":"act2","agentId":"a2","title":"Watch: monitor price","kind":"watch","watch":{"url":"https://shop.example.com/monitor","mode":"contains"},"enabled":false}]"""

    private val chats = """[{"id":"ch1","title":"Friday meeting","model":null,"effectiveModel":{"provider":"openrouter","model":"openai/gpt-5"},"createdAt":"2026-11-13T09:00:00Z","updatedAt":"2026-11-13T09:05:00Z","lastMessagePreview":"Here is the summary."}]"""
    private val task = """{"id":"tk1","agentId":"a3","conversationId":"ch1","title":"Summarise the Friday meeting","instruction":"@Dev summarise the Friday meeting","status":"completed","completedSteps":4,"result":"Here is the summary.","artifacts":[{"id":"art_r1","name":"summary.pdf","mediaType":"application/pdf","size":48213,"url":"/api/artifacts/art_r1/content"}],"createdAt":"2026-11-13T09:01:00Z","finishedAt":"2026-11-13T09:05:00Z","events":[{"seq":1,"kind":"status","summary":"Started","createdAt":"2026-11-13T09:01:00Z"},{"seq":2,"kind":"step","summary":"Reads the meeting notes","createdAt":"2026-11-13T09:02:00Z"}]}"""
    private val codeTask = """{"id":"tk2","agentId":"a1","conversationId":"c1","title":"Refactor the settings","instruction":"Group OAuth with the providers.","status":"running","completedSteps":3,"currentActionSummary":"Runs the tests","provider":"opencode","external":{"instanceId":"oc1","instanceName":"Dev PC","sessionId":"ses_1","directory":"/home/dev/opendots","unreachable":false,"changes":{"files":4,"additions":128,"deletions":36}},"createdAt":"2026-11-13T10:00:00Z"}"""
    private val chatHistory = """{"conversationId":"ch1","cursor":null,"active":false,"tasks":[],"messages":[
      {"id":"g1","role":"user","metadata":{"kind":"chat"},"parts":[{"type":"text","text":"@Dev summarise the Friday meeting"},{"type":"file","url":"/api/artifacts/art_n1/content","filename":"meeting notes.md","mediaType":"text/markdown"}]},
      {"id":"g2","role":"assistant","metadata":{"kind":"chat"},"parts":[{"type":"tool-invoke_agent","toolCallId":"i1","state":"output-available","input":{"agent":"Dev","instruction":"summarise"},"output":{"ok":true,"status":"queued","taskId":"tk1","agentId":"a3","agentName":"Dev"}}]},
      {"id":"g3","role":"assistant","metadata":{"kind":"chat","agentId":"a3","taskId":"tk1"},"parts":[{"type":"text","text":"Here is the summary."},{"type":"file","url":"/api/artifacts/art_r1/content","filename":"summary.pdf","mediaType":"application/pdf"}]},
      {"id":"g4","role":"assistant","metadata":{"kind":"chat","model":"openai/gpt-5","previous":[{"id":"old","text":"An older answer.","model":"openai/gpt-4"}]},"parts":[{"type":"text","text":"Anything else about that meeting?"}]}
    ]}"""
    private val artifact = """{"id":"art_r1","name":"summary.pdf","mediaType":"application/pdf","size":48213,"authorKind":"worker","authorId":"a3","createdAt":"2026-11-13T09:05:00Z","url":"/api/artifacts/art_r1/content",
      "grants":[{"agentId":"a3","grantedBy":"a3","via":"create","createdAt":"2026-11-13T09:05:00Z","revokedAt":null}],
      "access":[{"actor":"a3","action":"create","detail":"summary.pdf","createdAt":"2026-11-13T09:05:00Z"},{"actor":"a3","action":"publish","detail":"ch1","createdAt":"2026-11-13T09:05:00Z"}]}"""

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath.removePrefix("/api")
                if (request.method == "GET") gets += path to (request.headers["Cookie"] ?: "")
                if (path.startsWith("/computer/screenshots/dead")) return MockResponse.Builder().code(404).build()
                if (path.startsWith("/computer/screenshots/")) return MockResponse.Builder().code(if (request.headers["Cookie"]?.contains("opendots_session=tok123") == true) 200 else 401).addHeader("Content-Type", "image/png").body(okio.Buffer().write(desktopPng)).build()
                if (request.method != "GET") {
                    posts += path to (request.body?.utf8() ?: "")
                    if (request.headers["x-opendots-client"] != "1") return json("""{"error":"Client non reconnu"}""", 403)
                }
                return when {
                    path == "/auth/me" -> json(if (signedIn) """{"account":{"id":"usr_1","email":"robin@example.com","role":"admin"},"registrationOpen":true}""" else """{"account":null,"registrationOpen":true}""")
                    path == "/auth/login" -> { signedIn = true; MockResponse.Builder().code(200).addHeader("Set-Cookie", "opendots_session=tok123; Path=/; HttpOnly").body("""{"account":{"id":"usr_1","email":"robin@example.com","role":"admin"}}""").build() }
                    path == "/avatars/presets" -> json("""[{"id":"circle","label":"Cercle","points":[[50,5],[95,50],[50,95],[5,50]],"roundness":1},{"id":"house","label":"Maison","points":[[50,6],[94,42],[94,94],[6,94],[6,42]],"roundness":0.35}]""")
                    path == "/agents/a1/avatar" -> json("{}")
                    path == "/profile" && request.method == "PUT" -> json(request.body?.utf8() ?: "{}")
                    path == "/profile" -> json("""{"firstName":null,"lastName":null}""")
                    path == "/bootstrap" -> json("""{"onboarded":$onboarded,"openrouterConfigured":true,"paused":false}""")
                    path == "/agents" -> json(agents)
                    path == "/approvals" -> json(approvals)
                    path == "/activities" -> json(activities)
                    path == "/agents/a1/messages" -> json(history)
                    path == "/agents/a1/clear" -> json("""{"conversationId":"c1b","archivedId":"c1"}""")
                    path == "/agents/a1/stream" -> MockResponse.Builder().code(204).build()
                    path == "/agents/a1/chat" -> MockResponse.Builder().code(200).addHeader("Content-Type", "text/event-stream").body(
                        listOf(
                            """{"type":"start","messageId":"m9","messageMetadata":{"agentId":"a1"}}""",
                            """{"type":"text-start","id":"t"}""", """{"type":"text-delta","id":"t","delta":"Hi "}""", """{"type":"text-delta","id":"t","delta":"there, streamed reply."}""", """{"type":"text-end","id":"t"}""",
                            """{"type":"finish"}""", "[DONE]",
                        ).joinToString("") { "data: $it\n\n" },
                    ).build()
                    path == "/chats" -> json(chats)
                    path == "/chats/ch1/messages" -> json(chatHistory)
                    path == "/models/available" -> json("""{"providers":[{"provider":"openrouter","name":"OpenRouter","count":2,"error":null},{"provider":"ollama","name":"Ollama","count":1,"error":null}],
                      "models":[{"id":"openai/gpt-5","name":"GPT-5","provider":"openrouter","reasoning":true},{"id":"anthropic/claude-sonnet-5.5","name":"Claude Sonnet 5.5","provider":"openrouter","vision":true},{"id":"llama4","name":"Llama 4","provider":"ollama"}],
                      "favorites":[{"provider":"openrouter","model":"openai/gpt-5"}]}""")
                    path == "/models/favorites" -> json("""{"favorites":[]}""")
                    path.startsWith("/models/") -> json("[]")
                    path == "/chats/ch1" && request.method == "PATCH" -> json("""{"id":"ch1","title":"Friday meeting","model":null,"effectiveModel":{"provider":"openrouter","model":"openai/gpt-5"},"webSearch":false,"pinned":false,"createdAt":"2026-11-13T09:00:00Z","updatedAt":"2026-11-13T09:05:00Z"}""")
                    path == "/chats/ch1/stream" -> MockResponse.Builder().code(204).build()
                    path == "/chats/ch1/chat" -> MockResponse.Builder().code(200).addHeader("Content-Type", "text/event-stream").body("data: {\"type\":\"start\",\"messageId\":\"g9\"}\n\ndata: {\"type\":\"finish\"}\n\ndata: [DONE]\n\n").build()
                    path == "/tasks" -> json("[$task,$codeTask]")
                    path == "/opencode/tasks/tk2" -> json("""{"task":$codeTask,"reachable":true,"error":null,"sessionStatus":"busy","model":$codeModel,
                      "messages":[{"id":"cm1","role":"user","createdAt":1,"completedAt":null,"model":null,"error":null,"parts":[{"type":"text","text":"Group OAuth with the providers."}]},
                        {"id":"cm1b","role":"assistant","createdAt":2,"completedAt":3,"model":"opencode/iceman-free","error":null,"parts":[{"type":"reasoning","text":"Look at the settings first."},{"type":"tool","tool":"bash","status":"completed","title":"find . -name '*.tsx' -path '*settings*'","input":"find .","output":"apps/web/src/settings-page.tsx"},{"type":"tool","tool":"read","status":"completed","title":"apps/web/src/settings-page.tsx","input":"","output":"…"}]},
                        {"id":"cm1c","role":"assistant","createdAt":3,"completedAt":4,"model":"opencode/iceman-free","error":null,"parts":[{"type":"tool","tool":"bash","status":"completed","title":"pnpm lint","input":"pnpm lint","output":"ok"},{"type":"tool","tool":"bash","status":"completed","title":"git status","input":"git status","output":"clean"},{"type":"tool","tool":"read","status":"completed","title":"apps/web/src/oauth.tsx","input":"","output":"…"}]},
                        {"id":"cm2","role":"assistant","createdAt":5,"completedAt":null,"model":"opencode/iceman-free","error":null,"parts":[{"type":"text","text":"Grouping the provider settings."},{"type":"tool","tool":"edit","status":"completed","title":"apps/web/src/settings-page.tsx","input":"","output":null},{"type":"tool","tool":"bash","status":"running","title":"Runs the tests","input":"pnpm test","output":null}]}],
                      "permissions":[{"id":"per1","permission":"bash","patterns":["rm -rf dist"]}],"questions":[],
                      "diffs":[{"path":"apps/web/src/settings-page.tsx","status":"modified","additions":12,"deletions":4,"patch":"@@ -1 +1 @@\n-old\n+new"}],
                      "exchanges":[{"seq":1,"taskId":"tk2","author":"companion","agentId":"a1","kind":"delegation","text":"Group OAuth with the providers.","original":"tidy the settings","createdAt":"2026-11-13T09:01:00Z"}]}""")
                    path == "/opencode/tasks/tk2/prompt" -> json("""{"queued":true,"delivery":"queue"}""")
                    path == "/opencode/instances" && request.method == "GET" -> json(if (paired) """[{"id":"oc9","name":"devbox","baseUrl":"https://8fbd.opentunnel.xyz","username":"opencode","defaultDirectory":null,"hasPassword":true,"state":"online","version":"2.3.0","lastCheckedAt":null,"lastError":null,"activeTasks":0,"apiVersion":"v2","authKind":"pairing","tokenExpiresAt":"2026-12-15T10:00:00Z"}]""" else "[]")
                    path == "/homeassistant/instances" -> json("""[{"id":"mcp_ha","name":"Maison","base":"http://ha.local:8123","mode":"assist","auth":"oauth","status":"ok","lastError":null,"tools":["GetLiveContext","HassTurnOn"],"policy":{"agents":{},"chats":"none","sensitive":["lock","alarm_control_panel"],"areas":[],"domains":[]}}]""")
                    path == "/homeassistant/instances/mcp_ha/policy" -> json("""{"id":"mcp_ha","name":"Maison","base":"http://ha.local:8123","mode":"assist","auth":"oauth","status":"ok","tools":[],"policy":{"agents":{"a1":"control"}}}""")
                    path == "/ssh/connections" && request.method == "GET" -> json("""[{"id":"ssh1","name":"Home server","host":"192.168.1.10","port":22,"username":"robin","auth":"key","hasSecret":true,"hostKey":null,"agents":["a1"],"approval":"ask","enabled":true,"status":"unknown","lastError":null,"lastOkAt":null}]""")
                    path == "/ssh/connections/ssh1/test" -> json(if ("true" in (request.body?.utf8() ?: "")) """{"ok":true,"hostKey":"SHA256:abcDEF","trusted":true,"error":null}""" else """{"ok":false,"hostKey":"SHA256:abcDEF","trusted":false,"error":"Hôte inconnu"}""")
                    path == "/opencode/instances/oc9/projects" -> json("""[{"id":"p1","worktree":"/home/dev/botcircle","name":"botcircle"}]""")
                    path == "/opencode/sessions" && request.method == "GET" -> json(if (paired) """[{"instanceId":"oc9","instanceName":"devbox","reachable":true,"sessions":[{"id":"ses_term","title":"Started in the terminal","directory":"/home/dev/botcircle","updatedAt":1,"busy":false,"additions":0,"deletions":0,"files":0,"taskId":null}]}]""" else "[]")
                    path == "/opencode/sessions" -> json(codeTask.replace("\"tk2\"", "\"tk7\"").replace("\"requestedBy\":\"agent\"", "\"requestedBy\":\"user\""))
                    path == "/opencode/instances/pair" -> { paired = true; json("""{"id":"oc9","name":"devbox","baseUrl":"https://8fbd.opentunnel.xyz","username":"opencode","defaultDirectory":null,"hasPassword":true,"state":"online","version":"2.3.0","lastCheckedAt":null,"lastError":null,"activeTasks":0,"apiVersion":"v2","authKind":"pairing","tokenExpiresAt":"2026-12-15T10:00:00Z"}""") }
                    path == "/opencode/tasks/tk2/permissions/per1" -> json("""{"ok":true}""")
                    path == "/opencode/tasks/tk2/models" -> json("""{"current":$codeModel,"models":[{"providerID":"openai","providerName":"OpenAI","id":"gpt-5","name":"GPT-5","variants":[],"input":["text","image"]},{"providerID":"opencode","providerName":"OpenCode","id":"glm-5.3-flash-free","name":"GLM-5.3-Flash Free","variants":["low","high","max"],"input":["text","image"]},{"providerID":"opencode","providerName":"OpenCode","id":"iceman-free","name":"Iceman Free","variants":[],"input":["text"]}]}""")
                    path == "/opencode/tasks/tk2/model" -> { codeModel = """{"providerID":"opencode","id":"glm-5.3-flash-free","variant":"high","name":"GLM-5.3-Flash Free","input":["text","image"]}"""; json(codeModel) }
                    path == "/tasks/tk1" -> json(task)
                    path == "/tasks/tk1/instruction" -> json(task)
                    path == "/artifacts/art_r1" -> json(artifact)
                    path == "/artifacts/art_n1" -> json("""{"id":"art_n1","name":"meeting notes.md","mediaType":"text/markdown","size":41}""")
                    path == "/artifacts/art_r1/grants/a3" -> json("""{"grants":[],"access":[{"actor":"user","action":"revoke","detail":"✕ a3","createdAt":"2026-11-13T09:06:00Z"}]}""")
                    path == "/agents/a2/messages" -> json("""{"conversationId":"c2","cursor":null,"active":false,"messages":[
                      {"id":"v1","role":"assistant","metadata":{"agentId":"a2"},"parts":[{"type":"text","text":"A sign-in is needed on service.example."},
                        {"type":"tool-request_secure_login","toolCallId":"l1","state":"output-available","input":{"url":"https://service.example/login","reason":"Read the latest invoice"},"output":{"ok":true,"status":"waiting_for_secure_login","loginId":"sl1","origin":"https://service.example"}}]},
                      {"id":"v2","role":"assistant","metadata":{"agentId":"a2"},"parts":[{"type":"text","text":"Here are the script and the notes."},
                        {"type":"file","url":"/api/artifacts/art_py/content","filename":"notepad.py","mediaType":"text/x-python"},
                        {"type":"file","url":"/api/artifacts/art_md/content","filename":"notes.md","mediaType":"text/markdown"},
                        {"type":"tool-shell_exec","toolCallId":"ap-a","state":"output-available","input":{},"output":{"ok":true,"status":"pending_approval","approvalId":"ap2","summary":"Terminal · rm -rf build · {\"cwd\":\"/home/dev/app\"}"}},
                        {"type":"tool-integration_call","toolCallId":"ap-b","state":"output-available","input":{},"output":{"ok":true,"status":"pending_approval","approvalId":"ap3","summary":"Gmail · Send the report"}}]}]}""")
                    path == "/artifacts/art_py/content" -> MockResponse.Builder().code(200).addHeader("Content-Type", "text/plain").body("def total(items):\n    # Sum of prices.\n    return sum(i.price for i in items)\n").build()
                    path == "/artifacts/art_md/content" -> MockResponse.Builder().code(200).addHeader("Content-Type", "text/plain").body("# Meeting\n\nShip on Friday.\n").build()
                    path == "/artifacts/art_py" -> json("""{"id":"art_py","name":"notepad.py","mediaType":"text/x-python","size":79}""")
                    path == "/artifacts/art_md" -> json("""{"id":"art_md","name":"notes.md","mediaType":"text/markdown","size":28}""")
                    path == "/approvals/ap3" -> json("""{"status":"rejected"}""")
                    path == "/agents/a2/stream" -> MockResponse.Builder().code(204).build()
                    path == "/secure-logins/sl1" -> json("""{"id":"sl1","agentId":"a2","conversationId":"c2","origin":"https://service.example","url":"https://service.example/login?next=%2Finvoices","reason":"Read the latest invoice","status":"pending"}""")
                    path == "/secure-logins/sl1/resolve" -> json("""{"id":"sl1","agentId":"a2","conversationId":"c2","origin":"https://service.example","url":"https://service.example/login?next=%2Finvoices","reason":"Read the latest invoice","status":"cancelled"}""")
                    path == "/agents/a1/memories" -> json("""[{"id":"mem1","agentId":"a1","content":"Robin prefers short answers."}]""")
                    path == "/memories/shared" -> json("""[{"id":"mem2","agentId":null,"content":"The office is closed on Fridays."}]""")
                    path == "/memories/mem1" -> json("""{"ok":true}""")
                    path == "/journal" -> json("""[{"id":"j1","summary":"Sent the weekly recap","createdAt":"2026-11-13T17:00:00Z"}]""")
                    path == "/team/threads" -> json("""[{"conversationId":"pair1","agentIds":["a1","a3"],"lastMessageAt":"2026-11-13T09:00:00Z","lastMessagePreview":"The build is green.","messageCount":2}]""")
                    path == "/conversations/pair1/messages" -> json("""{"messages":[{"id":"t1","role":"user","metadata":{"kind":"team","agentId":"a1"},"parts":[{"type":"text","text":"Is the build green?"}]},{"id":"t2","role":"assistant","metadata":{"kind":"team","agentId":"a3"},"parts":[{"type":"text","text":"The build is green."}]}]}""")
                    path == "/agents/a3/messages" -> json("""{"conversationId":"c3","cursor":null,"active":false,"messages":[
                      {"id":"s1","role":"user","metadata":{"kind":"chat"},"parts":[{"type":"text","text":"Show me your screenshots"}]},
                      {"id":"s2","role":"assistant","metadata":{"agentId":"a3"},"parts":[
                        {"type":"tool-share_screenshot","toolCallId":"sh1","state":"output-available","input":{"screenshotId":"0123456789abcdef0123456789abcdef"},"output":{"ok":true,"status":"attached","url":"/api/computer/screenshots/0123456789abcdef0123456789abcdef?agentId=a3","filename":"desktop.png","mediaType":"image/png"}},
                        {"type":"text","text":"Here is my desktop."},
                        {"type":"tool-share_screenshot","toolCallId":"sh3","state":"output-available","input":{"screenshotId":"deadbeefdeadbeefdeadbeefdeadbeef"},"output":{"ok":true,"status":"attached","url":"/api/computer/screenshots/deadbeefdeadbeefdeadbeefdeadbeef?agentId=a3","filename":"old.png","mediaType":"image/png"}},
                        {"type":"tool-share_screenshot","toolCallId":"sh2","state":"output-available","input":{"screenshotId":"ffff"},"output":{"ok":false,"status":"not_found","error":"expired"}}]}]}""")
                    path == "/agents/a3/stream" -> MockResponse.Builder().code(204).build()
                    path == "/settings" -> json("""{"openrouterKey":"sk-or-…-9f2c","defaultModel":{"provider":"openrouter","model":"openai/gpt-5"},"timezone":"Europe/Brussels","paused":false,"ollamaUrl":null,"turnStepLimit":null}""")
                    path == "/codex/account" -> json("""{"account":null,"error":null}""")
                    path == "/codex/login" -> json("""{"verificationUrl":"https://auth.openai.com/codex/device","userCode":"TEST-1234"}""")
                    // Like the real server, the event stream stays open (keep-alive comments) instead of ending at once,
                    // which would make the app reconnect and refresh everything every second.
                    path == "/events" -> MockResponse.Builder().code(200).addHeader("Content-Type", "text/event-stream")
                        .body("data: {\"type\":\"hello\"}\n\n" + ": keep-alive\n".repeat(20_000)).throttleBody(64, 1, java.util.concurrent.TimeUnit.SECONDS).build()
                    path == "/approvals/ap1" -> json("""{"ok":true,"status":"executed","error":null}""")
                    path.endsWith("/read") -> json("""{"ok":true}""")
                    else -> json("""{"error":"Introuvable"}""", 404)
                }
            }
        }
        server.start()
    }

    @After fun stop() { server.close() }

    private fun json(body: String, code: Int = 200) = MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    private fun launch(mode: ThemeMode, cookie: String? = "tok123", server: Boolean = true): AppState {
        val store = MemorySessionStore(serverUrl = if (server) this.server.url("/").toString() else null, sessionCookie = cookie)
        val app = AppState(store, OpenDotsClient(store))
        compose.setContent { DotTheme(mode) { OpenDotsRoot(app, app.state.collectAsStateForTest()) } }
        return app
    }

    private fun shoot(name: String) {
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width.coerceAtLeast(1), view.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(out, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /**
     * Taps [label], then waits for [expected]; taps again only if nothing came of it after a few seconds (a tap that
     * landed while a page was sliding in). Re-tapping sooner would hit the scrim of a sheet that is still loading.
     */
    private fun tapUntil(label: String, expected: String) {
        repeat(4) {
            runCatching { compose.onAllNodes(androidx.compose.ui.test.hasScrollToNodeAction())[0].performScrollToNode(hasText(label)) }
            runCatching { compose.onAllNodes(hasText(label))[0].performClick() }
            if (runCatching { compose.waitUntil(6_000) { compose.onAllNodesWithTextCompat(expected) } }.isSuccess) return
        }
        waitFor(expected)
    }

    private fun waitFor(text: String) = compose.waitUntil(10_000) { compose.onAllNodesWithTextCompat(text) }

    private fun conversation(mode: ThemeMode, name: String) {
        launch(mode)
        waitFor("12,418 lines")
        shoot("chat-$name")
    }

    @Test fun conversationDark() = conversation(ThemeMode.DARK, "dark")
    @Test fun conversationOled() = conversation(ThemeMode.OLED, "oled")
    @Test fun conversationLight() = conversation(ThemeMode.LIGHT, "light")

    @Test fun sendingStreamsAReplyAndApprovingReachesTheServer() {
        val app = launch(ThemeMode.DARK)
        waitFor("12,418 lines")
        compose.onNodeWithContentDescription("Write to Ari…").performTextInput("Hello")
        compose.onNodeWithContentDescription("Send").performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/agents/a1/chat" } }
        val sent = posts.first { it.first == "/agents/a1/chat" }.second
        assertTrue(sent, "\"role\":\"user\"" in sent && "\"text\":\"Hello\"" in sent)
        compose.waitUntil(10_000) { app.session("a1").state.value.messages.any { it.id == "m9" } || posts.any { it.first == "/agents/a1/read" } }
        compose.onNodeWithText("Allow").performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/approvals/ap1" } }
        assertEquals("""{"decision":"approve"}""", posts.first { it.first == "/approvals/ap1" }.second)
    }

    @Test fun slashClearAsksFirstThenArchivesTheThread() {
        launch(ThemeMode.DARK)
        waitFor("12,418 lines")
        compose.onNodeWithContentDescription("Write to Ari…").performTextInput("/clear")
        compose.onNodeWithContentDescription("Send").performClick()
        waitFor("Reset Ari?")
        waitFor("Long-term memory and connections kept")
        compose.onNodeWithText("Cancel").performClick()
        compose.waitForIdle()
        assertTrue(posts.none { it.first == "/agents/a1/clear" || it.first == "/agents/a1/chat" })
        compose.onNodeWithContentDescription("Write to Ari…").performTextInput("/clear")
        compose.onNodeWithContentDescription("Send").performClick()
        waitFor("Reset Ari?")
        compose.onNodeWithText("Reset").performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/agents/a1/clear" } }
        assertEquals("""{"conversationId":"c1"}""", posts.first { it.first == "/agents/a1/clear" }.second)
        assertTrue(posts.none { it.first == "/agents/a1/chat" })
    }

    /** #54: the profile card asks for a name (never guessed from the email) and saves it for every Circle. */
    @Test fun theProfileCardSetsTheNameCirclesUse() {
        launch(ThemeMode.DARK)
        waitFor("12,418 lines")
        compose.onNodeWithContentDescription("Circles").performClick()
        tab("Settings")
        waitFor("Add your name")
        compose.onNodeWithContentDescription("Edit your name").performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("profile-edit")).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(androidx.compose.ui.test.hasSetTextAction() and androidx.compose.ui.test.hasAnyAncestor(hasTestTag("profile-edit")))[0].performTextInput("Robin")
        compose.onNodeWithText("Save").performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/profile" } }
        assertEquals("""{"firstName":"Robin","lastName":null}""", posts.first { it.first == "/profile" }.second)
        waitFor("Robin")
        shoot("settings-profile-dark")
    }

    /** #47/#31: Code ＋ opens a new session at once (no form); sessions started in OpenCode are listed. */
    @Test fun codeStartsASessionDirectlyAndListsSessionsFromOpenCode() {
        paired = true
        launch(ThemeMode.DARK)
        waitFor("12,418 lines")
        compose.onNodeWithContentDescription("Circles").performClick()
        tab("Code")
        waitFor("Started in the terminal")
        waitFor("From OpenCode")
        compose.onNodeWithContentDescription("New session").performClick()
        // The session is created over the network, off the UI thread: let it land, then check the request.
        repeat(30) { if (posts.none { it.first == "/opencode/sessions" }) { Thread.sleep(200); compose.waitForIdle() } }
        compose.waitUntil(10_000) { posts.any { it.first == "/opencode/sessions" } }
        assertEquals("""{"instanceId":"oc9","directory":null,"instruction":""}""", posts.first { it.first == "/opencode/sessions" }.second)
        assertTrue(compose.onAllNodes(hasTestTag("code-instruction")).fetchSemanticsNodes().isEmpty())
    }

    /** #50: Advanced offers the silhouettes (Round = the dot); picking one saves it. */
    @Test fun circleSilhouetteIsPickedInAdvanced() {
        launch(ThemeMode.DARK)
        waitFor("12,418 lines")
        compose.onNodeWithContentDescription("Circle details").performClick()
        compose.onNodeWithText("Advanced").performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("shape-house")).fetchSemanticsNodes().isNotEmpty() }
        assertTrue(compose.onAllNodes(hasTestTag("shape-round")).fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodes(hasTestTag("shape-circle")).fetchSemanticsNodes().isEmpty())
        shoot("circle-silhouettes-dark")
        compose.onNode(hasTestTag("shape-house")).performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/agents/a1/avatar" } }
        assertEquals("""{"preset":"house"}""", posts.first { it.first == "/agents/a1/avatar" }.second)
    }

    /** #46: `/` opens a palette of real actions; a command is never sent to the model. */
    @Test fun slashCommandsAreRealActions() {
        launch(ThemeMode.DARK)
        waitFor("12,418 lines")
        compose.onNodeWithContentDescription("Write to Ari…").performTextInput("/")
        compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("slash-palette")).fetchSemanticsNodes().isNotEmpty() }
        waitFor("/think")
        waitFor("/tools")
        compose.onNodeWithContentDescription("Write to Ari…").performTextReplacement("/web off")
        compose.onNodeWithContentDescription("Send").performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/agents/a1" && "\"web\":false" in it.second } }
        assertTrue(posts.none { it.first == "/agents/a1/chat" })
        compose.onNodeWithContentDescription("Write to Ari…").performTextInput("/help")
        compose.onNodeWithContentDescription("Send").performClick()
        waitFor("All commands")
    }

    /** #52: SSH machines in Settings → Connections; the host key is confirmed before anything else. */
    @Test fun sshMachinesAreVerifiedBeforeUse() {
        launch(ThemeMode.DARK)
        waitFor("12,418 lines")
        compose.onNodeWithContentDescription("Circles").performClick()
        tab("Settings")
        compose.onNodeWithText("Connections").performClick()
        compose.onNodeWithText("SSH").performClick()
        waitFor("Home server")
        waitFor("Host not verified yet")
        waitFor("Allowed: Ari")
        compose.onNodeWithText("Test").performClick()
        waitFor("SHA256:abcDEF")
        compose.onNodeWithText("Trust this host").performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/ssh/connections/ssh1/test" && "true" in it.second } }
        shoot("ssh-dark")
    }

    /** #39: Home Assistant rights are set Circle by Circle. */
    @Test fun homeAssistantRightsArePerCircle() {
        launch(ThemeMode.DARK)
        waitFor("12,418 lines")
        compose.onNodeWithContentDescription("Circles").performClick()
        tab("Settings")
        compose.onNodeWithText("Connections").performClick()
        compose.onNodeWithText("Home Assistant").performClick()
        waitFor("GetLiveContext")
        compose.onAllNodes(hasText("Control"))[0].performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/homeassistant/instances/mcp_ha/policy" && "\"a1\":\"control\"" in it.second } }
        shoot("homeassistant-dark")
    }

    @Test fun workStaysOutOfTheThreadAndOpensInItsPanel() {
        launch(ThemeMode.DARK)
        waitFor("12,418 lines")
        assertTrue(!compose.onAllNodesWithTextCompat("Worked for"))
        assertTrue(!compose.onAllNodesWithTextCompat("set_upstream"))
        waitFor("Pousser (git push)")
        compose.onNodeWithContentDescription("Work").performClick()
        waitFor("Worked for 12 s")
        shoot("work-dark")
    }

    /** Dock destinations are spoken labels (only the active one shows its text). */
    private fun tab(label: String) {
        compose.onNode(androidx.compose.ui.test.hasContentDescription(label) and isSelectable()).performClick()
    }

    /** #47/#59: Activity and the Inbox are header actions of the top-level pages, not dock destinations. */
    private fun openActivity() = compose.onNodeWithContentDescription("Activity").performClick()
    private fun openInbox() = compose.onNode(androidx.compose.ui.test.hasContentDescription("Inbox", substring = true)).performClick()

    @Test fun pagesReplaceTheDrawer() {
        launch(ThemeMode.DARK)
        waitFor("I drafted the reply")
        // Back from a conversation leads to the full-screen Companions page.
        compose.onNodeWithContentDescription("Circles").performClick()
        waitFor("Venty")
        waitFor("Reads an email")
        shoot("Circles-dark")
        // #59: the dock, left to right, is exactly Circles · Chat · Code · Settings; only the active one shows its label.
        val dock = compose.onAllNodes(isSelectable()).fetchSemanticsNodes().map { it.config[androidx.compose.ui.semantics.SemanticsProperties.ContentDescription].first() }
        assertEquals(listOf("Circles", "Chat", "Code", "Settings"), dock)
        waitFor("Circles")
        assertTrue(!compose.onAllNodesWithTextCompat("Settings"))
        // Activity and the Inbox open from the header and return to the tab.
        openActivity()
        waitFor("Weekly recap")
        shoot("tasks-dark")
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        waitFor("Venty")
        openInbox()
        waitFor("Pousser (git push)")
        shoot("approvals-dark")
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        waitFor("Venty")
        tab("Code")
        waitFor("Connected machines")
        shoot("code-dark")
        tab("Settings")
        // #54: a short home — profile card, then Appearance, AI & models, Connections, Server, About.
        waitFor("AI & models")
        shoot("settings-dark")
        compose.onNodeWithText("Appearance").performClick()
        waitFor("OLED black")
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        waitFor("AI & models")
        // Settings is a destination: the dock stays; Back returns to Circles.
        assertTrue(compose.onAllNodes(hasTestTag("dock")).fetchSemanticsNodes().isNotEmpty())
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        waitFor("Venty")
        compose.onNodeWithText("Ari").performClick()
        waitFor("I drafted the reply")
        compose.onNodeWithContentDescription("Circle details").performClick()
        // #53: a short summary — the real model, four entries, no toggles; permissions on their own page.
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("anthropic/claude-sonnet-5.5", substring = true)).fetchSemanticsNodes().isNotEmpty() }
        assertTrue(!compose.onAllNodesWithTextCompat("Read public web pages"))
        shoot("profile-dark")
        compose.onNodeWithText("Permissions").performClick()
        waitFor("INFORMATION & SERVICES")
        waitFor("Read public web pages")
        shoot("profile-permissions-dark")
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        // The name is renamed in place: pencil, field, Done.
        compose.onNodeWithContentDescription("Rename").performClick()
        compose.onAllNodes(androidx.compose.ui.test.hasSetTextAction() and androidx.compose.ui.test.hasAnyAncestor(hasTestTag("rename")))[0].performTextReplacement("Ariane")
        compose.onNodeWithContentDescription("Save").performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/agents/a1" && "\"name\":\"Ariane\"" in it.second } }
    }

    /** #38: a general chat has its own controls in its field; answers can be regenerated, messages edited, versions read. */
    @Test fun aGeneralChatHasItsControlsVersionsEditAndRegenerate() {
        launch(ThemeMode.DARK)
        waitFor("I drafted the reply")
        compose.onNodeWithContentDescription("Circles").performClick()
        tab("Chat")
        waitFor("Friday meeting")
        compose.onNodeWithText("Friday meeting").performClick()
        waitFor("Anything else about that meeting?")
        assertTrue(compose.onAllNodes(hasTestTag("chat-controls"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        shoot("chat-controls-dark")
        // "+" holds attach and "ask a Circle"; there is no separate @ button.
        assertTrue(!compose.onAllNodes(androidx.compose.ui.test.hasContentDescription("Ask a Circle")).fetchSemanticsNodes().isNotEmpty())
        compose.onNodeWithContentDescription("Add").performClick()
        waitFor("Ask a Circle")
        compose.onNodeWithText("Ask a Circle").performClick()
        // The model picker: every configured provider, favourites first; a star keeps a model on top.
        waitFor("@")
        repeat(3) {
            if (compose.onAllNodes(hasTestTag("model-sheet"), useUnmergedTree = true).fetchSemanticsNodes().isEmpty()) {
                runCatching { compose.onNodeWithTag("chat-model").performClick() }
                runCatching { compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag("model-sheet"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() } }
            }
        }
        compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("model-sheet"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        waitFor("FAVOURITES")
        waitFor("Claude Sonnet 5.5")
        compose.onAllNodesWithContentDescription("Add to favourites")[0].performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/models/favorites" } }
        compose.onNodeWithText("Llama 4").performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/chats/ch1" && "llama4" in it.second } }
        // Web search is switched off for this chat, on the server.
        compose.onNodeWithTag("chat-web").performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/chats/ch1" && "webSearch" in it.second } }
        // The fixture's chat already came back with web search off (after the model change): the switch turns it on.
        assertEquals("""{"webSearch":true}""", posts.first { it.first == "/chats/ch1" && "webSearch" in it.second }.second)
        // The replaced answer is still there to read.
        waitFor("2/2")
        compose.onNodeWithContentDescription("Previous version").performClick()
        waitFor("An older answer.")
        // A new answer to the latest message.
        compose.onNodeWithContentDescription("Regenerate").performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/chats/ch1/chat" && "\"regenerate\":true" in it.second } }
        // Editing a message sends it again, naming the one it replaces.
        compose.waitUntil(10_000) { compose.onAllNodesWithTextCompat("@Dev summarise the Friday meeting") }
        compose.onNodeWithText("@Dev summarise the Friday meeting").performTouchInput { longClick() }
        compose.onNodeWithText("Edit").performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("edit-sheet"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(androidx.compose.ui.test.hasSetTextAction() and androidx.compose.ui.test.hasAnyAncestor(hasTestTag("edit-sheet")))[0].performTextReplacement("@Dev summarise Friday in three points")
        compose.onNodeWithText("Send the edit").performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/chats/ch1/chat" && "\"editOf\":\"g1\"" in it.second } }
        assertTrue("three points" in posts.first { "\"editOf\"" in it.second }.second)
    }

    @Test fun chatsAreTheirOwnDestinationWithSignedContributions() {
        launch(ThemeMode.DARK)
        waitFor("I drafted the reply")
        compose.onNodeWithContentDescription("Circles").performClick()
        tab("Chat")
        waitFor("Friday meeting")
        shoot("chats-dark")
        compose.onNodeWithText("Friday meeting").performClick()
        // One card for the contribution, updated from the task; the answer is signed by the companion that gave it.
        waitFor("contribution")
        waitFor("Summarise the Friday meeting")
        waitFor("4 actions")
        waitFor("Here is the summary.")
        waitFor("Assistant")
        assertEquals(2, compose.onAllNodes(androidx.compose.ui.test.hasTestTag("author")).fetchSemanticsNodes().size)
        // Any file is a card with its real name, type and size.
        waitFor("summary.pdf")
        waitFor("PDF · 47 KB")
        waitFor("meeting notes.md")
        shoot("chat-general-dark")
        // @ completes a companion's name; the message goes to the chat, not to a companion's thread.
        compose.onNodeWithContentDescription("Message, @ for a Circle…").performTextInput("@D")
        compose.onNodeWithText("@Dev").performClick()
        compose.onNodeWithContentDescription("Send").performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/chats/ch1/chat" } }
        assertTrue("\"text\":\"@Dev\"" in posts.first { it.first == "/chats/ch1/chat" }.second)
        assertTrue(posts.none { it.first == "/agents/a3/chat" })
    }

    @Test fun aTaskShowsItsRealStateAndJournal() {
        launch(ThemeMode.DARK)
        waitFor("I drafted the reply")
        compose.onNodeWithContentDescription("Circles").performClick()
        openActivity()
        waitFor("Summarise the Friday meeting")
        waitFor("Finished")
        waitFor("Weekly recap")
        shoot("tasks-background-dark")
        // The OpenCode card opens its session; the worker task keeps its Details.
        compose.onAllNodes(hasText("Details"))[0].performClick()
        waitFor("Reads the meeting notes")
        waitFor("summary.pdf")
        waitFor("PDF · 47 KB")
    }

    @Test fun providersSitTogetherWithTheirStatus() {
        launch(ThemeMode.OLED)
        waitFor("I drafted the reply")
        compose.onNodeWithContentDescription("Circles").performClick()
        tab("Settings")
        compose.onNodeWithText("AI & models").performClick()
        waitFor("Model providers")
        compose.onNodeWithText("Model providers").performClick()
        waitFor("OpenRouter")
        waitFor("ChatGPT / Codex")
        waitFor("Ollama")
        waitFor("sk-or-…-9f2c")
        compose.waitUntil(10_000) { compose.onAllNodes(androidx.compose.ui.test.hasTestTag("provider-connected")).fetchSemanticsNodes().size == 1 && compose.onAllNodes(androidx.compose.ui.test.hasTestTag("provider-disconnected")).fetchSemanticsNodes().size == 2 }
        shoot("providers-oled")
        // The ChatGPT sign-in happens here, next to the other providers, with the official device code.
        compose.onNodeWithText("Connect ChatGPT").performClick()
        waitFor("TEST-1234")
        waitFor("openai/gpt-5")
    }

    @Test fun aSignInIsATrustedCardWithoutAnyCredentialField() {
        launch(ThemeMode.DARK)
        waitFor("I drafted the reply")
        compose.onNodeWithContentDescription("Circles").performClick()
        waitFor("Venty")
        compose.onNodeWithText("Venty").performClick()
        waitFor("Sign in to service.example")
        waitFor("Waiting for you to sign in")
        waitFor("Read the latest invoice")
        // The card offers control of the browser, never a place to type a password.
        waitFor("Take control of the browser")
        assertEquals(0, compose.onAllNodes(androidx.compose.ui.test.hasSetTextAction() and androidx.compose.ui.test.hasAnyAncestor(androidx.compose.ui.test.hasTestTag("secure-login"))).fetchSemanticsNodes().size)
        shoot("secure-login-dark")
        compose.onNodeWithText("Cancel").performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/secure-logins/sl1/resolve" } }
        assertEquals("""{"outcome":"cancelled"}""", posts.first { it.first == "/secure-logins/sl1/resolve" }.second)
        waitFor("Sign-in cancelled")
        assertTrue(!compose.onAllNodesWithTextCompat("Take control of the browser"))
    }

    @Test fun anOpenCodeTaskOpensItsOwnLiveSession() {
        launch(ThemeMode.DARK)
        waitFor("I drafted the reply")
        compose.onNodeWithContentDescription("Circles").performClick()
        openActivity()
        // #43: one compact card with the official logo, the real state and what the session really changed.
        waitFor("Refactor the settings")
        waitFor("Running · OpenCode")
        waitFor("Runs the tests")
        waitFor("4 files")
        waitFor("+128")
        assertTrue(compose.onAllNodes(hasTestTag("opencode-logo"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        assertTrue(!compose.onAllNodesWithTextCompat("Pause"))
        shoot("tasks-opencode-dark")
        // The whole card opens that exact session.
        compose.onNodeWithText("Refactor the settings").performClick()
        waitFor("Grouping the provider settings.")
        waitFor("Dev PC · opendots")
        // Work between two paragraphs is one quiet line; the step running now is shown live.
        waitFor("Ran 3 commands, read 2 files")
        waitFor("Runs the tests")
        assertTrue(!compose.onAllNodesWithTextCompat("opencode/iceman-free"))
        assertTrue(!compose.onAllNodesWithTextCompat("git status"))
        waitFor("OpenCode asks for permission")
        shoot("code-workspace-dark")
        compose.onNodeWithText("Ran 3 commands, read 2 files").performClick()
        waitFor("git status")
        shoot("code-workspace-unfolded-dark")
        compose.onNodeWithText("Allow once").performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/opencode/tasks/tk2/permissions/per1" } }
        assertEquals("""{"reply":"once"}""", posts.first { it.first == "/opencode/tasks/tk2/permissions/per1" }.second)
        // Writing here goes to the task's own session, as the user. OpenCode is working: the message can wait for the
        // end of this work instead of being folded in.
        compose.onNodeWithContentDescription("Write to OpenCode directly…").performTextInput("Keep the animations.")
        compose.onNodeWithText("Fold it in now").performClick()
        waitFor("After this work")
        compose.onNodeWithContentDescription("Send").performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/opencode/tasks/tk2/prompt" } }
        assertEquals("""{"text":"Keep the animations.","delivery":"queue"}""", posts.first { it.first == "/opencode/tasks/tk2/prompt" }.second)
        // The session's model is shown in the field; it changes from there, with its effort.
        waitFor("GPT-5")
        compose.onNodeWithTag("code-model").performClick()
        waitFor("Iceman Free")
        compose.onNodeWithText("GLM-5.3-Flash Free").performClick()
        waitFor("Effort for GLM-5.3-Flash Free")
        shoot("code-model-sheet-dark")
        compose.onNodeWithText("high").performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/opencode/tasks/tk2/model" } }
        assertEquals("""{"providerID":"opencode","id":"glm-5.3-flash-free","variant":"high"}""", posts.first { it.first == "/opencode/tasks/tk2/model" }.second)
        waitFor("GLM-5.3-Flash Free")
        shoot("code-composer-dark")
        // What changed opens from the pill above the field; back returns to the session.
        compose.onNodeWithTag("code-changes-pill").performClick()
        waitFor("apps/web/src/settings-page.tsx")
        assertTrue(!compose.onAllNodesWithTextCompat("Grouping the provider settings."))
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        waitFor("Grouping the provider settings.")
        compose.onNodeWithContentDescription("More").performClick()
        compose.onNodeWithText("Exchanges").performClick()
        waitFor("Ari → OpenCode")
        waitFor("Original request")
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        waitFor("Grouping the provider settings.")
        // Android back returns to the page that opened the workspace.
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        waitFor("Weekly recap")
    }

    /** #42: files sent together are one surface with Preview and Save; code previews with colours and search. */
    @Test fun filesAreCompactLinesWithAPreviewAndApprovalsAskedTogetherAreGrouped() {
        launch(ThemeMode.DARK)
        waitFor("I drafted the reply")
        compose.onNodeWithContentDescription("Circles").performClick()
        waitFor("Venty")
        compose.onNodeWithText("Venty").performClick()
        waitFor("notepad.py")
        waitFor("Python · 79 B")
        assertEquals(1, compose.onAllNodes(hasTestTag("file-group"), useUnmergedTree = true).fetchSemanticsNodes().size)
        // Two validations asked together: one surface; the risky one shows its details before the buttons.
        waitFor("2 approvals requested")
        waitFor("This action has consequences")
        waitFor("/home/dev/app")
        waitFor("Asked by Venty")
        shoot("files-approvals-dark")
        compose.onAllNodes(hasText("Refuse") and androidx.compose.ui.test.hasClickAction())[1].performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/approvals/ap3" } }
        assertEquals("""{"decision":"reject"}""", posts.first { it.first == "/approvals/ap3" }.second)
        // Preview of the Python file: coloured, numbered, searchable.
        compose.onAllNodesWithContentDescription("Preview")[0].performClick()
        compose.waitUntil(10_000) { compose.onAllNodes(hasTestTag("code-highlighted"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        waitFor("return sum(i.price for i in items)")
        shoot("file-preview-code-dark")
        compose.onNodeWithContentDescription("Search in the file").performTextInput("return")
        waitFor("1/1")
    }

    /** Files attached in the code workspace go with the instruction, as multipart, to that task's session. */
    @Test fun filesAttachedToAnOpenCodeInstructionAreSentWithIt() {
        val client = OpenDotsClient(MemorySessionStore(serverUrl = server.url("/").toString(), sessionCookie = "tok123"))
        kotlinx.coroutines.runBlocking {
            client.codePrompt("tk2", "Read these.", "queue", listOf("notes.txt" to "à garder\n".toByteArray().toRequestBody("text/plain".toMediaType())))
        }
        val body = posts.last { it.first == "/opencode/tasks/tk2/prompt" }.second
        assertTrue(body.contains("name=\"text\"") && body.contains("Read these."))
        assertTrue(body.contains("name=\"delivery\"") && body.contains("queue"))
        assertTrue(body.contains("name=\"file\"; filename=\"notes.txt\"") && body.contains("à garder"))
    }

    /** `opencode pair --remote`: its one-time link is pasted (or scanned) and the server redeems it. */
    @Test fun anOpenCodeMachineIsPairedWithTheLinkOfOpencodePair() {
        launch(ThemeMode.DARK)
        waitFor("I drafted the reply")
        compose.onNodeWithContentDescription("Circles").performClick()
        waitFor("Venty")
        tab("Settings")
        compose.onNodeWithText("Connections").performClick()
        tapUntil("OpenCode", "Pair with a link")
        compose.onNodeWithText("Pair with a link").performClick()
        waitFor("Scan the QR code")
        compose.onAllNodes(androidx.compose.ui.test.hasSetTextAction() and androidx.compose.ui.test.hasAnyAncestor(androidx.compose.ui.test.hasTestTag("pair-form")))[0].performTextInput("https://8fbd.opentunnel.xyz/auth/connect/ZXcLiAFp9to8r6uD7cWV3w")
        shoot("opencode-pair-dark")
        compose.onNodeWithText("Pair").performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/opencode/instances/pair" } }
        assertEquals("""{"link":"https://8fbd.opentunnel.xyz/auth/connect/ZXcLiAFp9to8r6uD7cWV3w","defaultDirectory":null}""", posts.first { it.first == "/opencode/instances/pair" }.second)
        waitFor("devbox")
        waitFor("paired until")
    }

    @Test fun aCompanionsMemoryCanBeReadAndForgotten() {
        launch(ThemeMode.DARK)
        waitFor("I drafted the reply")
        compose.onNodeWithContentDescription("Circle details").performClick()
        compose.onNodeWithText("Data & connections").performClick()
        waitFor("KNOWLEDGE")
        tapUntil("Memory", "Robin prefers short answers.")
        waitFor("shared by all Circles")
        compose.onAllNodes(hasText("Forget"))[0].performClick()
        compose.waitUntil(10_000) { posts.any { it.first == "/memories/mem1" } }
    }

    @Test fun teamExchangesOpenTheThreadBetweenTwoCompanions() {
        launch(ThemeMode.DARK)
        waitFor("I drafted the reply")
        compose.onNodeWithContentDescription("Circles").performClick()
        waitFor("Venty")
        // #54: team exchanges are activity, not a setting.
        openActivity()
        tapUntil("Team exchanges", "Ari ↔ Dev")
        tapUntil("Ari ↔ Dev", "Is the build green?")
        shoot("team-thread-dark")
    }

    /** Issue #22: a screenshot the companion really shared is fetched by the Android client, with the session. */
    @Test fun aSharedScreenshotIsFetchedWithTheSessionAndShownInTheThread() {
        val store = MemorySessionStore(serverUrl = server.url("/").toString(), sessionCookie = "tok123")
        val client = OpenDotsClient(store)
        // The same image loader as OpenDotsApp: attachments are fetched with the API's HTTP client and cookie.
        coil3.SingletonImageLoader.setUnsafe(coil3.ImageLoader.Builder(compose.activity).components { add(coil3.network.okhttp.OkHttpNetworkFetcherFactory(callFactory = { client.http })) }.imageDecoderEnabled(false).build())
        val app = AppState(store, client)
        compose.setContent { DotTheme(ThemeMode.DARK) { OpenDotsRoot(app, app.state.collectAsStateForTest()) } }
        waitFor("I drafted the reply")
        compose.onNodeWithContentDescription("Circles").performClick()
        waitFor("Venty")
        tapUntil("Dev", "Here is my desktop.")
        // The shared capture is an image of the thread (not a line of text), and only the one that was really attached.
        compose.waitUntil(15_000) { compose.onAllNodes(androidx.compose.ui.test.hasContentDescription("desktop.png")).fetchSemanticsNodes().size == 1 }
        compose.waitUntil(15_000) { gets.any { it.first.startsWith("/computer/screenshots/0123456789abcdef") } }
        val fetched = gets.first { it.first.startsWith("/computer/screenshots/") }
        assertTrue(fetched.second, "opendots_session=tok123" in fetched.second)
        assertTrue(gets.none { it.first.contains("ffff") })
        // A capture that can no longer be fetched is still visible as a frame that says so, never as nothing.
        waitFor("Image unavailable")
        // The image is laid out at its decoded size, and its pixels are the capture's (blue with a light window).
        // (Robolectric has no ImageDecoder, so this test decodes with BitmapFactory; devices use either.)
        compose.waitUntil(15_000) { compose.onAllNodes(androidx.compose.ui.test.hasTestTag("image-loaded")).fetchSemanticsNodes().size == 1 }
        val pixels = compose.onNode(androidx.compose.ui.test.hasTestTag("image-loaded")).captureToImage().asAndroidBitmap()
        File(out, "screenshot-shared-image.png").outputStream().use { pixels.compress(Bitmap.CompressFormat.PNG, 100, it) }
        val sample = pixels.getPixel(pixels.width * 3 / 4, pixels.height * 3 / 4)
        // The capture's blue background, within rounding of scaling and blending.
        assertTrue("pixel ${Integer.toHexString(sample)}", kotlin.math.abs(android.graphics.Color.red(sample) - 0x2E) < 24 && kotlin.math.abs(android.graphics.Color.green(sample) - 0x5A) < 24 && kotlin.math.abs(android.graphics.Color.blue(sample) - 0xAC) < 24)
        shoot("screenshot-shared-dark")
    }

    @Test fun signInThenEnter() {
        signedIn = false
        launch(ThemeMode.LIGHT, cookie = null)
        waitFor("Welcome back")
        shoot("signin-light")
        compose.onNodeWithContentDescription("Email").performTextInput("robin@example.com")
        compose.onNodeWithContentDescription("Password").performTextInput("correct horse battery")
        compose.onNodeWithText("Sign in").performClick()
        waitFor("12,418 lines")
        val request = posts.first { it.first == "/auth/login" }.second
        assertTrue(request, "robin@example.com" in request)
    }

    @Test fun firstLaunchAsksForTheServer() {
        launch(ThemeMode.OLED, cookie = null, server = false)
        waitFor("Connect to BotCircle")
        shoot("server-oled")
    }

    private fun catalog(mode: ThemeMode) {
        compose.setContent { DotTheme(mode) { QuietCatalogScreen {} } }
        shoot("catalog-${mode.name.lowercase()}")
    }

    @Test fun catalogLight() = catalog(ThemeMode.LIGHT)
    @Test fun catalogDark() = catalog(ThemeMode.DARK)
    @Test fun catalogOled() = catalog(ThemeMode.OLED)
}
