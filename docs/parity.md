# Web ↔ Android parity matrix

One row per capability. **Rule:** a feature is not "done" until both columns are filled or the gap is written here
with its reason. Update this file in the same change as the feature. "Tested" names the automated check; a row
without one has only been exercised by hand, or not at all on a device — nothing here has been run on a physical
phone yet.

States: ✅ available · ◐ partial · ✗ missing · — not relevant on that platform.

## Conversation

| Capability | Web | Android | Tested | Notes |
|---|---|---|---|---|
| Streamed replies, resume of a running turn | ✅ | ✅ | `ui-smoke`, `ScreensTest.sendingStreams…` | |
| History with older pages | ✅ | ✅ | `ProtocolTest` | |
| Markdown, code blocks, tables | ✅ | ✅ | `ScreensTest.conversation*` | |
| Reasoning and tools out of the thread, in a work panel | ✅ panel | ✅ sheet | `ui-smoke`, `ScreensTest.workStaysOut…` | |
| Live status line while working | ✅ | ✅ | | |
| Replies (quote) and reactions | ✅ | ✅ | | |
| Stop a turn | ✅ | ✅ | | |
| Image attachments | ✅ | ✅ | | Android re-encodes large or HEIC images |
| Any-file attachments, file cards (open, save, access) | ✅ | ✅ | `ui-work-smoke`, `ScreensTest.chats…` | Android open/save not run on a device |
| Shared screenshots shown and openable (#22) | ✅ | ✅ | `ProtocolTest`, `ScreensTest.aSharedScreenshot…` (fetched with the session, pixels checked) | An image that cannot be fetched shows an 'Image unavailable · Open' frame |
| Approvals in the thread | ✅ | ✅ | `ScreensTest.sendingStreams…` | |
| Question forms (`ask_user`) | ✅ | ✅ | | |
| Mail drafts: view, approve | ✅ | ✅ | | Editing a draft is Web only |
| Search inside a conversation | ✗ | ✗ | | Not built on either client |
| Edit / resend a message | ✗ | ✗ | | Not built on either client |
| Drag and drop, paste files | ✅ | — | `ui-work-smoke` | Android uses the system picker and share targets are not registered |

## Companions

| Capability | Web | Android | Tested | Notes |
|---|---|---|---|---|
| List, unread, state | ✅ | ✅ | `ScreensTest.pagesReplaceTheDrawer` | |
| Profile: name, permissions | ✅ | ✅ | same | |
| Per-companion model, reset to default (provider change) | ✅ | ✅ OpenRouter, ChatGPT | same | Ollama models cannot be picked on Android |
| Description, personality, instructions editing | ✅ | ✗ | | Done by talking to the companion; no form on Android |
| Create / archive a companion | ✅ | ✗ | | Create by asking a companion; archive is Web only |
| Activities (schedules, watches, webhooks): list, pause, run, delete | ✅ | ✅ | `ScreensTest.pagesReplaceTheDrawer` | |
| Activities: create / edit by form | ✅ | ✗ | | Created by asking a companion |
| Memory: view, forget | ✅ | ✅ | `ScreensTest.aCompanionsMemory…` | |
| Journal | ✅ | ✅ | | |
| Team exchanges between companions | ✅ | ✅ read-only | `ScreensTest.teamExchanges…` | OpenCode exchanges are in the code workspace on Android |

## Background tasks, chats, files

| Capability | Web | Android | Tested | Notes |
|---|---|---|---|---|
| Task card updated in place, details, journal, instruction, pause / resume / cancel (#24) | ✅ | ✅ | `ui-work-smoke`, `ScreensTest.aTaskShows…`, `live-model-check` | |
| Task list (running, finished) | ✅ panel tab | ✅ Tasks tab | same | |
| General chats: new, search, rename, model, delete (#29) | ✅ | ✅ | `ui-work-smoke`, `ScreensTest.chats…`, `live-model-check` | |
| `@mention` completion and touch action; signed contributions | ✅ | ✅ | same | |
| File access history, grant, revoke, delete (#30) | ✅ | ✅ | same | |
| Files list per companion / chat | ✅ | ✅ | | |

## Computer, sign-in, code

| Capability | Web | Android | Tested | Notes |
|---|---|---|---|---|
| Live view of a companion's computer | ✅ noVNC | ✅ native RFB | | Never run against a real desktop from this branch |
| Take control (mouse, keyboard) and hand back | ✅ | ✅ | | same |
| Start / stop the desktop | ✅ | ◐ start only | | |
| Desktop action permissions (ask / allow per action) | ✅ | ✗ | | |
| Secure sign-in card and takeover (#23) | ✅ | ✅ | `securelogin.test`, `ui-work-smoke`, `ScreensTest.aSignIn…` | No credential form on either: by design, see docs/computer-use.md |
| OpenCode instances: add, check, edit, remove (#31) | ✅ | ✅ | `ui-work-smoke` | |
| OpenCode pairing with `opencode pair --remote`: paste the link or scan its QR code | ✅ paste · QR where `BarcodeDetector` exists | ✅ paste · QR (Play services scanner) | `opencode-v2.test`, `opencode-real-check`, `ScreensTest.anOpenCodeMachineIsPaired…` | QR scanning itself is not exercised by the Robolectric test |
| Follow-up while OpenCode works: fold in now (steer) or after (queue) | ✅ | ✅ | `opencode.test`, `ScreensTest.anOpenCodeTask…` | OpenCode 1.x always queues |
| OpenCode task card and code workspace (session, changes, files, exchanges, prompts, permissions, stop) | ✅ side pane / full view | ✅ full screen | `opencode.test`, `ui-work-smoke`, `ScreensTest.anOpenCodeTask…`, `live-model-check` | Fakes of OpenCode 1.x/2.x, and a real OpenCode 2.3.0 (`opencode-real-check`) |
| Start an OpenCode task directly, without a companion | ✗ | ✗ | | Delegation goes through a companion |

## Settings

| Capability | Web | Android | Tested | Notes |
|---|---|---|---|---|
| Theme: system, light, dark, OLED | ✅ | ✅ | `ui-smoke`, `ScreensTest.*` | |
| Language | ✅ FR / EN | ✅ system (FR / EN) | | |
| Notifications when in background | ✅ browser | ✗ | | No push on Android: needs a push channel on the server |
| Model providers with status: OpenRouter, ChatGPT / Codex, Ollama (#26) | ✅ | ✅ | `ui-smoke`, `ScreensTest.providers…` | |
| Default model, reasoning effort, preferred provider | ✅ | ◐ model only | | |
| Agent behaviour: step limit, pause autonomous activity, time zone | ✅ | ✅ | `ui-smoke` | |
| Connectors (mail, MCP, integrations, plugins) | ✅ | ✗ | | OAuth pop-ups and catalog are Web only |
| Skills | ✅ | ✗ | | |
| Search and tools (search engine, shell approval, sudo) | ✅ | ✗ | | |
| Approvals list | ✅ | ✅ | `ScreensTest.pagesReplaceTheDrawer` | |
| Account: sign in, register, sign out | ✅ | ✅ | `ScreensTest.signInThenEnter` | |
| Onboarding | ✅ OpenRouter or ChatGPT | ◐ OpenRouter only | | |
| Administration (accounts, OAuth app credentials) | ✅ | ✗ | | |

## What "on a device" still needs

Blur (Haze), the document picker, opening and saving files, the VNC viewer with touch, keyboard and insets, TalkBack
and font scaling have only been checked in Robolectric or not at all. They are the first things to verify on a phone.
