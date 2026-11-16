package app.dot.opendots.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class ApiException(message: String, val status: Int, val body: JsonObject? = null) : IOException(message)

/** Normalises what a person types ("opendots.example.com", "localhost:4317") into the server's base URL. */
fun normalizeServerUrl(input: String): HttpUrl? {
    val trimmed = input.trim().trimEnd('/')
    if (trimmed.isEmpty()) return null
    val local = Regex("^(localhost|127\\.0\\.0\\.1|10\\.0\\.2\\.2)(:\\d+)?(/.*)?$").matches(trimmed)
    val withScheme = if ("://" in trimmed) trimmed else (if (local) "http://" else "https://") + trimmed
    val url = withScheme.toHttpUrlOrNull() ?: return null
    return url.newBuilder().encodedPath("/").query(null).fragment(null).build()
}

/**
 * The BotCircle engine, as seen from a native client. It speaks the same HTTP API as the web app (`/api/...`): a session
 * cookie for identity, the `x-opendots-client` header on every call, server-sent events for realtime, and the AI SDK
 * UI-message stream for a companion's turn.
 */
class OpenDotsClient(private val store: SessionStore, baseClient: OkHttpClient = OkHttpClient()) : TemporaryChatApi {

    private val jar = object : CookieJar {
        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
            val session = cookies.lastOrNull { it.name == COOKIE } ?: return
            store.sessionCookie = if (session.value.isEmpty() || session.expiresAt < System.currentTimeMillis()) null else session.value
        }

