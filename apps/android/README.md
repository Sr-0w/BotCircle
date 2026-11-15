# OpenDots for Android

A native Android client for the OpenDots engine: 100 % Kotlin and Jetpack Compose, no WebView.
It speaks the same HTTP API as the web app, so it works with any OpenDots server reachable over HTTPS.

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
original Quiet UI spec for OpenDots Android (issue #28): do not reintroduce it.

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
- `:app` — the OpenDots client: `data/` (API client, stream assembler), `chat/` (conversation logic), `ui/` (screens).

Settings → Quiet UI catalog shows every token and component, plus a scrolling test for the blur.

## Build

```bash
./gradlew :app:assembleDebug
```

```bash
./gradlew :app:testDebugUnitTest
```

The tests drive the real app against a fake OpenDots engine and write a PNG of each screen to `app/build/shots`.

## Strings

`res/values{,-fr}/strings.xml` are generated: edit `tools/strings.py`, then run `python3 tools/strings.py app/src/main/res`.

## Release

Put the tag to publish (for example `android-v0.1.0-alpha.2`) in `RELEASE` and push: the
`Android release` workflow builds the APK and publishes it as a GitHub pre-release.
