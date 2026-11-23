# BotCircle for Android

A native Android client for the BotCircle engine: 100 % Kotlin and Jetpack Compose, no WebView.
It speaks the same HTTP API as the web app, so it works with any BotCircle server reachable over HTTPS.

## What it does

- One conversation per companion, with streamed replies, Markdown, code blocks and images.
- Reasoning and tool calls tucked behind a "Worked for…" line; terminal output and search results on demand.
- Approvals, "ready to send" email drafts and question forms, answered in the thread.
- Attachments of any type (system document picker): images are shown to the model, every other file is handed over
  unchanged and shown as a file card (name, type, size, Open, Save, Access with history and revoke).
- Background tasks as a single card updated in place (status, current step, actions run, Details / Pause / Cancel),
  listed under Tasks with their journal.
- Chats: free threads that belong to no companion, with their own model; `@Name` brings a companion in and its answer
  is signed.
- Secure sign-in: when a companion's browser hits a login page, a trusted card shows the real host and lets you take
  control of its browser; the companion's tools are suspended and it only learns the outcome.
- Settings: model providers with their status (OpenRouter key, ChatGPT device-code sign-in, Ollama), default model,
  agent behaviour.
- OpenCode: connect development machines (Settings → OpenCode); a delegated coding task is a single live card that
  opens a full-screen code workspace on that exact session (messages and tools, changes with diffs, project files,
  exchanges, permission prompts, direct instructions, Stop).
- Replies, reactions, stop.
- Full-screen pages, no drawer: Companions (home), Chats, Tasks, Approvals and Settings behind a quiet bottom bar; a
  conversation, a companion's profile (name, model, permissions) and its computer are pushed pages.
- A companion's computer, live, with optional take-over (mouse and keyboard).
- System, light, dark and true-black OLED themes; English and French.

A companion's memory and journal, and the exchanges between companions, are readable from the app. Connectors, skills
and tool settings are still managed from the web app (see `docs/parity.md` for the full matrix).

## Navigation

