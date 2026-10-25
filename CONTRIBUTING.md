# Contributing to OpenGMB

Thank you for helping. Small, focused pull requests are the easiest to review. This repository is the community edition of OpenGMB, so a change should make sense for a self-hosted install with one owner login.

## Good first contributions

- Fix a typo or an unclear sentence in the docs or in the app text.
- Add a test for a rule in `packages/core/src/guardrails`.
- Report a bug with steps to reproduce it. The mock Google mode makes most bugs reproducible without any keys.

For anything larger than a bug fix, open an issue first and describe what you want to change, so you do not build something we cannot take.

## How accepted pull requests flow

This repository is published from our main codebase, and each sync replaces its contents. Because of that, **we do not merge pull requests here with the merge button.**

1. You open a pull request and we review it on GitHub.
2. If we accept it, we label it `accepted`. The maintainers apply the change to the main codebase.
3. The change arrives in this repository with the next sync. The sync commit credits you with a `Co-authored-by` line, closes your pull request, and thanks you there.

So an accepted pull request is closed by the sync commit, not merged directly, and it can take until the next sync to show up in the history. If a change is not a fit, we tell you why. We aim to reply promptly, and a reply may be a question or a request for changes.

## Set up

You need Node 22 or newer (see `.nvmrc`), pnpm 10 and Docker.

```sh
cp .env.example .env     # set BETTER_AUTH_SECRET, ENCRYPTION_KEY and AUDIT_CHECKPOINT_KEY with: openssl rand -base64 32
                         # and OWNER_EMAIL and OWNER_PASSWORD for your local owner login
docker compose up -d     # starts Postgres on localhost:54329
pnpm i
pnpm db:migrate
pnpm dev
```

Tests need a separate database. Create a second database next to the dev one and point `DATABASE_URL_TEST` in `.env` at it. Never point it at a database you care about, because tests write to it.

## Run the checks

```sh
pnpm typecheck
pnpm lint
pnpm exec vitest run path/to/changed.test.ts     # the tests for the files you changed
```

Run the tests that cover your change. The whole suite is large and slow, and it is fine to leave it to us. If you change the database schema, run `pnpm db:generate` and include the generated migration in your pull request. We replace it with our own generated version when we apply the change, so keep the schema change small and clear.

## Sign off your commits

We use the Developer Certificate of Origin (https://developercertificate.org). Add a `Signed-off-by` line to every commit with `git commit -s`. By signing off you state that you wrote the change or have the right to submit it under this repository's license (MIT). There is no CLA, and we do not ask you to sign a separate agreement.

## Do not copy code from GPL or AGPL projects

Do not paste code from AGPL or GPL projects into this repository. If OpenGMB works with such a project, it does so through that project's public API only.

## Writing rules

Text that users read follows these rules.

- US spelling.
- No em dashes.
- Plain words. Say what the button does.
- The product name is OpenGMB.

## Security problems

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
