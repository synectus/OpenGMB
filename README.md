# OpenGMB

OpenGMB is open-source software for managing Google Business Profiles: reviews, posts, profile edits, approvals, performance, reports and rank tracking. This repository is the **community edition**. You run it on your own server, with your own API keys, and one owner login manages as many clients and locations as you need.

It uses the official Google Business Profile API. Nothing goes live without a person's approval, with one setting the owner controls. Posts and profile edits always need approval. Replies need it too, unless the owner turns on auto-approve for 4- or 5-star reviews. Replies to 1- to 3-star reviews always need a person. Rules check every reply, post and edit before anyone approves it.

OpenGMB is made by [Synectus](https://synectus.com). It is not affiliated with or endorsed by Google.

## What the community edition includes

- Many clients and many locations under one owner login, with location groups.
- Posts, reviews, review replies and an approvals inbox, with guardrail rules that check text before approval.
- Performance data, reports, and shareable report links for your clients.
- White-label branding on reports.
- Geo-grid and rank tracking, with your own DataForSEO account.
- AI drafts and suggestions, with your own Anthropic key. There are no credits.
- An MCP server and API tokens, so Claude or another MCP client can work with your profiles. A token is read only or read and write.
- A REST API (v1), webhooks, and the source of the Zapier app.
- Review request links with QR codes, and public location pages.
- Two-factor sign-in and an audit log.

There is no sign-up page, billing or credit system. You set the owner's email and password in the env file on first start.

## What is not in this repository

OpenGMB is open core. The hosted version, [OpenGMB](https://opengmb.synectus.com), adds teams and roles, a client portal, billing with a monthly credit plan, custom domains and the managed service, where we run the servers, the Google connection and the updates. If you would rather not run your own server, use that.

## Quick start

You need Docker Engine 24 or newer with the Compose plugin, about 4 GB of free RAM while the images build, and a public HTTPS hostname if you want Google sign-in.

```sh
cd deploy/selfhost
cp .env.example .env     # fill in the required values; the comments explain each one
docker compose up -d --build
```

Set `OWNER_EMAIL` and `OWNER_PASSWORD` in `.env` before the first start. Then open <http://localhost:8080> (or your `WEB_URL`) and sign in. Two-factor sign-in is required: the app makes you enrol an authenticator app on the first sign-in and shows backup codes once, so save them. The Google client runs in `mock` mode out of the box: under Settings, Google, press "Use the sample Google account" to import sample locations and click through the app without any Google keys. After you change `.env`, run `docker compose up -d` again (`restart` keeps the old environment). Going live needs Google's approval of Business Profile API access for your own Google Cloud project, which you request yourself and which can take days. [SETUP.md](SETUP.md) covers every step.

## What is in this repository

| Path | What |
| --- | --- |
| `apps/web` | The Next.js app |
| `apps/mcp` | The MCP server (Streamable HTTP) |
| `apps/worker` | Background jobs: review sync, publishing, reports, Pub/Sub push |
| `packages/core` | Auth, tenancy, the audit log, the action registry, the Google client, guardrail rules |
| `packages/db` | Drizzle schema and migrations (Postgres) |
| `deploy/selfhost` | The self-host stack (Docker Compose): use this to run OpenGMB |
| `integrations/zapier` | The Zapier app source |

The `docker-compose.yml` at the repository root is only a development Postgres for contributors. It is not the self-host stack: run the one in `deploy/selfhost`.

Internal package names use the `@opengmb/` prefix.

## Contribute and report problems

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request. Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## License

The code is released under the MIT license. See [LICENSE](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Trademarks

The license covers the code. It does not cover the OpenGMB name or logo, which are trademarks of Synectus Private Limited, so a fork needs its own name and logo. See [TRADEMARKS.md](TRADEMARKS.md).
