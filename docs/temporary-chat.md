# Temporary general chat (issue #57, P2)

## Delivery status

This is a restricted **Web + backend first increment**, not completion of #57.

### Web UX (ephemeral mode of a new chat)

Ephemeral chat is a **mode of a new, empty general chat**, not a separate page:

- A ghost icon ("Chat éphémère") appears on a new chat that has no message yet.
  Clicking it switches to ephemeral mode (route `#/chat/ephemeral`); clicking it
  again, still before any message, goes back to a normal chat. Once a message is
  sent, the icon disappears: there is no conversion in either direction.
- The ephemeral chat reuses the normal chat components (conversation, message
  bubbles, floating composer, streaming orb, stop button) through a custom
  `ChatTransport` over `/api/temporary-chats`. It shows a persistent
  "Éphémère · non sauvegardé" badge and one short empty-state sentence (not
  saved, gone when you leave, the provider still processes messages).
- The model defaults to the new chat's effective model when it is OpenRouter or
  Ollama and can be changed with the usual model menu; Codex is listed but
  disabled. Files and images can be attached ("+", paste, drag and drop) and
  appear in the bubble like in a normal chat (local previews). `@Circle`
  mentions, slash commands, web search, edit and regenerate are not offered.
- The empty normal chat created by "New chat" is deleted when switching to
  ephemeral mode (and removed from the sidebar); switching back creates a fresh
  one. The server session is created lazily on the first send, so toggling costs
  nothing. It never appears in the chat list, archive or search.
- Leaving the view (another chat, a Circle, settings, new chat), reloading or
  closing the tab sends `DELETE` and drops all local state. A non-empty chat shows
  the toast "Chat éphémère effacé" on leave; closing the tab with a non-empty
  ephemeral chat triggers the browser's `beforeunload` warning. A stopped or
  failed turn is not kept by the server and is dropped from the view as well.

Native Android now has a dedicated
temporary page and session implementation, compiled and tested with JUnit,
Compose and emulator startup in GitHub Actions (see `apps/android/README.md`).
Testing on a physical phone and with live providers remains manual.
Existing Circle history is unchanged. Circle temporary conversations remain
deliberately unsupported.

## Actual lifecycle and retention

- `temporary/store.ts` is a separate, bounded, in-process RAM store. No SQL rows,
  conversation IDs, message events, journal records, jobs, summaries, profile or
  memory updates are created. Consequently ordinary history/archive/search,
  export/share and attachment indexing pipelines have no temporary content to
  consume. This is **not** a flag on a durable conversation.
- Each session is owned by both the authenticated account and a hash of its login
  cookie. Another login, even for the same account, cannot retrieve it. Standard
  authentication and same-origin mutation checks still apply. IDs are random,
  opaque capabilities but do not replace authorization. Logout/revocation purges
  associated data immediately and aborts active inference.
- A session lives as long as the user stays in it. Expiry is an **idle timeout of
  30 minutes renewed by any authenticated access** (`GET`, which the Web client
  sends as a heartbeat every 30 s while the chat is open, as well as `turn`), plus
  a **12-hour absolute safety cap**. Access checks enforce expiry immediately; a
  15-second sweep removes otherwise unaccessed entries and aborts their requests.
  A busy process/event-loop stall can delay the sweep. Expiry is not a secure
  memory-erasure guarantee.
- Explicit close aborts inference and removes messages and the store entry.
  Leaving the Web view or `pagehide` makes a best-effort authenticated `DELETE`
  with keepalive. A crash, offline device, killed browser or lost DELETE relies on
  the idle timeout. Graceful server shutdown purges and aborts; restart loses all
  temporary data (the Web client notices on its next heartbeat and clears the view).
- The Web view is unmounted on any navigation, so the session cannot be resumed.
  No transcript, draft or session ID goes to localStorage, sessionStorage, the
  URL, the normal chat store, analytics or a service worker. Reload or browser
  Back cannot recover the session. A browser can retain page/process memory; we
  cannot guarantee forensic erasure.
