# Post-rebrand audit (#75): OpenDots → BotCircle

Method: `git grep -nIiE "open[ _-]?dots"` over the whole tree (excluding `pnpm-lock.yaml`, `apps/server/drizzle`), a
stricter pass for the old name used *as a name* (`(?<![@./\w-])open[ _-]?dots(?![./\w:-])`, plus capitalised/spaced
variants `OpenDots`, `Open Dots`, `open-dots`), a scan of the built web bundle (`apps/web/dist`) and an `aapt2 dump
badging/strings` of a freshly built debug APK (`app-debug.apk`, alpha.36).

## Replaced in this branch

| File | Change |
|---|---|
| `README.md`, `docs/docker-compose.md` | clone URL / directory → `Sr-0w/BotCircle` |
| `docs/renaming.md` | repository rename is done; clone/remote instructions updated |
| `apps/android/.../OpenDotsClient.kt`, `GateScreens.kt` | example server address `botcircle.example.com` (placeholder shown to the user) |
| `apps/server/src/models/gateway.ts`, `tools/web.ts` | OpenRouter `HTTP-Referer` and fetch `User-Agent` URL → `github.com/Sr-0w/BotCircle` |
| `apps/server/src/models/codex.ts` | Codex `clientInfo.title: 'BotCircle'` (`name: 'opendots'` kept: protocol identifier) |
| `apps/web/.../connector-dialogs.tsx` | plugin URL placeholder `botcircle-plugin.json` |
| `apps/server/scripts/ui-work-smoke.ts`, `ScreensTest.kt` | fixture project path `/home/dev/botcircle` (and the matching assertion) |
| `apps/server/test/branding.test.ts` (new) | regression guard: no old brand in Android `strings.xml`, manifest, web `index.html`/`public`, web translations, agent prompts; matcher self-test spares identifiers and `OpenCode` |

## Kept on purpose (technical identifiers — changing them would break existing installs)

| Occurrence | Why kept |
|---|---|
| npm scope `@opendots/*`, root package `opendots`, `pnpm --filter @opendots/…` | internal workspace names, not user-visible |
| `OPENDOTS_*` env vars (`OPENDOTS_DATA_DIR`, `OPENDOTS_CONTAINER`, `OPENDOTS_PUBLIC_URL`, `OPENDOTS_DOMAIN`…) | deployed `.env` / systemd files depend on them |
| `opendots_session` cookie, `x-opendots-client` header, `opendots:unauthorized` / `opendots:oauth` / `opendots:work-panel` browser events, `opendots-oauth-*` popup name | session continuity and CSRF contract between web, Android and server |
| Android `applicationId`/`namespace` `app.dot.opendots`, package `app.dot.opendots.*`, `Theme.OpenDots`, `OpenDotsApp`, `OpenDotsClient`, SharedPreferences file `opendots`, Keystore alias `opendots.session` | stable Android identity; stored sessions/keys |
| Docker: image `opendots/server`, `opendots/computer:N`, compose project/service `opendots`, labels `opendots.*`, containers `opendots-computer*`, `opendots-search-*`, volume cache ids | running deployments, built computer images and container discovery use them |
| In-container tools `opendots-open-browser`, `opendots-shell-run`, `opendots-chromium`, `opendots-browser.desktop`, `opendots-proxy` certificate | referenced by the computer image and by agent prompts; renaming needs an image rebuild |
| Temp dir prefixes `opendots-*-` in scripts/tests, `opendots-data*.tgz` in `.gitignore`, CA file names in `deploy/` and `Dockerfile` secret ids | internal, invisible to users |
| `opendots.snyders.xyz` in `docs/accounts-and-connectors.md`, `deploy/compose.env.example` | the live host name and the OAuth callback URLs registered with Google/Microsoft/GitHub; host rename is a separate deployment decision |
| `README.md:3` "Previously OpenDots…", `docs/renaming.md`, `patches/@novnc__novnc*.patch` comment | explicit historical/migration note |
| Android `.github/workflows/android-release.yml` `app.dot.opendots/.MainActivity` | applicationId |

`OpenCode` occurrences (Android `strings.xml`, web code pages, server `opencode/*`) are the real third-party integration and
were not touched. No place was found where `OpenCode` is shown as the host application's name.

## Verification

* Built web bundle: no `OpenDots` / `Open Dots` in `apps/web/dist`.
* Built APK: `application-label` is `BotCircle` for every locale; package `app.dot.opendots`, versionName `0.1.0-alpha.36`;
  no old-brand string in the resource table.
* `pnpm typecheck`, `pnpm build`: pass. Server suite (`--exclude test/git-broker.test.ts`): 345 passed, 12 failed — the known
  Windows environment failures (browser-session 3, capabilities/MCP 4, computer 3, ssh 1, codex 1). Android
  `testDebugUnitTest`: pass (after fixing `ScreensTest` which still waited for the old fixture name).

## Android upgrade finding (needs a decision by the product owner)

The published APKs share the application id `app.dot.opendots` but are signed with **different certificates**:
OpenDots alpha.9 `1e16dec3…`, BotCircle alpha.36 `ffff890a…`, local debug `ee18a72b…`. Android refuses an in-place update
across different signing certificates, so a device with the old published OpenDots APK **cannot upgrade in place** to a
BotCircle build: it must uninstall (losing the stored session) and reinstall. Not changed here (signing keys must not be
altered); BotCircle alpha.36 → later BotCircle releases are unaffected as long as the same key is used.

## Not verified here (needs the lead's emulator / live environment)

* Visual pass on Android: launcher label/icon, splash, login/server screen placeholder, settings/about, notification channels,
  OpenCode code pages; fresh install and upgrade from the last BotCircle alpha.
* Visual pass on the web (title, favicon, PWA install, login, settings, dark/OLED/light, FR/EN) on the live server.
* Server-generated e-mails/notification texts were only grepped (no old brand found), not triggered.