        override fun loadForRequest(url: HttpUrl): List<Cookie> {
            val base = baseUrl ?: return emptyList()
            val value = store.sessionCookie ?: return emptyList()
            // Only ever sent to the server the user chose.
            if (url.host != base.host || url.port != base.port || url.scheme != base.scheme) return emptyList()
            return listOf(Cookie.Builder().name(COOKIE).value(value).domain(url.host).path("/").build())
        }
    }

    /** Shared with the image loader so attachments are fetched with the session. */
    val http: OkHttpClient = baseClient.newBuilder()
        .cookieJar(jar)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .addInterceptor { chain -> chain.proceed(chain.request().newBuilder().header("x-opendots-client", "1").build()) }
        .build()

    /** Streams stay open for as long as a turn runs; the server pings the event stream every 20 s. */
    private val streaming: OkHttpClient = http.newBuilder().readTimeout(0, TimeUnit.SECONDS).build()

    val baseUrl: HttpUrl? get() = store.serverUrl?.toHttpUrlOrNull()
    val hasSession: Boolean get() = store.sessionCookie != null

    /** Absolute URL of a server path such as `/api/attachments/abc`. */
    fun resolve(path: String): String = if (path.startsWith("http") || path.startsWith("data:")) path else (baseUrl?.resolve(path)?.toString() ?: path)

    private fun url(path: String): HttpUrl = (baseUrl ?: throw ApiException("No server", 0)).resolve("/api$path") ?: throw ApiException("Bad path", 0)

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { cancel() }
        enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { if (cont.isActive) cont.resumeWithException(e) }
            override fun onResponse(call: Call, response: Response) { cont.resume(response) }
        })
    }

    private suspend fun raw(method: String, path: String, body: RequestBody? = null): JsonElement {
        val request = Request.Builder().url(url(path)).method(method, body ?: if (method == "GET") null else EMPTY).build()
        http.newCall(request).await().use { response ->
            val text = response.body.string()
            val json = if (text.isBlank()) JsonObject(emptyMap()) else runCatching { OdJson.parseToJsonElement(text) }.getOrElse { JsonObject(emptyMap()) }
            if (!response.isSuccessful) throw ApiException(json.asObject()?.str("error") ?: "HTTP ${response.code}", response.code, json.asObject())
            return json
        }
    }

    private suspend fun json(method: String, path: String, body: JsonElement? = null): JsonElement =
        raw(method, path, body?.toString()?.toRequestBody(JSON))

    private suspend inline fun <reified T> get(path: String): T = OdJson.decodeFromJsonElement(json("GET", path))

    // --- Temporary chat: RAM-only server state; no normal history/upload endpoints. ----------
    private fun temporaryPath(id: String): String {
        require(Regex("^tmp_[a-f0-9]{48}$").matches(id)) { "Invalid temporary session" }
        return "/temporary-chats/$id"
    }

    override suspend fun createTemporaryChat(): TemporarySnapshot =
        OdJson.decodeFromJsonElement(json("POST", "/temporary-chats"))

    override suspend fun temporaryChat(id: String): TemporarySnapshot = get(temporaryPath(id))
    override suspend fun deleteTemporaryChat(id: String) { json("DELETE", temporaryPath(id)) }
    override suspend fun stopTemporaryChat(id: String) { json("POST", "${temporaryPath(id)}/stop") }

    override fun temporaryTurn(id: String, text: String, model: ModelConfig): Flow<TemporaryEvent> = callbackFlow {
        require(model.provider in setOf("openrouter", "ollama") && model.model.isNotBlank())
        require(text.isNotBlank() && text.length <= 16_000)
        // Explicit schema: do not accidentally send providerOrder, attachments, tools or mentions.
        val body = buildJsonObject {
            put("text", text)
            putJsonObject("model") {
                put("provider", model.provider); put("model", model.model)
                model.reasoning?.let { put("reasoning", it) }
            }
        }.toString().toRequestBody(JSON)
        val call = streaming.newCall(Request.Builder().url(url("${temporaryPath(id)}/turn"))
            .header("Accept", "text/event-stream").header("Cache-Control", "no-store").post(body).build())
        val worker = Thread {
            try {
                call.execute().use { response ->
                    if (!response.isSuccessful) throw ApiException("Temporary request failed", response.code)
                    readTemporaryEvents(response.body.source()) { trySendBlocking(it).getOrThrow() }
                }
                close()
            } catch (e: Exception) {
                // SDK, proxy and parse errors may embed input/output; never forward their diagnostics.
                close(ApiException("Temporary stream interrupted", (e as? ApiException)?.status ?: 0))
            }
        }
        worker.isDaemon = true
        worker.start()
        awaitClose { call.cancel() }
    }.flowOn(Dispatchers.IO)

    // --- Server & account ------------------------------------------------------------

    /** Checks that [candidate] really is an BotCircle engine, then adopts it. */
    suspend fun connect(candidate: HttpUrl): MeResponse {
        val previous = store.serverUrl
        if (previous != candidate.toString()) store.sessionCookie = null
        store.serverUrl = candidate.toString()
        return try { me() } catch (e: Exception) { store.serverUrl = previous; throw e }
    }

    suspend fun me(): MeResponse = get("/auth/me")
    suspend fun profile(): UserProfile = get("/profile")
    suspend fun setProfile(firstName: String?, lastName: String?): UserProfile = OdJson.decodeFromJsonElement(json("PUT", "/profile", buildJsonObject { put("firstName", firstName); put("lastName", lastName) }))

    suspend fun signIn(email: String, password: String, register: Boolean): Account {
        val body = buildJsonObject { put("email", email.trim()); put("password", password) }
        return OdJson.decodeFromJsonElement<AccountResponse>(json("POST", if (register) "/auth/register" else "/auth/login", body)).account
    }

    suspend fun signOut() {
        runCatching { json("POST", "/auth/logout") }
        store.sessionCookie = null
    }

    fun forgetSession() { store.sessionCookie = null }

    suspend fun bootstrap(): Bootstrap = get("/bootstrap")
    suspend fun saveOpenRouterKey(key: String) { json("POST", "/onboarding/key", buildJsonObject { put("key", key.trim()) }) }
    suspend fun openRouterModels(): List<ModelInfo> = get("/models/openrouter")
    /** Models of one provider: "openrouter" or "codex" (ChatGPT sign-in, configured from the web app). */
    suspend fun models(provider: String): List<ModelInfo> = get("/models/$provider")
    suspend fun availableModels(): AvailableModels = get("/models/available")
    suspend fun setFavoriteModels(favorites: List<FavoriteModel>) { json("PUT", "/models/favorites", buildJsonObject { put("favorites", OdJson.encodeToJsonElement(favorites)) }) }
    suspend fun completeOnboarding(model: String, timezone: String) {
        json("POST", "/onboarding/complete", buildJsonObject {
            putJsonObject("model") { put("provider", "openrouter"); put("model", model) }
            put("timezone", timezone)
        })
    }

    suspend fun settings(): ServerSettings = get("/settings")
    suspend fun updateSettings(patch: JsonObject) { json("PUT", "/settings", patch) }

    // --- Model providers (the same endpoints as the web settings) ---------------------------------
    suspend fun codexAccount(): CodexStatus = get("/codex/account")
    suspend fun codexLogin(): CodexLogin = OdJson.decodeFromJsonElement(json("POST", "/codex/login"))
    suspend fun codexLogout() { json("POST", "/codex/logout") }
    suspend fun ollamaModels(url: String?): List<ModelInfo> = get("/models/ollama" + (url?.takeIf { it.isNotBlank() }?.let { "?url=" + java.net.URLEncoder.encode(it, "UTF-8") } ?: ""))

    suspend fun setPaused(paused: Boolean) { json("PUT", "/settings", buildJsonObject { put("paused", paused) }) }

    // --- Companions ---------------------------------------------------------------------

    suspend fun agents(): List<Agent> = get("/agents")
    suspend fun markRead(agentId: String) { json("POST", "/agents/$agentId/read") }
    suspend fun stop(agentId: String) { json("POST", "/agents/$agentId/stop") }
    suspend fun stop(target: ChatTarget) { json("POST", "${target.path}/stop") }

    suspend fun updateAgent(agentId: String, patch: JsonObject): Agent = OdJson.decodeFromJsonElement(json("PATCH", "/agents/$agentId", patch))

    data class History(val conversationId: String, val messages: List<ChatMessage>, val cursor: Long?, val active: Boolean)

    suspend fun messages(agentId: String, before: Long? = null): History = messages(ChatTarget.Companion(agentId), before)

    suspend fun messages(target: ChatTarget, before: Long? = null): History {
        val root = json("GET", "${target.path}/messages" + (before?.let { "?before=$it" } ?: "")).asObject() ?: JsonObject(emptyMap())
        return History(
            conversationId = root.str("conversationId").orEmpty(),
            messages = root.arr("messages").orEmpty().mapNotNull { (it as? JsonObject)?.let(::parseMessage) },
            cursor = root.num("cursor")?.toLong(),
            active = root.bool("active") == true,
        )
    }

    suspend fun react(messageId: String, emoji: String): ReactionResult =
        OdJson.decodeFromJsonElement(json("POST", "/messages/$messageId/reactions", buildJsonObject { put("emoji", emoji) }))

    // --- Approvals, forms, drafts, activities ---------------------------------------------

    suspend fun approvals(status: String? = null): List<Approval> = get("/approvals" + (status?.let { "?status=$it" } ?: ""))
    suspend fun decide(approvalId: String, approve: Boolean): DecisionResult =
        OdJson.decodeFromJsonElement(json("POST", "/approvals/$approvalId", buildJsonObject { put("decision", if (approve) "approve" else "reject") }))

    suspend fun userRequest(id: String): UserRequest = get("/requests/$id")
    suspend fun draft(id: String): MailDraft = get("/mail/drafts/$id")

    suspend fun activities(): List<Activity> = get("/activities")
    suspend fun setActivityEnabled(id: String, enabled: Boolean): Activity =
        OdJson.decodeFromJsonElement(json("PATCH", "/activities/$id", buildJsonObject { put("enabled", enabled) }))
    suspend fun runActivity(id: String) { json("POST", "/activities/$id/run") }
    suspend fun deleteActivity(id: String) { json("DELETE", "/activities/$id") }

    // --- Companion computer -------------------------------------------------------------------

    suspend fun desktop(agentId: String): DesktopStatus = get("/computer/desktop?agentId=$agentId")
    suspend fun startDesktop(agentId: String): DesktopStatus =
        OdJson.decodeFromJsonElement(json("POST", "/computer/desktop/start?agentId=$agentId", buildJsonObject { put("notify", false) }))

    /** Human control: while it is on, the companion's own desktop tools wait instead of acting. */
    suspend fun setDesktopControl(agentId: String, enabled: Boolean) {
        json("POST", "/computer/desktop/control?agentId=$agentId", buildJsonObject { put("enabled", enabled) })
    }

    /**
     * The companion's screen as a VNC stream, relayed by the server over an authenticated WebSocket. The server only
     * accepts it from its own origin, so the Origin header is the server's.
     */
    fun desktopSocket(agentId: String, listener: okhttp3.WebSocketListener): okhttp3.WebSocket {
        val base = baseUrl ?: throw ApiException("No server", 0)
        val origin = "${base.scheme}://${base.host}" + if (base.port == HttpUrl.defaultPort(base.scheme)) "" else ":${base.port}"
        return streaming.newWebSocket(Request.Builder().url(url("/computer/vnc?agentId=$agentId")).header("Origin", origin).build(), listener)
    }

    // --- Attachments ------------------------------------------------------------------------

    suspend fun uploadImage(bytes: ByteArray, filename: String, mediaType: String): Attachment {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", filename, bytes.toRequestBody(mediaType.toMediaType()))
            .build()
        return OdJson.decodeFromJsonElement(raw("POST", "/attachments", body))
    }

    // --- Files (artifacts) -------------------------------------------------------------------

    /**
     * Any non-image file: stored unchanged as an artifact of the account. [agentId] gives that companion the right to
     * read it; [conversationId] attaches it to a general chat.
     */
    suspend fun uploadArtifact(body: RequestBody, filename: String, agentId: String? = null, conversationId: String? = null): Artifact {
        val form = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("file", filename, body)
        agentId?.let { form.addFormDataPart("agentId", it) }
        conversationId?.let { form.addFormDataPart("conversationId", it) }
        return OdJson.decodeFromJsonElement(raw("POST", "/artifacts", form.build()))
    }

    suspend fun artifacts(agentId: String? = null, conversationId: String? = null): List<Artifact> =
        get("/artifacts" + (agentId?.let { "?agentId=$it" } ?: conversationId?.let { "?conversationId=$it" } ?: ""))
    suspend fun artifact(id: String): ArtifactDetails = get("/artifacts/$id")
    suspend fun grantArtifact(id: String, agentId: String): ArtifactHistory = OdJson.decodeFromJsonElement(json("POST", "/artifacts/$id/grants", buildJsonObject { put("agentId", agentId) }))
    suspend fun revokeArtifact(id: String, agentId: String): ArtifactHistory = OdJson.decodeFromJsonElement(json("DELETE", "/artifacts/$id/grants/$agentId"))
    suspend fun deleteArtifact(id: String) { json("DELETE", "/artifacts/$id") }

    /** Downloads a private file (session required) into [target], unchanged. */
    suspend fun download(path: String, target: java.io.File) = kotlinx.coroutines.withContext(Dispatchers.IO) {
        val request = Request.Builder().url(resolve(path)).build()
        streaming.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw ApiException("HTTP ${response.code}", response.code)
            target.outputStream().use { out -> response.body.byteStream().copyTo(out) }
        }
    }

    // --- Secure sign-in --------------------------------------------------------------------------

    suspend fun secureLogins(pending: Boolean = false): List<SecureLogin> = get("/secure-logins" + if (pending) "?pending=1" else "")
    suspend fun secureLogin(id: String): SecureLogin = get("/secure-logins/$id")
    /** [outcome] is authenticated, cancelled or failed. Only this status ever reaches the companion. */
    suspend fun resolveSecureLogin(id: String, outcome: String): SecureLogin =
        OdJson.decodeFromJsonElement(json("POST", "/secure-logins/$id/resolve", buildJsonObject { put("outcome", outcome) }))

    // --- OpenCode ---------------------------------------------------------------------------------

    suspend fun opencodeInstances(): List<OpencodeInstance> = get("/opencode/instances")
    suspend fun haInstances(): List<HaInstance> = get("/homeassistant/instances")
    suspend fun haToken(url: String, mode: String, token: String): HaInstance = OdJson.decodeFromJsonElement(json("POST", "/homeassistant/token", buildJsonObject { put("url", url); put("mode", mode); put("token", token) }))
    suspend fun haOAuth(url: String, mode: String): HaAuthorize = OdJson.decodeFromJsonElement(json("POST", "/homeassistant/oauth/start", buildJsonObject { put("url", url); put("mode", mode) }))
    suspend fun haPolicy(id: String, body: kotlinx.serialization.json.JsonObject): HaInstance = OdJson.decodeFromJsonElement(json("PUT", "/homeassistant/instances/$id/policy", body))
    suspend fun haDelete(id: String) { json("DELETE", "/homeassistant/instances/$id") }
    suspend fun sshConnections(): List<SshConnection> = get("/ssh/connections")
    suspend fun saveSsh(id: String?, body: kotlinx.serialization.json.JsonObject): SshConnection = OdJson.decodeFromJsonElement(json(if (id == null) "POST" else "PUT", "/ssh/connections" + (id?.let { "/$it" } ?: ""), body))
    suspend fun deleteSsh(id: String) { json("DELETE", "/ssh/connections/$id") }
    suspend fun testSsh(id: String, trust: Boolean): SshTest = OdJson.decodeFromJsonElement(json("POST", "/ssh/connections/$id/test", buildJsonObject { put("trust", trust) }))
    suspend fun mentionables(agentId: String): List<Mentionable> = get("/agents/$agentId/mentionables")
    suspend fun opencodeProjects(instanceId: String): List<OpencodeProject> = get("/opencode/instances/$instanceId/projects")
    suspend fun opencodeSessions(): List<OpencodeMachineSessions> = get("/opencode/sessions")
    /** Code ＋: a session started directly by the user, no Circle in between. */
    suspend fun startCodeSession(instanceId: String, directory: String?, instruction: String): BgTask =
        OdJson.decodeFromJsonElement(json("POST", "/opencode/sessions", buildJsonObject { put("instanceId", instanceId); put("directory", directory); put("instruction", instruction) }))
    suspend fun attachCodeSession(instanceId: String, sessionId: String, directory: String?): BgTask =
        OdJson.decodeFromJsonElement(json("POST", "/opencode/sessions/attach", buildJsonObject { put("instanceId", instanceId); put("sessionId", sessionId); put("directory", directory) }))
    /** [body] holds name, baseUrl, username, defaultDirectory and, only when it changes, password. */
    suspend fun saveOpencodeInstance(id: String?, body: JsonObject): OpencodeInstance =
        OdJson.decodeFromJsonElement(json(if (id == null) "POST" else "PUT", "/opencode/instances" + (id?.let { "/$it" } ?: ""), body))
    /** The one-time link of `opencode pair` (or its QR code): the server redeems it and keeps the session token. */
    suspend fun pairOpencode(link: String, defaultDirectory: String?): OpencodeInstance =
        OdJson.decodeFromJsonElement(json("POST", "/opencode/instances/pair", buildJsonObject { put("link", link.trim()); if (defaultDirectory.isNullOrBlank()) put("defaultDirectory", JsonNull) else put("defaultDirectory", defaultDirectory.trim()) }))
    suspend fun checkOpencodeInstance(id: String): OpencodeInstance = OdJson.decodeFromJsonElement(json("POST", "/opencode/instances/$id/check"))
    suspend fun deleteOpencodeInstance(id: String) { json("DELETE", "/opencode/instances/$id") }
    suspend fun codeWorkspace(taskId: String): CodeWorkspace = get("/opencode/tasks/$taskId")
    /** Written by the user in the workspace: attributed to the user, sent to the task's own session. */
    /**
     * [delivery] (steer or queue) only matters while OpenCode is working. [files] (name, body) go to OpenCode on the
     * development machine with the instruction; BotCircle does not keep them.
     */
    suspend fun codePrompt(taskId: String, text: String, delivery: String? = null, files: List<Pair<String, RequestBody>> = emptyList()): PromptResult {
        if (files.isEmpty()) return OdJson.decodeFromJsonElement(json("POST", "/opencode/tasks/$taskId/prompt", buildJsonObject { put("text", text); if (delivery != null) put("delivery", delivery) }))
        val form = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("text", text)
        if (delivery != null) form.addFormDataPart("delivery", delivery)
        files.forEach { (name, body) -> form.addFormDataPart("file", name, body) }
        return OdJson.decodeFromJsonElement(raw("POST", "/opencode/tasks/$taskId/prompt", form.build()))
    }
    suspend fun codeAutoResume(taskId: String, enabled: Boolean) { json("POST", "/opencode/tasks/$taskId/auto-resume", buildJsonObject { put("enabled", enabled) }) }
    suspend fun codeModels(taskId: String): OpencodeModels = get("/opencode/tasks/$taskId/models")
    suspend fun codeSetModel(taskId: String, model: OpencodeModel, variant: String?): OpencodeCurrentModel =
        OdJson.decodeFromJsonElement(json("POST", "/opencode/tasks/$taskId/model", buildJsonObject { put("providerID", model.providerID); put("id", model.id); if (variant != null) put("variant", variant) }))
    /** [reply] is once, always or reject. */
    suspend fun codePermission(taskId: String, requestId: String, reply: String) { json("POST", "/opencode/tasks/$taskId/permissions/$requestId", buildJsonObject { put("reply", reply) }) }
    suspend fun codeQuestion(taskId: String, requestId: String, answers: List<List<String>>) {
        json("POST", "/opencode/tasks/$taskId/questions/$requestId", buildJsonObject { put("answers", buildJsonArray { answers.forEach { list -> add(buildJsonArray { list.forEach { add(JsonPrimitive(it)) } }) } }) })
    }
    suspend fun codeFiles(taskId: String, path: String): List<CodeFileNode> = get("/opencode/tasks/$taskId/files?path=" + java.net.URLEncoder.encode(path, "UTF-8"))
    suspend fun codeFile(taskId: String, path: String): CodeFile = get("/opencode/tasks/$taskId/file?path=" + java.net.URLEncoder.encode(path, "UTF-8"))

    // --- Memory, journal, team exchanges ----------------------------------------------------------

    /** What a companion remembers, followed by what every companion shares. */
    suspend fun memories(agentId: String): List<Memory> = get<List<Memory>>("/agents/$agentId/memories") + get<List<Memory>>("/memories/shared")
    suspend fun deleteMemory(id: String) { json("DELETE", "/memories/$id") }
    suspend fun journal(agentId: String): List<JournalEntry> = get("/journal?agentId=$agentId")
    suspend fun teamThreads(): List<TeamThread> = get("/team/threads")
    /** A thread between two companions, read-only. */
    suspend fun conversationMessages(conversationId: String): List<ChatMessage> =
        (json("GET", "/conversations/$conversationId/messages").asObject() ?: JsonObject(emptyMap())).arr("messages").orEmpty().mapNotNull { (it as? JsonObject)?.let(::parseMessage) }

    // --- Background tasks ------------------------------------------------------------------------

    suspend fun tasks(): List<BgTask> = get("/tasks")
    /** One task with its journal (`events`). */
    suspend fun task(id: String): BgTask = get("/tasks/$id")
    /** [action] is cancel, pause or resume. */
    suspend fun taskAction(id: String, action: String): BgTask = OdJson.decodeFromJsonElement(json("POST", "/tasks/$id/$action"))
    suspend fun taskInstruction(id: String, instruction: String): BgTask =
        OdJson.decodeFromJsonElement(json("POST", "/tasks/$id/instruction", buildJsonObject { put("instruction", instruction) }))

    // --- General chats -------------------------------------------------------------------------

    suspend fun chats(query: String? = null): List<GeneralChat> =
        get("/chats" + (query?.takeIf { it.isNotBlank() }?.let { "?q=" + java.net.URLEncoder.encode(it, "UTF-8") } ?: ""))
    /** Makes [agentId] the primary Circle (its avatar stands for Circles in the navigation). */
    suspend fun setPrimaryAgent(agentId: String) { json("PUT", "/agents/$agentId/primary") }
    /** #50: the silhouettes a Circle can take; [preset] null puts it back to the round dot. */
    suspend fun avatarPresets(): List<AvatarPreset> = get("/avatars/presets")
    suspend fun setAvatar(agentId: String, preset: String?) { json("PUT", "/agents/$agentId/avatar", buildJsonObject { put("preset", preset) }) }
    suspend fun restoreAvatar(agentId: String) { json("POST", "/agents/$agentId/avatar/restore") }
    suspend fun createChat(): GeneralChat = OdJson.decodeFromJsonElement(json("POST", "/chats", buildJsonObject { }))
    /** `/clear` on a companion: archives its main thread (kept, readable) and opens an empty one. */
    suspend fun clearConversation(agentId: String, conversationId: String) {
        json("POST", "/agents/$agentId/clear", buildJsonObject { put("conversationId", conversationId) })
    }
    suspend fun updateChat(id: String, patch: JsonObject): GeneralChat = OdJson.decodeFromJsonElement(json("PATCH", "/chats/$id", patch))
    // #56: archive (reversible), restore, delete (final; the server refuses while a reply runs or tasks are active, unless confirmed).
    suspend fun archivedChats(): List<GeneralChat> = get("/chats?archived=1")
    suspend fun archiveChat(id: String) { json("POST", "/chats/$id/archive") }
    suspend fun restoreChat(id: String) { json("POST", "/chats/$id/restore") }
    suspend fun deleteChat(id: String, stopActive: Boolean = false, confirmTasks: Boolean = false) {
        json("DELETE", "/chats/$id", buildJsonObject { if (stopActive) put("stopActive", true); if (confirmTasks) put("confirmTasks", true) })
    }
    suspend fun archivedThreads(agentId: String): List<ArchivedThread> = get("/agents/$agentId/archives")
    suspend fun archiveThread(agentId: String, conversationId: String) { json("POST", "/agents/$agentId/conversations/$conversationId/archive") }
    suspend fun restoreThread(agentId: String, conversationId: String) { json("POST", "/agents/$agentId/conversations/$conversationId/restore") }
    suspend fun deleteThread(agentId: String, conversationId: String, stopActive: Boolean = false, confirmTasks: Boolean = false) {
        json("DELETE", "/agents/$agentId/conversations/$conversationId", buildJsonObject { if (stopActive) put("stopActive", true); if (confirmTasks) put("confirmTasks", true) })
    }


    // --- Streams ------------------------------------------------------------------------------

    /** Sends one user message and follows the companion's turn. */
    fun chat(agentId: String, messageId: String, text: String, files: List<Attachment>, replyTo: ReplyRef?, answer: JsonObject?): Flow<JsonObject> =
        chat(ChatTarget.Companion(agentId), messageId, text, files, replyTo, answer)

    /** A new answer to the latest message of a general chat; the replaced one stays readable in its versions. */
    fun regenerate(target: ChatTarget): Flow<JsonObject> =
        sse(Request.Builder().url(url("${target.path}/chat")).post(buildJsonObject { put("regenerate", true) }.toString().toRequestBody(JSON)).build())

    fun chat(target: ChatTarget, messageId: String, text: String, files: List<Attachment>, replyTo: ReplyRef?, answer: JsonObject?, editOf: String? = null): Flow<JsonObject> {
        val message = buildJsonObject {
            put("id", messageId)
            put("role", "user")
            put("parts", buildJsonArray {
                if (text.isNotBlank()) add(buildJsonObject { put("type", "text"); put("text", text) })
                files.forEach { file -> add(buildJsonObject { put("type", "file"); put("url", file.url); put("filename", file.filename); put("mediaType", file.mediaType) }) }
            })
            putJsonObject("metadata") {
                put("kind", "chat")
                if (replyTo != null) put("replyTo", OdJson.encodeToJsonElement(replyTo))
                if (answer != null) put("answer", answer)
            }
        }
        val body = buildJsonObject { put("message", message); if (editOf != null) put("editOf", editOf) }.toString().toRequestBody(JSON)
        return sse(Request.Builder().url(url("${target.path}/chat")).post(body).build())
    }

    /** Joins the turn currently running for [agentId], replayed from its first chunk. Empty when nothing is running. */
    fun resume(agentId: String): Flow<JsonObject> = resume(ChatTarget.Companion(agentId))
    fun resume(target: ChatTarget): Flow<JsonObject> = sse(Request.Builder().url(url("${target.path}/stream")).build())

    /** The account's realtime events. Completes when the connection drops; the caller reconnects. */
    fun events(): Flow<ServerEvent> = callbackFlow {
        val call = streaming.newCall(Request.Builder().url(url("/events")).header("Accept", "text/event-stream").build())
        val worker = Thread {
            try {
                call.execute().use { response ->
                    if (!response.isSuccessful) throw ApiException("HTTP ${response.code}", response.code)
                    readSse(response) { data -> (runCatching { OdJson.parseToJsonElement(data) }.getOrNull() as? JsonObject)?.let(::parseServerEvent)?.let { trySend(it) } }
                }
                close()
            } catch (e: Exception) { close(e) }
        }
        worker.start()
        awaitClose { call.cancel() }
    }

    private fun sse(request: Request): Flow<JsonObject> = callbackFlow {
        val call = streaming.newCall(request)
        val worker = Thread {
            try {
                call.execute().use { response ->
                    if (response.code == 204) return@use
                    if (!response.isSuccessful) {
                        val text = runCatching { response.body.string() }.getOrDefault("")
                        val error = (runCatching { OdJson.parseToJsonElement(text) }.getOrNull() as? JsonObject)?.str("error")
                        throw ApiException(error ?: "HTTP ${response.code}", response.code)
                    }
                    readSse(response) { data -> (runCatching { OdJson.parseToJsonElement(data) }.getOrNull() as? JsonObject)?.let { trySend(it) } }
                }
                close()
            } catch (e: Exception) { close(e) }
        }
        worker.start()
        awaitClose { call.cancel() }
    }.flowOn(Dispatchers.IO)

    private fun readSse(response: Response, onData: (String) -> Unit) {
        val source = response.body.source()
        val data = StringBuilder()
        while (true) {
            val line = source.readUtf8Line() ?: break
            when {
                line.isEmpty() -> {
                    if (data.isNotEmpty()) { val payload = data.toString(); data.setLength(0); if (payload != "[DONE]") onData(payload) }
                }
                line.startsWith("data:") -> { if (data.isNotEmpty()) data.append('\n'); data.append(line.removePrefix("data:").removePrefix(" ")) }
            }
        }
    }

    private companion object {
        const val COOKIE = "opendots_session"
        val JSON = "application/json".toMediaType()
        val EMPTY = ByteArray(0).toRequestBody(null)
    }
}