- Within the same open document/login, reconnect fetches only completed turns
  until expiry. A disconnected/stopped/failed turn is not committed, and can be
  retried. If the completion was committed just before a lost network response,
  fetch the snapshot before retrying: there is no automatic replay, resumable
  stream or cross-device recovery. No conversion to a durable thread exists.
- Limits: 3 sessions per login scope, 1,000 process-wide; 16,000 characters per
  prompt; 100,000 characters/100 messages per session. Over-limit sends are
  rejected, not silently summarized. Responses are capped at 8,192 output tokens,
  the context character budget and a 120-second request timeout. No retries.
- The app logically releases references on deletion. Garbage collection, OS swap,
  crash/core dumps, reverse proxies, browser extensions and infrastructure packet
  capture are outside this guarantee. Disable body capture, verbose SDK/network
  tracing and core dumps in deployment; review proxy/APM configuration before
  making stronger privacy claims. Do not claim “zero storage”.

## Providers, diagnostics and capabilities

OpenRouter and Ollama use the normal account model gateway and credentials;
model choice belongs to each send, with the effective model recorded only in
the RAM response. Web defaults to the new chat's model when supported. Their API operators
can retain inputs, outputs and metadata under their own policies, including when
an Ollama endpoint is remotely configured. No zero-retention provider agreement
is asserted or automatically negotiated. Codex is rejected server-side until
its local app-server diagnostic persistence has been audited.

All tools are **disabled by policy** in this increment (`tools: {}`,
`toolChoice: 'none'`), including read-only Web tools. Tool calls unexpectedly
returned by a model are rejected, never executed. File URLs/artifact
references, structured Circle/plugin mentions, delegation, schedules, connector
actions, memory writes, sharing and export are not accepted by the strict turn
schema. The only file input is the inline `attachments` field described below.
Plain `@Circle` or `/clear` text is just text, never a server action. No
export/share controls are offered. This is a deliberate restriction,
not a claim to preserve full tool parity. Other API actions explicitly performed
by the user outside this session retain their ordinary durable semantics.

The temporary route catches validation, model-resolution and streaming failures
before the parent API's verbose logger. Errors and audit responses contain only
fixed messages, never upstream errors, prompt fragments, model output or
validation dumps. SDK telemetry is not enabled; the SDK's default stream error
logger is replaced. Inference cancellation is wired to disconnect, explicit stop,
close, logout, expiry, timeout and shutdown. Provider-side cancellation is best
effort: providers may finish/charge an already submitted request.

## API contract

All paths are under `/api/temporary-chats`, require the normal login cookie, and
mutations require `x-opendots-client: 1` plus standard same-origin checks.
Responses, including SSE, are `Cache-Control: no-store`.

| Method/path | Behavior |
| --- | --- |
| `POST /` | Create RAM session; return `{id, expiresAt, messages, busy}` |
| `GET /:id` | Snapshot of completed turns; renews the 30 min idle window (keepalive) |
| `POST /:id/turn` | Strict `{text, model: {provider, model, reasoning?}, attachments?: [{name, mediaType, data}]}`; OpenRouter/Ollama only. `text` may be empty if attachments are present; `data` is base64 without `data:` prefix |
| `POST /:id/stop` | Abort this session's inference only |
| `DELETE /:id` | Abort and purge; unknown/expired/foreign IDs return 404 |

### Attachments

Up to 5 per turn, 10 MB decoded each, 20 MB per turn and 50 MB per session;
over-limit requests get 400/413 with a fixed French message (the turn route alone
accepts a ~28 MB body; every other route stays at 70 kB). Bytes are held in the
RAM session only (never in artifacts, the uploads/attachments directories, the
DB, logs or the journal) and are zeroed and dropped on `DELETE`, expiry, logout
and shutdown. Snapshots (`POST /`, `GET /:id`) return metadata only: user
messages gain `attachments: [{name, mediaType, size}]`, never the bytes.
Earlier attachments stay in the context of later turns. The model input mirrors
the normal chat: images go through the same normalization (JPEG, 2048 px max)
and are sent as image parts regardless of the model (a non-vision model gets the
same provider behaviour as in a normal chat); PDFs are sent as file parts;
UTF-8 text files are inlined (first 60,000 characters, flagged as untrusted
external data); other binaries are mentioned by name/type only.

