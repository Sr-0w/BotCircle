# Incident #65 — day-old "Message reçu de Hugues" card in Ari's active chat

Forensics on SRV03 (`ov-cda3a0.infomaniak.ch`), read-only, on a copy of the PGlite database
(`~/OpenDots/data/users/usr_…/pg` copied to `/tmp`, deleted afterwards). Times are UTC; Zurich = UTC+1 in November.

## Findings (data)

| Item | Value |
|---|---|
| Team message | `tm_1biovifwia4smw`, from Hugues (`ag_i8t0s02gji3owx`) to Ari (`ag_hrog58b05pmcrj`), pair thread `cv_zzef5cuabj0cv5` |
| Content | "Confirmation demandée par Robin : j'ai réessayé et agent_update_profile(color="#8B5E3C") a bien renvoyé ok:true…" |
| Created / sent | 2026-11-15 10:48:32.088Z (= 11:48 Zurich) |
| Job | `team.deliver` #246: enqueued 10:48:32.091Z, locked 10:49:27.512Z, **attempts = 1**, status `done`, no `last_error` |
| Card in Ari's main chat | `msg_rcv_tm_1biovifwia4smw`, conversation `cv_adt73i5jx74774` (Ari main), **seq 1074**, `created_at` 2026-11-15 10:49:27.519Z (= 11:49 Zurich — the time printed on the card) |
| Status | `answered` at 10:50:18.783Z |
| Robin's request (OpenCode #57) | `msg_002b0f39…`, same conversation, **seq 1264**, 2026-11-16 08:20:32Z (= 09:20 Zurich); Ari's reply `msg_b7sxqzgs…` seq 1265, 08:22:42Z |

Checks:

* The card exists **once**, inserted by the first and only run of the job, in its chronological place (seq 1074, between
  Ari's other Nov 15 messages). No row exists with an old `created_at` and a recent `seq` (query: rows dated before
  2026-11-16 with seq above the first Nov 16 row → empty). Seq 1264 and 1265 are adjacent: **nothing sits between the
  user's request and Ari's reply in the database.**
* No retry, no replay, no late delivery, no duplicate for this event. The service restarts of Nov 15–16 (journalctl shows
  frequent deploy restarts) happened long after the job was `done`.
* So the hypothesis "stale/late/redelivered event" is **refuted for this incident**; the server stored and ordered it
  correctly. The card's shown time is its true creation time.

## What is wrong, then

1. **Surface (server, #61-related)**: inter-agent "Message reçu de …" cards are written into the recipient's *main user
   conversation* (`postTeamNote` → `mainConversationId`). Ari's chat is full of them (dozens on Nov 15). This is by design
   today and is the pollution #61 describes; it is not changed here.
2. **Placement (client, confirmed in code, cause of the screenshot)**: seq 1074 is ~190 messages before the end, so it can
   only appear between messages 1264 and 1265 through the client. In `ChatSession.resync` (Android) any message the screen
   already held that is absent from the freshly read window was re-appended **after** the window while a turn is busy
   (`pending = s.messages.filter { it.id !in remote … }`), whatever its age. An old persisted message held on screen
   (scroll-back page, "open at message" window, search focus) therefore reappeared at the end, right before the streaming
   reply — exactly the screenshot (user request → old card → Ari's answer). I could not run the emulator (lead-only), so
   the exact trigger on Robin's device is inferred, not observed.

## Fixes (branch `fix/65-stale-team-event-routing`)

* Android `ChatSession.mergeHistory`: only messages created locally by this device (`localIds`, i.e. unsent user messages)
  are kept after the window; old persisted messages are never re-appended. JVM tests: `MergeHistoryTest`.
* Server hardening (earlier commit): `team.deliver` replays (retry after failure, orphaned job requeued at restart) no
  longer re-insert / re-announce `msg_rcv_*`, `msg_ans_*` and the other notes (`saveMessage … ifAbsent`): before, a replay
  upserted the row and emitted `message.created` live. Regression: `apps/server/test/team-redelivery.test.ts`.
  This is a real but *different* failure mode from the observed incident.

Not done: moving the cards out of the main chat to Team Exchanges/Activity (#61).
