# BotCircle migration

BotCircle is the new product name of OpenDots. This is the same application and repository history.

The Web and Android display names, onboarding, settings, OAuth result pages, provider identification and documentation use BotCircle. Existing companion avatars and the Quiet UI design remain in use.

Compatibility is deliberate: npm scopes (`@opendots/*`), environment variables (`OPENDOTS_*`), storage paths, database records, cookies, browser storage, OAuth callbacks/messages, Docker service/container names, Android application ID (`app.dot.opendots`), resource theme and implementation class names remain unchanged. Keep existing deployment configuration, secrets and Android signing keys. Do not rename volumes or create a new application/database for this change.

## Repository and deployment addresses

Clone from `https://github.com/Sr-0w/BotCircle.git`. Existing clones can use `git remote set-url origin https://github.com/Sr-0w/BotCircle.git`. Deployment hostnames and registered OAuth callbacks are independent of the repository name.

## Validation

Run `pnpm typecheck`, `pnpm test` and `pnpm build`. Build Android with the existing application ID and signing configuration, then verify installation over the previous release, login, screenshot attachments and OAuth on the existing deployment. Android SDK/device validation is still required where those tools are available.