SSE events: `delta` (JSON string), `done`, `stopped`, `failure` (fixed JSON string).
Concurrent sends return 409. Expired, discarded or inaccessible sessions return
404, never fall back to a normal conversation. The native Android temporary page
uses this same contract, including named SSE events and cancellation.

## Validation and remaining acceptance work

Commands from the repository root:

```sh
npx --yes pnpm@10.28.0 install --frozen-lockfile
npx --yes pnpm@10.28.0 typecheck
npx --yes pnpm@10.28.0 --filter @opendots/server exec vitest run test/temporary-chat.test.ts
npx --yes pnpm@10.28.0 build
npx --yes pnpm@10.28.0 test:temporary:ui
npx --yes pnpm@10.28.0 test
npx --yes pnpm@10.28.0 --filter @opendots/server exec vitest run --exclude test/git-broker.test.ts
```

The smoke script serves the actual built Web client and authenticated backend on
loopback, intercepts inference with a local Ollama fixture and uses system
Chromium (`OPENDOTS_CHROMIUM_PATH` can override `/usr/bin/chromium`; on Windows
point it at Chrome or Edge). It covers the icon on a new chat, toggling on/off,
removal and re-creation of the empty normal chat, streaming, stop, absence from
list/archive/search, and deletion of the session on navigation and reload.
It creates/removes only its own temporary directory under the OS temp folder.
No production service, external model account or paid inference is used.

### Production-baseline rebase validation, 2026-11-16

The three temporary-chat commits were transplanted onto
`e1c8498e6f13251b485a3c3da616d7bcf1906fd5`, without replaying the unrelated
historical approvals/delegation commit `7ec9dfd`. Conflict resolution preserves
all production API routes, shell views, archive controls, settings navigation,
Code workspace and existing package scripts.

- Frozen install succeeded; 17 additional packages were installed. pnpm warned
  that optional build scripts for `cpu-features` and `ssh2` were not run.
- Root build succeeded: `2989 modules transformed`, `built in 656ms`.
  Existing Vite configuration/chunk warnings remain.
- Root typecheck succeeded: shared/server/web all `Done`.
- Temporary API tests: `Test Files 1 passed (1)`, `Tests 16 passed (16)`.
- Chromium smoke passed at `1365x1000` and `390x844`, including production
  search/archive exclusion and explicit creation of an empty normal general chat
  with empty tasks, while preserving the separate temporary context.
- The first full root test attempt timed out after 120 seconds, after reporting
  both Docker-dependent `git-broker.test.ts` failures. It was rerun with a
  600-second limit; no tests were removed or weakened to make the run pass.
- The complete rerun finished in 137.79 seconds with exit 1:
  `Test Files 1 failed | 49 passed (50)`,
  `Tests 2 failed | 360 passed | 2 skipped (364)`. Both failures remain the
  Docker-availability assertion and null Docker container in `git-broker.test.ts`.
  This is not an all-green validation, so the conditional push is not performed.

### Original pre-rebase validation, 2026-11-16

- Frozen-lockfile install: success, 502 packages.
- `typecheck`: shared/server/web all `Done`.
- Targeted tests: `Test Files 1 passed (1)`, `Tests 16 passed (16)`.
- Web build: exit 0, `2953 modules transformed`; existing Vite config,
  large-chunk and ineffective-dynamic-import warnings remain.
- Chromium smoke: both `PASS Chromium 1365x1000` and `PASS Chromium 390x844`,
  including real HTTP stop propagated to the mocked provider's abort signal.
- First full `test` run (before adding the final two targeted tests):
  `Test Files 1 failed | 31 passed (32)`,
  `Tests 2 failed | 269 passed | 2 skipped (273)`. Both failures are in the
  existing `test/git-broker.test.ts`: Docker availability assertion and a null
  Docker container in its SELinux migration test. Docker is not available to
  those tests here; no production container was accessed to work around this.