The app has no hamburger menu and no side drawer. This replaces the "side drawer" recommendation of section 8 of the
original Quiet UI spec for BotCircle Android (issue #28): do not reintroduce it.

- Top level: Companions, Chats, Tasks, Approvals, Settings, switched with the bottom bar. Android back returns to Companions.
- Companions → conversation → profile → model picker or computer. Back always leads to the page that opened the current one.
- Chats → chat → chat settings → model picker.
- Settings → model providers / default model / agent behaviour / OpenCode. A task card → code workspace, back to the
  page that opened it.
- The app reopens on the conversation it was left on.

## Modules

- `:designsystem` — Quiet UI, the design language shared with Dot Mail: tokens (`Tokens.kt`), theme, and
  components. Backdrop blur goes through `QuietBackdrop` (Haze 2.1); screens never use the blur engine directly.
  Glass is only used for the top header and floating controls; the composer and the bottom of the screen never blur.
- `:app` — the BotCircle client: `data/` (API client, stream assembler), `chat/` (conversation logic), `ui/` (screens).

Settings → Quiet UI catalog shows every token and component, plus a scrolling test for the blur.

## Build

```bash
./gradlew :app:assembleDebug
```

```bash
./gradlew :app:testDebugUnitTest
```

The tests drive the real app against a fake BotCircle engine and write a PNG of each screen to `app/build/shots`.

## Ephemeral chat (#57)

A **new, empty** general chat has a discreet icon (eye-off, "Ephemeral chat") in
its top bar. Tap it and the chat becomes ephemeral: you chat as usual, but the
conversation is never saved and never listed. Tap it again before any message
to go back to a normal chat. After the first message, in either mode, the icon
is gone: there is no conversion in either direction.

- It is the same screen as a normal chat (`EphemeralChatScreen`): same header,
  bubbles, streaming, composer and stop. A small persistent badge says
  "Ephemeral · not saved" and the empty state has one line: not saved, gone when
  you leave, the provider still processes the messages, not anonymous. The model
  is the new chat's default when it is OpenRouter/Ollama; the model sheet is the
  normal one, with Codex shown as unavailable. The "+" attaches images and files
  (up to 5 per turn, 10 MB each, 20 MB per turn; the server also caps a session):
  they are read into memory, sent base64 in the turn (`attachments`), never written
  to app storage, and drawn under the message (thumbnails from the in-memory bytes,
  file chips); the server answers limit errors with its own message, shown as is.
  @mentions, `/` commands, web search, replies and reactions are not offered, and
  replies show image links as text (no automatic remote request).
- Switching on deletes the empty normal chat that "New chat" had just created
  (`DELETE /api/chats/:id`) and removes it from the list at once; switching back
  creates a fresh one. The ephemeral chat itself is never in the Chats list, the
  archive or search.
- Server contract (unchanged): `POST /api/temporary-chats`, `GET`/`DELETE /:id`,
  `POST /:id/turn` (`text`, `model`) and `POST /:id/stop`; named
  `delta`/`done`/`stopped`/`failure` SSE events. OpenRouter and Ollama only.
- Transcript, partial answer, draft, model and ID live only in the AppState
  ViewModel's `TemporaryChatSession`. They never enter SessionStore, saved
  instance state, chat lists, search, uploads or analytics.
- **Leaving it erases it**: Back, another chat, tab, Circle, settings or a
  notification, a new chat, logout, an unauthorized session or a server change
  discard it (`DELETE`, best effort, five-second bound) and drop the local state. Leaving a
  non-empty one shows a short "Ephemeral chat erased" snackbar; there is no
  confirmation dialog. Configuration changes keep it.
- **Briefly in the background it is kept** (a live reply is stopped, completed
  turns stay); sends are never replayed. While it is open and visible the app
  reads `GET /:id` every 30 s as a heartbeat: the server renews its 30-minute
  idle timeout on any authenticated access. Process death or a long absence
  relies on that expiry (the heartbeat stops), checked again on return.
- Release builds set Android `FLAG_SECURE` on this screen (not debug builds) (screenshots/recents) and restores the
  prior flag on leaving. Logical deletion, not forensic erasure from runtime/OS
  memory. Providers, proxies and remote Ollama operators can retain data under
  their own policies; the mode is not anonymous. Errors use fixed localized
  categories, never upstream bodies or prompt fragments.
### Validation of this increment

The server baseline `72a0811` was tested in an isolated clone on SRV03:
`pnpm --filter @opendots/server exec vitest run test/git-broker.test.ts` →
**2 passed** (24.63 s); `pnpm test` → **50 files, 364 passed**, no skipped tests
(205.09 s). These are backend tests, **not Android tests**.

The initial local Android attempt found no `java` in PATH, no JAVA_HOME or SDK on
SRV03, and no JDK/SDK in the usual locations on Gentoo. The actual command
`./gradlew --no-daemon :app:compileReleaseKotlin` on SRV03 stopped before
compilation with `JAVA_HOME is not set and no 'java' command could be found`.
GitHub Actions subsequently provided the real Android build/test environment.

**Alpha.36 (`93d9385`) is compiled, tested and published.** The
[successful workflow](https://github.com/Sr-0w/BotCircle/actions/runs/43859884734)
ran `:app:assembleDebug`, `:app:compileReleaseKotlin` and
`:app:testDebugUnitTest`: **58 tests passed, zero failures/errors/skips** (10
temporary protocol/session tests, 14 protocol tests and 34 Compose screen tests).
That alpha's temporary-chat Compose scenario used the former separate page (replaced by the
ephemeral mode above; its tests now cover the icon, the switch, streaming, leaving and
the untouched Chats list).

The same workflow installed and cold-started the APK on an **Android 36 emulator**:
`am start -W` returned `Status: ok`, the connection screen contained `Server
address`, the app process remained alive, and the captured AndroidRuntime crash
log was empty. This startup smoke is not a live-provider test or a test on a
physical phone. Phone testing remains manual.

`TemporaryChatTest.kt` contains **10 passing JUnit tests** for named SSE,
strict transport/model scoping, cookie/header use, reconnect without replay,
stop/background, clean restart, expiry and unauthorized cleanup. With a toolchain:

```sh
./gradlew --no-daemon :app:compileReleaseKotlin :app:testDebugUnitTest --tests '*TemporaryChatTest'
```

Static checks executed successfully on Gentoo: generated EN/FR resource parity,
resource references, endpoint/cancellation/auth wiring, no durable-store/logging
calls in the temporary state/screen, and tree-sitter Kotlin grammar parsing of
nine source/test files. Syntax parsing is **not** Kotlin compilation.

```sh
python3 tools/strings.py app/src/main/res
python3 tools/check_temporary_chat.py
# Optional grammar parsing also needs tree-sitter==0.25.2, tree-sitter-kotlin==1.1.0.
```

The `.github/workflows/android-release.yml` installs Java 21 and the SDK, builds
the debug APK, compiles release Kotlin, runs unit/Compose tests and launches the
APK on an emulator **before** publishing a pre-release. Reports, test screenshots
and emulator startup evidence are uploaded even if validation fails. It triggers on a
change to `apps/android/RELEASE`, an `android-v*` tag or manual dispatch with a tag;
an ordinary code push without a RELEASE change does not publish an APK. Manual
`validation_only: true` runs the same checks without a tag/release publication.
The failed alpha.34 attempts did not publish; corrected alpha.35 and alpha.36
passed and were published. The original failures were test synchronization/
selector issues, not Kotlin compilation errors.

## Strings

`res/values{,-fr}/strings.xml` are generated: edit `tools/strings.py`, then run `python3 tools/strings.py app/src/main/res`.

## Release

For **each new Android feature**, increment `versionCode`/`versionName` in
`app/build.gradle.kts` (and the user-facing build metadata if present), and put
the matching `android-v…` tag in `RELEASE`. Push these together: the `Android
release` workflow publishes the APK as a GitHub pre-release only after build,
tests and emulator startup succeed. Do not mark an APK as tested from static
analysis alone. An already-green release does not need rebuilding just because
validation documentation changes.

The current APK is available from
[alpha.36](https://github.com/Sr-0w/BotCircle/releases/tag/android-v0.1.0-alpha.36).
These are debug-signed alpha APKs. If Android reports a signature mismatch with
an older installation, that APK cannot be updated in place; uninstall/reinstall
requires signing in again. Durable conversations remain on the server.
