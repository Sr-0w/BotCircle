# BotCircle migration

BotCircle is the new product name of OpenDots. This is the same application and repository history.

The Web and Android display names, onboarding, settings, OAuth result pages, provider identification and documentation use BotCircle. Existing companion avatars and the Quiet UI design remain in use.

Compatibility is deliberate: npm scopes (`@opendots/*`), environment variables (`OPENDOTS_*`), storage paths, database records, cookies, browser storage, OAuth callbacks/messages, Docker service/container names, Android application ID (`app.dot.opendots`), resource theme and implementation class names remain unchanged. Keep existing deployment configuration, secrets and Android signing keys. Do not rename volumes or create a new application/database for this change.

## Repository rename still to perform

The connected GitHub tools can publish commits but cannot rename repositories. An administrator must check that `Sr-0w/BotCircle` is available, then rename the existing repository in Settings → General. Do not create a replacement repository. Until that operation succeeds, clone URLs retain the working OpenDots path.

After renaming, update the clone links and local remotes to `https://github.com/Sr-0w/BotCircle.git`, verify old links redirect, and check GitHub Actions/release publishing. Existing deployment URLs and OAuth callback URLs do not change merely because the repository name changes.

## Validation

Run `pnpm typecheck`, `pnpm test` and `pnpm build`. Build Android with the existing application ID and signing configuration, then verify installation over the previous release, login, screenshot attachments and OAuth on the existing deployment. Android SDK/device validation is still required where those tools are available.