- Final regression run excluding only that Docker-dependent file:
  `Test Files 31 passed (31)`, `Tests 271 passed | 2 skipped (273)`,
  exit 0, 84.74 seconds. The two Docker tests remain unvalidated.

### SRV03 follow-up and Android implementation, 2026-11-16

After host-key verification, the bundle containing `72a0811` was tested in the
separate `/home/fedora/sol-test-clone`, not the running application directory:

- Docker regression tests: `1 passed` file, `2 passed` tests, 24.63 seconds.
- Complete root `pnpm test`: `50 passed` files, `364 passed` tests, no skipped
  tests, exit 0, 205.09 seconds. This resolved the Gentoo Docker validation gap;
  `72a0811` was then pushed fast-forward to the production branch.
- Android was added without changing server/Web source. Static resource,
  contract/lifecycle and Kotlin syntax checks pass; ten JUnit tests are defined
  but not executed. The attempted Gradle compile stopped before compilation:
  no Java/JAVA_HOME or Android SDK was found. No native APK/device validation is
  claimed. The existing release workflow builds APKs but was not dispatched.

### GitHub Android validation follow-up, 2026-11-16

The release workflow now gates publication on debug APK build, release Kotlin
compilation, unit/Compose tests and APK startup on an Android 36 emulator. The
first alpha.34 runs compiled but exposed two Robolectric synchronization/selector
issues; these were fixed without dropping the original assertions. The alpha.35
and alpha.36 workflows succeeded and published installable APKs.

The verified [alpha.36 run](https://github.com/Sr-0w/BotCircle/actions/runs/43859884734)
at `93d9385` contains JUnit XML for **58 passing tests**, no failures/errors/skips:
10 temporary session/transport tests, 14 protocol tests and 34 Compose screen
tests, including the complete temporary UI scenario. Emulator evidence reports
`Status: ok`, a live process and the initial connection screen, with an empty
AndroidRuntime crash log. Temporary UI screenshots use synthetic mock data.
This supersedes the initial local-only Android validation limitation above.

| Criterion | Status / coverage |
| --- | --- |
| Web action, visible indicator, model, streaming, SPA continuity | Backend + desktop/mobile Web smoke |
| Native Android action and native lifecycle | Kotlin debug/release compilation and JUnit/Compose tests pass; APK starts on emulator; physical phone/live providers remain manual |
| Completed context, no normal/archive/memory/profile/job writes | Backend test compares durable table snapshots and preserves a normal Circle thread |
| Global search/index/export exclusion | Structural separation; real production general-chat search and archive exclusion also checked in Chromium |
| Stop, close, expiry, timeout, logout, disconnect, restart and redacted provider errors | Backend tests; real HTTP stop, close cancel/confirm and reload also in Chromium |
| Restricted tools/uploads/jobs and honest retention explanation | Server schema/toolset tests + displayed notice |
| Create a new normal general chat without contamination | Explicit new-chat action; Chromium verifies empty normal messages/tasks and preserved temporary context |
| Physical Android, live providers, deployed proxy/APM and live expiry | **Not tested** |

## Production validation (Ari only)

No SRV03 connection or deployment is performed by this session. Do **not** deploy
this increment as a complete #57 release. No database migration is needed.

First identify the actual application deployment rather than assuming that the
historical `opendots-computer` and `opendots-search` containers run the HTTP app.
Read-only commands, working directory `/`:

```sh
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
docker inspect opendots-computer opendots-search --format '{{.Name}} compose_dir={{index .Config.Labels "com.docker.compose.project.working_dir"}} service={{index .Config.Labels "com.docker.compose.service"}}'
```

Purpose: report service names and Compose working directories, without dumping
environment variables, credentials, bodies or conversation logs. Supply the
actual application repository path and revision before
preparing exact build/deployment commands. Do not run the Docker security tests
against production computer containers: they intentionally recreate fixtures.
