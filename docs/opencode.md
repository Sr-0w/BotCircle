# OpenCode in BotCircle

OpenCode does the coding on your development machine. BotCircle orchestrates: who may delegate, which machine and
session a task belongs to, what was said, and what you see.

## How it connects (and why)

BotCircle talks to the HTTP API of `opencode serve` — the same API the OpenCode TUI, web and mobile clients use. Two
generations exist and both are supported; the server detects which one answers (`GET /api/info`, otherwise
`GET /global/health`) and remembers it per instance:

- **OpenCode 2.x** (`@opencode/cli`, protocol `@opencode/protocol`): everything under `/api/…` — sessions with a
  `location`, one assistant message per step, `prompt` with `delivery: steer | queue`, `interrupt`, forms, permissions,
  diff between turns, files. Verified end to end against a real `opencode serve` 2.3.0
  (`apps/server/scripts/opencode-real-check.ts`).
- **OpenCode 1.x** (`@opencode-ai/sdk` 1.19): `/session`, `/global/health`, `prompt_async`.

### Pairing (recommended): `opencode pair --remote`

```bash
opencode pair --remote
```

It prints a one-time link `https://<id>.opentunnel.xyz/auth/connect/<code>` and its QR code. `--remote` publishes
the instance through OpenTunnel, so it works behind a NAT without opening a port. In **Settings → OpenCode → Pair with
a link**, paste the link (Web, Android) or scan the QR code (Web where the browser has `BarcodeDetector`, Android
through the Google Play services scanner, which needs no camera permission for the app).

- The BotCircle **server** redeems the code (`GET /auth/connect/<code>`, `Accept: application/json`) and keeps the
  token it gets, encrypted at rest, never returned. Requests then use HTTP Basic `opencode:<token>`.
- The link works **once, for 5 minutes**. Don't open it in a browser or scan it with the phone's camera app: that
  uses it up. Pairing lasts **30 days**; the card shows "paired until …". When it expires or is revoked, the instance
  shows it and asks for a new `opencode pair --remote`; pairing again the same address renews it in place.

### Address and password

```bash
OPENCODE_SERVER_PASSWORD=choose-one opencode serve --hostname 0.0.0.0 --port 4096
```

The BotCircle server must reach that address: a private network (Tailscale, WireGuard), an SSH tunnel or an HTTPS
reverse proxy. Never expose the port without a password. Add it in **Settings → OpenCode → Address and password**.

Options considered:

| Option | Verdict |
|---|---|
| **Call the OpenCode HTTP API from the BotCircle server** | Chosen. Upstream-supported, covers sessions, prompts, status, permissions, diffs and files. Pairing and OpenTunnel come from upstream too. |
| Fork / embed OpenCode Web | Not done. A separate app with its own design system; re-skinning it to Quiet UI and keeping it merged would cost more than rendering the API natively, and it would not exist on Android. |
| A BotCircle daemon on the development machine | Not needed: `opencode pair --remote` already solves NAT traversal. |

Allow a companion from its profile: "Delegate code to OpenCode".

## What a delegation is

A task of the shared registry (the one background workers use) with provider `opencode`. It keeps the instance, the
session id and the directory, so an instruction can never land in another session. Same single card, same Tasks list.

- **State is read, not assumed.** Every engine tick (5 s) each active task is reconciled with its session: current
  tool, finished tool calls, pending permission or question, retry, idle.
- **Unreachable is not failed.** If the instance does not answer, the card shows the last known state marked
  "state unknown"; nothing is concluded. Stop is only reported once the abort reached the instance.
- **Completion is delivered.** When the session goes idle with a finished answer, the companion that delegated is
  woken with OpenCode's own report and the changed files, exactly once. It reviews (`opencode_changes`) and either
  continues the same session or reports to you. "Finished" means the session stopped, not that tests passed.
- **Follow-ups** go to the same session. While it works, the message is either folded into the current work
  (`steer`, default) or handled after it (`queue`) — the companion picks with `opencode_send mode`, you pick in the
  workspace. With OpenCode 1.x it is always queued. If it had finished, the session restarts in the same context.
  The current turn is everything after the last user message, so a queued instruction must be answered before the
  task completes.
- **Permissions and questions** from OpenCode suspend only that task. You answer them in the code workspace; the
  reply goes to that session and gives the companion no access of its own.

Companion tools (permission `code`): `opencode_instances`, `opencode_projects`, `opencode_start`, `opencode_status`,
`opencode_send`, `opencode_stop`, `opencode_changes`. With several instances and no name given, the companion must ask.

## The code workspace

Opening a card opens that session: beside the chat on desktop (expandable), full screen on a phone.

- **Session**: messages, with tool calls folded (input and output on demand), reasoning folded.
- **Changes**: files changed by the session with additions, deletions and the diff.
- **Files**: the project tree and file contents, read on the development machine on demand; nothing is copied.
- **Exchanges**: what was really sent to OpenCode, by whom (you or a companion), with your original words when a
  companion rephrased them, and OpenCode's results. Tool and terminal noise stays out of it. On the Web the same
  exchanges appear under Settings → Team exchanges.
- A field to write to OpenCode directly (attributed to you), laid out like a coding agent's: the text, then **+** to
  attach files, the session's **model** (with its effort when it has some) and Send / Stop.
  - The model list is the instance's own (`GET /api/model`, cached 5 minutes). Choosing one switches the session's
    model on the development machine (`POST /api/session/:id/model`); with OpenCode 1.x it is sent with each
    instruction instead.
  - Attached files (up to 8, 10 MB each, 20 MB in all) are sent inline with the instruction straight to OpenCode;
    BotCircle does not keep them, and only their names come back in the session. An image or a PDF is refused before
    sending when the session's model cannot read it.
- The permission / question prompts.

## Not covered

- Compared with OpenCode's own UI: no terminal (PTY), no model / agent switch per session, no session fork, revert
  or share, no slash commands, no LSP or MCP panels. Those endpoints exist upstream and are not wired here.
- No push of events: state is polled, so the card can lag by a few seconds.
- Files produced on the development machine are not turned into BotCircle attachments; they stay there and are read
  through the workspace.
- Starting a task from the UI without a companion, and browsing sessions created outside BotCircle from the UI, are
  not offered (a companion can list and resume such sessions with `opencode_projects` and `session_id`).
- Tested against fakes of both API generations, with a real model driving the companion, and against a real
  OpenCode 2.3.0 (pairing, single-use link, edit, diff, files, permission, stop).
