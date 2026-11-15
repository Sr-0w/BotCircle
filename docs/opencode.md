# OpenCode in OpenDots

OpenCode does the coding on your development machine. OpenDots orchestrates: who may delegate, which machine and
session a task belongs to, what was said, and what you see.

## How it connects (and why)

OpenDots talks to the HTTP API of `opencode serve` — the same API the OpenCode TUI and web client use, described by
its OpenAPI spec (checked against the published SDK `@opencode-ai/sdk` 1.19, API v2). Authentication is HTTP Basic
(`OPENCODE_SERVER_PASSWORD`, username `opencode` by default).

Options considered:

| Option | Verdict |
|---|---|
| **Call the OpenCode HTTP API from the OpenDots server** | Chosen. Upstream-supported, versioned by an OpenAPI spec, covers sessions, prompts, status, permissions, diffs and files. No extra component to install or keep in sync. |
| Fork / embed OpenCode Web | Not done. It is a separate SolidJS app with its own design system and state; re-skinning it to Quiet UI and keeping it merged with upstream would cost more than rendering the API natively, and it would not exist on Android. |
| An OpenDots daemon on the development machine | Not needed: everything required is in the upstream API. It would only help with NAT traversal, which a private network already solves. |

What upstream does **not** provide: reaching a machine behind NAT. `opencode serve` listens on an address; something
must make that address reachable from the OpenDots server — a private network (Tailscale, WireGuard), an SSH tunnel
or an HTTPS reverse proxy. Never expose the port without a password.

```bash
OPENCODE_SERVER_PASSWORD=choose-one opencode serve --hostname 0.0.0.0 --port 4096
```

Then add the instance in **Settings → OpenCode** (Web or Android): name, address, password, default project
directory. The password is encrypted at rest and never returned. Allow a companion from its profile:
"Delegate code to OpenCode".

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
- **Follow-ups** go to the same session. If it is busy, OpenCode queues the message behind the current work — it does
  not interrupt it. If it had finished, the session restarts in the same context and the card runs again.
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
- A field to write to OpenCode directly (attributed to you), Stop, and the permission / question prompts.

## Not covered

- Compared with OpenCode's own UI: no terminal (PTY), no model / agent switch per session, no session fork, revert
  or share, no slash commands, no LSP or MCP panels. Those endpoints exist upstream and are not wired here.
- No push of events: state is polled, so the card can lag by a few seconds.
- Files produced on the development machine are not turned into OpenDots attachments; they stay there and are read
  through the workspace.
- Starting a task from the UI without a companion, and browsing sessions created outside OpenDots from the UI, are
  not offered (a companion can list and resume such sessions with `opencode_projects` and `session_id`).
- It has been exercised against a fake server that speaks the documented API and with a real model driving the
  companion — not yet against a real OpenCode instance.
