# Temporary general chat (issue #57, P2)

## Delivery status

This is a restricted **Web + backend first increment**, not completion of #57.
The checked-out default branch has Circle conversations only: independent normal
chats (#29/#38) and a native Android module are absent. Do not label mobile Web as
Android parity. A new normal general chat action cannot honestly be wired until
#29 exists; the UI says so rather than creating a hidden Circle or converting a
temporary transcript. Existing Circle history is unchanged. Circle temporary
conversations are deliberately unsupported.

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
- Expiry is **10 minutes after creation or the last accepted send**, and at most
  **30 minutes after creation**. Reads, navigation, polling and streaming do not
  renew it. Access checks enforce expiry immediately; a 15-second sweep removes
  otherwise unaccessed entries and aborts their requests. A busy process/event-loop
  stall can delay the sweep. Expiry is not a secure memory-erasure guarantee.
- Explicit close aborts inference and removes messages and the store entry.
  Browser `pagehide` makes a best-effort authenticated `DELETE` with keepalive;
  browser close/reload warns if there is an active temporary session. A crash,
  offline device, killed browser or lost DELETE relies on server expiry.
  Graceful server shutdown purges and aborts; restart loses all temporary data.
- The Web component stays mounted during SPA navigation, including when visiting
  a Circle or settings. Return using **Chat temporaire**. No transcript, draft or
  session ID goes to localStorage, sessionStorage, the URL, the normal chat store,
  analytics or a service worker. Hard reload/browser Back after leaving the
  document cannot recover the session. BFCache restoration clears local state.
  A browser can retain page/process memory; we cannot guarantee forensic erasure.
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
the RAM response. The user must select a model explicitly. Their API operators
can retain inputs, outputs and metadata under their own policies, including when
an Ollama endpoint is remotely configured. No zero-retention provider agreement
is asserted or automatically negotiated. Codex is rejected server-side until
its local app-server diagnostic persistence has been audited.

All tools are **disabled by policy** in this increment (`tools: {}`,
`toolChoice: 'none'`), including read-only Web tools. Tool calls unexpectedly
returned by a model are rejected, never executed. Uploads, file URLs/parts,
structured Circle/plugin mentions, delegation, schedules, connector actions,
memory writes, sharing and export are not accepted by the strict turn schema.
Plain `@Circle` or `/clear` text is just text, never a server action. No upload
picker or export/share controls are offered. This is a deliberate restriction,
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
| `GET /:id` | Snapshot of completed turns; no TTL extension |
| `POST /:id/turn` | Strict `{text, model: {provider, model, reasoning?}}`; OpenRouter/Ollama only |
| `POST /:id/stop` | Abort this session's inference only |
| `DELETE /:id` | Abort and purge; unknown/expired/foreign IDs return 404 |

SSE events: `delta` (JSON string), `done`, `stopped`, `failure` (fixed JSON string).
Concurrent sends return 409. Expired, discarded or inaccessible sessions return
404, never fall back to a normal conversation. Native Android can use this API
once its actual source and auth integration are available.

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
Chromium (`OPENDOTS_CHROMIUM_PATH` can override `/usr/bin/chromium`).
It creates/removes only its own `/tmp/opencode/temporary-chat-smoke-*` directory.
No production service, external model account or paid inference is used.

### Executed locally, 2026-11-16

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

| Criterion | Status / coverage |
| --- | --- |
| Web action, visible indicator, model, streaming, SPA continuity | Backend + desktop/mobile Web smoke |
| Native Android action and native lifecycle | **Blocked: no Android source in repo/workspace** |
| Completed context, no normal/archive/memory/profile/job writes | Backend test compares durable table snapshots and preserves a normal Circle thread |
| Global search/index/export exclusion | Structural separation; no independent general-chat search/export implementation to exercise yet |
| Stop, close, expiry, timeout, logout, disconnect, restart and redacted provider errors | Backend tests; real HTTP stop, close cancel/confirm and reload also in Chromium |
| Restricted tools/uploads/jobs and honest retention explanation | Server schema/toolset tests + displayed notice |
| Create a new normal general chat without contamination | **Blocked on #29**; new temporary state and existing normal Circle isolation tested |
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
actual application repository path, revision and Android source location before
preparing exact build/deployment commands. Do not run the Docker security tests
against production computer containers: they intentionally recreate fixtures.
